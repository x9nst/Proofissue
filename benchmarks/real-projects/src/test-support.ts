/**
 * A fake {@link Executor} for tests. It answers git, npm, preflight, and ProofIssue CLI calls
 * with contract-shaped fixtures, creating the files the pipeline expects on the real disk.
 * Production code never imports this module.
 */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
  BoundedExecutionSummary,
  BoundedStreamCapture,
  InspectOperationResult,
  PrepareOperationResult,
  RecordOperationResult,
  ReplayOperationResult,
} from '@proofissue/contracts';

import type { TrialCase } from './manifest.js';
import type { PipelineContext } from './pipeline.js';
import type { ExecOutcome, ExecRequest, Executor } from './process.js';
import type { TrialResult } from './result-model.js';
import { createScrubber } from './scrub.js';

const capture = (text: string): BoundedStreamCapture => ({
  decoded_text: text,
  discarded_bytes: 0,
  had_decoding_replacement: false,
  retained_bytes: Buffer.byteLength(text),
  total_bytes: Buffer.byteLength(text),
  truncated: false,
});

export const okOutcome = (stdout = '', stderr = ''): ExecOutcome => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  spawnFailed: false,
  durationMs: 10,
  stdout: capture(stdout),
  stderr: capture(stderr),
});

export const failedOutcome = (exitCode: number, stdout = '', stderr = ''): ExecOutcome => ({
  ...okOutcome(stdout, stderr),
  exitCode,
});

export const timedOutOutcome = (): ExecOutcome => ({
  ...okOutcome(),
  exitCode: null,
  signal: 'SIGKILL',
  timedOut: true,
});

export const streamSummary = (bytes: number): BoundedExecutionSummary['stdout'] => ({
  discarded_bytes: 0,
  had_decoding_replacement: false,
  retained_bytes: bytes,
  total_bytes: bytes,
  truncated: false,
});

export const replayJson = (
  status: ReplayOperationResult['status'],
  overrides: Readonly<Record<string, unknown>> = {},
): string => {
  const reproduced = status === 'reproduced';
  const base: ReplayOperationResult = {
    result_schema_version: 1,
    operation: 'replay',
    status,
    artifact_version: 1,
    artifact_digest: 'a'.repeat(64),
    warnings: [],
    errors: [],
    mode: 'snapshot',
    image_digest: `sha256:${'b'.repeat(64)}`,
    effective_limits: {
      cpus: 1,
      memory_mb: 512,
      output_bytes_per_stream: 1_048_576,
      processes: 64,
      timeout_seconds: 60,
      writable_workspace_mb: 256,
    },
    execution: {
      duration_ms: 20_000,
      exit_code: 1,
      stdout: streamSummary(300),
      stderr: streamSummary(0),
      termination_reason: 'exited',
    },
    evidence: reproduced
      ? [
          { kind: 'exit_code', message: 'Exit code matched: 1.' },
          { kind: 'stdout_contains', message: 'Expected stdout text was present.' },
        ]
      : [],
    differences:
      status === 'not_reproduced'
        ? [{ kind: 'stdout_missing', message: 'Expected stdout text was not present.' }]
        : [],
    substituted_paths: [],
    scope_limitations: [],
    cleanup: {
      completed: true,
      attempted_resources: ['container', 'workspace'],
      residual_resources: [],
    },
  };
  return `${JSON.stringify({ ...base, ...overrides })}\n`;
};

export const failedReplayJson = (
  code: ReplayOperationResult['errors'][number]['code'],
  message: string,
  overrides: Readonly<Record<string, unknown>> = {},
): string =>
  replayJson('execution_failed', {
    errors: [{ code, message }],
    execution: undefined,
    ...overrides,
  });

export const timeoutReplayJson = (): string =>
  failedReplayJson('timeout', 'Replay exceeded its wall-clock limit.', {
    execution: {
      duration_ms: 60_000,
      stdout: streamSummary(0),
      stderr: streamSummary(0),
      termination_reason: 'timeout',
    },
  });

const preparedJson = (reused: boolean): string => {
  const result: PrepareOperationResult = {
    result_schema_version: 1,
    operation: 'prepare',
    status: 'prepared',
    artifact_version: 1,
    artifact_digest: 'c'.repeat(64),
    warnings: [],
    errors: [],
    preparation: {
      packages: 355,
      downloaded_tarballs: reused ? 0 : 340,
      downloaded_bytes: reused ? 0 : 20_000_000,
      reused_tarballs: reused ? 340 : 0,
      skipped_for_platform: 2,
      install_script_packages: 0,
    },
  };
  return `${JSON.stringify(result)}\n`;
};

