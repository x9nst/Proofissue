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
import { offlineInstallArguments, verifyPrepared } from '@proofissue/dependencies';
import { BoundedOutputCollector } from '@proofissue/process-output';

export const APPROVED_NODE_IMAGE =
  'node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6';
/**
 * Where the replayed command runs, and what its `import.meta.url` and `process.cwd()` show.
 * Output matching relies on these two names: a replayed program's own paths always start
 * with the workspace, and `os.tmpdir()` is the temporary directory because `TMPDIR` is unset.
 */
export const REPLAY_WORKSPACE_PATH = '/workspace';
/** The temporary directory of the replayed command (a size-limited in-memory filesystem). */
export const REPLAY_TEMPORARY_DIRECTORY = '/tmp';
export const WRITABLE_WORKSPACE_MB = 64;
/** Room for an installed dependency tree. In memory, so it counts against the memory limit. */
export const DEPENDENCY_WORKSPACE_MB = 256;
/**
 * The exit status the dependency bootstrap uses when setup or the offline install fails,
 * before the artifact's command has started. A replayed program that happens to exit with
 * this status is also reported as a failed install, which is the safe direction: it can only
 * turn a result into an execution failure, never into a match.
 */
export const DEPENDENCY_INSTALL_FAILED_EXIT_CODE = 199;

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
  /**
   * The prepared store for an artifact that carries dependency files. Required for such
   * artifacts and ignored for others. It is checked in full, read-only, before any container
   * is created, and is mounted into the container read-only.
   */
  readonly dependency_store?: string;
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
  | 'dependencies_not_prepared'
  | 'dependency_install_failed'
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
  readonly dependency_workspace_mb: number;
  readonly maximum_limits: ArtifactLimitsV1;
  readonly writable_workspace_mb: number;
}

