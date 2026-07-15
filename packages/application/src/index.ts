import type { Matcher } from '@proofissue/matcher';
import { createRecorder, RecorderError } from '@proofissue/recorder';
import type { RecordCapture, Recorder } from '@proofissue/recorder';
import type { Redactor } from '@proofissue/redactor';
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
}

export interface ApplicationServices {
  record(request: RecordApplicationRequest): Promise<RecordOperationResult>;
  validate(request: ValidateApplicationRequest): Promise<ValidateOperationResult>;
  inspect(request: InspectApplicationRequest): Promise<InspectOperationResult>;
  replay(request: ReplayApplicationRequest): Promise<ReplayOperationResult>;
}

export type StaticArtifactApplicationServices = Pick<ApplicationServices, 'inspect' | 'validate'>;
export type RecordApplicationService = Pick<ApplicationServices, 'record'>;

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

export interface ApplicationPorts {
  readonly matcher: Matcher;
  readonly recorder: Recorder;
  readonly redactor: Redactor;
  readonly runner: Runner;
}

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
