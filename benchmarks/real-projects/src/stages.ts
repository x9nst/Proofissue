/**
 * One function per pipeline stage.
 *
 * Every external step goes through the injected {@link Executor}: `shell: false`, an explicit
 * environment, a deadline, and bounded output. Output from third-party tools goes to the
 * diagnostics sink only. Stage records hold counts, enums, and durations.
 */
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  parseInspect,
  parsePrepare,
  parseRecordOutput,
  parseReplay,
  toReplayRun,
  type InspectionView,
  type ReplayObservation,
  type ReplayRun,
} from './cli-results.js';
import type { DiagnosticSink } from './diagnostics.js';
import type { TrialCase } from './manifest.js';
import { CLI_TIMEOUT_ERROR_CODE, classifyPrepareFailure } from './outcome.js';
import type { ExecOutcome, ExecRequest, Executor } from './process.js';
import {
  buildBaselineRecordArguments,
  buildRecordArguments,
  type RecordArgumentContext,
} from './record-arguments.js';
import type {
  BaselineStage,
  CliFailureKind,
  FetchStage,
  FileRecord,
  FilesStage,
  HostInstallStage,
  NodeModulesSize,
  PrepareStage,
  PreflightStage,
  RecordStage,
} from './result-model.js';
import { findLocalPath } from './scrub.js';

export interface StageTimeouts {
  readonly gitFetchMs: number;
  readonly gitMs: number;
  readonly hostInstallMs: number;
  readonly preflightMs: number;
  readonly recordMs: number;
  readonly inspectMs: number;
  readonly prepareMs: number;
  readonly replayMs: number;
}

export const DEFAULT_TIMEOUTS: StageTimeouts = {
  gitFetchMs: 180_000,
  gitMs: 60_000,
  hostInstallMs: 600_000,
  preflightMs: 90_000,
  recordMs: 180_000,
  inspectMs: 60_000,
  prepareMs: 900_000,
  replayMs: 300_000,
};

export interface CaseDirectories {
  /** `<work>/<ID>`: must not exist before the run. */
  readonly work: string;
  readonly repo: string;
  readonly fix: string;
  readonly store: string;
  readonly npmCache: string;
  readonly home: string;
  /** `<output>/<ID>`: must not exist before the run. */
  readonly results: string;
  readonly diagnostics: string;
}

export const caseDirectories = (
  roots: { readonly work: string; readonly output: string; readonly diagnostics: string },
  id: string,
): CaseDirectories => {
  const work = path.join(roots.work, id);
  return {
    work,
    repo: path.join(work, 'repo'),
    fix: path.join(work, 'fix'),
    store: path.join(work, 'store'),
    npmCache: path.join(work, 'npm-cache'),
    home: path.join(work, 'home'),
    results: path.join(roots.output, id),
    diagnostics: path.join(roots.diagnostics, id),
  };
};

export interface StageContext {
  readonly exec: Executor;
  /** A millisecond clock. Injected so tests are deterministic. */
  readonly now: () => number;
  readonly item: TrialCase;
  readonly image: string;
  readonly cliPath: string;
  readonly nodePath: string;
  readonly pathEnv: string | undefined;
  readonly dirs: CaseDirectories;
  readonly sink: DiagnosticSink;
  readonly timeouts: StageTimeouts;
  /** Job-log progress. Callers pass only case IDs, stage names, enums, and numbers. */
  readonly log: (line: string) => void;
}

const KIB = 1024;
const MIB = 1024 * KIB;
const GIT_OUTPUT_BYTES = 64 * KIB;
const NODE_MODULES_MAX_ENTRIES = 500_000;
const MAX_COUNTED_FILE_BYTES = 8 * MIB;
const PAGE_BYTES = 4096;

const withPath = (ctx: StageContext): Record<string, string> =>
  ctx.pathEnv === undefined ? {} : { PATH: ctx.pathEnv };

