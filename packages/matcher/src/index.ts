import type { BoundedExecutionResult, Difference, MatchEvidence } from '@proofissue/contracts';

export interface MatchExpectation {
  readonly exit_code: number;
  readonly stderr_contains: readonly string[];
  readonly stdout_contains: readonly string[];
}

export interface MatchInput {
  readonly execution: BoundedExecutionResult;
  readonly expectation: MatchExpectation;
}

export interface MatchResult {
  readonly reproduced: boolean;
  readonly evidence: readonly MatchEvidence[];
  readonly differences: readonly Difference[];
}

export interface Matcher {
  match(input: MatchInput): MatchResult;
}
