import { createMatcher } from '@proofissue/matcher';
import type { Matcher } from '@proofissue/matcher';
import { createRecorder, RecorderError } from '@proofissue/recorder';
import { MAX_GUIDED_SELECTIONS, parseLineId } from '@proofissue/recorder';
import type {
  ExpectationRequest,
  GuidedRecorder,
  ObservationListing,
  RecordCapture,
  RecordOutputExpectation,
  Recorder,
} from '@proofissue/recorder';
import { createOutputPathContext } from '@proofissue/output-rules';
import { createRedactor } from '@proofissue/redactor';
import type { Redactor } from '@proofissue/redactor';
import {
  APPROVED_NODE_IMAGE,
  createDockerRunner,
  REPLAY_TEMPORARY_DIRECTORY,
  REPLAY_WORKSPACE_PATH,
  RunnerError,
} from '@proofissue/runner';
import type { Runner } from '@proofissue/runner';

export type { RecordOutputExpectation } from '@proofissue/recorder';
export {
  LISTING_LIMITS,
  lineId,
  MAX_GUIDED_SELECTIONS,
  MAX_SELECTABLE_LINE_BYTES,
  parseLineId,
  SUGGESTION_RULES,
} from '@proofissue/recorder';
export type {
  LineSuggestion,
  ObservationListing,
  ObservedLine,
  ObservedStreamName,
  StreamListing,
  SuggestionRule,
  UnselectableReason,
} from '@proofissue/recorder';

/** The only replay image replay accepts; recording defaults to it. */
export const APPROVED_REPLAY_IMAGE: string = APPROVED_NODE_IMAGE;

export {
  artifactStem,
  DEFAULT_ARTIFACT_EXTENSION,
  defaultArtifactPath,
  MAX_DEFAULT_ARTIFACT_SUFFIX,
  REPLAY_NODE_MAJOR,
} from './record-defaults.js';
export type { DefaultArtifactPathInput, DefaultArtifactPathResult } from './record-defaults.js';

export {
  explainRecordCommand,
  MAX_PROBE_REASONS,
  planSuggestedFiles,
  probeRecordDependencies,
  SUGGESTION_LIMITS,
  suggestRecordFiles,
} from './record-suggestions.js';
export type {
  CommandHint,
  DependencyProbe,
  FileSuggestions,
  RecordFilePlan,
  RecordFileSelection,
  SuggestedFile,
  SuggestionLimit,
  SuggestRecordFilesRequest,
} from './record-suggestions.js';

export type {
  InspectOperationResult,
  OperationResult,
  OutputNormalizationRule,
  PrepareOperationResult,
  PrepareStatus,
  ProofIssueError,
  ProofIssueErrorCode,
  RecordOperationResult,
  ReplayOperationResult,
  ReplayStatus,
  ValidateOperationResult,
} from '@proofissue/contracts';

import type {
  ArtifactInspectionOutputExpectation,
  ArtifactInspectionSummary,
  BoundedExecutionResult,
  BoundedExecutionSummary,
  InspectOperationResult,
  OutputNormalizationRule,
  PrepareOperationResult,
  RecordOperationResult,
  ReplayOperationResult,
  ReplayStatus,
  ValidateOperationResult,
} from '@proofissue/contracts';
import {
  readArtifactFile,
  validateArtifactValue,
  writeArtifactFile,
} from '@proofissue/artifact-schema';
import { ArtifactFileError } from '@proofissue/artifact-schema';
import type { ArtifactLimitsV1 } from '@proofissue/artifact-schema';
import type { ValidatedArtifactV1 } from '@proofissue/artifact-schema';
import { toProofIssueError } from './artifact-errors.js';
import { createPrepareApplicationService } from './prepare.js';
import type { PrepareApplicationRequest } from './prepare.js';

export { createPrepareApplicationService } from './prepare.js';
export type {
  PrepareApplicationDependencies,
  PrepareApplicationRequest,
  PrepareApplicationService,
} from './prepare.js';
import type { PackageFetcher } from '@proofissue/dependencies';

export interface RecordApplicationRequest {
  readonly arguments: readonly string[];
  readonly environment_image: string;
  /** Output expectations; a plain string is a raw literal that must appear in the stream. */
  readonly expect_stderr: readonly RecordOutputExpectation[];
  readonly expect_stdout: readonly RecordOutputExpectation[];
  /** Also record package.json and package-lock.json from the project root. */
  readonly include_dependencies?: boolean;
  readonly limits?: ArtifactLimitsV1;
  readonly output_path: string;
  readonly program: 'node';
  readonly project_root: string;
  readonly reproduction_paths: readonly string[];
  readonly subject_paths: readonly string[];
}

