export const RESULT_SCHEMA_VERSION = 1 as const;

export type ResultSchemaVersion = typeof RESULT_SCHEMA_VERSION;
export type ArtifactVersion = 1;
export type OperationName = 'record' | 'validate' | 'inspect' | 'replay';

export type ProofIssueErrorCode =
  | 'malformed_input'
  | 'unsupported_artifact_version'
  | 'schema_violation'
  | 'semantic_violation'
  | 'policy_rejection'
  | 'unsafe_checkout_file'
  | 'image_unavailable'
  | 'engine_unavailable'
  | 'engine_capability_unavailable'
  | 'container_creation_failed'
  | 'timeout'
  | 'resource_termination'
  | 'cleanup_failed'
  | 'record_command_failed'
  | 'atomic_write_failed'
  | 'internal_error';

export interface ProofIssueError {
  readonly code: ProofIssueErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, boolean | number | string>>;
}

export interface ProofIssueWarning {
  readonly code: string;
  readonly message: string;
}

export interface EffectiveLimits {
  readonly cpus: number;
  readonly memory_mb: number;
  readonly output_bytes_per_stream: number;
  readonly processes: number;
  readonly timeout_seconds: number;
  readonly writable_workspace_mb: number;
}

export interface BoundedStreamSummary {
  readonly discarded_bytes: number;
  readonly had_decoding_replacement: boolean;
  readonly retained_bytes: number;
  readonly total_bytes: number;
  readonly truncated: boolean;
}

export interface BoundedStreamCapture extends BoundedStreamSummary {
  readonly decoded_text: string;
}

export type TerminationReason =
  'exited' | 'signaled' | 'timeout' | 'resource_limit' | 'runner_failure';

export interface BoundedExecutionSummary {
  readonly duration_ms: number;
  readonly exit_code?: number;
  readonly signal?: string;
  readonly stderr: BoundedStreamSummary;
  readonly stdout: BoundedStreamSummary;
  readonly termination_reason: TerminationReason;
}

export interface BoundedExecutionResult {
  readonly duration_ms: number;
  readonly exit_code?: number;
  readonly signal?: string;
  readonly stderr: BoundedStreamCapture;
  readonly stdout: BoundedStreamCapture;
  readonly termination_reason: TerminationReason;
}

export interface CleanupSummary {
  readonly completed: boolean;
  readonly attempted_resources: readonly string[];
  readonly residual_resources: readonly string[];
}

export interface MatchEvidence {
  readonly kind: 'exit_code' | 'stderr_contains' | 'stdout_contains';
  readonly message: string;
}

export interface Difference {
  readonly kind: 'exit_code' | 'stderr_missing' | 'stdout_missing' | 'insufficient_output';
  readonly message: string;
}

export interface ScopeLimitation {
  readonly code: 'declared_subject_paths_only' | 'output_truncated';
  readonly message: string;
}

export interface OperationResultBase {
  readonly result_schema_version: ResultSchemaVersion;
  readonly operation: OperationName;
  readonly artifact_version?: ArtifactVersion;
  readonly artifact_digest?: string;
  readonly warnings: readonly ProofIssueWarning[];
  readonly errors: readonly ProofIssueError[];
}

export interface RecordOperationResult extends OperationResultBase {
  readonly operation: 'record';
  readonly status: 'created' | 'cancelled' | 'invalid_input' | 'execution_failed';
}

export interface ValidateOperationResult extends OperationResultBase {
  readonly operation: 'validate';
  readonly status: 'valid' | 'invalid_artifact';
}

export interface ArtifactInspectionFile {
  readonly path: string;
  readonly role: 'reproduction' | 'subject';
  readonly bytes: number;
  readonly sha256: string;
}

export interface ArtifactInspectionRedactionFinding {
  readonly category:
    'api_key' | 'authorization_header' | 'password' | 'private_key' | 'sensitive_environment';
  readonly target: string;
  readonly count: number;
}

export interface ArtifactInspectionSummary {
  readonly runtime: 'node';
  readonly runtime_version: string;
  readonly operating_system: 'linux';
  readonly image: string;
  readonly command: {
    readonly program: 'node';
    readonly argument_count: number;
    readonly working_directory: '.';
  };
  readonly files: readonly ArtifactInspectionFile[];
  readonly expectations: {
    readonly exit_code: number;
    readonly stdout_count: number;
    readonly stderr_count: number;
  };
  readonly limits: {
    readonly cpus: number;
    readonly memory_mb: number;
    readonly output_bytes_per_stream: number;
    readonly processes: number;
    readonly timeout_seconds: number;
  };
  readonly redaction: {
    readonly enabled: true;
    readonly finding_count: number;
    readonly findings: readonly ArtifactInspectionRedactionFinding[];
  };
}

export interface InspectOperationResult extends OperationResultBase {
  readonly operation: 'inspect';
  readonly status: 'inspected' | 'invalid_artifact';
  readonly inspection?: ArtifactInspectionSummary;
}

export type ReplayStatus =
  'reproduced' | 'not_reproduced' | 'invalid_artifact' | 'execution_failed';

export interface ReplayOperationResult extends OperationResultBase {
  readonly operation: 'replay';
  readonly status: ReplayStatus;
  readonly mode: 'snapshot' | 'current_checkout';
  readonly image_digest?: string;
  readonly effective_limits?: EffectiveLimits;
  readonly execution?: BoundedExecutionSummary;
  readonly evidence: readonly MatchEvidence[];
  readonly differences: readonly Difference[];
  readonly substituted_paths: readonly string[];
  readonly scope_limitations: readonly ScopeLimitation[];
  readonly cleanup?: CleanupSummary;
}

export type OperationResult =
  InspectOperationResult | RecordOperationResult | ReplayOperationResult | ValidateOperationResult;
