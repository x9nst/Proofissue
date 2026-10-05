import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { RedactionLimitError, redactText } from './index.js';

// Synthetic secrets are assembled at runtime so no literal credential-shaped string exists in the
// repository. The canary marks every fake secret: any surviving copy is a leak.
const canary = ['SYNTHETIC', '_TEST_ONLY'].join('');
const bearer = ['Bear', 'er'].join('');
const S = canary;
const bs = '\\';
const q = '"';

const PASSWORD = '[REDACTED:password]';
const ENVIRONMENT = '[REDACTED:sensitive_environment]';
const HEADER = '[REDACTED:authorization_header]';

const redactOnce = (input: string): string => redactText(input).text;

describe('redactText 0.1.0 partial-leak regressions', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['unquoted with comma', `password=abc${S},tail${S}`, `password=${PASSWORD}`],
    ['unquoted with semicolon', `PASSWORD=abc${S};tail${S}`, `PASSWORD=${ENVIRONMENT}`],
    ['unquoted with space', `DB_PASSWORD=abc${S} tail${S}`, `DB_PASSWORD=${ENVIRONMENT}`],
    ['unquoted with quote inside', `API_KEY=abc${S}${q}tail${S}`, `API_KEY=${ENVIRONMENT}`],
    [
      'JSON escaped quote',
      `{${q}password${q}: ${q}ab${S}${bs}${q}tail${S}${q}}`,
      `{${q}password${q}: ${PASSWORD}}`,
    ],
    ['cookie quoted value', `Cookie: session=${q}abc${S}${q}; other=${S}x`, `Cookie: ${HEADER}`],
    ['set-cookie with quote', `Set-Cookie: sid=${q}${S}tail${q}`, `Set-Cookie: ${HEADER}`],
    [
      'bearer with comma',
      `Authorization: ${bearer} abc${S},tail${S}`,
      `Authorization: ${bearer} ${HEADER}`,
    ],
    ['bearer quoted', `authorization: ${q}${bearer} abc${S}${q}`, `authorization: ${HEADER}`],
    ['camelCase password', `userPassword=abc${S}`, `userPassword=${PASSWORD}`],
    ['camelCase apiKey', `myApiKey: abc${S}`, `myApiKey: ${ENVIRONMENT}`],
    ['yaml key', `password: abc${S}`, `password: ${PASSWORD}`],
    ['url password with slash', `https://user:ab${S}/cd${S}@host`, `https://user:${PASSWORD}@host`],
    ['url password with @', `https://user:ab@${S}x@host`, `https://user:${PASSWORD}@host`],
    ['basic header', `Authorization: Basic dXNlcjpw${S}YXNz`, `Authorization: Basic ${HEADER}`],
    [
      'env export quoted with space',
      `export NPM_TOKEN=${q}abc ${S} def${S}${q}`,
      `export NPM_TOKEN=${ENVIRONMENT}`,
    ],
    ['single-quoted with spaces', `secret_key='ab ${S} cd'`, `secret_key=${ENVIRONMENT}`],
    ['token value with dot', `GITHUB_TOKEN=ab${S}.cd${S}`, `GITHUB_TOKEN=${ENVIRONMENT}`],
    ['flag and value', `--password ${S}`, `--password ${PASSWORD}`],
    // Fuzz counterexample: the shell reads '',x as the single word ,x, so a closed quote does
    // not end a flag value.
    [
      'flag with an empty quote joined to the secret',
      `--password '',${S}`,
      `--password ${PASSWORD}`,
    ],
    ['flag equals with an empty quote', `--token=${q}${q},${S}`, `--token=${ENVIRONMENT}`],
    ['flag equals value', `--password=${S}tail`, `--password=${PASSWORD}`],
    ['header colon no space', `x-api-key:${S}`, `x-api-key:${HEADER}`],
    // Extra cases.
    ['raw authorization value', `Authorization: ab${S}cd,ef`, `Authorization: ${HEADER}`],
    [
      'flag with prefix words and a following flag',
      `--github-token ${S} --verbose`,
      `--github-token ${ENVIRONMENT}`,
    ],
    ['camelCase suffix name', `githubToken: ${S}`, `githubToken: ${ENVIRONMENT}`],
    ['yaml block scalar', `password: |\n  ${S}\n  ${S}\nnext: 1`, `password: ${PASSWORD}\nnext: 1`],
    ['backtick template value', `const apiKey = \`${S}\`;`, `const apiKey = ${ENVIRONMENT};`],
    [
      'url user name with @',
      `https://me@corp.example:pw${S}@host/x`,
      `https://me@corp.example:${PASSWORD}@host/x`,
    ],
    [
      'JSON authorization with escaped quote',
      `{${q}Authorization${q}: ${q}${bearer} ab${bs}${q}${S}${q}}`,
      `{${q}Authorization${q}: ${q}${bearer} ${HEADER}${q}}`,
    ],
    ['bare flag equals', `--token=${S}`, `--token=${ENVIRONMENT}`],
    ['bare secret name', `secret: ${S}`, `secret: ${ENVIRONMENT}`],
  ];

  it.each(cases)('redacts the whole value: %s', (_name, input, expected) => {
    const first = redactText(input);

    expect(first.text).toBe(expected);
    expect(first.text).not.toContain(canary);
    const second = redactText(first.text);
    expect(second.text).toBe(first.text);
    expect(second.findings).toEqual([]);
  });
});