/** An expectation as the recording derived it: the text that will be stored. */
export interface RecordPreviewExpectation {
  readonly mode: 'contains' | 'exact' | 'regex';
  /** Empty means the raw redacted stream. */
  readonly normalize: readonly OutputNormalizationRule[];
  readonly value: string;
}

export interface RecordPreview {
  /** The Node.js major version this recording ran with; replay always uses the approved image's. */
  readonly host_node_major: number;
  /** Where the artifact will be written, as the request gave it. */
  readonly output_path: string;
  /** The replay image the artifact will name. */
  readonly replay_image: string;
  readonly command: { readonly program: 'node'; readonly arguments: readonly string[] };
  /** Present only when dependency files are being recorded. */
  readonly dependencies?: {
    readonly files: readonly string[];
    readonly install_script_packages: number;
    readonly package_count: number;
  };
  readonly reproduction_files: readonly string[];
  readonly subject_files: readonly string[];
  readonly expectations: {
    readonly exit_code: number;
    readonly stdout: readonly RecordPreviewExpectation[];
    readonly stderr: readonly RecordPreviewExpectation[];
  };
  readonly limits: ArtifactLimitsV1;
  readonly output: {
    readonly stdout: Omit<RecordCapture['stdout'], 'decoded_text'>;
    readonly stderr: Omit<RecordCapture['stderr'], 'decoded_text'>;
  };
  readonly redaction: {
    readonly finding_count: number;
    readonly findings: readonly {
      readonly category: string;
      readonly target: string;
      readonly count: number;
      readonly replacement: string;
    }[];
  };
}

export interface RecordConfirmation {
  readonly reproduction_files_confirmed: boolean;
  readonly subject_files_confirmed: boolean;
  readonly write_confirmed: boolean;
}

export type ConfirmRecording = (preview: RecordPreview) => Promise<RecordConfirmation>;

export interface ValidateApplicationRequest {
  readonly artifact_path: string;
}

export interface InspectApplicationRequest {
  readonly artifact_path: string;
}

export interface ReplayApplicationRequest {
  readonly against_path?: string;
  readonly artifact_path: string;
  /** The prepared store for an artifact with dependency files. Ignored for other artifacts. */
  readonly dependency_store?: string;
  readonly mode: 'snapshot' | 'current_checkout';
  readonly signal?: AbortSignal;
}

export interface ApplicationServices {
  record(request: RecordApplicationRequest): Promise<RecordOperationResult>;
  validate(request: ValidateApplicationRequest): Promise<ValidateOperationResult>;
  inspect(request: InspectApplicationRequest): Promise<InspectOperationResult>;
  prepare(request: PrepareApplicationRequest): Promise<PrepareOperationResult>;
  replay(request: ReplayApplicationRequest): Promise<ReplayOperationResult>;
}

export type StaticArtifactApplicationServices = Pick<ApplicationServices, 'inspect' | 'validate'>;
export type RecordApplicationService = Pick<ApplicationServices, 'record'>;
export type ReplayApplicationService = Pick<ApplicationServices, 'replay'>;

const withoutDecodedText = (capture: RecordCapture['stdout']) => ({
  discarded_bytes: capture.discarded_bytes,
  had_decoding_replacement: capture.had_decoding_replacement,
  retained_bytes: capture.retained_bytes,
  total_bytes: capture.total_bytes,
  truncated: capture.truncated,
});

const previewExpectation = (
  item: RecordCapture['artifact']['expect']['stdout'][number],
): RecordPreviewExpectation => ({
  mode: item.mode,
  normalize: item.normalize === undefined ? [] : [...item.normalize],
  value: item.value,
});