const gitEnvironment = (ctx: StageContext): Record<string, string> => ({
  ...withPath(ctx),
  HOME: ctx.dirs.home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(ctx.dirs.home, 'gitconfig'),
  GIT_TERMINAL_PROMPT: '0',
  GIT_LITERAL_PATHSPECS: '1',
  LC_ALL: 'C',
});

const npmEnvironment = (ctx: StageContext): Record<string, string> => ({
  ...withPath(ctx),
  HOME: ctx.dirs.home,
  npm_config_userconfig: path.join(ctx.dirs.home, 'npmrc'),
  npm_config_globalconfig: path.join(ctx.dirs.home, 'npmrc-global'),
  npm_config_cache: ctx.dirs.npmCache,
  npm_config_update_notifier: 'false',
});

const succeeded = (outcome: ExecOutcome): boolean =>
  !outcome.spawnFailed && !outcome.timedOut && outcome.exitCode === 0;

const describeExit = (outcome: ExecOutcome): string => {
  if (outcome.spawnFailed) return 'could not start';
  if (outcome.timedOut) return 'timed out';
  return `exit ${outcome.exitCode === null ? 'none' : String(outcome.exitCode)}`;
};

const MAX_LABEL_LENGTH = 400;

const execLogged = async (
  ctx: StageContext,
  diagnosticName: string,
  request: ExecRequest,
): Promise<ExecOutcome> => {
  const outcome = await ctx.exec(request);
  const label = `${request.command} ${request.args.join(' ')}`.slice(0, MAX_LABEL_LENGTH);
  ctx.sink.add(
    diagnosticName,
    `$ ${label}\n[${describeExit(outcome)}, ${String(outcome.durationMs)} ms]\n${outcome.stdout.decoded_text}${
      outcome.stderr.decoded_text === '' ? '' : `\n[stderr]\n${outcome.stderr.decoded_text}`
    }\n\n`,
  );
  return outcome;
};

const runGit = (
  ctx: StageContext,
  args: readonly string[],
  options: { readonly cwd?: string; readonly timeoutMs?: number; readonly limit?: number } = {},
): Promise<ExecOutcome> =>
  execLogged(ctx, 'git.txt', {
    command: 'git',
    args,
    cwd: options.cwd ?? ctx.dirs.repo,
    env: gitEnvironment(ctx),
    timeoutMs: options.timeoutMs ?? ctx.timeouts.gitMs,
    outputLimitBytes: options.limit ?? GIT_OUTPUT_BYTES,
    termination: 'immediate',
  });