export type ReplayKind = 'baseline' | 'fix' | 'pre_fix' | 'snapshot';

export interface ReplayCall {
  readonly kind: ReplayKind;
  readonly index: number;
}

export interface FakeOptions {
  /** Answers `replay` calls. Return undefined for the default (reproduced, or not_reproduced at the fix). */
  readonly replay?: (call: ReplayCall) => ExecOutcome | undefined;
  readonly preflight?: ExecOutcome;
  readonly hostInstall?: ExecOutcome;
  /** When set, `record` fails with this message. */
  readonly recordFailure?: string;
  /** Selected files whose on-disk bytes differ from the commit blob. */
  readonly corruptedFiles?: ReadonlySet<string>;
  readonly missingAtFix?: ReadonlySet<string>;
  readonly preparedFailure?: ExecOutcome;
  /** The Executor throws when asked to run this command. */
  readonly throwOn?: string;
}

export interface FakeWorld {
  readonly exec: Executor;
  readonly calls: ExecRequest[];
  /** Calls to the ProofIssue CLI, by subcommand. */
  cliCalls: (subcommand: string) => ExecRequest[];
}

const sha1 = (content: string): string => createHash('sha1').update(content).digest('hex');

const canonicalContent = (file: string): string =>
  file === 'package.json'
    ? '{"name":"example","license":"MIT"}\n'
    : file === 'package-lock.json'
      ? '{"lockfileVersion":3}\n'
      : `// canonical content of ${file}\r\nmodule.exports = 1;\n`;

export interface FakeWorldInputs {
  readonly cliPath: string;
  readonly nodePath: string;
  readonly files: readonly string[];
  readonly options?: FakeOptions;
}