const createRecordPreview = (
  capture: RecordCapture,
  request: Pick<RecordApplicationRequest, 'output_path'>,
): RecordPreview => {
  const grouped = new Map<string, RecordPreview['redaction']['findings'][number]>();
  for (const finding of capture.artifact.redaction.findings) {
    const key = `${finding.target}\u0000${finding.category}`;
    const current = grouped.get(key);
    grouped.set(key, {
      category: finding.category,
      target: finding.target,
      count: (current?.count ?? 0) + 1,
      replacement: finding.replacement,
    });
  }
  return {
    host_node_major: Number(capture.artifact.capture.node_version.split('.')[0]),
    output_path: request.output_path,
    replay_image: capture.artifact.environment.image,
    command: {
      program: capture.artifact.command.program,
      arguments: capture.artifact.command.arguments,
    },
    ...(capture.dependencies === undefined
      ? {}
      : {
          dependencies: {
            files: capture.artifact.files
              .filter((file) => file.role === 'dependency')
              .map((file) => file.path),
            install_script_packages: capture.dependencies.install_script_packages,
            package_count: capture.dependencies.package_count,
          },
        }),
    reproduction_files: capture.artifact.files
      .filter((file) => file.role === 'reproduction')
      .map((file) => file.path),
    subject_files: capture.artifact.files
      .filter((file) => file.role === 'subject')
      .map((file) => file.path),
    expectations: {
      exit_code: capture.artifact.expect.exit_code,
      stdout: capture.artifact.expect.stdout.map(previewExpectation),
      stderr: capture.artifact.expect.stderr.map(previewExpectation),
    },
    limits: capture.artifact.limits,
    output: {
      stdout: withoutDecodedText(capture.stdout),
      stderr: withoutDecodedText(capture.stderr),
    },
    redaction: {
      finding_count: capture.artifact.redaction.findings.length,
      findings: [...grouped.values()],
    },
  };
};

const recordFailure = (error: unknown): RecordOperationResult => {
  if (error instanceof RecorderError) {
    const executionFailure = error.code === 'command_failed' || error.code === 'timeout';
    return {
      result_schema_version: 1,
      operation: 'record',
      status: executionFailure ? 'execution_failed' : 'invalid_input',
      warnings: [],
      errors: [
        {
          code:
            error.code === 'timeout'
              ? 'timeout'
              : error.code === 'command_failed'
                ? 'record_command_failed'
                : 'policy_rejection',
          message: error.message,
        },
      ],
    };
  }
  if (error instanceof ArtifactFileError) {
    return {
      result_schema_version: 1,
      operation: 'record',
      status: 'execution_failed',
      warnings: [],
      errors: [{ code: 'atomic_write_failed', message: error.message }],
    };
  }
  return {
    result_schema_version: 1,
    operation: 'record',
    status: 'execution_failed',
    warnings: [],
    errors: [{ code: 'internal_error', message: 'Recording could not be completed safely.' }],
  };
};

/**
 * Replays the recording's own output against the expectations it derived, using the same
 * matcher a replay uses. A recording that does not satisfy its own expectations could never
 * reproduce, so it is rejected before anything is previewed or written. Returns the first
 * explanation (which never contains output text or expected values), or undefined.
 */
const selfCheckFailure = (capture: RecordCapture, matcher: Matcher): string | undefined => {
  const expectation = capture.artifact.expect;
  const execution: BoundedExecutionResult = {
    duration_ms: capture.duration_ms,
    exit_code: expectation.exit_code,
    stderr: capture.stderr,
    stdout: capture.stdout,
    termination_reason: 'exited',
  };
  const result = matcher.match({
    execution,
    expectation: {
      exit_code: expectation.exit_code,
      stderr: expectation.stderr,
      stdout: expectation.stdout,
    },
    path_context: capture.path_context,
  });
  return result.reproduced
    ? undefined
    : (result.differences[0]?.message ?? 'The recording did not match its own output.');
};

/**
 * What a person chose after seeing the observed output: output line ids such as `e3` and `o12`,
 * or nothing, which cancels the recording.
 */
export type ExpectationChoice =
  | { readonly line_ids: readonly string[]; readonly status: 'chosen' }
  | { readonly status: 'cancelled' };

/**
 * The listing a person chooses from: the normalized, redacted lines of both streams and the
 * suggested line. It holds output text, so it goes only to the selector, which shows it to the
 * person who ran the command, and never into an operation result.
 */
export type RecordObservationView = ObservationListing;

/** Asks the person which observed lines the artifact should expect. */
export type SelectExpectations = (view: RecordObservationView) => Promise<ExpectationChoice>;

export interface RecordApplicationOptions {
  /**
   * Enables guided recording: when a request carries no expected output, the command is run
   * first and this callback chooses the expected lines from what it printed. It is never called
   * for a request that already names its expectations.
   */
  readonly select_expectations?: SelectExpectations;
}