const runCli = (
  ctx: StageContext,
  diagnosticName: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<ExecOutcome> =>
  execLogged(ctx, diagnosticName, {
    command: ctx.nodePath,
    args: [ctx.cliPath, ...args],
    cwd: ctx.dirs.work,
    env: withPath(ctx),
    timeoutMs,
    outputLimitBytes: MIB,
    termination: 'graceful',
  });

/** The records name the stage and an enum, never the third-party text that explains it. */
const elapsed = (ctx: StageContext, started: number): number => Math.max(0, ctx.now() - started);

// ---------------------------------------------------------------------------------------------
// Stage 1: fetch

const prepareDirectories = async (ctx: StageContext): Promise<void> => {
  // The case and result directories must be new: a leftover directory would mix runs.
  await mkdir(path.dirname(ctx.dirs.work), { recursive: true });
  await mkdir(ctx.dirs.work);
  await mkdir(path.dirname(ctx.dirs.results), { recursive: true });
  await mkdir(ctx.dirs.results);
  await mkdir(ctx.dirs.npmCache, { recursive: true });
  await mkdir(ctx.dirs.home, { recursive: true });
  for (const name of ['gitconfig', 'npmrc', 'npmrc-global']) {
    await writeFile(path.join(ctx.dirs.home, name), '', { flag: 'wx' });
  }
};

export const fetchStage = async (ctx: StageContext): Promise<FetchStage> => {
  const started = ctx.now();
  const fail = (failure: string): FetchStage => ({
    status: 'failed',
    duration_ms: elapsed(ctx, started),
    failure,
  });
  try {
    await prepareDirectories(ctx);
  } catch {
    return fail('The work or result directory could not be created; it may already exist.');
  }

  const { item, dirs } = ctx;
  const steps: readonly {
    readonly name: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly timeoutMs?: number;
  }[] = [
    { name: 'init', args: ['init', '-q', '-b', 'trial', 'repo'], cwd: dirs.work },
    { name: 'config', args: ['config', 'core.autocrlf', 'false'], cwd: dirs.repo },
    { name: 'remote', args: ['remote', 'add', 'origin', item.repository], cwd: dirs.repo },
    {
      name: 'fetch',
      args: [
        'fetch',
        '-q',
        '--depth',
        '1',
        '--no-tags',
        'origin',
        item.pre_fix_commit,
        item.fix_commit,
      ],
      cwd: dirs.repo,
      timeoutMs: ctx.timeouts.gitFetchMs,
    },
    { name: 'checkout', args: ['checkout', '-q', '--detach', item.pre_fix_commit], cwd: dirs.repo },
    {
      name: 'overlay',
      args: ['checkout', '-q', item.fix_commit, '--', ...item.reproduction_files],
      cwd: dirs.repo,
    },
    {
      name: 'worktree',
      args: ['worktree', 'add', '-q', '--detach', dirs.fix, item.fix_commit],
      cwd: dirs.repo,
    },
  ];
  for (const step of steps) {
    const outcome = await runGit(ctx, step.args, {
      cwd: step.cwd,
      ...(step.timeoutMs === undefined ? {} : { timeoutMs: step.timeoutMs }),
    });
    if (!succeeded(outcome)) return fail(`git ${step.name} failed (${describeExit(outcome)}).`);
  }
  return { status: 'ok', duration_ms: elapsed(ctx, started) };
};

// ---------------------------------------------------------------------------------------------
// Stage 2: files

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt))?$/iu;
const CONFIG_FILE =
  /^(\.mocharc.*|\.babelrc.*|babel\.config\..*|jest\.config\..*|vitest\.config\..*|\.npmrc|\.nvmrc|\.c8rc.*|\.nycrc.*|tsconfig.*\.json)$/u;
const LICENSE_FIELD = /^[A-Za-z0-9.+() -]{1,64}$/u;
const BLOB_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;
const LICENSE_TEXT_LIMIT = 64 * KIB;

interface FileSpec {
  readonly path: string;
  readonly role: FileRecord['role'];
  readonly commit: string;
}

const fileSpecs = (item: TrialCase): readonly FileSpec[] => [
  ...item.reproduction_files.map((file) => ({
    path: file,
    role: 'reproduction' as const,
    commit: item.fix_commit,
  })),
  ...item.subject_files.map((file) => ({
    path: file,
    role: 'subject' as const,
    commit: item.pre_fix_commit,
  })),
  ...(item.dependencies
    ? ['package.json', 'package-lock.json'].map((file) => ({
        path: file,
        role: 'dependency' as const,
        commit: item.pre_fix_commit,
      }))
    : []),
];

const countCarriageReturns = (bytes: Uint8Array): number => {
  let count = 0;
  for (const byte of bytes) if (byte === 0x0d) count += 1;
  return count;
};

