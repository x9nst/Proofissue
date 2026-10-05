import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RedactionLimitError, redactText, type RedactionCategory } from './index.js';

// Secret-shaped values are assembled at runtime so no literal credential-like string
// exists in the repository for secret scanners to flag.
const join = (...parts: readonly string[]): string => parts.join('');
const bearer = join('Bear', 'er');
const pem = (label: string, body: string, end = true): string =>
  join(
    '-----BE',
    'GIN ',
    label,
    '-----\n',
    body,
    end ? join('\n-----EN', 'D ', label, '-----') : '',
  );

const awsAccess = join('AK', 'IA', '0123456789ABCDEF');
const awsSession = join('AS', 'IA', '0123456789ABCDEF');
const githubClassic = join('gh', 'p_', 'a'.repeat(36));
const githubFineGrained = join('github', '_pat_', 'A'.repeat(22), '_', 'B'.repeat(59));
const jwt = join('ey', 'J', 'a'.repeat(12), '.ey', 'J', 'b'.repeat(12), '.', 'c'.repeat(20));
const gitlab = join('gl', 'pat-', 'a'.repeat(20));
const slack = join('xo', 'xb-', '1234567890-abcdefghij');
const stripe = join('sk', '_live_', 'a'.repeat(24));
const google = join('AI', 'za', 'a'.repeat(35));
const npmToken = join('np', 'm_', 'a'.repeat(36));
const openAi = join('sk', '-proj-', 'abcdefghijklmnopqrstuv');

