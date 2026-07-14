import { describe, expect, it } from 'vitest';

import type { ReplayOperationResult } from './index.js';
import { evaluateRequiredReplayStatus } from './index.js';

const replayResult = (status: ReplayOperationResult['status']): ReplayOperationResult => ({
  result_schema_version: 1,
  operation: 'replay',
  status,
  mode: 'snapshot',
  warnings: [],
  errors: [],
  evidence: [],
  differences: [],
  substituted_paths: [],
  scope_limitations: [],
});

describe('evaluateRequiredReplayStatus', () => {
  it('accepts the requested classification without changing the result', () => {
    const result = replayResult('reproduced');

    expect(evaluateRequiredReplayStatus(result, 'reproduced')).toEqual({
      actual: 'reproduced',
      required: 'reproduced',
      satisfied: true,
    });
    expect(result.status).toBe('reproduced');
  });

  it('reports a policy mismatch independently from the classification', () => {
    const result = replayResult('not_reproduced');

    expect(evaluateRequiredReplayStatus(result, 'reproduced')).toEqual({
      actual: 'not_reproduced',
      required: 'reproduced',
      satisfied: false,
    });
    expect(result.status).toBe('not_reproduced');
  });
});
