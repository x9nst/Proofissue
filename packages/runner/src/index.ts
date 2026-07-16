import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { ARTIFACT_LIMITS, resolveArtifactPath, sha256 } from '@proofissue/artifact-schema';
import type {
  ArtifactFileV1,
  ArtifactLimitsV1,
  ValidatedArtifactV1,
} from '@proofissue/artifact-schema';
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
  | 'unsafe_checkout_file'
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
  create(
    artifact: ValidatedArtifactV1,
    subjectReplacements?: ReadonlyMap<string, string>,
  ): Promise<string>;
  remove(root: string): Promise<void>;
}

export const createReplayWorkspace = (): ReplayWorkspace => ({
  create: async (artifact, subjectReplacements = new Map()) => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-replay-'));
    try {
      await chmod(root, 0o755);
      for (const file of artifact.files) {
        const replacement = subjectReplacements.get(file.path);
        if (replacement !== undefined && file.role !== 'subject') {
          throw new RunnerError(
            'unsafe_checkout_file',
            'A reproduction file cannot be replaced during current-checkout replay.',
          );
        }
        const target = resolveArtifactPath(root, file.path);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, replacement ?? file.content, {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o444,
        });
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

export interface SubjectReplacement {
  readonly content: string;
  readonly path: string;
  readonly sha256: string;
}

export interface CurrentCheckoutReader {
  read(
    checkoutRoot: string,
    subjectFiles: readonly ArtifactFileV1[],
  ): Promise<readonly SubjectReplacement[]>;
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const unsafeCheckout = (message: string): RunnerError =>
  new RunnerError('unsafe_checkout_file', message);

const prepareCheckoutRoot = async (requestedRoot: string): Promise<string> => {
  const absolute = path.resolve(requestedRoot);
  let rootStat;
  try {
    rootStat = await lstat(absolute);
  } catch (error: unknown) {
    throw unsafeCheckout(
      isMissing(error)
        ? 'The selected current checkout does not exist.'
        : 'The selected current checkout could not be inspected safely.',
    );
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw unsafeCheckout('The selected current checkout must be a directory, not a symbolic link.');
  }
  try {
    return await realpath(absolute);
  } catch {
    throw unsafeCheckout('The selected current checkout could not be resolved safely.');
  }
};

const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const assertSafeCheckoutPath = async (root: string, artifactPath: string): Promise<string> => {
  let current = root;
  const segments = artifactPath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw unsafeCheckout('A declared subject path is invalid.');
    current = path.join(current, segment);
    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch (error: unknown) {
      throw unsafeCheckout(
        isMissing(error)
          ? `Declared subject file is missing from the current checkout: ${artifactPath}`
          : `Declared subject file could not be inspected safely: ${artifactPath}`,
      );
    }
    if (currentStat.isSymbolicLink()) {
      throw unsafeCheckout(`Declared subject paths cannot contain symbolic links: ${artifactPath}`);
    }
    const isLast = index === segments.length - 1;
    if ((!isLast && !currentStat.isDirectory()) || (isLast && !currentStat.isFile())) {
      throw unsafeCheckout(
        `Declared subject path is not the same regular-file type: ${artifactPath}`,
      );
    }
  }
  return current;
};

const readSubjectReplacement = async (
  root: string,
  subjectFile: ArtifactFileV1,
): Promise<SubjectReplacement> => {
  const absolute = await assertSafeCheckoutPath(root, subjectFile.path);
  const initialStat = await lstat(absolute);
  if (initialStat.size > ARTIFACT_LIMITS.scalar_bytes) {
    throw unsafeCheckout(
      `Declared subject file exceeds the replacement byte limit: ${subjectFile.path}`,
    );
  }

  let handle;
  try {
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(absolute, constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    const resolved = await realpath(absolute);
    if (
      !isWithinRoot(root, resolved) ||
      !openedStat.isFile() ||
      openedStat.size !== initialStat.size ||
      openedStat.dev !== initialStat.dev ||
      openedStat.ino !== initialStat.ino ||
      openedStat.size > ARTIFACT_LIMITS.scalar_bytes
    ) {
      throw unsafeCheckout(
        `Declared subject file changed or escaped while opening: ${subjectFile.path}`,
      );
    }

    const buffer = Buffer.alloc(openedStat.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== openedStat.size) {
      throw unsafeCheckout(`Declared subject file changed while reading: ${subjectFile.path}`);
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw unsafeCheckout(`Declared subject file is not valid UTF-8: ${subjectFile.path}`);
    }
    return { content, path: subjectFile.path, sha256: sha256(content) };
  } catch (error: unknown) {
    if (error instanceof RunnerError) throw error;
    throw unsafeCheckout(`Declared subject file could not be read safely: ${subjectFile.path}`);
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export const createCurrentCheckoutReader = (): CurrentCheckoutReader => ({
  read: async (checkoutRoot, subjectFiles) => {
    const root = await prepareCheckoutRoot(checkoutRoot);
    const replacements: SubjectReplacement[] = [];
    let totalBytes = 0;
    for (const subjectFile of subjectFiles) {
      if (subjectFile.role !== 'subject') {
        throw unsafeCheckout('Only declared subject files may be read from the current checkout.');
      }
      const replacement = await readSubjectReplacement(root, subjectFile);
      totalBytes += Buffer.byteLength(replacement.content, 'utf8');
      if (totalBytes > ARTIFACT_LIMITS.total_file_content_bytes) {
        throw unsafeCheckout('Current-checkout subject files exceed the aggregate content limit.');
      }
      replacements.push(replacement);
    }
    return replacements;
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
  readonly checkout?: CurrentCheckoutReader;
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
  const checkout = options.checkout ?? createCurrentCheckoutReader();
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
      if (request.mode === 'current_checkout' && request.against_path === undefined) {
        throw new RunnerError(
          'policy_rejection',
          'Current-checkout replay requires an explicitly selected checkout directory.',
          { effective_limits: effectiveLimits, events },
        );
      }
      if (request.mode === 'snapshot' && request.against_path !== undefined) {
        throw new RunnerError(
          'policy_rejection',
          'Snapshot replay cannot read from a current checkout.',
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
      let subjectReplacements: readonly SubjectReplacement[] = [];
      const stdout = new BoundedOutputCollector(effectiveLimits.output_bytes_per_stream);
      const stderr = new BoundedOutputCollector(effectiveLimits.output_bytes_per_stream);
      const executionStartedAt = performance.now();

      try {
        if (request.mode === 'current_checkout') {
          const checkoutPath = request.against_path;
          if (checkoutPath === undefined) {
            throw new RunnerError(
              'policy_rejection',
              'Current-checkout replay requires an explicitly selected checkout directory.',
            );
          }
          subjectReplacements = await checkout.read(
            checkoutPath,
            request.artifact.files.filter((file) => file.role === 'subject'),
          );
        }
        const replacementsByPath = new Map(
          subjectReplacements.map((replacement) => [replacement.path, replacement.content]),
        );
        const reconstructedBytes = request.artifact.files.reduce(
          (total, file) =>
            total + Buffer.byteLength(replacementsByPath.get(file.path) ?? file.content, 'utf8'),
          0,
        );
        if (reconstructedBytes > ARTIFACT_LIMITS.total_file_content_bytes) {
          throw unsafeCheckout('The reconstructed current-checkout workspace exceeds file limits.');
        }
        root = await workspace.create(request.artifact, replacementsByPath);
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
        substituted_paths: subjectReplacements.map((replacement) => replacement.path),
      };
    },
  };
};
