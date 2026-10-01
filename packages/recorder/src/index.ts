import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import {
  ARTIFACT_LIMITS,
  isArtifactPath,
  sha256,
  validateArtifactValue,
} from '@proofissue/artifact-schema';
import type {
  ArtifactFileRoleV1,
  ArtifactFileV1,
  ArtifactLimitsV1,
  ArtifactRedactionFindingV1,
  ArtifactV1,
} from '@proofissue/artifact-schema';
import type { BoundedStreamCapture } from '@proofissue/contracts';
import { validateNpmLockfile } from '@proofissue/dependencies';
import type { OutputPathContext } from '@proofissue/output-rules';
import { BoundedOutputCollector } from '@proofissue/process-output';
import { createRedactor, RedactionLimitError } from '@proofissue/redactor';
import type { Redactor } from '@proofissue/redactor';

import { RecorderError } from './errors.js';
import {
  createRecordPathContexts,
  deriveOutputExpectations,
  requestedLiterals,
  validateExpectationRequest,
} from './expectations.js';
import type { RecordOutputExpectation } from './expectations.js';

export { RecorderError } from './errors.js';
export type { RecorderErrorCode } from './errors.js';
export type { RecordOutputExpectation } from './expectations.js';

export const DEFAULT_RECORD_LIMITS: ArtifactLimitsV1 = Object.freeze({
  timeout_seconds: 60,
  memory_mb: 512,
  cpus: 1,
  processes: 64,
  output_bytes_per_stream: 1_048_576,
});

export interface RecordRequest {
  readonly arguments: readonly string[];
  readonly environment_image: string;
  /** Output expectations; a plain string is a raw literal, as before. */
  readonly expect_stderr: readonly RecordOutputExpectation[];
  readonly expect_stdout: readonly RecordOutputExpectation[];
  /**
   * Also record `package.json` and `package-lock.json` from the project root, so replay can
   * later install exactly the locked packages. Off unless asked for: nothing beyond the
   * selected files is collected by default.
   */
  readonly include_dependencies?: boolean;
  readonly limits?: ArtifactLimitsV1;
  readonly program: 'node';
  readonly project_root: string;
  readonly reproduction_paths: readonly string[];
  readonly subject_paths: readonly string[];
}

export interface DependencySummary {
  readonly install_script_packages: number;
  readonly package_count: number;
}

export interface RecordCapture {
  readonly artifact: ArtifactV1;
  /** Present only when dependency files were recorded. */
  readonly dependencies?: DependencySummary;
  readonly duration_ms: number;
  /**
   * The directories the recording's output was normalized with. This holds host paths: it must
   * never be serialized, logged, previewed, or placed in a result. The application uses it to
   * check that the recording satisfies its own expectations.
   */
  readonly path_context: OutputPathContext;
  readonly stderr: BoundedStreamCapture;
  readonly stdout: BoundedStreamCapture;
}

export interface Recorder {
  capture(request: RecordRequest): Promise<RecordCapture>;
}

const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const prepareProjectRoot = async (requestedRoot: string): Promise<string> => {
  const absolute = path.resolve(requestedRoot);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error: unknown) {
    throw new RecorderError(
      'unsafe_project',
      isMissing(error)
        ? 'Selected project does not exist.'
        : 'Selected project could not be inspected.',
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RecorderError(
      'unsafe_project',
      'Selected project must be a directory, not a symbolic link.',
    );
  }
  try {
    return await realpath(absolute);
  } catch {
    throw new RecorderError('unsafe_project', 'Selected project could not be resolved safely.');
  }
};