export const createFakeWorld = (inputs: FakeWorldInputs): FakeWorld => {
  const options = inputs.options ?? {};
  const calls: ExecRequest[] = [];
  const counters = new Map<ReplayKind, number>();
  const allFiles = [...inputs.files, 'package.json', 'package-lock.json'];

  const writeTree = async (root: string): Promise<void> => {
    for (const file of allFiles) {
      const target = path.join(root, ...file.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      const corrupted = options.corruptedFiles?.has(file) === true;
      await writeFile(target, corrupted ? 'tampered' : canonicalContent(file));
    }
  };

  const argAfter = (args: readonly string[], flag: string): string | undefined => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };

  const git = async (request: ExecRequest): Promise<ExecOutcome> => {
    const [sub, ...rest] = request.args;
    switch (sub) {
      case 'init':
        await mkdir(path.join(request.cwd, 'repo'), { recursive: true });
        await writeTree(path.join(request.cwd, 'repo'));
        return okOutcome();
      case 'worktree': {
        const target = rest[3];
        if (target === undefined) return failedOutcome(128);
        await mkdir(target, { recursive: true });
        await writeTree(target);
        return okOutcome();
      }
      case 'rev-parse': {
        const spec = rest[0] ?? '';
        const file = spec.slice(spec.indexOf(':') + 1);
        return okOutcome(`${sha1(canonicalContent(file))}\n`);
      }
      case 'hash-object': {
        const file = rest[rest.length - 1] ?? '';
        const content = await readFile(path.join(request.cwd, ...file.split('/')), 'utf8');
        return okOutcome(`${sha1(content)}\n`);
      }
      case 'cat-file': {
        const spec = rest[1] ?? '';
        const file = spec.slice(spec.indexOf(':') + 1);
        return options.missingAtFix?.has(file) === true ? failedOutcome(128) : okOutcome();
      }
      case 'ls-tree':
        return okOutcome('.mocharc.json\nLICENSE\nREADME.md\npackage.json\ntest\n');
      case 'show':
        return okOutcome('Example licence text for tests.\n');
      default:
        return okOutcome();
    }
  };

  const cli = async (request: ExecRequest): Promise<ExecOutcome> => {
    const sub = request.args[1];
    const args = request.args.slice(2);
    switch (sub) {
      case 'record': {
        const output = argAfter(args, '--output');
        if (output === undefined) return failedOutcome(2, 'Usage: ...');
        if (options.recordFailure !== undefined) {
          const failure: RecordOperationResult = {
            result_schema_version: 1,
            operation: 'record',
            status: 'invalid_input',
            warnings: [],
            errors: [{ code: 'policy_rejection', message: options.recordFailure }],
          };
          return failedOutcome(1, `${JSON.stringify(failure)}\n`);
        }
        await mkdir(path.dirname(output), { recursive: true });
        const bytes = `artifact bytes for ${path.basename(output)}\n`;
        await writeFile(output, bytes);
        const created: RecordOperationResult = {
          result_schema_version: 1,
          operation: 'record',
          status: 'created',
          artifact_version: 1,
          artifact_digest: createHash('sha256').update(bytes).digest('hex'),
          warnings: [],
          errors: [],
        };
        return okOutcome(`${JSON.stringify(created)}\n`);
      }
      case 'inspect': {
        const target = args[0] ?? '';
        const bytes = await readFile(target);
        const result: InspectOperationResult = {
          result_schema_version: 1,
          operation: 'inspect',
          status: 'inspected',
          artifact_version: 1,
          artifact_digest: createHash('sha256').update(bytes).digest('hex'),
          warnings: [],
          errors: [],
          inspection: {
            runtime: 'node',
            runtime_version: '24.18.0',
            operating_system: 'linux',
            image: `node@sha256:${'e'.repeat(64)}`,
            command: { program: 'node', argument_count: 4, working_directory: '.' },
            files: [
              {
                path: 'test/example.test.js',
                role: 'reproduction',
                bytes: 200,
                sha256: 'a'.repeat(64),
              },
              { path: 'package.json', role: 'dependency', bytes: 40, sha256: 'b'.repeat(64) },
            ],
            expectations: {
              exit_code: 1,
              stdout_count: 1,
              stderr_count: 0,
              stdout_expectations: [{ mode: 'contains', normalize: [] }],
              stderr_expectations: [],
            },
            limits: {
              cpus: 1,
              memory_mb: 512,
              output_bytes_per_stream: 1_048_576,
              processes: 64,
              timeout_seconds: 60,
            },
            redaction: {
              enabled: true,
              finding_count: 1,
              findings: [{ category: 'password', target: 'lib/example.js', count: 1 }],
            },
          },
        };
        return okOutcome(`${JSON.stringify(result)}\n`);
      }
      case 'prepare': {
        if (options.preparedFailure !== undefined) return options.preparedFailure;
        const warm = args[0]?.includes('-install-baseline') === true;
        return okOutcome(preparedJson(warm));
      }
      case 'replay': {
        const artifact = args[0] ?? '';
        const against = argAfter(args, '--against');
        const kind: ReplayKind = artifact.includes('-install-baseline')
          ? 'baseline'
          : against === undefined
            ? 'snapshot'
            : path.basename(against) === 'fix'
              ? 'fix'
              : 'pre_fix';
        const index = (counters.get(kind) ?? 0) + 1;
        counters.set(kind, index);
        const custom = options.replay?.({ kind, index });
        if (custom !== undefined) return custom;
        const mode = against === undefined ? 'snapshot' : 'current_checkout';
        const digest = createHash('sha256')
          .update(await readFile(artifact))
          .digest('hex');
        return okOutcome(
          replayJson(kind === 'fix' ? 'not_reproduced' : 'reproduced', {
            mode,
            artifact_digest: digest,
            execution: {
              duration_ms: kind === 'baseline' ? 12_000 : 20_000 + index * 100,
              exit_code: kind === 'baseline' ? 0 : 1,
              stdout: streamSummary(300),
              stderr: streamSummary(0),
              termination_reason: 'exited',
            },
          }),
        );
      }
      default:
        return failedOutcome(2, 'Unknown command');
    }
  };

  const exec: Executor = async (request) => {
    calls.push(request);
    if (options.throwOn === request.command)
      throw new Error('The fake executor was told to throw.');
    if (request.command === 'git') return await git(request);
    if (request.command === 'npm') {
      const result = options.hostInstall ?? okOutcome();
      if (request.args[0] === 'ci' && result.exitCode === 0 && !result.timedOut) {
        const modules = path.join(request.cwd, 'node_modules', 'example-package');
        await mkdir(modules, { recursive: true });
        await writeFile(path.join(modules, 'index.js'), 'x'.repeat(5000));
        await writeFile(path.join(modules, 'package.json'), '{}');
      }
      return result;
    }
    if (request.command === inputs.nodePath) {
      if (request.args[0] === inputs.cliPath) return await cli(request);
      return options.preflight ?? failedOutcome(1, '1 failing\nfailing literal\n');
    }
    return failedOutcome(127);
  };

  return {
    exec,
    calls,
    cliCalls: (subcommand) =>
      calls.filter(
        (call) =>
          call.command === inputs.nodePath &&
          call.args[0] === inputs.cliPath &&
          call.args[1] === subcommand,
      ),
  };
};