describe('redactText', () => {
  it.each([
    ['api_key', `token=${openAi}`, 'token=[REDACTED:api_key]'],
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
    ['private_key', pem('PRIVATE KEY', 'synthetic'), '[REDACTED:private_key]'],
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

interface Case {
  readonly category: RedactionCategory;
  readonly input: string;
  /** The secret value that must not survive redaction. */
  readonly secret: string;
  /** The exact text expected after redaction. */
  readonly expected: string;
}

const m = (category: RedactionCategory): string => `[REDACTED:${category}]`;

const CASES: readonly (readonly [string, Case])[] = [
  [
    'AWS access key id',
    {
      category: 'api_key',
      input: `key ${awsAccess} end`,
      secret: awsAccess,
      expected: `key ${m('api_key')} end`,
    },
  ],
  [
    'AWS temporary access key id',
    {
      category: 'api_key',
      input: `key ${awsSession} end`,
      secret: awsSession,
      expected: `key ${m('api_key')} end`,
    },
  ],
  [
    'GitHub classic token',
    {
      category: 'api_key',
      input: `x ${githubClassic}`,
      secret: githubClassic,
      expected: `x ${m('api_key')}`,
    },
  ],
  [
    'GitHub fine-grained token',
    {
      category: 'api_key',
      input: `x ${githubFineGrained}`,
      secret: githubFineGrained,
      expected: `x ${m('api_key')}`,
    },
  ],
  [
    'JSON web token',
    { category: 'api_key', input: `jwt=${jwt};`, secret: jwt, expected: `jwt=${m('api_key')};` },
  ],
  [
    'GitLab token',
    { category: 'api_key', input: `x ${gitlab}`, secret: gitlab, expected: `x ${m('api_key')}` },
  ],
  [
    'Slack token',
    { category: 'api_key', input: `x ${slack}`, secret: slack, expected: `x ${m('api_key')}` },
  ],
  [
    'Stripe secret key',
    { category: 'api_key', input: `x ${stripe}`, secret: stripe, expected: `x ${m('api_key')}` },
  ],
  [
    'Google API key',
    { category: 'api_key', input: `x ${google}`, secret: google, expected: `x ${m('api_key')}` },
  ],
  [
    'npm access token',
    {
      category: 'api_key',
      input: `x ${npmToken}`,
      secret: npmToken,
      expected: `x ${m('api_key')}`,
    },
  ],
  [
    'JSON Authorization header',
    {
      category: 'authorization_header',
      input: `{"Authorization": "${bearer} abc123def"}`,
      secret: 'abc123def',
      expected: `{"Authorization": "Bearer ${m('authorization_header')}"}`,
    },
  ],
  [
    'Token scheme',
    {
      category: 'authorization_header',
      input: 'Authorization: Token abc123def',
      secret: 'abc123def',
      expected: `Authorization: Token ${m('authorization_header')}`,
    },
  ],
  [
    'Digest scheme with several parameters',
    {
      category: 'authorization_header',
      input: 'Authorization: Digest username="u", response="deadbeef"\nnext line',
      secret: 'deadbeef',
      expected: `Authorization: Digest ${m('authorization_header')}\nnext line`,
    },
  ],
  [
    'Cookie header',
    {
      category: 'authorization_header',
      input: 'Cookie: session=abc123; theme=dark\nok',
      secret: 'abc123',
      expected: `Cookie: ${m('authorization_header')}\nok`,
    },
  ],
  [
    'Set-Cookie header',
    {
      category: 'authorization_header',
      input: 'Set-Cookie: sid=abc123; HttpOnly',
      secret: 'abc123',
      expected: `Set-Cookie: ${m('authorization_header')}`,
    },
  ],
  [
    'X-Api-Key header',
    {
      category: 'authorization_header',
      input: 'X-Api-Key: abc123def',
      secret: 'abc123def',
      expected: `X-Api-Key: ${m('authorization_header')}`,
    },
  ],
  [
    'double-quoted password',
    {
      category: 'password',
      input: 'password: "hunter2 with spaces"',
      secret: 'hunter2',
      expected: `password: ${m('password')}`,
    },
  ],
  [
    'JSON password',
    {
      category: 'password',
      input: '{"password":"hunter2"}',
      secret: 'hunter2',
      expected: `{"password":${m('password')}}`,
    },
  ],
  [
    'prefixed password name',
    {
      category: 'password',
      input: 'db_password=hunter2',
      secret: 'hunter2',
      expected: `db_password=${m('password')}`,
    },
  ],
  [
    'password with an unterminated quote',
    {
      category: 'password',
      input: 'password="hunter2',
      secret: 'hunter2',
      expected: `password=${m('password')}`,
    },
  ],
  [
    'credentials embedded in a URL',
    {
      category: 'password',
      input: 'connect postgres://app:hunter2@db.internal:5432/main now',
      secret: 'hunter2',
      expected: `connect postgres://app:${m('password')}@db.internal:5432/main now`,
    },
  ],
  [
    'AWS session token variable',
    {
      category: 'sensitive_environment',
      input: 'AWS_SESSION_TOKEN=abc123def',
      secret: 'abc123def',
      expected: `AWS_SESSION_TOKEN=${m('sensitive_environment')}`,
    },
  ],
  [
    'generic credential variable name',
    {
      category: 'sensitive_environment',
      input: 'STRIPE_WEBHOOK_SECRET="abc def"',
      secret: 'abc def',
      expected: `STRIPE_WEBHOOK_SECRET=${m('sensitive_environment')}`,
    },
  ],
  [
    'generic password variable name',
    {
      category: 'sensitive_environment',
      input: 'MY_SERVICE_PASSWORD=abc123def',
      secret: 'abc123def',
      expected: `MY_SERVICE_PASSWORD=${m('sensitive_environment')}`,
    },
  ],
  [
    'lowercase api key setting',
    {
      category: 'sensitive_environment',
      input: 'service.api_key = abc123def',
      secret: 'abc123def',
      expected: `service.api_key = ${m('sensitive_environment')}`,
    },
  ],
  [
    'npm registry auth token',
    {
      category: 'sensitive_environment',
      input: '//registry.example.test/:_authToken=abc123def',
      secret: 'abc123def',
      expected: `//registry.example.test/:_authToken=${m('sensitive_environment')}`,
    },
  ],
  [
    'encrypted private key',
    {
      category: 'private_key',
      input: `before\n${pem('ENCRYPTED PRIVATE KEY', 'abc123def')}\nafter`,
      secret: 'abc123def',
      expected: `before\n${m('private_key')}\nafter`,
    },
  ],
  [
    'PGP private key block',
    {
      category: 'private_key',
      input: pem('PGP PRIVATE KEY BLOCK', 'abc123def'),
      secret: 'abc123def',
      expected: m('private_key'),
    },
  ],
  [
    'private key truncated before its end line',
    {
      category: 'private_key',
      input: `log line\n${pem('RSA PRIVATE KEY', 'abc123def', false)}`,
      secret: 'abc123def',
      expected: `log line\n${m('private_key')}`,
    },
  ],
];

describe('redactText coverage', () => {
  it.each(CASES)('redacts %s', (_name, { category, input, secret, expected }) => {
    const result = redactText(input);

    expect(result.text).toBe(expected);
    expect(result.text).not.toContain(secret);
    expect(result.findings).toEqual([{ category, replacement: m(category) }]);
  });

  it.each(CASES)('is idempotent for %s', (_name, { input }) => {
    const first = redactText(input);
    const second = redactText(first.text);

    expect(second.text).toBe(first.text);
    expect(second.findings).toEqual([]);
  });
});

describe('redactText false positives', () => {
  it.each([
    'max_tokens=5',
    'token: IDENT',
    'tokens: 5',
    'token_count = 10',
    'passwords are hashed with a salt',
    'cookie recipe: flour, sugar',
    'NODE_ENV=production',
    'PATH=/usr/local/bin:/usr/bin',
    'author: Jane Doe',
    'https://example.com/path?x=1',
    'http://localhost:3000/health',
    'contact user@example.com',
    'task-force-alpha-bravo-charlie-delta',
    'eyJ is a prefix, not a token',
    join('AK', 'IA', 'TOOSHORT'),
    'Expected 4 from calculate(2)',
    'at Object.<anonymous> (/work/test.mjs:3:9)',
    'AssertionError: expected 4 to equal 5',
    'MAX_TOKEN_COUNT=64',
  ])('leaves %j unchanged', (input) => {
    expect(redactText(input)).toEqual({ text: input, findings: [] });
  });
});

describe('redactText idempotence regressions', () => {
  // Found by the property test below. A redaction marker contains a colon, so it must
  // never be readable as user:password inside a URL.
  it('does not read a marker as URL credentials', () => {
    const input = 'scheme://[REDACTED:api_key]@';

    expect(redactText(input)).toEqual({ text: input, findings: [] });
  });

  it('settles after one pass when a redacted token sits where URL credentials would', () => {
    const first = redactText(`token://${jwt}@`);

    expect(first.text).toBe(`token://${m('api_key')}@`);
    expect(redactText(first.text)).toEqual({ text: first.text, findings: [] });
  });
});

describe('redactText idempotence property', () => {
  it('redacting redacted text changes nothing, for text built from credential-like fragments', () => {
    const fragment = fc.constantFrom(
      'password',
      'token',
      'API_KEY',
      '_authToken',
      'Authorization',
      'Cookie',
      ': ',
      '=',
      '"',
      "'",
      ' ',
      '\n',
      '://',
      '@',
      'user',
      'abc123',
      'Bearer ',
      'Digest ',
      'x-api-key',
      'Set-Cookie',
      '[REDACTED:password]',
      '[REDACTED:api_key]',
      join('-----BE', 'GIN PRIVATE KEY-----'),
      join('-----EN', 'D PRIVATE KEY-----'),
      awsAccess,
      jwt,
      '[',
      ']',
      ':',
      '/',
      '//',
      '\r',
      'Basic ',
      'Token ',
      'passwd',
      '_password',
      '_auth',
      'SECRET',
      'TOKEN',
      '_',
      '.',
      '-',
      'x',
      '`',
      '|',
      '>',
      '--',
      '--token ',
      '--password ',
      'userPassword',
      'myToken',
      'secret',
      'Secret',
      '{',
      '}',
      ',',
      ';',
      'https://',
    );
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 32 }), (parts) => {
        const input = parts.join('');
        let first;
        try {
          first = redactText(input);
        } catch (error: unknown) {
          if (error instanceof RedactionLimitError) return;
          throw error;
        }
        expect(redactText(first.text).text).toBe(first.text);
      }),
      { numRuns: Math.max(3000, Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '0')) },
    );
  });
});

describe('redactText performance on adversarial input', () => {
  const budgetMs = 2000;
  const timed = (input: string): number => {
    const started = performance.now();
    try {
      redactText(input);
    } catch (error: unknown) {
      if (!(error instanceof RedactionLimitError)) throw error;
    }
    return performance.now() - started;
  };

  it.each([
    [
      'many unterminated private key headers',
      join('-----BE', 'GIN PRIVATE KEY-----').repeat(20_000),
    ],
    ['a long run of dotted words', 'a.'.repeat(200_000)],
    ['a long run of underscored words', 'A_'.repeat(200_000)],
    ['many unterminated quotes', 'password="'.repeat(20_000)],
    ['many URL schemes without credentials', 'http://a:'.repeat(30_000)],
    ['a very long single token', 'a'.repeat(1_000_000)],
    ['many header names without values', 'Cookie:'.repeat(30_000)],
  ])('finishes within the time budget for %s', (_name, input) => {
    expect(timed(input)).toBeLessThan(budgetMs);
  });
});