type CaptureOutcome =
  | { readonly capture: RecordCapture; readonly kind: 'captured' }
  | { readonly kind: 'ended'; readonly result: RecordOperationResult };

const isGuidedRecorder = (recorder: Recorder): recorder is GuidedRecorder =>
  'observe' in recorder && 'finalize' in recorder && 'list' in recorder;

const lineIdsToExpectations = (
  view: RecordObservationView,
  lineIds: readonly string[],
): ExpectationRequest | undefined => {
  const unique = [...new Set(lineIds)];
  if (unique.length === 0 || unique.length > MAX_GUIDED_SELECTIONS) return undefined;
  const stdout: RecordOutputExpectation[] = [];
  const stderr: RecordOutputExpectation[] = [];
  for (const id of unique) {
    const parsed = parseLineId(id);
    if (parsed === undefined) return undefined;
    const listing = parsed.stream === 'stdout' ? view.stdout : view.stderr;
    const listed = listing.lines.find((line) => line.number === parsed.number);
    // An omitted or unselectable line cannot be chosen, whatever the selector sent.
    if (listed === undefined || !listed.selectable) return undefined;
    (parsed.stream === 'stdout' ? stdout : stderr).push({ mode: 'line', line: parsed.number });
  }
  return { expect_stdout: stdout, expect_stderr: stderr };
};

const cancelledResult = (): RecordOperationResult => ({
  result_schema_version: 1,
  operation: 'record',
  status: 'cancelled',
  warnings: [],
  errors: [],
});

const guidedCapture = async (
  recorder: GuidedRecorder,
  select: SelectExpectations,
  request: RecordApplicationRequest,
): Promise<CaptureOutcome> => {
  // The selected files are read before the command runs, as they are for every recording.
  const observation = await recorder.observe({
    arguments: request.arguments,
    environment_image: request.environment_image,
    ...(request.include_dependencies === undefined
      ? {}
      : { include_dependencies: request.include_dependencies }),
    ...(request.limits === undefined ? {} : { limits: request.limits }),
    program: request.program,
    project_root: request.project_root,
    reproduction_paths: request.reproduction_paths,
    subject_paths: request.subject_paths,
  });
  const view = recorder.list(observation);
  if (![...view.stdout.lines, ...view.stderr.lines].some((line) => line.selectable)) {
    return {
      kind: 'ended',
      result: recordFailure(
        new RecorderError(
          'invalid_request',
          'The command printed no line that can be recorded as expected output: every listed line was empty, held a redaction marker or a local path, looked like a secret, or was too long. Give an expectation with an --expect option instead.',
        ),
      ),
    };
  }
  const choice = await select(view);
  if (choice.status === 'cancelled' || choice.line_ids.length === 0) {
    return { kind: 'ended', result: cancelledResult() };
  }
  const expectations = lineIdsToExpectations(view, choice.line_ids);
  if (expectations === undefined) {
    return {
      kind: 'ended',
      result: recordFailure(
        new RecorderError(
          'invalid_request',
          `Choose between 1 and ${String(MAX_GUIDED_SELECTIONS)} listed, selectable output lines.`,
        ),
      ),
    };
  }
  return { kind: 'captured', capture: recorder.finalize(observation, expectations) };
};

const hasNoExpectations = (request: RecordApplicationRequest): boolean =>
  request.expect_stdout.length + request.expect_stderr.length === 0;