export const DEFAULT_RUNNER_POLICY: RunnerPolicy = Object.freeze({
  approved_images: Object.freeze([APPROVED_NODE_IMAGE]),
  dependency_workspace_mb: DEPENDENCY_WORKSPACE_MB,
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
  withDependencies = false,
): EffectiveLimits => ({
  cpus: Math.min(requested.cpus, policy.maximum_limits.cpus),
  memory_mb: Math.min(requested.memory_mb, policy.maximum_limits.memory_mb),
  output_bytes_per_stream: Math.min(
    requested.output_bytes_per_stream,
    policy.maximum_limits.output_bytes_per_stream,
  ),
  processes: Math.min(requested.processes, policy.maximum_limits.processes),
  timeout_seconds: Math.min(requested.timeout_seconds, policy.maximum_limits.timeout_seconds),
  writable_workspace_mb: withDependencies
    ? policy.dependency_workspace_mb
    : policy.writable_workspace_mb,
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
  /** Host path of a verified prepared store, mounted read-only for the offline install. */
  readonly dependency_cache?: string;
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

// The container's init process exits with 128 + the signal that ended the replayed process.
// The engine can report that exit before it records the kernel's out-of-memory kill, so a
// process killed for memory may arrive with oom_killed false. A SIGKILL exit is therefore
// treated as resource termination: reporting it as an ordinary exit could classify a killed
// replay as a clean failure to reproduce.
const SIGKILL_EXIT_CODE = 137;

const CONTAINER_BOOTSTRAP = `cp -R /proofissue-input/. ${REPLAY_WORKSPACE_PATH}/ && cd ${REPLAY_WORKSPACE_PATH} && exec env -i PATH=/usr/local/bin:/usr/bin:/bin "$@"`;

const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';
const DEPENDENCY_CACHE_MOUNT = '/proofissue-cache';

// Reads the one error code npm printed, and nothing else. The output is npm's own but it
// names packages, so none of it is repeated in a message.
const NPM_ERROR_CODE = /^npm error code (E[A-Z0-9_]{2,30})$/mu;

const installFailureMessage = (setupOutput: string): string => {
  const code = NPM_ERROR_CODE.exec(setupOutput)?.[1];
  return code === undefined
    ? 'The locked packages could not be installed offline.'
    : `The locked packages could not be installed offline (npm error ${code}).`;
};

// Everything below is constant text, never artifact data, and is checked once so a later edit
// cannot slip a shell metacharacter into the script.
const INSTALL_ARGUMENTS = offlineInstallArguments({
  cache_directory: DEPENDENCY_CACHE_MOUNT,
  global_config: `${REPLAY_TEMPORARY_DIRECTORY}/npmrc-global`,
  logs_directory: `${REPLAY_TEMPORARY_DIRECTORY}/npm-logs`,
  user_config: `${REPLAY_TEMPORARY_DIRECTORY}/npmrc-user`,
});
if (!INSTALL_ARGUMENTS.every((item) => /^[A-Za-z0-9/_.=-]+$/u.test(item))) {
  throw new Error('The install arguments must be plain words.');
}

/**
 * Used instead of CONTAINER_BOOTSTRAP when an artifact has dependency files. It copies the
 * artifact's files, installs the locked packages from the read-only prepared store with no
 * network and no install scripts, and only then replaces itself with the artifact's command.
 *
 * Any failure before the command starts exits with DEPENDENCY_INSTALL_FAILED_EXIT_CODE, after
 * writing the tail of the setup log to stderr, so a failed install can never be mistaken for
 * the command failing. The log is npm's own output, so it is bounded to 4 KiB, and the runner
 * reads a single error code out of it and nothing else.
 */
const DEPENDENCY_BOOTSTRAP = [
  `fail() { tail -c 4096 ${REPLAY_TEMPORARY_DIRECTORY}/proofissue-setup.log >&2; exit ${String(DEPENDENCY_INSTALL_FAILED_EXIT_CODE)}; }`,
  `cp -R /proofissue-input/. ${REPLAY_WORKSPACE_PATH}/ >${REPLAY_TEMPORARY_DIRECTORY}/proofissue-setup.log 2>&1 || fail`,
  `cd ${REPLAY_WORKSPACE_PATH} || fail`,
  `: > ${REPLAY_TEMPORARY_DIRECTORY}/npmrc-user || fail`,
  `: > ${REPLAY_TEMPORARY_DIRECTORY}/npmrc-global || fail`,
  `mkdir ${REPLAY_TEMPORARY_DIRECTORY}/npm-logs || fail`,
  `env -i PATH=${SANDBOX_PATH} HOME=${REPLAY_TEMPORARY_DIRECTORY} npm ${INSTALL_ARGUMENTS.join(' ')} >>${REPLAY_TEMPORARY_DIRECTORY}/proofissue-setup.log 2>&1 || fail`,
  // npm can report success when extraction ran out of space, leaving a truncated package. A
  // workspace with under 1 MiB free after the install is treated as that, so the command
  // never runs against an incomplete tree.
  `df -P ${REPLAY_WORKSPACE_PATH} | awk 'NR==2 { exit ($4 < 1024) }' || { echo 'npm error code ENOSPC' >>${REPLAY_TEMPORARY_DIRECTORY}/proofissue-setup.log; fail; }`,
  `exec env -i PATH=${SANDBOX_PATH} "$@"`,
].join('\n');

const dockerCreateArguments = (spec: ContainerCreateSpec): readonly string[] => [
  'create',
  '--name',
  spec.name,
  '--label',
  'org.proofissue.replay=true',
  '--pull',
  'never',
  '--log-driver',
  'none',
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
  '--ulimit',
  'core=0:0',
  '--ulimit',
  'nofile=1024:1024',
  '--init',
  '--mount',
  `type=bind,src=${spec.input_path},dst=/proofissue-input,readonly`,
  ...(spec.dependency_cache === undefined
    ? []
    : ['--mount', `type=bind,src=${spec.dependency_cache},dst=${DEPENDENCY_CACHE_MOUNT},readonly`]),
  '--tmpfs',
  `${REPLAY_WORKSPACE_PATH}:rw,nosuid,nodev,noexec,size=${String(spec.limits.writable_workspace_mb * 1_048_576)},mode=1777`,
  '--tmpfs',
  `${REPLAY_TEMPORARY_DIRECTORY}:rw,nosuid,nodev,noexec,size=16777216,mode=1777`,
  '--workdir',
  REPLAY_WORKSPACE_PATH,
  '--entrypoint',
  '/bin/sh',
  spec.image,
  '-c',
  spec.dependency_cache === undefined ? CONTAINER_BOOTSTRAP : DEPENDENCY_BOOTSTRAP,
  '--',
  'node',
  ...spec.arguments,
];

const hasUnsafeMountCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x2c || code === 0x22 || code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

/**
 * The bind-mount source is interpolated into a comma-separated --mount value, so
 * a comma or quote in it could append or redirect mount options. The message
 * deliberately omits the rejected path.
 */
const assertSafeMountSource = (inputPath: string): void => {
  if (!path.isAbsolute(inputPath) || hasUnsafeMountCharacter(inputPath)) {
    throw new RunnerError(
      'policy_rejection',
      'The replay workspace location cannot be mounted safely.',
    );
  }
};

export const buildDockerCreateArguments = (spec: ContainerCreateSpec): readonly string[] => {
  assertSafeMountSource(spec.input_path);
  if (spec.dependency_cache !== undefined) assertSafeMountSource(spec.dependency_cache);
  return dockerCreateArguments(spec);
};

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
      const hasDependencies = request.artifact.files.some((file) => file.role === 'dependency');
      const effectiveLimits = calculateEffectiveLimits(
        request.artifact.limits,
        policy,
        hasDependencies,
      );
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
      // An artifact with dependency files cannot be replayed without them: the command would
      // run in the wrong environment and could be reported as a genuine non-reproduction. The
      // prepared store is therefore checked in full, read-only, before anything is created.
      let dependencyCache: string | undefined;
      if (hasDependencies) {
        const lockfile = request.artifact.files.find(
          (file) => file.role === 'dependency' && file.path === 'package-lock.json',
        );
        const refuse = (
          code: 'dependencies_not_prepared' | 'policy_rejection',
          message: string,
        ): RunnerError =>
          new RunnerError(code, message, { effective_limits: effectiveLimits, events });
        if (lockfile === undefined) {
          throw refuse('policy_rejection', 'The artifact has dependency files but no lockfile.');
        }
        if (request.dependency_store === undefined) {
          throw refuse(
            'dependencies_not_prepared',
            'This artifact needs its dependencies prepared first, and no prepared store was given.',
          );
        }
        const verification = await verifyPrepared(lockfile.content, request.dependency_store);
        if (verification.status === 'invalid_lockfile') {
          throw refuse('policy_rejection', 'The artifact lockfile cannot be used for replay.');
        }
        if (verification.status === 'store_unusable') {
          throw refuse('dependencies_not_prepared', verification.message);
        }
        if (verification.status === 'not_prepared') {
          throw refuse(
            'dependencies_not_prepared',
            verification.missing_count === 1
              ? '1 locked package is missing from the prepared store or does not match its hash.'
              : `${String(verification.missing_count)} locked packages are missing from the prepared store or do not match their hashes.`,
          );
        }
        dependencyCache = verification.cache_directory;
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
          ...(dependencyCache === undefined ? {} : { dependency_cache: dependencyCache }),
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
          const resourceTerminated =
            outcome.state.oom_killed || outcome.state.exit_code === SIGKILL_EXIT_CODE;
          execution = {
            duration_ms: Math.max(0, Math.round(performance.now() - executionStartedAt)),
            ...(outcome.state.exit_code === undefined
              ? {}
              : { exit_code: outcome.state.exit_code }),
            ...(outcome.state.signal === undefined ? {} : { signal: outcome.state.signal }),
            stdout: stdout.finish(),
            stderr: stderr.finish(),
            termination_reason: resourceTerminated ? 'resource_limit' : 'exited',
          };
          if (resourceTerminated) {
            primaryError = new RunnerError(
              'resource_termination',
              'Replay was terminated by an enforced resource limit.',
            );
          } else if (
            dependencyCache !== undefined &&
            outcome.state.exit_code === DEPENDENCY_INSTALL_FAILED_EXIT_CODE
          ) {
            primaryError = new RunnerError(
              'dependency_install_failed',
              installFailureMessage(execution.stderr.decoded_text),
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
