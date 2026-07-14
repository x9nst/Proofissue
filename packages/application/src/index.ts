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
  InspectOperationResult,
  RecordOperationResult,
  ReplayOperationResult,
  ReplayStatus,
  ValidateOperationResult,
} from '@proofissue/contracts';

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
