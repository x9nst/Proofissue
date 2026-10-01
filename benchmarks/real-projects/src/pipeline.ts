/**
 * Runs one trial case from fetch to fix verification and writes its outputs.
 *
 * {@link runTrialCase} never throws: an unexpected exception becomes a `harness_error` outcome.
 * Everything the harness writes goes through a self-check first: a result or summary that
 * contains a local path or a likely secret is replaced by a minimal result carrying only the
 * error code.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { redactText } from '@proofissue/redactor';

import { createDiagnosticSink } from './diagnostics.js';
import type { TrialCase } from './manifest.js';
import { decideOutcome, summarizeRuns, type HarnessIssue } from './outcome.js';
import type { Executor } from './process.js';
import type {
  CaseRecord,
  EnvironmentRecord,
  HarnessCode,
  TrialResult,
  TrialStages,
} from './result-model.js';
import { escapeForLog, findLocalPath, scrubValue, type Scrubber } from './scrub.js';
import {
  DEFAULT_TIMEOUTS,
  artifactPaths,
  baselineStage,
  caseDirectories,
  fetchStage,
  filesStage,
  hostInstallStage,
  preflightStage,
  prepareStage,
  recordStage,
  replaySeries,
  type StageContext,
  type StageTimeouts,
} from './stages.js';

export interface PipelineContext {
  readonly exec: Executor;
  /** A millisecond clock. */
  readonly now: () => number;
  readonly environment: EnvironmentRecord;
  readonly image: string;
  readonly roots: {
    readonly work: string;
    readonly output: string;
    readonly diagnostics: string;
  };
  readonly cliPath: string;
  readonly nodePath: string;
  readonly pathEnv: string | undefined;
  /** Snapshot replays per case. */
  readonly runs: number;
  readonly baselineRuns: number;
  readonly fixRuns: number;
  readonly scrub: Scrubber;
  /** Receives one job-log line at a time. Lines are escaped before they get here. */
  readonly log: (line: string) => void;
  readonly timeouts?: StageTimeouts;
  /** Renders `<ID>.summary.md` from the final result. Omitted in tests of the pipeline alone. */
  readonly renderSummary?: (result: TrialResult) => string;
  /** The ProofIssue CLI build is missing: every stage is skipped and the case is a harness error. */
  readonly cliMissing?: boolean;
}

/** Every stage skipped: the starting point, and the shape of a minimal result. */
export const skippedStages = (item: Pick<TrialCase, 'expected_exit_code'>): TrialStages => ({
  fetch: { status: 'skipped', duration_ms: 0 },
  files: { status: 'skipped', files: [], unselected_config_files: [] },
  host_install: { status: 'skipped', duration_ms: 0, timed_out: false },
  preflight: {
    status: 'skipped',
    duration_ms: 0,
    expected_exit_code: item.expected_exit_code,
    timed_out: false,
    expectations_observed: [],
    stdout_bytes: 0,
    stderr_bytes: 0,
  },
  record: { status: 'skipped', duration_ms: 0 },
  prepare: { status: 'skipped', duration_ms: 0, errors: [], warning_codes: [] },
  install_baseline: { status: 'skipped', record_status: 'skipped', runs: [] },
  snapshot: { status: 'skipped', runs: [], summary: summarizeRuns([]) },
  pre_fix_checkout: { status: 'skipped', runs: [] },
  fix_verification: { status: 'skipped', runs: [] },
});

export const toCaseRecord = (item: TrialCase, upstreamLicense: string | null): CaseRecord => ({
  id: item.id,
  title: item.title,
  repository: item.repository,
  links: item.links,
  pre_fix_commit: item.pre_fix_commit,
  fix_commit: item.fix_commit,
  dependencies: item.dependencies,
  reproduction_files: item.reproduction_files,
  subject_files: item.subject_files,
  command: item.command,
  expected_exit_code: item.expected_exit_code,
  expectations: item.expectations,
  sets: item.sets,
  upstream_license: upstreamLicense,
});

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

/** What the stages have produced so far. Kept outside the flow so an exception loses nothing. */
interface Progress {
  stages: TrialStages;
  upstreamLicense: string | null;
  licenseText: string | null;
}