// Intermediate directories are not protected by O_NOFOLLOW, so the final location is
// resolved after the file is open and must still be inside the project root. This mirrors
// the check the runner applies to current-checkout files.
const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const assertSafePathComponents = async (root: string, artifactPath: string): Promise<string> => {
  let current = root;
  const segments = artifactPath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new RecorderError('unsafe_file', 'Selected path is invalid.');
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error: unknown) {
      throw new RecorderError(
        'unsafe_file',
        isMissing(error)
          ? `Selected file does not exist: ${artifactPath}`
          : `Selected file could not be inspected: ${artifactPath}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new RecorderError('unsafe_file', `Symbolic links are not collected: ${artifactPath}`);
    }
    const isLast = index === segments.length - 1;
    if ((!isLast && !stat.isDirectory()) || (isLast && !stat.isFile())) {
      throw new RecorderError(
        'unsafe_file',
        `Selected path must resolve to one regular file: ${artifactPath}`,
      );
    }
  }
  return current;
};

const readSelectedFile = async (
  root: string,
  artifactPath: string,
  role: ArtifactFileRoleV1,
): Promise<ArtifactFileV1> => {
  if (!isArtifactPath(artifactPath)) {
    throw new RecorderError(
      'unsafe_file',
      `Selected path is not a portable project-relative file path: ${artifactPath}`,
    );
  }
  const absolute = await assertSafePathComponents(root, artifactPath);
  const initialStat = await lstat(absolute);
  if (initialStat.size > ARTIFACT_LIMITS.scalar_bytes) {
    throw new RecorderError(
      'unsafe_file',
      `Selected file exceeds the ${String(ARTIFACT_LIMITS.scalar_bytes)} byte limit: ${artifactPath}`,
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
      throw new RecorderError(
        'unsafe_file',
        `Selected file changed or escaped the project while opening: ${artifactPath}`,
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
      throw new RecorderError(
        'unsafe_file',
        `Selected file changed while reading: ${artifactPath}`,
      );
    }
    const bytes = buffer.subarray(0, offset);
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new RecorderError('invalid_utf8', `Selected file is not valid UTF-8: ${artifactPath}`);
    }
    return { path: artifactPath, role, encoding: 'utf8', content, sha256: sha256(content) };
  } catch (error: unknown) {
    if (error instanceof RecorderError) throw error;
    throw new RecorderError(
      'unsafe_file',
      `Selected file could not be read safely: ${artifactPath}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

const minimalChildEnvironment = (): NodeJS.ProcessEnv => {
  if (process.platform !== 'win32') return {};
  const systemRoot = process.env.SystemRoot;
  return systemRoot === undefined ? {} : { SystemRoot: systemRoot };
};

const terminateProcessTree = async (pid: number): Promise<void> => {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        return;
      }
    }
    return;
  }

  const systemRoot = process.env.SystemRoot;
  const taskkill =
    systemRoot === undefined ? 'taskkill.exe' : path.join(systemRoot, 'System32', 'taskkill.exe');
  await new Promise<void>((resolve) => {
    const killer = spawn(taskkill, ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    killer.once('error', () => {
      resolve();
    });
    killer.once('close', () => {
      resolve();
    });
  });
};

interface CommandCapture {
  readonly duration_ms: number;
  readonly exit_code: number;
  readonly stderr: BoundedStreamCapture;
  readonly stdout: BoundedStreamCapture;
}