export const createRecordApplicationService = (
  confirm: ConfirmRecording,
  recorder: Recorder = createRecorder(),
  matcher: Matcher = createMatcher(),
  options: RecordApplicationOptions = {},
): RecordApplicationService => ({
  record: async (request): Promise<RecordOperationResult> => {
    try {
      let outcome: CaptureOutcome;
      if (
        options.select_expectations !== undefined &&
        hasNoExpectations(request) &&
        isGuidedRecorder(recorder)
      ) {
        outcome = await guidedCapture(recorder, options.select_expectations, request);
      } else {
        outcome = {
          kind: 'captured',
          capture: await recorder.capture({
            arguments: request.arguments,
            environment_image: request.environment_image,
            expect_stderr: request.expect_stderr,
            expect_stdout: request.expect_stdout,
            ...(request.include_dependencies === undefined
              ? {}
              : { include_dependencies: request.include_dependencies }),
            ...(request.limits === undefined ? {} : { limits: request.limits }),
            program: request.program,
            project_root: request.project_root,
            reproduction_paths: request.reproduction_paths,
            subject_paths: request.subject_paths,
          }),
        };
      }
      if (outcome.kind === 'ended') return outcome.result;
      const { capture } = outcome;
      const mismatch = selfCheckFailure(capture, matcher);
      if (mismatch !== undefined) {
        return recordFailure(
          new RecorderError(
            'invalid_request',
            `The recording does not satisfy its own expectations (${mismatch}); no artifact was written.`,
          ),
        );
      }
      const preview = createRecordPreview(capture, request);
      const confirmation = await confirm(preview);
      if (
        !confirmation.reproduction_files_confirmed ||
        !confirmation.subject_files_confirmed ||
        !confirmation.write_confirmed
      ) {
        return {
          result_schema_version: 1,
          operation: 'record',
          status: 'cancelled',
          warnings: [],
          errors: [],
        };
      }
      const validation = validateArtifactValue(capture.artifact);
      if (!validation.ok)
        return recordFailure(
          new RecorderError('invalid_request', 'The proposed artifact did not pass validation.'),
        );
      const written = await writeArtifactFile(request.output_path, capture.artifact);
      const warnings = [capture.stdout, capture.stderr]
        .filter((stream) => stream.truncated)
        .map(() => ({
          code: 'output_truncated',
          message: 'Recorded output exceeded its retained byte limit.',
        }));
      return {
        result_schema_version: 1,
        operation: 'record',
        status: 'created',
        artifact_version: 1,
        artifact_digest: written.digest,
        warnings,
        errors: [],
      };
    } catch (error: unknown) {
      return recordFailure(error);
    }
  },
});

export const validateArtifact = async (
  request: ValidateApplicationRequest,
): Promise<ValidateOperationResult> => {
  const result = await readArtifactFile(request.artifact_path);
  if (!result.ok) {
    return {
      result_schema_version: 1,
      operation: 'validate',
      status: 'invalid_artifact',
      warnings: [],
      errors: result.errors.map(toProofIssueError),
    };
  }
  return {
    result_schema_version: 1,
    operation: 'validate',
    status: 'valid',
    artifact_version: 1,
    artifact_digest: result.artifact.digest,
    warnings: [],
    errors: [],
  };
};

const inspectExpectation = (
  item: ValidatedArtifactV1['expect']['stdout'][number],
): ArtifactInspectionOutputExpectation => ({
  mode: item.mode,
  normalize: item.normalize === undefined ? [] : [...item.normalize],
});

const inspectArtifactModel = (artifact: ValidatedArtifactV1): ArtifactInspectionSummary => {
  const findingGroups = new Map<
    string,
    ArtifactInspectionSummary['redaction']['findings'][number]
  >();
  for (const finding of artifact.redaction.findings) {
    const key = `${finding.target}\u0000${finding.category}`;
    const existing = findingGroups.get(key);
    findingGroups.set(key, {
      category: finding.category,
      target: finding.target,
      count: (existing?.count ?? 0) + 1,
    });
  }
  return {
    runtime: artifact.environment.runtime,
    runtime_version: artifact.environment.runtime_version,
    operating_system: artifact.environment.operating_system,
    image: artifact.environment.image,
    command: {
      program: artifact.command.program,
      argument_count: artifact.command.arguments.length,
      working_directory: artifact.command.working_directory,
    },
    files: artifact.files.map((file) => ({
      path: file.path,
      role: file.role,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      sha256: file.sha256,
    })),
    expectations: {
      exit_code: artifact.expect.exit_code,
      stdout_count: artifact.expect.stdout.length,
      stderr_count: artifact.expect.stderr.length,
      stdout_expectations: artifact.expect.stdout.map(inspectExpectation),
      stderr_expectations: artifact.expect.stderr.map(inspectExpectation),
    },
    limits: { ...artifact.limits },
    redaction: {
      enabled: true,
      finding_count: artifact.redaction.findings.length,
      findings: [...findingGroups.values()],
    },
  };
};