const checkFile = async (ctx: StageContext, spec: FileSpec): Promise<FileRecord> => {
  const absolute = path.join(ctx.dirs.repo, ...spec.path.split('/'));
  let bytes = 0;
  let carriageReturns = 0;
  let regular: boolean;
  try {
    const info = await lstat(absolute);
    regular = info.isFile();
    if (regular) {
      bytes = info.size;
      if (info.size <= MAX_COUNTED_FILE_BYTES) {
        carriageReturns = countCarriageReturns(await readFile(absolute));
      }
    }
  } catch {
    regular = false;
  }
  const expected = await runGit(ctx, ['rev-parse', `${spec.commit}:${spec.path}`]);
  const actual = await runGit(ctx, ['hash-object', '--no-filters', '--', spec.path]);
  const expectedId = succeeded(expected) ? expected.stdout.decoded_text.trim() : '';
  const actualId = succeeded(actual) ? actual.stdout.decoded_text.trim() : '';
  const matches =
    regular && BLOB_ID.test(expectedId) && BLOB_ID.test(actualId) && expectedId === actualId;
  let missingAtFix: boolean | undefined;
  if (spec.role === 'subject') {
    const exists = await runGit(ctx, ['cat-file', '-e', `${ctx.item.fix_commit}:${spec.path}`]);
    missingAtFix = !succeeded(exists);
  }
  return {
    path: spec.path,
    role: spec.role,
    bytes,
    matches_commit: matches,
    carriage_returns: carriageReturns,
    ...(missingAtFix === undefined ? {} : { missing_at_fix: missingAtFix }),
  };
};

const readPackageLicense = async (ctx: StageContext): Promise<string | null> => {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(path.join(ctx.dirs.repo, 'package.json'), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const license = (parsed as Record<string, unknown>)['license'];
    return typeof license === 'string' && LICENSE_FIELD.test(license) ? license : null;
  } catch {
    return null;
  }
};

export interface FilesStageResult {
  readonly stage: FilesStage;
  /** The `license` field of package.json at the pre-fix commit, when valid. */
  readonly upstreamLicense: string | null;
  /** The upstream root licence file at the pre-fix commit, when small and clean. */
  readonly licenseText: string | null;
}

export const filesStage = async (ctx: StageContext): Promise<FilesStageResult> => {
  const files: FileRecord[] = [];
  for (const spec of fileSpecs(ctx.item)) files.push(await checkFile(ctx, spec));

  const listing = await runGit(ctx, ['ls-tree', '--name-only', ctx.item.pre_fix_commit], {
    limit: 256 * KIB,
  });
  const rootNames = succeeded(listing)
    ? listing.stdout.decoded_text
        .split('\n')
        .map((name) => name.trim())
        .filter((name) => name !== '' && !name.startsWith('"'))
    : [];
  const selected = new Set(ctx.item.reproduction_files.concat(ctx.item.subject_files));
  const unselected = rootNames
    .filter((name) => CONFIG_FILE.test(name) && !selected.has(name))
    .sort();

  let licenseText: string | null = null;
  const licenseName = [...rootNames].sort().find((name) => LICENSE_FILE.test(name));
  if (licenseName !== undefined) {
    const shown = await runGit(ctx, ['show', `${ctx.item.pre_fix_commit}:${licenseName}`], {
      limit: LICENSE_TEXT_LIMIT,
    });
    const text = shown.stdout.decoded_text;
    if (succeeded(shown) && !shown.stdout.truncated && !findLocalPath(text)) licenseText = text;
  }

  const mismatched = files.filter((file) => !file.matches_commit).length;
  const stage: FilesStage = {
    status: mismatched === 0 ? 'ok' : 'failed',
    files,
    unselected_config_files: unselected,
    ...(mismatched === 0
      ? {}
      : {
          failure: `${String(mismatched)} selected file${mismatched === 1 ? '' : 's'} did not match the commit blob or could not be read.`,
        }),
  };
  return { stage, upstreamLicense: await readPackageLicense(ctx), licenseText };
};

// ---------------------------------------------------------------------------------------------
// Stage 3: host install

/** Counts files and bytes without following symbolic links. A host estimate of tmpfs use. */
export const measureTree = async (root: string): Promise<NodeModulesSize | undefined> => {
  let files = 0;
  let bytes = 0;
  let pageRounded = 0;
  let entries = 0;
  const pending: string[] = [root];
  try {
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) break;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        entries += 1;
        if (entries > NODE_MODULES_MAX_ENTRIES) return undefined;
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(full);
          continue;
        }
        const info = await lstat(full);
        files += 1;
        bytes += info.size;
        pageRounded += Math.max(1, Math.ceil(info.size / PAGE_BYTES)) * PAGE_BYTES;
      }
    }
  } catch {
    return undefined;
  }
  return { files, bytes, page_rounded_bytes: pageRounded };
};

