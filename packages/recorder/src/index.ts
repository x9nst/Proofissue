import { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';

import { ARTIFACT_LIMITS, sha256, validateArtifactValue } from '@proofissue/artifact-schema';
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

import { describeNonPortableArgument, findNonPortableArgument } from './arguments.js';
import { RecorderError } from './errors.js';
import {
  createRecordPathContexts,
  deriveOutputExpectations,
  requestedLiterals,
  validateExpectationRequest,
} from './expectations.js';
import type { RecordOutputExpectation, RecordPathContexts } from './expectations.js';
import { listObservation } from './observation.js';
import type { ObservationListing } from './observation.js';
import { prepareProjectRoot, readProjectTextFile } from './safe-files.js';

export { findNonPortableArgument } from './arguments.js';
export type { NonPortableArgument, NonPortableArgumentOptions } from './arguments.js';
export { RecorderError } from './errors.js';
export type { RecorderErrorCode } from './errors.js';
export type { RecordOutputExpectation, RecordPathContexts } from './expectations.js';
export {
  LISTING_LIMITS,
  listObservation,
  lineId,
  MAX_GUIDED_SELECTIONS,
  MAX_SELECTABLE_LINE_BYTES,
  parseLineId,
  SUGGESTION_RULES,
} from './observation.js';
export type {
  LineSuggestion,
  ObservationListing,
  ObservedLine,
  ObservedStreamName,
  StreamListing,
  SuggestionRule,
  UnselectableReason,
} from './observation.js';

export { MAX_PROBE_REASONS, probeDependencyFiles } from './dependency-probe.js';
export type { DependencyProbe } from './dependency-probe.js';
export { hintForCommand } from './bin-hint.js';
export type { CommandHint, CommandHintRequest } from './bin-hint.js';
export { roleOfPath, SUGGESTION_LIMITS, suggestFiles } from './suggest.js';
export type { FileSuggestions, SuggestedFile, SuggestionLimit, SuggestRequest } from './suggest.js';

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

/** What an expectation-free observation needs: a request without any expected output. */
export type ObserveRequest = Omit<RecordRequest, 'expect_stderr' | 'expect_stdout'>;

/** The expected output a recording is finalized with. */
export interface ExpectationRequest {
  readonly expect_stderr: readonly RecordOutputExpectation[];
  readonly expect_stdout: readonly RecordOutputExpectation[];
}

/**
 * A command's redacted observed output, before any expectation was chosen.
 *
 * It holds host paths in `contexts`, so it must never be serialized, logged, previewed, or
 * placed in a result. The output text is redacted but may still hold anything the command
 * printed; it may be shown to the person who ran the command, and nowhere else.
 */
export interface RecordObservation {
  readonly arguments: readonly string[];
  readonly contexts: RecordPathContexts;
  /** Present only when dependency files were recorded. */
  readonly dependencies?: DependencySummary;
  readonly duration_ms: number;
  readonly environment_image: string;
  readonly exit_code: number;
  readonly files: readonly ArtifactFileV1[];
  readonly findings: readonly ArtifactRedactionFindingV1[];
  readonly limits: ArtifactLimitsV1;
  /** The redacted text, as `decoded_text`. */
  readonly stderr: BoundedStreamCapture;
  readonly stdout: BoundedStreamCapture;
}

export interface Recorder {
  capture(request: RecordRequest): Promise<RecordCapture>;
}

/** A recorder that can also split a recording, which guided selection needs. */
export interface GuidedRecorder extends Recorder {
  finalize(observation: RecordObservation, expectations: ExpectationRequest): RecordCapture;
  /** The normalized lines of the observed output and the suggested line. */
  list(observation: RecordObservation): ObservationListing;
  observe(request: ObserveRequest): Promise<RecordObservation>;
}

const isExistingProjectFile = (root: string, relative: string): boolean => {
  try {
    return lstatSync(path.join(root, ...relative.split('/'))).isFile();
  } catch {
    return false;
  }
};

const readSelectedFile = async (
  root: string,
  artifactPath: string,
  role: ArtifactFileRoleV1,
): Promise<ArtifactFileV1> => {
  const content = await readProjectTextFile(root, artifactPath, ARTIFACT_LIMITS.scalar_bytes);
  return { path: artifactPath, role, encoding: 'utf8', content, sha256: sha256(content) };
};

// On Windows, libuv then adds HOMEDRIVE, HOMEPATH, LOGONSERVER, PATH, SYSTEMDRIVE, TEMP,
// USERDOMAIN, USERNAME, USERPROFILE, and WINDIR from this process when they are missing, and
// nothing turns that off. Passing them empty hides the values but breaks os.homedir() and,
// for PATH, program lookup, so the added names are documented in docs/recording.md instead.
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

const validateSelections = (request: ObserveRequest, expectations?: ExpectationRequest): void => {
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
  if (expectations !== undefined) {
    validateExpectationRequest(
      expectations.expect_stdout,
      expectations.expect_stderr,
      ARTIFACT_LIMITS.output_expectations,
    );
  }
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

/**
 * Each argument is checked alone and all of them together, so a flag and its value given as
 * separate arguments (`--password`, then the value) are read as the command line they form. A
 * count of findings too large to describe is a refusal as well.
 */
const argumentsHoldSecret = (args: readonly string[], redactor: Redactor): boolean => {
  try {
    return (
      args.some((argument) => redactor.redact(argument).findings.length > 0) ||
      redactor.redact(args.join(' ')).findings.length > 0
    );
  } catch (error: unknown) {
    if (error instanceof RedactionLimitError) return true;
    throw error;
  }
};

/**
 * Reads the selected files, runs the command, and redacts what it printed, without deciding
 * what the artifact will expect. This is the first half of a recording: the file contents are
 * read before the command runs, and nothing here has chosen an expectation. Pass the
 * expectations only to have them checked for shape before the command runs.
 *
 * The result holds host paths (in its path contexts): it must never be serialized, logged,
 * previewed, or placed in a result.
 */
export const observeRecording = async (
  request: ObserveRequest,
  redactor: Redactor = createRedactor(),
  expectations?: ExpectationRequest,
): Promise<RecordObservation> => {
  validateSelections(request, expectations);
  if (argumentsHoldSecret(request.arguments, redactor)) {
    throw new RecorderError('redaction_failed', 'A command argument contains a likely secret.');
  }
  const root = await prepareProjectRoot(request.project_root);
  const limits = request.limits ?? DEFAULT_RECORD_LIMITS;
  // The directories this recording can print are known before anything runs, so an argument
  // that holds one is refused first: it would leak into the artifact and cannot replay.
  const contexts = await createRecordPathContexts({
    declared_paths: [
      ...request.reproduction_paths,
      ...request.subject_paths,
      ...(request.include_dependencies === true ? DEPENDENCY_PATHS : []),
    ],
    project_root: root,
    requested_root: request.project_root,
  });
  const nonPortable = findNonPortableArgument(request.arguments, {
    exists: (relative) => isExistingProjectFile(root, relative),
    host_context: contexts.host,
    platform: process.platform === 'win32' ? 'win32' : 'posix',
  });
  if (nonPortable !== undefined) {
    throw new RecorderError('invalid_request', describeNonPortableArgument(nonPortable));
  }
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

  return {
    arguments: request.arguments,
    contexts,
    ...(dependencies === undefined ? {} : { dependencies }),
    duration_ms: command.duration_ms,
    environment_image: request.environment_image,
    exit_code: command.exit_code,
    files: redactedFiles.map((item) => item.file),
    findings,
    limits,
    stdout: { ...command.stdout, decoded_text: stdout.text },
    stderr: { ...command.stderr, decoded_text: stderr.text },
  };
};

/**
 * Derives the expectations from an observation and builds the artifact. This is the second
 * half of a recording. It is synchronous and runs no command.
 */
export const finalizeRecording = (
  observation: RecordObservation,
  expectations: ExpectationRequest,
  redactor: Redactor = createRedactor(),
): RecordCapture => {
  const { contexts } = observation;
  for (const literal of [
    ...requestedLiterals(expectations.expect_stdout),
    ...requestedLiterals(expectations.expect_stderr),
  ]) {
    if (redactor.redact(literal).findings.length > 0) {
      throw new RecorderError(
        'redaction_failed',
        'An expected output literal contains a likely secret.',
      );
    }
  }
  const stdout = {
    name: 'stdout',
    text: observation.stdout.decoded_text,
    truncated: observation.stdout.truncated,
  } as const;
  const stderr = {
    name: 'stderr',
    text: observation.stderr.decoded_text,
    truncated: observation.stderr.truncated,
  } as const;
  const stdoutExpectations = deriveOutputExpectations(
    stdout,
    expectations.expect_stdout,
    contexts,
    redactor,
    stderr,
  );
  const stderrExpectations = deriveOutputExpectations(
    stderr,
    expectations.expect_stderr,
    contexts,
    redactor,
    stdout,
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
      image: observation.environment_image,
    },
    capture: {
      host_operating_system: process.platform,
      host_architecture: process.arch,
      node_version: process.versions.node,
    },
    command: { program: 'node', arguments: observation.arguments, working_directory: '.' },
    files: observation.files,
    expect: {
      exit_code: observation.exit_code,
      stdout: stdoutExpectations,
      stderr: stderrExpectations,
    },
    limits: observation.limits,
    redaction: { enabled: true, findings: observation.findings },
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
    ...(observation.dependencies === undefined ? {} : { dependencies: observation.dependencies }),
    duration_ms: observation.duration_ms,
    path_context: contexts.output,
    stdout: observation.stdout,
    stderr: observation.stderr,
  };
};

/** Validates the request, observes the command, and finalizes: the whole recording at once. */
export const captureRecording = async (
  request: RecordRequest,
  redactor: Redactor = createRedactor(),
): Promise<RecordCapture> =>
  finalizeRecording(await observeRecording(request, redactor, request), request, redactor);

export const createRecorder = (redactor: Redactor = createRedactor()): GuidedRecorder => ({
  capture: async (request) => await captureRecording(request, redactor),
  finalize: (observation, expectations) => finalizeRecording(observation, expectations, redactor),
  list: (observation) => listObservation(observation, redactor),
  observe: async (request) => await observeRecording(request, redactor),
});
