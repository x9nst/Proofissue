import type { Matcher } from '@proofissue/matcher';
import type { Recorder } from '@proofissue/recorder';
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
import { readArtifactFile } from '@proofissue/artifact-schema';
import type { ArtifactValidationError, ValidatedArtifactV1 } from '@proofissue/artifact-schema';

export interface RecordApplicationRequest {
  readonly arguments: readonly string[];
  readonly output_path: string;
  readonly program: 'node';
  readonly project_root: string;
  readonly reproduction_paths: readonly string[];
  readonly subject_paths: readonly string[];
}

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