describe('redactText whole-value false positives', () => {
  it.each([
    'token: 5',
    'tokens: 5',
    'max_tokens=5',
    'token_count = 10',
    'MAX_TOKEN_COUNT=64',
    'password field is required',
    'Enter your password',
    'JsonWebTokenError: invalid signature',
    'TokenExpiredError: jwt expired',
    'maxTokens: 5',
    'isTokenValid: true',
    'tokenCount: 5',
    'id-token: write',
    '--passWithNoTests',
    'secrets: inherit',
    '--no-password-prompt',
  ])('leaves %j unchanged', (input) => {
    expect(redactText(input)).toEqual({ text: input, findings: [] });
  });
});

describe('redactText known over-redaction', () => {
  it.each([
    ['isToken: true', `isToken: ${S}`],
    ['hasSecret: false', `hasSecret: ${S}`],
  ])('accepts a false positive for %s', (_name, input) => {
    expect(redactText(input).text).not.toContain(canary);
  });

  it('hides the rest of the line after a recognized credential', () => {
    expect(redactOnce('password=abc then more text\nnext line')).toBe(
      `password=${PASSWORD}\nnext line`,
    );
  });

  it('records two findings for DATABASE_URL with URL credentials', () => {
    const result = redactText(`DATABASE_URL=scheme://u:p${S}@h`);
    expect(result.findings).toHaveLength(2);
    expect(result.text).not.toContain(canary);
  });
});

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 600_000;

const VALUE_FRAGMENTS = [
  ',',
  ';',
  ' ',
  '\t',
  '"',
  "'",
  '`',
  bs,
  '@',
  '/',
  ':',
  '=',
  '#',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '?',
  '&',
  '|',
  '>',
  '<',
  '%',
  '+',
  '.',
  '-',
  '_',
  'a',
  'Z',
  '0',
  'password=',
  'TOKEN:',
  `${bearer} `,
  'Cookie: ',
  'https://u:',
  '--token ',
];

const KEYS = [
  'password',
  'DB_PASSWORD',
  'userPassword',
  'myApiKey',
  'API_KEY',
  'client_secret',
  'GITHUB_TOKEN',
  'githubToken',
  'secret',
  'accessToken',
  'privateKey',
  'pwd',
  'dbPassword',
  'sessionToken',
  'secretKey',
  'authToken',
  'clientSecret',
];