const runStages = async (
  item: TrialCase,
  context: PipelineContext,
  ctx: StageContext,
  progress: Progress,
): Promise<void> => {
  const id = item.id;

  const fetched = await fetchStage(ctx);
  progress.stages = { ...progress.stages, fetch: fetched };
  ctx.log(`[${id}] fetch: ${fetched.status} (${seconds(fetched.duration_ms)} s)`);
  if (fetched.status !== 'ok') return;

  const files = await filesStage(ctx);
  progress.stages = { ...progress.stages, files: files.stage };
  progress.upstreamLicense = files.upstreamLicense;
  progress.licenseText = files.licenseText;
  ctx.log(`[${id}] files: ${files.stage.status}`);
  if (files.stage.status !== 'ok') return;

  const installed = await hostInstallStage(ctx);
  progress.stages = { ...progress.stages, host_install: installed };
  ctx.log(`[${id}] host_install: ${installed.status} (${seconds(installed.duration_ms)} s)`);
  if (installed.status === 'failed') return;

  const preflight = await preflightStage(ctx);
  progress.stages = { ...progress.stages, preflight };
  ctx.log(`[${id}] preflight: ${preflight.status} (${seconds(preflight.duration_ms)} s)`);
  if (preflight.status !== 'ok') return;

  const recorded = await recordStage(ctx);
  progress.stages = { ...progress.stages, record: recorded };
  ctx.log(`[${id}] record: ${recorded.status} (${seconds(recorded.duration_ms)} s)`);
  if (recorded.status !== 'created') return;

  const prepared = await prepareStage(ctx);
  progress.stages = { ...progress.stages, prepare: prepared };
  ctx.log(`[${id}] prepare: ${prepared.status} (${seconds(prepared.duration_ms)} s)`);
  if (prepared.status !== 'ok') return;

  const { artifact } = artifactPaths(ctx);
  const baseline = await baselineStage(ctx, context.baselineRuns);
  progress.stages = { ...progress.stages, install_baseline: baseline };
  ctx.log(`[${id}] install_baseline: ${baseline.status}`);

  const snapshotRuns = await replaySeries(
    ctx,
    { artifactPath: artifact },
    context.runs,
    'snapshot',
  );
  progress.stages = {
    ...progress.stages,
    snapshot: { status: 'ok', runs: snapshotRuns, summary: summarizeRuns(snapshotRuns) },
  };

  const preFixRuns = await replaySeries(
    ctx,
    { artifactPath: artifact, against: ctx.dirs.repo },
    1,
    'pre-fix',
  );
  progress.stages = { ...progress.stages, pre_fix_checkout: { status: 'ok', runs: preFixRuns } };

  const fixRuns = await replaySeries(
    ctx,
    { artifactPath: artifact, against: ctx.dirs.fix },
    context.fixRuns,
    'fix',
  );
  progress.stages = { ...progress.stages, fix_verification: { status: 'ok', runs: fixRuns } };
};

/** Why a serialized result or summary may not be written, or undefined when it is clean. */
export const selfCheck = (text: string): HarnessCode | undefined => {
  if (findLocalPath(text)) return 'local_path_in_result';
  try {
    return redactText(text).findings.length > 0 ? 'secret_like_value_in_result' : undefined;
  } catch {
    return 'secret_like_value_in_result';
  }
};

const noticeText = (item: TrialCase, license: string | null): string =>
  [
    '# Third-party material notice',
    '',
    `The .proofissue files in this directory embed files copied unmodified from ${item.repository}.`,
    `Subject and dependency files come from commit ${item.pre_fix_commit};`,
    `reproduction files come from commit ${item.fix_commit}.`,
    '',
    `Those files remain under their upstream licence${license === null ? '' : ` (${license})`}.`,
    'The upstream root licence text at the pre-fix commit is in UPSTREAM-LICENSE.txt when it was',
    'small and clean enough to copy. The files were captured by the ProofIssue real-project trial',
    'harness for evaluation only. Check the upstream licence before reusing them elsewhere.',
    '',
  ].join('\n');

