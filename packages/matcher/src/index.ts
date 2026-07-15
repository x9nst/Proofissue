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

const exitCodeEvidence = (exitCode: number): MatchEvidence => ({
  kind: 'exit_code',
  message: `Exit code matched: ${String(exitCode)}.`,
});

const outputEvidence = (stream: 'stderr' | 'stdout'): MatchEvidence => ({
  kind: `${stream}_contains`,
  message: `Expected ${stream} text was present.`,
});

const missingOutput = (stream: 'stderr' | 'stdout', truncated: boolean): Difference =>
  truncated
    ? {
        kind: 'insufficient_output',
        message: `Retained ${stream} was truncated before the expected text could be established.`,
      }
    : {
        kind: stream === 'stderr' ? 'stderr_missing' : 'stdout_missing',
        message: `Expected ${stream} text was not present.`,
      };

export const matchExecution = (input: MatchInput): MatchResult => {
  const evidence: MatchEvidence[] = [];
  const differences: Difference[] = [];
  const { execution, expectation } = input;

  if (execution.exit_code === expectation.exit_code) {
    evidence.push(exitCodeEvidence(expectation.exit_code));
  } else {
    differences.push({
      kind: 'exit_code',
      message:
        execution.exit_code === undefined
          ? `Expected exit code ${String(expectation.exit_code)}, but execution did not return one.`
          : `Expected exit code ${String(expectation.exit_code)} but received ${String(execution.exit_code)}.`,
    });
  }

  for (const value of expectation.stdout_contains) {
    if (execution.stdout.decoded_text.includes(value)) evidence.push(outputEvidence('stdout'));
    else differences.push(missingOutput('stdout', execution.stdout.truncated));
  }
  for (const value of expectation.stderr_contains) {
    if (execution.stderr.decoded_text.includes(value)) evidence.push(outputEvidence('stderr'));
    else differences.push(missingOutput('stderr', execution.stderr.truncated));
  }

  return {
    reproduced: differences.length === 0,
    evidence,
    differences,
  };
};

export const createMatcher = (): Matcher => ({ match: matchExecution });