export const inspectArtifact = async (
  request: InspectApplicationRequest,
): Promise<InspectOperationResult> => {
  const result = await readArtifactFile(request.artifact_path);
  if (!result.ok) {
    return {
      result_schema_version: 1,
      operation: 'inspect',
      status: 'invalid_artifact',
      warnings: [],
      errors: result.errors.map(toProofIssueError),
    };
  }
  return {
    result_schema_version: 1,
    operation: 'inspect',
    status: 'inspected',
    artifact_version: 1,
    artifact_digest: result.artifact.digest,
    warnings: [],
    errors: [],
    inspection: inspectArtifactModel(result.artifact),
  };
};

export const createStaticArtifactApplicationServices = (): StaticArtifactApplicationServices => ({
  inspect: inspectArtifact,
  validate: validateArtifact,
});

const summarizeExecution = (execution: BoundedExecutionResult): BoundedExecutionSummary => ({
  duration_ms: execution.duration_ms,
  ...(execution.exit_code === undefined ? {} : { exit_code: execution.exit_code }),
  ...(execution.signal === undefined ? {} : { signal: execution.signal }),
  stdout: withoutDecodedText(execution.stdout),
  stderr: withoutDecodedText(execution.stderr),
  termination_reason: execution.termination_reason,
});

const replayBase = (
  mode: ReplayApplicationRequest['mode'],
): Pick<
  ReplayOperationResult,
  | 'differences'
  | 'errors'
  | 'evidence'
  | 'mode'
  | 'operation'
  | 'result_schema_version'
  | 'scope_limitations'
  | 'substituted_paths'
  | 'warnings'
> => ({
  result_schema_version: 1,
  operation: 'replay',
  mode,
  warnings: [],
  errors: [],
  evidence: [],
  differences: [],
  substituted_paths: [],
  scope_limitations:
    mode === 'current_checkout'
      ? [
          {
            code: 'declared_subject_paths_only',
            message:
              'Only listed subject paths were substituted; undeclared additions, removals, and renames were not evaluated.',
          },
        ]
      : [],
});

/**
 * The directories a replayed command can print. Replay always runs in the same two locations,
 * so normalization needs nothing from the host that runs ProofIssue.
 */
const REPLAY_PATH_CONTEXT = createOutputPathContext({
  platform: 'posix',
  project_roots: [REPLAY_WORKSPACE_PATH],
  temporary_roots: [REPLAY_TEMPORARY_DIRECTORY],
});

export interface ReplayApplicationDependencies {
  readonly matcher?: Matcher;
  readonly redactor?: Redactor;
  readonly runner?: Runner;
}

export const createReplayApplicationService = (
  dependencies: ReplayApplicationDependencies = {},
): ReplayApplicationService => {
  const matcher = dependencies.matcher ?? createMatcher();
  const redactor = dependencies.redactor ?? createRedactor();
  const runner = dependencies.runner ?? createDockerRunner();

  return {
    replay: async (request): Promise<ReplayOperationResult> => {
      const parsed = await readArtifactFile(request.artifact_path);
      if (!parsed.ok) {
        return {
          ...replayBase(request.mode),
          status: 'invalid_artifact',
          errors: parsed.errors.map(toProofIssueError),
        };
      }

      const artifact = parsed.artifact;
      const imageDigest = artifact.environment.image.split('@')[1];
      try {
        const result = await runner.run({
          artifact,
          ...(request.against_path === undefined ? {} : { against_path: request.against_path }),
          ...(request.dependency_store === undefined
            ? {}
            : { dependency_store: request.dependency_store }),
          mode: request.mode,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        });
        const redactedStdout = redactor.redact(result.execution.stdout.decoded_text);
        const redactedStderr = redactor.redact(result.execution.stderr.decoded_text);
        const safeExecution: BoundedExecutionResult = {
          ...result.execution,
          stdout: { ...result.execution.stdout, decoded_text: redactedStdout.text },
          stderr: { ...result.execution.stderr, decoded_text: redactedStderr.text },
        };
        const match = matcher.match({
          execution: safeExecution,
          expectation: {
            exit_code: artifact.expect.exit_code,
            stdout: artifact.expect.stdout,
            stderr: artifact.expect.stderr,
          },
          path_context: REPLAY_PATH_CONTEXT,
        });
        const truncated = safeExecution.stdout.truncated || safeExecution.stderr.truncated;
        return {
          ...replayBase(request.mode),
          status: match.reproduced ? 'reproduced' : 'not_reproduced',
          artifact_version: 1,
          artifact_digest: artifact.digest,
          ...(imageDigest === undefined ? {} : { image_digest: imageDigest }),
          effective_limits: result.effective_limits,
          execution: summarizeExecution(safeExecution),
          evidence: match.evidence,
          differences: match.differences,
          substituted_paths: result.substituted_paths,
          scope_limitations: [
            ...replayBase(request.mode).scope_limitations,
            ...(truncated
              ? [
                  {
                    code: 'output_truncated' as const,
                    message: 'Replay output exceeded its retained byte limit.',
                  },
                ]
              : []),
          ],
          cleanup: result.cleanup,
          warnings:
            redactedStdout.findings.length + redactedStderr.findings.length > 0
              ? [
                  {
                    code: 'replay_output_redacted',
                    message: 'Likely secrets were removed from replay output before matching.',
                  },
                ]
              : [],
        };
      } catch (error: unknown) {
        if (error instanceof RunnerError) {
          const cleanupError =
            error.cleanup !== undefined &&
            !error.cleanup.completed &&
            error.code !== 'cleanup_failed'
              ? [
                  {
                    code: 'cleanup_failed' as const,
                    message: 'Replay cleanup did not complete successfully.',
                  },
                ]
              : [];
          return {
            ...replayBase(request.mode),
            status: 'execution_failed',
            artifact_version: 1,
            artifact_digest: artifact.digest,
            ...(error.code === 'policy_rejection' || imageDigest === undefined
              ? {}
              : { image_digest: imageDigest }),
            ...(error.effective_limits === undefined
              ? {}
              : { effective_limits: error.effective_limits }),
            ...(error.execution === undefined
              ? {}
              : { execution: summarizeExecution(error.execution) }),
            ...(error.cleanup === undefined ? {} : { cleanup: error.cleanup }),
            errors: [{ code: error.code, message: error.message }, ...cleanupError],
          };
        }
        return {
          ...replayBase(request.mode),
          status: 'execution_failed',
          artifact_version: 1,
          artifact_digest: artifact.digest,
          errors: [
            {
              code: 'internal_error',
              message: 'Replay could not be completed safely.',
            },
          ],
        };
      }
    },
  };
};