export const sampleCase: TrialCase = {
  id: 'X1',
  sets: ['unit'],
  title: 'A reproducible failure',
  repository: 'https://github.com/example-owner/example-repository.git',
  links: ['https://github.com/example-owner/example-repository/issues/1'],
  pre_fix_commit: 'a'.repeat(40),
  fix_commit: 'b'.repeat(40),
  dependencies: true,
  reproduction_files: ['test/example.test.js'],
  subject_files: ['lib/example.js', 'lib/helper.js'],
  command: ['node', '--test', 'test/example.test.js'],
  expected_exit_code: 1,
  expectations: [{ stream: 'stdout', mode: 'contains', value: 'failing literal' }],
};

export const SAMPLE_CLI_PATH = '/mnt/ci/proofissue/packages/cli/dist/bin.js';
export const SAMPLE_NODE_PATH = '/mnt/ci/node/bin/node';
export const SAMPLE_IMAGE = `node@sha256:${'d'.repeat(64)}`;

const temporaryRoots: string[] = [];

export const cleanupTrialHarnesses = async (): Promise<void> => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { force: true, recursive: true });
};

export interface TrialHarness {
  readonly root: string;
  readonly roots: { work: string; output: string; diagnostics: string };
  readonly world: FakeWorld;
  readonly lines: string[];
  readonly context: PipelineContext;
}

export const createTrialHarness = async (
  options: FakeOptions = {},
  overrides: Partial<PipelineContext> = {},
): Promise<TrialHarness> => {
  const root = await mkdtemp(path.join(tmpdir(), 'trial-pipeline-'));
  temporaryRoots.push(root);
  const roots = {
    work: path.join(root, 'work'),
    output: path.join(root, 'out'),
    diagnostics: path.join(root, 'diag'),
  };
  const world = createFakeWorld({
    cliPath: SAMPLE_CLI_PATH,
    nodePath: SAMPLE_NODE_PATH,
    files: [...sampleCase.reproduction_files, ...sampleCase.subject_files],
    options,
  });
  let tick = 0;
  const lines: string[] = [];
  const context: PipelineContext = {
    exec: world.exec,
    now: () => {
      tick += 250;
      return tick;
    },
    environment: {
      platform: 'linux',
      arch: 'x64',
      kernel_release: '6.11.0',
      cpu_count: 4,
      cpu_model: 'Example CPU',
      memory_total_mb: 16384,
      host_node_version: '24.18.0',
      approved_image: SAMPLE_IMAGE,
    },
    image: SAMPLE_IMAGE,
    roots,
    cliPath: SAMPLE_CLI_PATH,
    nodePath: SAMPLE_NODE_PATH,
    pathEnv: '/mnt/ci/bin',
    runs: 5,
    baselineRuns: 3,
    fixRuns: 1,
    scrub: createScrubber([
      { path: roots.work, token: '<work>' },
      { path: roots.output, token: '<results>' },
      { path: roots.diagnostics, token: '<diagnostics>' },
    ]),
    log: (line) => {
      lines.push(line);
    },
    ...overrides,
  };
  return { root, roots, world, lines, context };
};

export const readTrialResult = async (harness: TrialHarness): Promise<TrialResult> =>
  JSON.parse(
    await readFile(path.join(harness.roots.output, 'X1', 'X1.result.json'), 'utf8'),
  ) as TrialResult;

export const listFiles = async (directory: string): Promise<string[]> => {
  const names: string[] = [];
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) names.push(path.join(entry.parentPath, entry.name));
  }
  return names.sort();
};

/** Makes a temporary directory that {@link cleanupTrialHarnesses} removes. */
export const temporaryDirectory = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
};