const executeCommand = async (
  root: string,
  arguments_: readonly string[],
  limits: ArtifactLimitsV1,
): Promise<CommandCapture> => {
  const stdout = new BoundedOutputCollector(limits.output_bytes_per_stream);
  const stderr = new BoundedOutputCollector(limits.output_bytes_per_stream);
  const started = performance.now();

  return await new Promise<CommandCapture>((resolve, reject) => {
    const child = spawn(process.execPath, [...arguments_], {
      cwd: root,
      detached: process.platform !== 'win32',
      env: minimalChildEnvironment(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    child.stdout.on('data', (chunk: Buffer) => {
      stdout.add(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr.add(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32') child.kill('SIGKILL');
      if (child.pid !== undefined) void terminateProcessTree(child.pid);
    }, limits.timeout_seconds * 1000);
    timer.unref();

    child.once('error', () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(
        new RecorderError('command_failed', 'The authorized Node.js command could not start.'),
      );
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (timedOut) {
        reject(
          new RecorderError('timeout', 'The authorized Node.js command exceeded its time limit.'),
        );
        return;
      }
      if (exitCode === null || signal !== null || exitCode < 0 || exitCode > 255) {
        reject(
          new RecorderError(
            'command_failed',
            'The authorized Node.js command did not return a usable exit code.',
          ),
        );
        return;
      }
      resolve({
        duration_ms: Math.max(0, Math.round(performance.now() - started)),
        exit_code: exitCode,
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      });
    });
  });
};

const DEPENDENCY_PATHS: readonly string[] = ['package.json', 'package-lock.json'];

// A reporter's own file, but its text still reaches a terminal, so escape it and bound it.
const describeDependencyErrors = (
  errors: readonly { readonly code: string; readonly package_path?: string }[],
): string => {
  const shown = errors.slice(0, 3).map((error) => {
    const where =
      error.package_path === undefined
        ? ''
        : ` at ${JSON.stringify(error.package_path.slice(0, 80))}`;
    return `${error.code}${where}`;
  });
  const more =
    errors.length > shown.length ? `; and ${String(errors.length - shown.length)} more` : '';
  return `${shown.join('; ')}${more}`;
};

/**
 * Checks the dependency files before the command runs, so an unsupported lockfile fails
 * fast and nothing is executed for a recording that cannot be used.
 */
const summarizeDependencies = (files: readonly ArtifactFileV1[]): DependencySummary => {
  const manifest = files.find((file) => file.path === 'package.json');
  const lockfile = files.find((file) => file.path === 'package-lock.json');
  if (manifest === undefined || lockfile === undefined) {
    throw new RecorderError(
      'invalid_request',
      'Dependency capture needs package.json and package-lock.json.',
    );
  }
  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(manifest.content);
  } catch {
    throw new RecorderError('invalid_request', 'package.json is not valid JSON.');
  }
  if (typeof manifestValue !== 'object' || manifestValue === null || Array.isArray(manifestValue)) {
    throw new RecorderError('invalid_request', 'package.json must be a JSON object.');
  }
  const validation = validateNpmLockfile(lockfile.content);
  if (!validation.ok) {
    throw new RecorderError(
      'invalid_request',
      `The lockfile cannot be used for dependency replay: ${describeDependencyErrors(validation.errors)}.`,
    );
  }
  return {
    install_script_packages: validation.packages.filter((item) => item.has_install_script).length,
    package_count: validation.packages.length,
  };
};

const validateSelections = (request: RecordRequest): void => {
  if (request.arguments.length === 0 || request.arguments.length > 128) {
    throw new RecorderError('invalid_request', 'At least one Node.js argument is required.');
  }
  const hasDisallowedArgumentCharacter = (argument: string): boolean =>
    Array.from(argument).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 8 || (codePoint >= 10 && codePoint <= 31) || codePoint === 127;
    });
  if (
    request.arguments.some(
      (argument) =>
        argument.length === 0 || argument.length > 8192 || hasDisallowedArgumentCharacter(argument),
    )
  ) {
    throw new RecorderError(
      'invalid_request',
      'A Node.js argument is empty, too long, or contains a control character.',
    );
  }
  if (request.reproduction_paths.length === 0 || request.subject_paths.length === 0) {
    throw new RecorderError(
      'invalid_request',
      'Select at least one reproduction file and at least one subject file.',
    );
  }
  validateExpectationRequest(
    request.expect_stdout,
    request.expect_stderr,
    ARTIFACT_LIMITS.output_expectations,
  );
  if (!/^[a-z0-9]+(?:[._/-][a-z0-9]+)*@sha256:[a-f0-9]{64}$/u.test(request.environment_image)) {
    throw new RecorderError(
      'invalid_request',
      'The replay image must be pinned by a valid SHA-256 digest.',
    );
  }
  const limits = request.limits ?? DEFAULT_RECORD_LIMITS;
  if (
    !Number.isInteger(limits.timeout_seconds) ||
    limits.timeout_seconds < 1 ||
    limits.timeout_seconds > 300 ||
    !Number.isInteger(limits.memory_mb) ||
    limits.memory_mb < 64 ||
    limits.memory_mb > 2048 ||
    limits.cpus < 0.25 ||
    limits.cpus > 2 ||
    limits.cpus * 4 !== Math.round(limits.cpus * 4) ||
    !Number.isInteger(limits.processes) ||
    limits.processes < 8 ||
    limits.processes > 256 ||
    !Number.isInteger(limits.output_bytes_per_stream) ||
    limits.output_bytes_per_stream < 1024 ||
    limits.output_bytes_per_stream > 1_048_576
  ) {
    throw new RecorderError(
      'invalid_request',
      'Recording limits are outside artifact version 1 bounds.',
    );
  }
  const paths = [
    ...request.reproduction_paths,
    ...request.subject_paths,
    ...(request.include_dependencies === true ? DEPENDENCY_PATHS : []),
  ];
  if (
    paths.length > ARTIFACT_LIMITS.files ||
    new Set(paths.map((value) => value.toLowerCase())).size !== paths.length
  ) {
    throw new RecorderError(
      'invalid_request',
      'Selected file paths must be unique and within the file-count limit.',
    );
  }
};

const redactTarget = (
  redactor: Redactor,
  text: string,
  target: string,
): { readonly findings: readonly ArtifactRedactionFindingV1[]; readonly text: string } => {
  try {
    const result = redactor.redact(text);
    return {
      text: result.text,
      findings: result.findings.map((finding) => ({ ...finding, target })),
    };
  } catch (error: unknown) {
    if (error instanceof RedactionLimitError) {
      throw new RecorderError('redaction_failed', error.message);
    }
    throw error;
  }
};

export const captureRecording = async (
  request: RecordRequest,
  redactor: Redactor = createRedactor(),
): Promise<RecordCapture> => {
  validateSelections(request);
  if (request.arguments.some((argument) => redactor.redact(argument).findings.length > 0)) {
    throw new RecorderError('redaction_failed', 'A command argument contains a likely secret.');
  }
  const root = await prepareProjectRoot(request.project_root);
  const limits = request.limits ?? DEFAULT_RECORD_LIMITS;
  const selectedFiles = await Promise.all([
    ...request.reproduction_paths.map((filePath) =>
      readSelectedFile(root, filePath, 'reproduction'),
    ),
    ...request.subject_paths.map((filePath) => readSelectedFile(root, filePath, 'subject')),
    ...(request.include_dependencies === true
      ? DEPENDENCY_PATHS.map((filePath) => readSelectedFile(root, filePath, 'dependency'))
      : []),
  ]);
  const totalBytes = selectedFiles.reduce(
    (total, file) => total + Buffer.byteLength(file.content, 'utf8'),
    0,
  );
  if (totalBytes > ARTIFACT_LIMITS.total_file_content_bytes) {
    throw new RecorderError('unsafe_file', 'Selected files exceed the aggregate content limit.');
  }

  const dependencies =
    request.include_dependencies === true
      ? summarizeDependencies(selectedFiles.filter((file) => file.role === 'dependency'))
      : undefined;

  const command = await executeCommand(root, request.arguments, limits);
  const stdout = redactTarget(redactor, command.stdout.decoded_text, 'stdout');
  const stderr = redactTarget(redactor, command.stderr.decoded_text, 'stderr');
  const redactedFiles = selectedFiles.map((file) => {
    const result = redactTarget(redactor, file.content, file.path);
    if (file.role === 'dependency' && result.findings.length > 0) {
      // Editing either file would break the lockfile's integrity, so refuse instead.
      throw new RecorderError(
        'redaction_failed',
        `${file.path} contains a likely secret, and dependency files cannot be altered.`,
      );
    }
    return {
      file: { ...file, content: result.text, sha256: sha256(result.text) },
      findings: result.findings,
    };
  });
  const findings = [
    ...stdout.findings,
    ...stderr.findings,
    ...redactedFiles.flatMap((item) => item.findings),
  ];
  if (findings.length > ARTIFACT_LIMITS.findings) {
    throw new RecorderError(
      'redaction_failed',
      'Selected content contains too many redaction findings.',
    );
  }

  for (const literal of [
    ...requestedLiterals(request.expect_stdout),
    ...requestedLiterals(request.expect_stderr),
  ]) {
    if (redactor.redact(literal).findings.length > 0) {
      throw new RecorderError(
        'redaction_failed',
        'An expected output literal contains a likely secret.',
      );
    }
  }
  const contexts = await createRecordPathContexts({
    declared_paths: redactedFiles.map((item) => item.file.path),
    project_root: root,
    requested_root: request.project_root,
  });
  const stdoutExpectations = deriveOutputExpectations(
    { name: 'stdout', text: stdout.text, truncated: command.stdout.truncated },
    request.expect_stdout,
    contexts,
    redactor,
  );
  const stderrExpectations = deriveOutputExpectations(
    { name: 'stderr', text: stderr.text, truncated: command.stderr.truncated },
    request.expect_stderr,
    contexts,
    redactor,
  );

  const version = process.versions.node.split('.')[0];
  if (version === undefined)
    throw new RecorderError('command_failed', 'Node.js version could not be determined.');
  if (
    process.platform !== 'win32' &&
    process.platform !== 'darwin' &&
    process.platform !== 'linux'
  ) {
    throw new RecorderError(
      'command_failed',
      'This host operating system cannot be represented by artifact version 1.',
    );
  }
  const artifact: ArtifactV1 = {
    version: 1,
    environment: {
      runtime: 'node',
      runtime_version: version,
      operating_system: 'linux',
      image: request.environment_image,
    },
    capture: {
      host_operating_system: process.platform,
      host_architecture: process.arch,
      node_version: process.versions.node,
    },
    command: { program: 'node', arguments: request.arguments, working_directory: '.' },
    files: redactedFiles.map((item) => item.file),
    expect: {
      exit_code: command.exit_code,
      stdout: stdoutExpectations,
      stderr: stderrExpectations,
    },
    limits,
    redaction: { enabled: true, findings },
  };
  const validation = validateArtifactValue(artifact);
  if (!validation.ok) {
    throw new RecorderError(
      'invalid_request',
      validation.errors[0]?.message ?? 'The proposed artifact is invalid.',
    );
  }

  return {
    artifact,
    ...(dependencies === undefined ? {} : { dependencies }),
    duration_ms: command.duration_ms,
    path_context: contexts.output,
    stdout: { ...command.stdout, decoded_text: stdout.text },
    stderr: { ...command.stderr, decoded_text: stderr.text },
  };
};

export const createRecorder = (redactor: Redactor = createRedactor()): Recorder => ({
  capture: async (request) => await captureRecording(request, redactor),
});