export interface ApplicationPorts {
  readonly fetcher: PackageFetcher;
  readonly matcher: Matcher;
  readonly recorder: Recorder;
  readonly redactor: Redactor;
  readonly runner: Runner;
}

export const createApplicationServices = (
  confirm: ConfirmRecording,
  ports: Partial<ApplicationPorts> = {},
): ApplicationServices => {
  const recorder = ports.recorder ?? createRecorder();
  const matcher = ports.matcher ?? createMatcher();
  const redactor = ports.redactor ?? createRedactor();
  const runner = ports.runner ?? createDockerRunner();
  return {
    ...createRecordApplicationService(confirm, recorder, matcher),
    ...createStaticArtifactApplicationServices(),
    ...createPrepareApplicationService(
      ports.fetcher === undefined ? {} : { fetcher: ports.fetcher },
    ),
    ...createReplayApplicationService({ matcher, redactor, runner }),
  };
};

export interface RequiredStatusEvaluation {
  readonly actual: ReplayStatus;
  readonly required: Extract<ReplayStatus, 'not_reproduced' | 'reproduced'>;
  readonly satisfied: boolean;
}

export const evaluateRequiredReplayStatus = (
  result: ReplayOperationResult,
  required: Extract<ReplayStatus, 'not_reproduced' | 'reproduced'>,
): RequiredStatusEvaluation => ({
  actual: result.status,
  required,
  satisfied: result.status === required,
});

export interface ReplayPolicyEvaluation {
  readonly classification_completed: boolean;
  readonly required_status_satisfied: boolean;
  readonly success: boolean;
}

/**
 * Single source of truth for whether a replay counts as a success for delivery
 * adapters. A replay succeeds when it reached a reproduced or not_reproduced
 * classification and, when a status was required, that status was the outcome.
 */
export const evaluateReplayPolicy = (
  result: ReplayOperationResult,
  required?: Extract<ReplayStatus, 'not_reproduced' | 'reproduced'>,
): ReplayPolicyEvaluation => {
  const classificationCompleted =
    result.status === 'reproduced' || result.status === 'not_reproduced';
  const requiredStatusSatisfied =
    required === undefined || evaluateRequiredReplayStatus(result, required).satisfied;
  return {
    classification_completed: classificationCompleted,
    required_status_satisfied: requiredStatusSatisfied,
    success: classificationCompleted && requiredStatusSatisfied,
  };
};