export const hostInstallStage = async (ctx: StageContext): Promise<HostInstallStage> => {
  if (!ctx.item.dependencies) return { status: 'skipped', duration_ms: 0, timed_out: false };
  const started = ctx.now();
  const outcome = await execLogged(ctx, 'host-install.log', {
    command: 'npm',
    args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress'],
    cwd: ctx.dirs.repo,
    env: npmEnvironment(ctx),
    timeoutMs: ctx.timeouts.hostInstallMs,
    outputLimitBytes: 256 * KIB,
    termination: 'immediate',
  });
  const duration = elapsed(ctx, started);
  const exit = outcome.exitCode === null ? {} : { exit_code: outcome.exitCode };
  if (!succeeded(outcome)) {
    return { status: 'failed', duration_ms: duration, ...exit, timed_out: outcome.timedOut };
  }
  const size = await measureTree(path.join(ctx.dirs.repo, 'node_modules'));
  return {
    status: 'ok',
    duration_ms: duration,
    ...exit,
    timed_out: false,
    ...(size === undefined ? {} : { node_modules: size }),
  };
};

// ---------------------------------------------------------------------------------------------
// Stage 4: preflight (a gate: a case that does not fail on the host is not worth recording)

export const preflightStage = async (ctx: StageContext): Promise<PreflightStage> => {
  const { item } = ctx;
  const started = ctx.now();
  const outcome = await ctx.exec({
    command: ctx.nodePath,
    args: item.command.slice(1),
    cwd: ctx.dirs.repo,
    env: {},
    timeoutMs: ctx.timeouts.preflightMs,
    outputLimitBytes: MIB,
    termination: 'immediate',
  });
  const duration = elapsed(ctx, started);
  ctx.sink.add('preflight.stdout.txt', outcome.stdout.decoded_text);
  ctx.sink.add('preflight.stderr.txt', outcome.stderr.decoded_text);

  const observed = item.expectations.map((expectation): boolean | null => {
    if (expectation.mode !== 'contains' || expectation.value === undefined) return null;
    const text =
      expectation.stream === 'stdout' ? outcome.stdout.decoded_text : outcome.stderr.decoded_text;
    return text.includes(expectation.value);
  });
  const passed =
    !outcome.spawnFailed &&
    !outcome.timedOut &&
    outcome.exitCode === item.expected_exit_code &&
    !observed.includes(false);
  return {
    status: passed ? 'ok' : 'failed',
    duration_ms: duration,
    ...(outcome.exitCode === null ? {} : { exit_code: outcome.exitCode }),
    expected_exit_code: item.expected_exit_code,
    timed_out: outcome.timedOut,
    expectations_observed: observed,
    stdout_bytes: outcome.stdout.total_bytes,
    stderr_bytes: outcome.stderr.total_bytes,
  };
};

// ---------------------------------------------------------------------------------------------
// Stage 5: record

export interface RecordedArtifact {
  readonly status: 'created' | 'failed';
  readonly cliExitCode: number | null;
  readonly failureKind?: CliFailureKind;
  readonly failureMessage?: string;
  readonly artifactDigest?: string;
  readonly inspection?: InspectionView;
}

const STOPPED_MESSAGE = 'The harness stopped the CLI after its time limit.';

