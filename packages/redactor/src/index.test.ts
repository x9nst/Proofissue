import { describe, expect, it } from 'vitest';

import { RedactionLimitError, redactText } from './index.js';

const bearer = ['Bear', 'er'].join('');
const privateKeyBegin = ['-----BE', 'GIN PRIVATE KEY-----'].join('');

describe('redactText', () => {
  it.each([
    ['api_key', 'token=sk-proj-abcdefghijklmnopqrstuv', 'token=[REDACTED:api_key]'],
    [
      'authorization_header',
      `Authorization: ${bearer} synthetic-token-value`,
      'Authorization: Bearer [REDACTED:authorization_header]',
    ],
    ['password', 'password=synthetic-password', 'password=[REDACTED:password]'],
    [
      'sensitive_environment',
      'AWS_SECRET_ACCESS_KEY=synthetic-secret',
      'AWS_SECRET_ACCESS_KEY=[REDACTED:sensitive_environment]',
    ],
    [
      'private_key',
      `${privateKeyBegin}\nsynthetic\n-----END PRIVATE KEY-----`,
      '[REDACTED:private_key]',
    ],
  ] as const)('redacts representative %s values', (category, input, expected) => {
    const result = redactText(input);

    expect(result.text).toBe(expected);
    expect(result.text).not.toContain('synthetic');
    expect(result.findings).toEqual([{ category, replacement: `[REDACTED:${category}]` }]);
  });

  it('is deterministic and leaves ordinary text unchanged', () => {
    const input = 'Expected 4 from calculate(2)';
    expect(redactText(input)).toEqual(redactText(input));
    expect(redactText(input)).toEqual({ text: input, findings: [] });
  });

  it('fails closed when safe finding metadata would exceed the artifact limit', () => {
    const input = Array.from(
      { length: 101 },
      (_, index) => `password=synthetic-${String(index)}`,
    ).join('\n');
    expect(() => redactText(input)).toThrow(RedactionLimitError);
  });
});