const value = fc
  .tuple(
    fc.array(fc.constantFrom(...VALUE_FRAGMENTS), { maxLength: 8 }),
    fc.array(fc.constantFrom(...VALUE_FRAGMENTS), { maxLength: 8 }),
  )
  .map(([before, after]) => `${before.join('')}${canary}${after.join('')}`);

const escapeQuoted = (v: string): string =>
  v.replaceAll(bs, `${bs}${bs}`).replaceAll(q, `${bs}${q}`);
const jsonBody = (v: string): string => JSON.stringify(v).slice(1, -1);
const startsLikeQuotedOrBlock = (v: string): boolean => /^\s*["'`|>]/u.test(v);
const urlSafe = (v: string): boolean => !/[\s"'`<>]/u.test(v);

interface Form {
  readonly name: string;
  readonly build: (key: string, v: string) => string | undefined;
}

const FORMS: readonly Form[] = [
  { name: 'key=value', build: (k, v) => (startsLikeQuotedOrBlock(v) ? undefined : `${k}=${v}`) },
  { name: 'key: value', build: (k, v) => (startsLikeQuotedOrBlock(v) ? undefined : `${k}: ${v}`) },
  {
    name: 'json',
    build: (k, v) => `{${q}${k}${q}: ${JSON.stringify(v)}, ${q}user${q}: ${q}bob${q}}`,
  },
  { name: 'double quoted', build: (k, v) => `${k}=${q}${escapeQuoted(v)}${q}` },
  {
    name: 'single quoted',
    build: (k, v) => `${k}='${v.replaceAll(bs, bs + bs).replaceAll("'", `${bs}'`)}'`,
  },
  { name: 'bearer', build: (_k, v) => `Authorization: ${bearer} ${v}` },
  { name: 'raw authorization', build: (_k, v) => `Authorization: ${v}` },
  {
    name: 'json authorization',
    build: (_k, v) => `{${q}Authorization${q}: ${q}${bearer} ${jsonBody(v)}${q}}`,
  },
  { name: 'cookie', build: (_k, v) => `Cookie: a=1; session=${v}` },
  { name: 'set-cookie', build: (_k, v) => `Set-Cookie: sid=${v}` },
  { name: 'x-api-key', build: (_k, v) => `X-Api-Key: ${v}` },
  { name: 'password flag', build: (_k, v) => `--password ${v}` },
  { name: 'token flag', build: (_k, v) => `--api-token ${v}` },
  { name: 'yaml block', build: (k, v) => `${k}: |\n  ${v}\n  ${v}` },
  {
    name: 'url password',
    build: (_k, v) => (urlSafe(v) ? `https://user:${v}@db.example.test/main now` : undefined),
  },
];

describe('redactText no-fragment property', () => {
  it(
    'leaves no part of a recognized secret value, and redacting again changes nothing',
    () => {
      fc.assert(
        fc.property(fc.constantFrom(...FORMS), fc.constantFrom(...KEYS), value, (form, key, v) => {
          fc.pre(!v.includes('[REDACTED:'));
          const built = form.build(key, v);
          if (built === undefined) {
            fc.pre(false);
            return;
          }
          const input = `log: ${built}\nnext line`;
          let first;
          try {
            first = redactText(input);
          } catch (error: unknown) {
            if (error instanceof RedactionLimitError) return;
            throw error;
          }
          expect(first.text, `${form.name} ${JSON.stringify(input)}`).not.toContain(canary);
          expect(redactText(first.text).text, `${form.name} ${JSON.stringify(input)}`).toBe(
            first.text,
          );
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'keeps the next line when the value holds no credential words',
    () => {
      const alphabet = [
        ',',
        ';',
        ' ',
        '\t',
        '"',
        "'",
        '`',
        bs,
        '@',
        '/',
        ':',
        '=',
        '#',
        '{',
        '}',
        '[',
        ']',
        '(',
        ')',
        '?',
        '&',
        '|',
        '>',
        '<',
        '%',
        '+',
        '.',
        '-',
        '_',
        'a',
        'Z',
        '0',
      ];
      fc.assert(
        fc.property(
          fc.constantFrom(...KEYS),
          fc.array(fc.constantFrom(...alphabet), { minLength: 1, maxLength: 12 }),
          (key, parts) => {
            const v = parts.join('');
            fc.pre(!/^\s/u.test(v));
            const text = redactOnce(`log: ${key}=${v}\nnext line`);
            expect(text.endsWith('\nnext line'), JSON.stringify(text)).toBe(true);
          },
        ),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});

describe('redactText extended idempotence property', () => {
  it(
    'redacting redacted text changes nothing, with backslash and tab fragments',
    () => {
      const fragment = fc.constantFrom(
        'password',
        'token',
        'Token',
        'secret',
        'Secret',
        'API_KEY',
        'userPassword',
        'myToken',
        'Authorization',
        'Cookie',
        ': ',
        '=',
        '"',
        "'",
        '`',
        bs,
        `${bs}${q}`,
        '\t',
        ' ',
        '\n',
        '|',
        '>',
        '--',
        '--token ',
        '--password ',
        '{',
        '}',
        ',',
        ';',
        'https://',
        '://',
        '@',
        `${bearer} `,
        '[REDACTED:password]',
        '[REDACTED:api_key]',
        'x',
      );
      fc.assert(
        fc.property(fc.array(fragment, { maxLength: 24 }), (parts) => {
          let first;
          try {
            first = redactText(parts.join(''));
          } catch (error: unknown) {
            if (error instanceof RedactionLimitError) return;
            throw error;
          }
          expect(redactText(first.text).text).toBe(first.text);
        }),
        { numRuns: Math.max(3000, RUNS) },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});

describe('redactText linear time on 1 MiB adversarial input', () => {
  const MiB = 1 << 20;
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
    ['password separator then spaces', `password=${' '.repeat(MiB)}`],
    ['password separator then newlines', `password=${'\n'.repeat(MiB)}`],
    ['bearer scheme then spaces', `Authorization: ${bearer}${' '.repeat(MiB)}`],
    ['quoted bearer then spaces', `${q}authorization${q}: ${q}${bearer}${' '.repeat(MiB)}`],
    ['cookie then spaces', `Cookie:${' '.repeat(MiB)}`],
    ['URL schemes only', 'a://'.repeat(MiB / 4)],
    ['URL hosts with empty passwords', 'http://a:'.repeat(MiB / 9)],
    ['URL slashes', 'x://u:/'.repeat(MiB / 7)],
    ['URL long user name', `https://${'u'.repeat(MiB)}`],
    ['URL long password', `https://u:${'p'.repeat(MiB)}`],
    ['URL many at signs', `https://u:${'@'.repeat(MiB)}`],
    ['quote then backslashes', `password=${q}${bs.repeat(MiB)}`],
    ['quote then escaped quotes', `password=${q}${`${bs}${q}`.repeat(MiB / 2)}`],
    ['quote runs', `password=${q.repeat(MiB)}`],
    ['repeated camelCase names', 'aToken'.repeat(MiB / 6)],
    ['repeated secret', 'secret'.repeat(MiB / 6)],
    ['repeated password', 'password'.repeat(MiB / 8)],
    ['flag prefix words', '--a-'.repeat(MiB / 4)],
    ['flag then spaces', `--token${' '.repeat(MiB)}`],
    ['long flag names', '--a-b-c-d-e-token'.repeat(MiB / 17)],
    ['yaml block lines', `password: |\n${'  x\n'.repeat(MiB / 4)}`],
    ['yaml block newlines', `password: |${'\n'.repeat(MiB)}`],
    ['separator far away', `password${' '.repeat(MiB)}=`],
  ])('finishes within the time budget for %s', (_name, input) => {
    expect(timed(input)).toBeLessThan(budgetMs);
  });
});