export const recordArtifact = async (
  ctx: StageContext,
  args: readonly string[],
  outputPath: string,
  diagnosticName: string,
): Promise<RecordedArtifact> => {
  const outcome = await runCli(ctx, diagnosticName, args, ctx.timeouts.recordMs);
  const failed = (failureKind: CliFailureKind, failureMessage?: string): RecordedArtifact => ({
    status: 'failed',
    cliExitCode: outcome.exitCode,
    failureKind,
    ...(failureMessage === undefined ? {} : { failureMessage }),
  });
  if (outcome.spawnFailed) return failed('unparseable', 'The CLI could not be started.');
  if (outcome.timedOut) return failed('refused', STOPPED_MESSAGE);
  if (outcome.exitCode === 2) return failed('arguments_rejected');

  const parsed = parseRecordOutput(outcome.stdout.decoded_text);
  if (parsed.status === 'failed') return failed('refused', parsed.message);
  if (parsed.status !== 'created' || outcome.exitCode !== 0) return failed('unparseable');

  const inspected = await runCli(
    ctx,
    diagnosticName,
    ['inspect', outputPath, '--json'],
    ctx.timeouts.inspectMs,
  );
  const inspection = parseInspect(inspected.stdout.decoded_text);
  if (
    !succeeded(inspected) ||
    inspection.status !== 'inspected' ||
    inspection.inspection === undefined ||
    inspection.artifact_digest === undefined
  ) {
    return failed('unparseable', 'The recorded artifact could not be inspected.');
  }
  return {
    status: 'created',
    cliExitCode: 0,
    artifactDigest: inspection.artifact_digest,
    inspection: inspection.inspection,
  };
};

export const artifactPaths = (
  ctx: StageContext,
): { readonly artifact: string; readonly baseline: string } => ({
  artifact: path.join(ctx.dirs.results, `${ctx.item.id}.proofissue`),
  baseline: path.join(ctx.dirs.results, `${ctx.item.id}-install-baseline.proofissue`),
});

const recordContext = (ctx: StageContext, outputPath: string): RecordArgumentContext => ({
  projectDirectory: ctx.dirs.repo,
  outputPath,
  image: ctx.image,
});

export const recordStage = async (ctx: StageContext): Promise<RecordStage> => {
  const started = ctx.now();
  const output = artifactPaths(ctx).artifact;
  const result = await recordArtifact(
    ctx,
    buildRecordArguments(ctx.item, recordContext(ctx, output)),
    output,
    'record.txt',
  );
  const duration = elapsed(ctx, started);
  if (result.status === 'failed') {
    return {
      status: 'failed',
      duration_ms: duration,
      cli_exit_code: result.cliExitCode,
      ...(result.failureKind === undefined ? {} : { failure_kind: result.failureKind }),
      ...(result.failureMessage === undefined ? {} : { failure_message: result.failureMessage }),
    };
  }
  return {
    status: 'created',
    duration_ms: duration,
    cli_exit_code: 0,
    ...(result.artifactDigest === undefined ? {} : { artifact_digest: result.artifactDigest }),
    ...(result.inspection === undefined ? {} : { inspection: result.inspection }),
  };
};

// ---------------------------------------------------------------------------------------------
// Stage 6: prepare

interface PrepareAttempt {
  readonly stage: PrepareStage;
  readonly reusedTarballs: number | undefined;
}

const prepareArtifact = async (
  ctx: StageContext,
  artifactPath: string,
  diagnosticName: string,
): Promise<PrepareAttempt> => {
  const started = ctx.now();
  const outcome = await runCli(
    ctx,
    diagnosticName,
    ['prepare', artifactPath, '--dependency-store', ctx.dirs.store, '--json'],
    ctx.timeouts.prepareMs,
  );
  const duration = elapsed(ctx, started);
  const observation = parsePrepare(outcome.stdout.decoded_text);
  const prepared =
    !outcome.timedOut &&
    outcome.exitCode === 0 &&
    (observation.status === 'prepared' || observation.status === 'not_required');
  if (prepared) {
    return {
      stage: {
        status: 'ok',
        duration_ms: duration,
        cli_exit_code: outcome.exitCode,
        ...(observation.preparation === undefined ? {} : { preparation: observation.preparation }),
        errors: observation.errors,
        warning_codes: observation.warning_codes,
      },
      reusedTarballs: observation.preparation?.reused_tarballs,
    };
  }
  return {
    stage: {
      status: 'failed',
      duration_ms: duration,
      cli_exit_code: outcome.exitCode,
      failure_kind: classifyPrepareFailure(observation, {
        cliExitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
      }),
      errors: observation.errors,
      warning_codes: observation.warning_codes,
    },
    reusedTarballs: undefined,
  };
};

