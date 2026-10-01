/**
 * The per-case trial result.
 *
 * `trial_result_version: 1` is an internal evaluation format, not a public ProofIssue interface.
 * It holds only manifest values, result-contract fields, counts, and durations: never decoded
 * program output, package names, hostnames, or user names.
 */
import type {
  InspectionView,
  Limit,
  PreparationView,
  PrepareErrorView,
  ReplayRun,
} from './cli-results.js';
import type { TrialExpectation } from './manifest.js';

export const STAGE_STATUSES = ['failed', 'ok', 'skipped'] as const;
export type StageStatus = (typeof STAGE_STATUSES)[number];

export const CLASSIFICATIONS = ['confirmed', 'finding', 'harness_error', 'setup_failed'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const SETUP_CODES = [
  'fetch_failed',
  'file_mismatch',
  'host_install_failed',
  'preflight_exit_code_mismatch',
  'preflight_expectation_missing',
  'preflight_timeout',
  'prepare_network',
  'replay_environment',
] as const;
export type SetupCode = (typeof SETUP_CODES)[number];

export const FINDING_CODES = [
  'fix_execution_failed',
  'fix_not_verified',
  'pre_fix_checkout_failed',
  'prepare_refused',
  'record_refused',
  'replay_error',
  'snapshot_execution_failed',
  'snapshot_inconsistent',
  'snapshot_not_reproduced',
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

export const HARNESS_CODES = [
  'cli_arguments_rejected',
  'cli_missing',
  'local_path_in_result',
  'record_arguments_rejected',
  'secret_like_value_in_result',
  'unexpected_exception',
  'unparseable_cli_output',
] as const;
export type HarnessCode = (typeof HARNESS_CODES)[number];

export const OUTCOME_CODES = [
  ...FINDING_CODES,
  ...HARNESS_CODES,
  ...SETUP_CODES,
  'all_stages_passed',
] as const;
export type OutcomeCode = (typeof OUTCOME_CODES)[number];

export const OUTCOME_STAGES = [
  'fetch',
  'files',
  'fix_verification',
  'harness',
  'host_install',
  'install_baseline',
  'pre_fix_checkout',
  'preflight',
  'prepare',
  'record',
  'snapshot',
  'write',
] as const;
export type OutcomeStage = (typeof OUTCOME_STAGES)[number];

export interface Outcome {
  readonly classification: Classification;
  readonly stage: OutcomeStage;
  readonly code: OutcomeCode;
  /** A short sentence built from fixed templates and numbers, never from third-party text. */
  readonly detail: string;
  /** Further issues found, as `stage:code` pairs, in pipeline order. */
  readonly additional: readonly string[];
}

export interface CaseRecord {
  readonly id: string;
  readonly title: string;
  readonly repository: string;
  readonly links: readonly string[];
  readonly pre_fix_commit: string;
  readonly fix_commit: string;
  readonly dependencies: boolean;
  readonly reproduction_files: readonly string[];
  readonly subject_files: readonly string[];
  readonly command: readonly string[];
  readonly expected_exit_code: number;
  readonly expectations: readonly TrialExpectation[];
  readonly sets: readonly string[];
  readonly upstream_license: string | null;
}

export interface EnvironmentRecord {
  readonly harness_commit?: string;
  readonly run_url?: string;
  /** `${ImageOS}/${ImageVersion}` of the hosted runner. */
  readonly runner_image?: string;
  readonly platform: string;
  readonly arch: string;
  readonly kernel_release: string;
  readonly cpu_count: number;
  readonly cpu_model: string;
  readonly memory_total_mb: number;
  readonly host_node_version: string;
  readonly host_npm_version?: string;
  readonly host_git_version?: string;
  readonly docker_server_version?: string;
  readonly approved_image: string;
}

export interface FetchStage {
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly failure?: string;
}

export interface FileRecord {
  readonly path: string;
  readonly role: 'dependency' | 'reproduction' | 'subject';
  readonly bytes: number;
  readonly matches_commit: boolean;
  readonly carriage_returns: number;
  readonly missing_at_fix?: boolean;
}

export interface FilesStage {
  readonly status: StageStatus;
  readonly files: readonly FileRecord[];
  readonly unselected_config_files: readonly string[];
  readonly failure?: string;
}

export interface NodeModulesSize {
  readonly files: number;
  readonly bytes: number;
  /** Each file rounded up to 4096 bytes: a host estimate of tmpfs use. */
  readonly page_rounded_bytes: number;
}

export interface HostInstallStage {
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly exit_code?: number;
  readonly timed_out: boolean;
  readonly node_modules?: NodeModulesSize;
}

export interface PreflightStage {
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly exit_code?: number;
  readonly expected_exit_code: number;
  readonly timed_out: boolean;
  /** One entry per `contains` expectation; null for modes the preflight does not gate on. */
  readonly expectations_observed: readonly (boolean | null)[];
  readonly stdout_bytes: number;
  readonly stderr_bytes: number;
}

export type CliFailureKind = 'arguments_rejected' | 'network' | 'refused' | 'unparseable';

export interface RecordStage {
  readonly status: 'created' | 'failed' | 'skipped';
  readonly duration_ms: number;
  readonly cli_exit_code?: number | null;
  readonly failure_kind?: CliFailureKind;
  readonly failure_message?: string;
  readonly artifact_digest?: string;
  readonly inspection?: InspectionView;
}

export interface PrepareStage {
  readonly status: StageStatus;
  readonly duration_ms: number;
  readonly cli_exit_code?: number | null;
  readonly failure_kind?: CliFailureKind;
  readonly preparation?: PreparationView;
  readonly errors: readonly PrepareErrorView[];
  readonly warning_codes: readonly string[];
}

export interface BaselineStage {
  readonly status: StageStatus;
  readonly record_status: 'created' | 'failed' | 'skipped';
  readonly artifact_digest?: string;
  readonly prepare_duration_ms?: number;
  readonly reused_tarballs?: number;
  readonly runs: readonly ReplayRun[];
}

export interface RunSummary {
  readonly total: number;
  readonly reproduced: number;
  readonly not_reproduced: number;
  readonly execution_failed: number;
  readonly invalid_artifact: number;
  readonly unparseable: number;
  /** Every run reproduced with the same sorted evidence kinds. */
  readonly consistent: boolean;
  readonly duration_ms?: { readonly min: number; readonly median: number; readonly max: number };
  readonly limits: Readonly<Record<Limit, number>>;
}

export interface SnapshotStage {
  readonly status: StageStatus;
  readonly runs: readonly ReplayRun[];
  readonly summary: RunSummary;
}

export interface RunsStage {
  readonly status: StageStatus;
  readonly runs: readonly ReplayRun[];
}

export interface TrialStages {
  readonly fetch: FetchStage;
  readonly files: FilesStage;
  readonly host_install: HostInstallStage;
  readonly preflight: PreflightStage;
  readonly record: RecordStage;
  readonly prepare: PrepareStage;
  readonly install_baseline: BaselineStage;
  readonly snapshot: SnapshotStage;
  readonly pre_fix_checkout: RunsStage;
  readonly fix_verification: RunsStage;
}

export interface TrialResult {
  readonly trial_result_version: 1;
  readonly case: CaseRecord;
  readonly environment: EnvironmentRecord;
  readonly stages: TrialStages;
  readonly outcome: Outcome;
}