const bareMinimum = (result: TrialResult, code: HarnessCode): TrialResult => ({
  trial_result_version: 1,
  case: result.case,
  environment: result.environment,
  stages: skippedStages(result.case),
  outcome: {
    classification: 'harness_error',
    stage: 'write',
    code,
    detail: 'The result was withheld because it failed the harness leak self-check.',
    additional: [],
  },
});

const serialize = (result: TrialResult, scrub: Scrubber): string =>
  `${JSON.stringify(scrubValue(result, scrub), null, 2)}\n`;

const writeOutputs = async (
  item: TrialCase,
  context: PipelineContext,
  ctx: StageContext,
  result: TrialResult,
  licenseText: string | null,
): Promise<TrialResult> => {
  let final = scrubValue(result, context.scrub);
  let json = serialize(final, context.scrub);
  const problem = selfCheck(json);
  if (problem !== undefined) {
    final = bareMinimum(result, problem);
    json = serialize(final, context.scrub);
    if (selfCheck(json) !== undefined) {
      json = `${JSON.stringify({
        trial_result_version: 1,
        case: { id: item.id },
        outcome: { classification: 'harness_error', stage: 'write', code: problem },
      })}\n`;
    }
  }

  try {
    await mkdir(ctx.dirs.results, { recursive: true });
    await writeFile(path.join(ctx.dirs.results, `${item.id}.result.json`), json, {
      encoding: 'utf8',
      flag: 'wx',
    });
    const notice = noticeText(item, final.case.upstream_license);
    if (selfCheck(notice) === undefined) {
      await writeFile(path.join(ctx.dirs.results, 'NOTICE.md'), notice, 'utf8');
    }
    if (licenseText !== null && !findLocalPath(licenseText)) {
      await writeFile(path.join(ctx.dirs.results, 'UPSTREAM-LICENSE.txt'), licenseText, 'utf8');
    }
    if (context.renderSummary !== undefined) {
      const markdown = `${scrubValue(context.renderSummary(final), context.scrub)}\n`;
      if (selfCheck(markdown) === undefined) {
        await writeFile(path.join(ctx.dirs.results, `${item.id}.summary.md`), markdown, 'utf8');
      }
    }
  } catch {
    // The outcome is already decided; a write failure shows up as a missing result file, which
    // the summary job reports as a missing case.
  }
  return final;
};

/** Runs one case. Never throws. */
export const runTrialCase = async (
  item: TrialCase,
  context: PipelineContext,
): Promise<TrialResult> => {
  const dirs = caseDirectories(context.roots, item.id);
  const sink = createDiagnosticSink(dirs.diagnostics, context.scrub);
  const ctx: StageContext = {
    exec: context.exec,
    now: context.now,
    item,
    image: context.image,
    cliPath: context.cliPath,
    nodePath: context.nodePath,
    pathEnv: context.pathEnv,
    dirs,
    sink,
    timeouts: context.timeouts ?? DEFAULT_TIMEOUTS,
    log: (line) => {
      context.log(escapeForLog(line));
    },
  };

  const progress: Progress = {
    stages: skippedStages(item),
    upstreamLicense: null,
    licenseText: null,
  };
  let harnessError: HarnessIssue | undefined;
  try {
    if (context.cliMissing === true) {
      harnessError = { code: 'cli_missing', detail: 'The ProofIssue CLI build was not found.' };
    } else {
      await runStages(item, context, ctx, progress);
    }
  } catch {
    harnessError = { code: 'unexpected_exception', detail: 'The harness failed unexpectedly.' };
  }

  const outcome = decideOutcome({
    stages: progress.stages,
    ...(harnessError === undefined ? {} : { harnessError }),
  });
  const result: TrialResult = {
    trial_result_version: 1,
    case: toCaseRecord(item, progress.upstreamLicense),
    environment: context.environment,
    stages: progress.stages,
    outcome,
  };
  ctx.log(`[${item.id}] outcome: ${outcome.classification} ${outcome.code}`);
  const final = await writeOutputs(item, context, ctx, result, progress.licenseText);
  await sink.flush();
  return final;
};