export const prepareStage = async (ctx: StageContext): Promise<PrepareStage> =>
  (await prepareArtifact(ctx, artifactPaths(ctx).artifact, 'prepare.txt')).stage;

// ---------------------------------------------------------------------------------------------
// Stages 7-10: replay

const stoppedObservation = (): ReplayObservation => ({
  status: 'unparseable',
  evidence_kinds: [],
  difference_kinds: [],
  errors: [{ code: CLI_TIMEOUT_ERROR_CODE, message: STOPPED_MESSAGE }],
  warning_codes: [],
  substituted_paths: [],
});

export interface ReplayTarget {
  readonly artifactPath: string;
  /** `--against <directory>` for current-checkout mode; absent for a snapshot replay. */
  readonly against?: string;
}

const replayOnce = async (
  ctx: StageContext,
  target: ReplayTarget,
  index: number,
  diagnosticName: string,
): Promise<ReplayRun> => {
  const started = ctx.now();
  const outcome = await runCli(
    ctx,
    diagnosticName,
    [
      'replay',
      target.artifactPath,
      ...(target.against === undefined ? [] : ['--against', target.against]),
      '--dependency-store',
      ctx.dirs.store,
      '--json',
    ],
    ctx.timeouts.replayMs,
  );
  const wall = elapsed(ctx, started);
  const observation =
    outcome.timedOut || outcome.spawnFailed
      ? stoppedObservation()
      : parseReplay(outcome.stdout.decoded_text);
  return toReplayRun(observation, { index, cliExitCode: outcome.exitCode, wallMs: wall });
};

/**
 * Runs the replay `count` times, one after the other. A CLI that the harness had to stop ends
 * the series, so one hung replay cannot use the whole job budget.
 */
export const replaySeries = async (
  ctx: StageContext,
  target: ReplayTarget,
  count: number,
  diagnosticPrefix: string,
): Promise<readonly ReplayRun[]> => {
  const runs: ReplayRun[] = [];
  for (let index = 1; index <= count; index += 1) {
    const run = await replayOnce(ctx, target, index, `${diagnosticPrefix}-${String(index)}.txt`);
    runs.push(run);
    ctx.log(
      `[${ctx.item.id}] ${diagnosticPrefix} ${String(index)}/${String(count)}: ${run.status}`,
    );
    if (run.errors.some((error) => error.code === CLI_TIMEOUT_ERROR_CODE)) break;
  }
  return runs;
};

export const baselineStage = async (
  ctx: StageContext,
  runCount: number,
): Promise<BaselineStage> => {
  if (!ctx.item.dependencies || runCount === 0) {
    return { status: 'skipped', record_status: 'skipped', runs: [] };
  }
  const output = artifactPaths(ctx).baseline;
  const recorded = await recordArtifact(
    ctx,
    buildBaselineRecordArguments(ctx.item, recordContext(ctx, output)),
    output,
    'baseline-record.txt',
  );
  if (recorded.status === 'failed') {
    return { status: 'failed', record_status: 'failed', runs: [] };
  }
  const prepared = await prepareArtifact(ctx, output, 'baseline-prepare.txt');
  const base = {
    record_status: 'created' as const,
    ...(recorded.artifactDigest === undefined ? {} : { artifact_digest: recorded.artifactDigest }),
    prepare_duration_ms: prepared.stage.duration_ms,
    ...(prepared.reusedTarballs === undefined ? {} : { reused_tarballs: prepared.reusedTarballs }),
  };
  if (prepared.stage.status === 'failed') return { status: 'failed', ...base, runs: [] };
  const runs = await replaySeries(ctx, { artifactPath: output }, runCount, 'baseline');
  return { status: 'ok', ...base, runs };
};
