import { describe, expect, it } from 'vitest';

import type { BoundedExecutionResult } from '@proofissue/contracts';

import { matchExecution } from './index.js';

const stream = (text: string, truncated = false) => ({
  decoded_text: text,
  discarded_bytes: truncated ? 10 : 0,
  had_decoding_replacement: false,
  retained_bytes: Buffer.byteLength(text),
  total_bytes: Buffer.byteLength(text) + (truncated ? 10 : 0),
  truncated,
});

const execution = (overrides: Partial<BoundedExecutionResult> = {}): BoundedExecutionResult => ({
  duration_ms: 10,
  exit_code: 1,
  stderr: stream('failure marker'),
  stdout: stream('details'),
  termination_reason: 'exited',
  ...overrides,
});

describe('basic matcher', () => {
  it('requires the exact exit code and every literal output expectation', () => {
    expect(
      matchExecution({
        execution: execution(),
        expectation: {
          exit_code: 1,
          stderr_contains: ['failure marker'],
          stdout_contains: ['details'],
        },
      }),
    ).toEqual({
      reproduced: true,
      evidence: [
        { kind: 'exit_code', message: 'Exit code matched: 1.' },
        { kind: 'stdout_contains', message: 'Expected stdout text was present.' },
        { kind: 'stderr_contains', message: 'Expected stderr text was present.' },
      ],
      differences: [],
    });
  });

  it('does not classify an unrelated failure with the same exit code as reproduced', () => {
    const result = matchExecution({
      execution: execution({ stderr: stream('a different failure') }),
      expectation: { exit_code: 1, stderr_contains: ['failure marker'], stdout_contains: [] },
    });

    expect(result.reproduced).toBe(false);
    expect(result.evidence).toContainEqual({ kind: 'exit_code', message: 'Exit code matched: 1.' });
    expect(result.differences).toContainEqual({
      kind: 'stderr_missing',
      message: 'Expected stderr text was not present.',
    });
  });

  it('reports insufficient evidence when required text may be beyond retained output', () => {
    const result = matchExecution({
      execution: execution({ stderr: stream('retained prefix', true) }),
      expectation: { exit_code: 1, stderr_contains: ['failure marker'], stdout_contains: [] },
    });

    expect(result.reproduced).toBe(false);
    expect(result.differences).toEqual([
      {
        kind: 'insufficient_output',
        message: 'Retained stderr was truncated before the expected text could be established.',
      },
    ]);
  });

  it('returns the same explanation for the same bounded input', () => {
    const input = {
      execution: execution(),
      expectation: { exit_code: 1, stderr_contains: ['failure'], stdout_contains: ['details'] },
    } as const;
    expect(matchExecution(input)).toEqual(matchExecution(input));
  });
});
