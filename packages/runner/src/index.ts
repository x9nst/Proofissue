import type { ValidatedArtifactReference } from '@proofissue/artifact-schema';
import type {
  BoundedExecutionResult,
  CleanupSummary,
  EffectiveLimits,
} from '@proofissue/contracts';

export interface ReplayRequest {
  readonly artifact: ValidatedArtifactReference;
  readonly against_path?: string;
  readonly mode: 'snapshot' | 'current_checkout';
}

export interface RunnerResult {
  readonly cleanup: CleanupSummary;
  readonly effective_limits: EffectiveLimits;
  readonly execution: BoundedExecutionResult;
  readonly substituted_paths: readonly string[];
}

export interface Runner {
  run(request: ReplayRequest): Promise<RunnerResult>;
}
