import { createMatcher } from '@proofissue/matcher';
import type { Matcher } from '@proofissue/matcher';
import { createRecorder, RecorderError } from '@proofissue/recorder';
import type { RecordCapture, Recorder } from '@proofissue/recorder';
import { createRedactor } from '@proofissue/redactor';
import type { Redactor } from '@proofissue/redactor';
import { createDockerRunner, RunnerError } from '@proofissue/runner';
import type { Runner } from '@proofissue/runner';

export type {
  InspectOperationResult,
  OperationResult,
  ProofIssueError,
  ProofIssueErrorCode,
  RecordOperationResult,
  ReplayOperationResult,
  ReplayStatus,
  ValidateOperationResult,
} from '@proofissue/contracts';

import type {
  ArtifactInspectionSummary,
  BoundedExecutionResult,
  BoundedExecutionSummary,
  InspectOperationResult,
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
import type { ArtifactValidationError, ValidatedArtifactV1 } from '@proofissue/artifact-schema';

export interface RecordApplicationRequest {
  readonly arguments: readonly string[];
  readonly environment_image: string;
  readonly expect_stderr: readonly string[];
  readonly expect_stdout: readonly string[];
  readonly limits?: ArtifactLimitsV1;
  readonly output_path: string;
  readonly program: 'node';
  readonly project_root: string;
  readonly reproduction_paths: readonly string[];
  readonly subject_paths: readonly string[];
}

export interface RecordPreview {
  readonly command: { readonly program: 'node'; readonly arguments: readonly string[] };
  readonly reproduction_files: readonly string[];
  readonly subject_files: readonly string[];
  readonly expectations: {
    readonly exit_code: number;
    readonly stdout: readonly string[];
    readonly stderr: readonly string[];
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
  readonly mode: 'snapshot' | 'current_checkout';
  readonly required_status?: Extract<ReplayStatus, 'not_reproduced' | 'reproduced'>;
  readonly signal?: AbortSignal;
}

export interface ApplicationServices {
  record(request: RecordApplicationRequest): Promise<RecordOperationResult>;
  validate(request: ValidateApplicationRequest): Promise<ValidateOperationResult>;
  inspect(request: InspectApplicationRequest): Promise<InspectOperationResult>;
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

const createRecordPreview = (capture: RecordCapture): RecordPreview => {
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
    command: {
      program: capture.artifact.command.program,
      arguments: capture.artifact.command.arguments,
    },
    reproduction_files: capture.artifact.files
      .filter((file) => file.role === 'reproduction')
      .map((file) => file.path),
    subject_files: capture.artifact.files
      .filter((file) => file.role === 'subject')
      .map((file) => file.path),
    expectations: {
      exit_code: capture.artifact.expect.exit_code,
      stdout: capture.artifact.expect.stdout.map((item) => item.value),
      stderr: capture.artifact.expect.stderr.map((item) => item.value),
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

export const createRecordApplicationService = (
  confirm: ConfirmRecording,
  recorder: Recorder = createRecorder(),
): RecordApplicationService => ({
  record: async (request): Promise<RecordOperationResult> => {
    try {
      const capture = await recorder.capture({
        arguments: request.arguments,
        environment_image: request.environment_image,
        expect_stderr: request.expect_stderr,
        expect_stdout: request.expect_stdout,
        ...(request.limits === undefined ? {} : { limits: request.limits }),
        program: request.program,
        project_root: request.project_root,
        reproduction_paths: request.reproduction_paths,
        subject_paths: request.subject_paths,
      });
      const preview = createRecordPreview(capture);
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
      await writeArtifactFile(request.output_path, capture.artifact);
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
        artifact_digest: validation.artifact.digest,
        warnings,
        errors: [],
      };
    } catch (error: unknown) {
      return recordFailure(error);
    }
  },
});

const toProofIssueError = (error: ArtifactValidationError) => ({
  code:
    error.code === 'unsupported_artifact_version'
      ? ('unsupported_artifact_version' as const)
      : error.code === 'schema_violation'
        ? ('schema_violation' as const)
        : error.code === 'semantic_violation'
          ? ('semantic_violation' as const)
          : ('malformed_input' as const),
  message: error.message,
  ...(error.path === undefined ? {} : { details: { path: error.path } }),
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
            stdout_contains: artifact.expect.stdout.map((item) => item.value),
            stderr_contains: artifact.expect.stderr.map((item) => item.value),
          },
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
    ...createRecordApplicationService(confirm, recorder),
    ...createStaticArtifactApplicationServices(),
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
