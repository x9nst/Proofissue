import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { resolveArtifactPath } from '@proofissue/artifact-schema';
import type { ArtifactLimitsV1, ValidatedArtifactV1 } from '@proofissue/artifact-schema';
import type {
  BoundedExecutionResult,
  CleanupSummary,
  EffectiveLimits,
  ProofIssueErrorCode,
} from '@proofissue/contracts';
import { BoundedOutputCollector } from '@proofissue/process-output';

export const APPROVED_NODE_IMAGE =
  'node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6';
export const WRITABLE_WORKSPACE_MB = 64;

export type ReplayEventType =
  | 'policy_checked'
  | 'workspace_created'
  | 'container_created'
  | 'container_started'
  | 'container_exited'
  | 'timeout_enforced'
  | 'cleanup_completed';

export interface ReplayExecutionEvent {
  readonly type: ReplayEventType;
  readonly elapsed_ms: number;
}

export interface ReplayRequest {
  readonly artifact: ValidatedArtifactV1;
  readonly against_path?: string;
  readonly mode: 'snapshot' | 'current_checkout';
  readonly signal?: AbortSignal;
}

export interface RunnerResult {
  readonly cleanup: CleanupSummary;
  readonly effective_limits: EffectiveLimits;
  readonly events: readonly ReplayExecutionEvent[];
  readonly execution: BoundedExecutionResult;
  readonly substituted_paths: readonly string[];
}

export interface Runner {
  run(request: ReplayRequest): Promise<RunnerResult>;
}

export type RunnerErrorCode = Extract<
  ProofIssueErrorCode,
  | 'cleanup_failed'
  | 'container_creation_failed'
  | 'engine_capability_unavailable'
  | 'engine_unavailable'
  | 'image_unavailable'
  | 'internal_error'
  | 'policy_rejection'
  | 'resource_termination'
  | 'timeout'
>;

interface RunnerErrorDetails {
  readonly cleanup?: CleanupSummary;
  readonly effective_limits?: EffectiveLimits;
  readonly events?: readonly ReplayExecutionEvent[];
  readonly execution?: BoundedExecutionResult;
}

export class RunnerError extends Error {
  readonly cleanup?: CleanupSummary;
  readonly code: RunnerErrorCode;
  readonly effective_limits?: EffectiveLimits;
  readonly events: readonly ReplayExecutionEvent[];
  readonly execution?: BoundedExecutionResult;

  constructor(code: RunnerErrorCode, message: string, details: RunnerErrorDetails = {}) {
    super(message);
    this.name = 'RunnerError';
    this.code = code;
    this.events = details.events ?? [];
    if (details.cleanup !== undefined) this.cleanup = details.cleanup;
    if (details.effective_limits !== undefined) this.effective_limits = details.effective_limits;
    if (details.execution !== undefined) this.execution = details.execution;
  }
}

export interface RunnerPolicy {
  readonly approved_images: readonly string[];
  readonly maximum_limits: ArtifactLimitsV1;
  readonly writable_workspace_mb: number;
}

export const DEFAULT_RUNNER_POLICY: RunnerPolicy = Object.freeze({
  approved_images: Object.freeze([APPROVED_NODE_IMAGE]),
  maximum_limits: Object.freeze({
    timeout_seconds: 300,
    memory_mb: 2048,
    cpus: 2,
    processes: 256,
    output_bytes_per_stream: 1_048_576,
  }),
  writable_workspace_mb: WRITABLE_WORKSPACE_MB,
});

export const calculateEffectiveLimits = (
  requested: ArtifactLimitsV1,
  policy: RunnerPolicy = DEFAULT_RUNNER_POLICY,
): EffectiveLimits => ({
  cpus: Math.min(requested.cpus, policy.maximum_limits.cpus),
  memory_mb: Math.min(requested.memory_mb, policy.maximum_limits.memory_mb),
  output_bytes_per_stream: Math.min(
    requested.output_bytes_per_stream,
    policy.maximum_limits.output_bytes_per_stream,
  ),
  processes: Math.min(requested.processes, policy.maximum_limits.processes),
  timeout_seconds: Math.min(requested.timeout_seconds, policy.maximum_limits.timeout_seconds),
  writable_workspace_mb: policy.writable_workspace_mb,
});

export interface ReplayWorkspace {
  create(artifact: ValidatedArtifactV1): Promise<string>;
  remove(root: string): Promise<void>;
}

export const createReplayWorkspace = (): ReplayWorkspace => ({
  create: async (artifact) => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-replay-'));
    try {
      await chmod(root, 0o755);
      for (const file of artifact.files) {
        const target = resolveArtifactPath(root, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, file.content, { encoding: 'utf8', flag: 'wx', mode: 0o444 });
      }
      return root;
    } catch (error: unknown) {
      await rm(root, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
  },
  remove: async (root) => {
    await rm(root, { force: true, maxRetries: 2, recursive: true, retryDelay: 50 });
  },
});

export interface ContainerCreateSpec {
  readonly arguments: readonly string[];
  readonly image: string;
  readonly input_path: string;
  readonly limits: EffectiveLimits;
  readonly name: string;
}

export interface ContainerState {
  readonly exit_code?: number;
  readonly oom_killed: boolean;
  readonly signal?: string;
}

export interface ContainerEngine {
  assertCapabilities(): Promise<void>;
  imageExists(image: string): Promise<boolean>;
  create(spec: ContainerCreateSpec): Promise<void>;
  start(
    name: string,
    onStdout: (chunk: Uint8Array) => void,
    onStderr: (chunk: Uint8Array) => void,
  ): Promise<ContainerState>;
  stop(name: string): Promise<void>;
  kill(name: string): Promise<void>;
  remove(name: string): Promise<void>;
}

const CONTAINER_BOOTSTRAP =
  'cp -R /proofissue-input/. /workspace/ && cd /workspace && exec env -i PATH=/usr/local/bin:/usr/bin:/bin "$@"';

export const buildDockerCreateArguments = (spec: ContainerCreateSpec): readonly string[] => [
  'create',
  '--name',
  spec.name,
  '--label',
  'org.proofissue.replay=true',
  '--network',
  'none',
  '--user',
  '65532:65532',
  '--read-only',
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges:true',
  '--pids-limit',
  String(spec.limits.processes + 1),
  '--memory',
  `${String(spec.limits.memory_mb)}m`,
  '--memory-swap',
  `${String(spec.limits.memory_mb)}m`,
  '--cpus',
  String(spec.limits.cpus),
  '--init',
  '--mount',
  `type=bind,src=${spec.input_path},dst=/proofissue-input,readonly`,
  '--tmpfs',
  `/workspace:rw,nosuid,nodev,noexec,size=${String(spec.limits.writable_workspace_mb * 1_048_576)},mode=1777`,
  '--tmpfs',
  '/tmp:rw,nosuid,nodev,noexec,size=16777216,mode=1777',
  '--workdir',
  '/workspace',
  '--entrypoint',
  '/bin/sh',
  spec.image,
  '-c',
  CONTAINER_BOOTSTRAP,
  '--',
  'node',
  ...spec.arguments,
];

interface DockerCommandResult {
  readonly exit_code: number;
  readonly stderr: string;
  readonly stdout: string;
}

const runDocker = async (arguments_: readonly string[]): Promise<DockerCommandResult> =>
  await new Promise((resolve, reject) => {
    const child = spawn('docker', [...arguments_], {
      env: {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = new BoundedOutputCollector(32_768);
    const stderr = new BoundedOutputCollector(32_768);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.add(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.add(chunk);
    });
    child.once('error', () => {
      reject(new RunnerError('engine_unavailable', 'Docker is unavailable.'));
    });
    child.once('close', (code) => {
      resolve({
        exit_code: code ?? 125,
        stdout: stdout.finish().decoded_text,
        stderr: stderr.finish().decoded_text,
      });
    });
  });

const dockerFailure = (result: DockerCommandResult, message: string): never => {
  if (result.exit_code !== 0) throw new Error(message);
  throw new Error('Unexpected Docker command state.');
};

const parseJson = (value: string, message: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new RunnerError('engine_capability_unavailable', message);
  }
};

export const createDockerEngine = (): ContainerEngine => ({
  assertCapabilities: async () => {
    if (process.platform !== 'linux' || process.arch !== 'x64') {
      throw new RunnerError(
        'engine_capability_unavailable',
        'Replay currently requires a local x86-64 Linux host with Docker Engine.',
      );
    }
    const context = await runDocker([
      'context',
      'inspect',
      '--format',
      '{{json .Endpoints.docker.Host}}',
    ]);
    if (context.exit_code !== 0) {
      throw new RunnerError(
        'engine_unavailable',
        'The local Docker context could not be inspected.',
      );
    }
    const endpoint = parseJson(context.stdout.trim(), 'Docker returned an invalid context.');
    if (typeof endpoint !== 'string' || !endpoint.startsWith('unix://')) {
      throw new RunnerError(
        'engine_capability_unavailable',
        'Remote Docker contexts are not supported for replay.',
      );
    }
    const version = await runDocker(['version', '--format', '{{json .Server}}']);
    if (version.exit_code !== 0 || version.stdout.trim() === 'null') {
      throw new RunnerError('engine_unavailable', 'The Docker Engine is not running.');
    }
    const server = parseJson(
      version.stdout.trim(),
      'Docker returned invalid server information.',
    ) as { Arch?: string; Os?: string; Version?: string };
    const major = Number.parseInt(server.Version?.split('.')[0] ?? '', 10);
    if (
      server.Os !== 'linux' ||
      server.Arch !== 'amd64' ||
      !Number.isInteger(major) ||
      major < 27
    ) {
      throw new RunnerError(
        'engine_capability_unavailable',
        'Replay requires Docker Engine 27 or newer running Linux amd64 containers.',
      );
    }
    const info = await runDocker(['info', '--format', '{{json .SecurityOptions}}']);
    if (info.exit_code !== 0 || !info.stdout.includes('seccomp')) {
      throw new RunnerError(
        'engine_capability_unavailable',
        'Docker must provide its default seccomp security profile.',
      );
    }
  },
  imageExists: async (image) => {
    const result = await runDocker([
      'image',
      'inspect',
      '--format',
      '{{json .RepoDigests}}',
      image,
    ]);
    return result.exit_code === 0;
  },
  create: async (spec) => {
    const result = await runDocker(buildDockerCreateArguments(spec));
    if (result.exit_code !== 0) dockerFailure(result, 'The replay container could not be created.');
  },
  start: async (name, onStdout, onStderr) =>
    await new Promise((resolve, reject) => {
      const child = spawn('docker', ['start', '--attach', name], {
        env: {},
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (chunk: Buffer) => {
        onStdout(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        onStderr(chunk);
      });
      child.once('error', () => {
        reject(new Error('The replay container could not start.'));
      });
      child.once('close', () => {
        void runDocker(['inspect', '--format', '{{json .State}}', name])
          .then((inspected) => {
            if (inspected.exit_code !== 0)
              dockerFailure(inspected, 'The replay container result could not be inspected.');
            const state = parseJson(
              inspected.stdout.trim(),
              'Docker returned an invalid container result.',
            ) as {
              Error?: string;
              ExitCode?: number;
              OOMKilled?: boolean;
            };
            if ((state.Error ?? '') !== '')
              throw new Error('The replay process could not execute.');
            resolve({
              ...(state.ExitCode === undefined ? {} : { exit_code: state.ExitCode }),
              oom_killed: state.OOMKilled === true,
            });
          })
          .catch((error: unknown) => {
            reject(error instanceof Error ? error : new Error('Docker result inspection failed.'));
          });
      });
    }),
  stop: async (name) => {
    const result = await runDocker(['stop', '--time', '1', name]);
    if (result.exit_code !== 0) dockerFailure(result, 'The replay container could not be stopped.');
  },
  kill: async (name) => {
    const result = await runDocker(['kill', name]);
    if (result.exit_code !== 0) dockerFailure(result, 'The replay container could not be killed.');
  },
  remove: async (name) => {
    const result = await runDocker(['rm', '--force', name]);
    if (result.exit_code !== 0 && !result.stderr.includes('No such container'))
      dockerFailure(result, 'The replay container could not be removed.');
  },
});

export interface DockerRunnerOptions {
  readonly engine?: ContainerEngine;
  readonly policy?: RunnerPolicy;
  readonly workspace?: ReplayWorkspace;
}

const safeCleanup = async (
  engine: ContainerEngine,
  workspace: ReplayWorkspace,
  name: string,
  root: string | undefined,
  containerAttempted: boolean,
  needsTermination: boolean,
): Promise<CleanupSummary> => {
  const attempted = new Set<string>();
  const residual = new Set<string>();
  let failed = false;

  if (containerAttempted) {
    attempted.add('container');
    if (needsTermination) {
      try {
        await engine.stop(name);
      } catch {
        failed = true;
        try {
          await engine.kill(name);
        } catch {
          failed = true;
        }
      }
    }
    try {
      await engine.remove(name);
    } catch {
      failed = true;
      residual.add('container');
    }
  }
  if (root !== undefined) {
    attempted.add('workspace');
    try {
      await workspace.remove(root);
    } catch {
      failed = true;
      residual.add('workspace');
    }
  }
  return {
    completed: !failed && residual.size === 0,
    attempted_resources: [...attempted],
    residual_resources: [...residual],
  };
};

export const createDockerRunner = (options: DockerRunnerOptions = {}): Runner => {
  const engine = options.engine ?? createDockerEngine();
  const policy = options.policy ?? DEFAULT_RUNNER_POLICY;
  const workspace = options.workspace ?? createReplayWorkspace();

  return {
    run: async (request) => {
      const startedAt = performance.now();
      const events: ReplayExecutionEvent[] = [];
      const event = (type: ReplayEventType): void => {
        events.push({ type, elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)) });
      };
      const effectiveLimits = calculateEffectiveLimits(request.artifact.limits, policy);
      const image = request.artifact.environment.image;
      if (request.mode !== 'snapshot') {
        throw new RunnerError(
          'policy_rejection',
          'Current-checkout replay is introduced in Milestone 5; use snapshot replay for now.',
          { effective_limits: effectiveLimits, events },
        );
      }
      if (!policy.approved_images.includes(image)) {
        throw new RunnerError('policy_rejection', 'The requested replay image is not approved.', {
          effective_limits: effectiveLimits,
          events,
        });
      }
      await engine.assertCapabilities();
      if (!(await engine.imageExists(image))) {
        throw new RunnerError(
          'image_unavailable',
          'The approved replay image is not available locally; replay never pulls images automatically.',
          { effective_limits: effectiveLimits, events },
        );
      }
      event('policy_checked');

      const name = `proofissue-${randomBytes(8).toString('hex')}`;
      let root: string | undefined;
      let containerAttempted = false;
      let needsTermination = false;
      let primaryError: RunnerError | undefined;
      let execution: BoundedExecutionResult | undefined;
      const stdout = new BoundedOutputCollector(effectiveLimits.output_bytes_per_stream);
      const stderr = new BoundedOutputCollector(effectiveLimits.output_bytes_per_stream);
      const executionStartedAt = performance.now();

      try {
        root = await workspace.create(request.artifact);
        event('workspace_created');
        containerAttempted = true;
        await engine.create({
          arguments: request.artifact.command.arguments,
          image,
          input_path: root,
          limits: effectiveLimits,
          name,
        });
        event('container_created');
        needsTermination = true;
        const startPromise = engine.start(
          name,
          (chunk) => {
            stdout.add(chunk);
          },
          (chunk) => {
            stderr.add(chunk);
          },
        );
        event('container_started');

        let timer: ReturnType<typeof setTimeout> | undefined;
        let abortListener: (() => void) | undefined;
        const interrupted = new Promise<'interrupted' | 'timeout'>((resolve) => {
          timer = setTimeout(() => {
            resolve('timeout');
          }, effectiveLimits.timeout_seconds * 1000);
          timer.unref();
          if (request.signal !== undefined) {
            abortListener = () => {
              resolve('interrupted');
            };
            if (request.signal.aborted) abortListener();
            else request.signal.addEventListener('abort', abortListener, { once: true });
          }
        });
        const outcome = await Promise.race([
          startPromise.then((state) => ({ kind: 'state' as const, state })),
          interrupted.then((kind) => ({ kind })),
        ]);
        if (timer !== undefined) clearTimeout(timer);
        if (abortListener !== undefined)
          request.signal?.removeEventListener('abort', abortListener);

        if (outcome.kind !== 'state') {
          event('timeout_enforced');
          primaryError = new RunnerError(
            'timeout',
            outcome.kind === 'timeout'
              ? 'Replay exceeded its wall-clock limit.'
              : 'Replay was interrupted before it completed.',
          );
        } else {
          needsTermination = false;
          event('container_exited');
          execution = {
            duration_ms: Math.max(0, Math.round(performance.now() - executionStartedAt)),
            ...(outcome.state.exit_code === undefined
              ? {}
              : { exit_code: outcome.state.exit_code }),
            ...(outcome.state.signal === undefined ? {} : { signal: outcome.state.signal }),
            stdout: stdout.finish(),
            stderr: stderr.finish(),
            termination_reason: outcome.state.oom_killed ? 'resource_limit' : 'exited',
          };
          if (outcome.state.oom_killed) {
            primaryError = new RunnerError(
              'resource_termination',
              'Replay was terminated by an enforced resource limit.',
            );
          }
        }
      } catch (error: unknown) {
        primaryError =
          error instanceof RunnerError
            ? error
            : new RunnerError(
                containerAttempted ? 'container_creation_failed' : 'internal_error',
                containerAttempted
                  ? 'The replay container could not complete safely.'
                  : 'The replay workspace could not be prepared safely.',
              );
      }

      if (primaryError?.code === 'timeout' && execution === undefined) {
        execution = {
          duration_ms: Math.max(0, Math.round(performance.now() - executionStartedAt)),
          stdout: stdout.finish(),
          stderr: stderr.finish(),
          termination_reason: 'timeout',
        };
      }
      const cleanup = await safeCleanup(
        engine,
        workspace,
        name,
        root,
        containerAttempted,
        needsTermination,
      );
      event('cleanup_completed');

      if (primaryError !== undefined || !cleanup.completed) {
        const error =
          primaryError ??
          new RunnerError('cleanup_failed', 'Replay cleanup did not complete successfully.');
        throw new RunnerError(error.code, error.message, {
          cleanup,
          effective_limits: effectiveLimits,
          events,
          ...(execution === undefined ? {} : { execution }),
        });
      }
      if (execution === undefined) {
        throw new RunnerError('internal_error', 'Replay produced no execution result.', {
          cleanup,
          effective_limits: effectiveLimits,
          events,
        });
      }
      return {
        cleanup,
        effective_limits: effectiveLimits,
        events,
        execution,
        substituted_paths: [],
      };
    },
  };
};
