import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  BOUNDED_REGEX_LIMITS,
  EMPTY_OUTPUT_PATH_CONTEXT,
  OUTPUT_NORMALIZATION_RULES,
  normalizeOutput,
} from '@proofissue/output-rules';

import type { ArtifactOutputExpectationV1, ArtifactV1 } from './index.js';
import {
  parseAndValidateArtifact,
  serializeArtifact,
  sha256,
  validateArtifactValue,
} from './index.js';

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 20_000 + RUNS * 5;

const FIXTURES = 'tests/fixtures/artifacts/v1';
const raw = String.raw;
const MARKER = ['REDACTED', ':api_key'].join('');

const read = async (relative: string): Promise<string> =>
  await readFile(`${FIXTURES}/${relative}`, 'utf8');

const artifact = (
  stdout: readonly ArtifactOutputExpectationV1[],
  stderr: readonly ArtifactOutputExpectationV1[],
): ArtifactV1 => {
  const reproduction = 'console.error("synthetic failure");\nprocess.exitCode = 1;\n';
  const subject = 'export const value = 1;\n';
  return {
    version: 1,
    environment: {
      runtime: 'node',
      runtime_version: '24',
      operating_system: 'linux',
      image: `node@sha256:${'1'.repeat(64)}`,
    },
    capture: { host_operating_system: 'linux', host_architecture: 'x64', node_version: '24.15.0' },
    command: { program: 'node', arguments: ['test/reproduction.mjs'], working_directory: '.' },
    files: [
      {
        path: 'test/reproduction.mjs',
        role: 'reproduction',
        encoding: 'utf8',
        content: reproduction,
        sha256: sha256(reproduction),
      },
      {
        path: 'src/subject.mjs',
        role: 'subject',
        encoding: 'utf8',
        content: subject,
        sha256: sha256(subject),
      },
    ],
    expect: { exit_code: 1, stdout, stderr },
    limits: {
      timeout_seconds: 60,
      memory_mb: 512,
      cpus: 1,
      processes: 64,
      output_bytes_per_stream: 1_048_576,
    },
    redaction: { enabled: true, findings: [] },
  };
};

const errorsOf = (value: unknown) => {
  const result = validateArtifactValue(value);
  return result.ok ? [] : result.errors;
};

const messagesFor = (pattern: string, stream: 'stderr' | 'stdout' = 'stderr') =>
  errorsOf(
    stream === 'stderr'
      ? artifact([], [{ mode: 'regex', value: pattern }])
      : artifact([{ mode: 'regex', value: pattern }], []),
  );

describe('regex output expectations', () => {
  it('accepts raw and normalized regex expectations', () => {
    const value = artifact(
      [{ mode: 'regex', value: raw`checking calculate\(\d+\)` }],
      [
        { mode: 'regex', normalize: [...OUTPUT_NORMALIZATION_RULES], value: raw`took <duration>` },
        { mode: 'regex', normalize: ['line_endings', 'paths'], value: raw`^at <project>/a\.mjs$` },
        { mode: 'contains', value: 'a plain literal' },
      ],
    );

    const result = validateArtifactValue(value);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.expect.stderr.map((item) => item.mode)).toEqual([
        'regex',
        'regex',
        'contains',
      ]);
      expect(result.artifact.expect.stdout[0]).not.toHaveProperty('normalize');
      expect(result.artifact.expect.stderr[1]?.normalize).toEqual(['line_endings', 'paths']);
    }
  });

  it('keeps the earlier fixtures valid, and the pattern in the mode enumeration', async () => {
    for (const name of [
      'minimal',
      'canonical',
      'with-dependencies',
      'exact-output',
      'normalized-output',
    ]) {
      const parsed = parseAndValidateArtifact(await read(`valid/${name}.proofissue`));
      expect(parsed.ok, name).toBe(true);
    }
  });

  it.each([
    ['a backreference', raw`(a)\1`, 'Backreferences are not supported.', 3],
    ['a lookahead', 'a(?=b)', 'Lookahead assertions are not supported.', 1],
    ['a negative lookahead', '(?!b)a', 'Lookahead assertions are not supported.', 0],
    ['a lookbehind', '(?<=a)b', 'Lookbehind assertions are not supported.', 0],
    ['a named group', '(?<n>a)', 'Named groups are not supported.', 0],
    ['a modifier group', '(?i:a)', 'Inline modifiers are not supported.', 0],
    ['a property escape', raw`\p{L}`, 'Unicode property escapes are not supported.', 0],
    ['a unicode escape', `${String.fromCharCode(92)}u0041`, 'The \\u escape is not supported', 0],
    ['an unterminated group', 'a(b', 'Unterminated group', 1],
    ['a lone bracket', 'a]', 'Lone bracket', 1],
  ] as const)('rejects %s with its feature and offset', (_name, pattern, fragment, offset) => {
    for (const stream of ['stdout', 'stderr'] as const) {
      const errors = messagesFor(pattern, stream);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe('semantic_violation');
      expect(errors[0]?.path).toBe(`/expect/${stream}/0`);
      expect(errors[0]?.message).toContain('Regular expression is not supported: ');
      expect(errors[0]?.message).toContain(fragment);
      expect(errors[0]?.message).toContain(`(offset ${String(offset)}).`);
      expect(errors[0]?.message).not.toContain(pattern);
    }
  });

  it('rejects regex patterns beyond the length, repetition, nesting, and size limits', () => {
    const limitMessages = [
      messagesFor('a'.repeat(BOUNDED_REGEX_LIMITS.pattern_characters + 1)),
      messagesFor('a{101}'),
      messagesFor(`${'('.repeat(17)}a${')'.repeat(17)}`),
      messagesFor('(a{100}){100}'),
    ].map((errors) => errors.map((error) => error.message));

    expect(limitMessages).toEqual([
      [
        'Regular expression is not supported: Pattern is longer than the limit of 1024 characters. (offset 1024).',
      ],
      [
        'Regular expression is not supported: Repetition count exceeds the limit of 100. (offset 2).',
      ],
      [
        'Regular expression is not supported: Groups are nested deeper than the limit of 16. (offset 16).',
      ],
      [
        'Regular expression is not supported: Pattern compiles to more than the limit of 2048 instructions. (offset 0).',
      ],
    ]);
  });

  it.each(['a*', '^', '$', raw`\b`, '(?:)', 'a|', '(a?)(b?)'])(
    'rejects the pattern %j that matches without consuming output',
    (pattern) => {
      const errors = messagesFor(pattern);

      expect(errors).toHaveLength(1);
      expect(errors[0]?.message).toContain(
        'Regular expression is not supported: Pattern can match without consuming output',
      );
    },
  );

  it('rejects redaction markers in a regex, including escaped markers', () => {
    for (const pattern of [MARKER, raw`\[${MARKER}\]`, `x${MARKER}+`, raw`\[${MARKER}`]) {
      const errors = messagesFor(pattern);

      expect(errors).toEqual([
        {
          code: 'semantic_violation',
          message: 'Redaction replacements cannot be used as matching evidence.',
          path: '/expect/stderr/0',
        },
      ]);
    }
  });

  it('still requires canonical rule order for a regex', () => {
    expect(
      errorsOf(
        artifact([], [{ mode: 'regex', normalize: ['paths', 'line_endings'], value: 'abc' }]),
      ),
    ).toEqual([
      {
        code: 'semantic_violation',
        message: 'Normalization rules must be listed once each, in the documented order.',
        path: '/expect/stderr/0/normalize',
      },
    ]);
  });

  it('does not apply the fixed-point rule to a pattern, because a pattern is not output', () => {
    // The text `took 5ms` is one its own durations rule would change, which a normalized
    // literal could never hold. A pattern is matched against normalized output, so it may.
    const pattern = 'took 5ms';
    expect(normalizeOutput(pattern, ['durations'], EMPTY_OUTPUT_PATH_CONTEXT).text).not.toBe(
      pattern,
    );
    expect(
      errorsOf(artifact([], [{ mode: 'regex', normalize: ['durations'], value: pattern }])),
    ).toEqual([]);
    expect(
      errorsOf(artifact([], [{ mode: 'contains', normalize: ['durations'], value: 'took 5ms' }])),
    ).toHaveLength(1);
  });

  it('counts a regex against the same limits as other expectations', () => {
    const many = Array.from({ length: 17 }, (_, index) => ({
      mode: 'regex' as const,
      value: `value${String(index)}`,
    }));

    expect(errorsOf(artifact([], many)).map((error) => error.code)).toEqual(['schema_violation']);
    expect(
      errorsOf(artifact([], [{ mode: 'regex', value: 'a'.repeat(8193) }])).map(
        (error) => error.code,
      ),
    ).toEqual(['schema_violation']);
  });

  it('rejects an unknown mode that resembles regex', () => {
    for (const mode of ['regexp', 'REGEX', 'pattern', 'glob']) {
      expect(
        errorsOf({
          ...artifact([], []),
          expect: { exit_code: 1, stdout: [], stderr: [{ mode, value: 'x' }] },
        }).map((error) => error.code),
      ).toEqual(['schema_violation']);
    }
  });

  it(
    'serializes regex expectations canonically and round-trips',
    () => {
      const ruleSubset = fc.subarray([...OUTPUT_NORMALIZATION_RULES], { minLength: 1 });
      const patterns = fc
        .array(
          fc.constantFrom('a', 'b+', raw`\d`, '.', '[ab]', '(?:xy)', '|z', raw`\.`, '"', ' '),
          {
            minLength: 1,
            maxLength: 8,
          },
        )
        .map((parts) => parts.join(''));
      fc.assert(
        fc.property(fc.option(ruleSubset, { nil: undefined }), patterns, (rules, pattern) => {
          const expectation: ArtifactOutputExpectationV1 = {
            mode: 'regex',
            ...(rules === undefined ? {} : { normalize: rules }),
            value: pattern,
          };
          const result = validateArtifactValue(artifact([], [expectation]));
          fc.pre(result.ok);
          const text = serializeArtifact(artifact([], [expectation]));
          const parsed = parseAndValidateArtifact(text);

          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          expect(parsed.artifact.expect.stderr).toEqual([expectation]);
          expect(serializeArtifact(parsed.artifact)).toBe(text);
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it('validation compiles exactly the patterns that normalizing text would never change', () => {
    // A tiny cross-check that validation and the matcher share one compiler: anything validation
    // accepts for a pattern is accepted again after a round trip through normalization of itself.
    const pattern = raw`Expected \d+ from calculate\(\d+\)`;
    expect(normalizeOutput(pattern, ['line_endings'], EMPTY_OUTPUT_PATH_CONTEXT).text).toBe(
      pattern,
    );
    expect(messagesFor(pattern)).toEqual([]);
  });
});

describe('regex compatibility fixtures', () => {
  it('the regex-output fixture validates, is byte-canonical, and uses each form', async () => {
    const text = await read('valid/regex-output.proofissue');
    const parsed = parseAndValidateArtifact(text);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeArtifact(parsed.artifact)).toBe(text);
    expect(parsed.artifact.expect.stdout.map((item) => [item.mode, item.normalize])).toEqual([
      ['regex', undefined],
    ]);
    expect(parsed.artifact.expect.stderr.map((item) => [item.mode, item.normalize])).toEqual([
      ['regex', [...OUTPUT_NORMALIZATION_RULES]],
      ['regex', ['line_endings', 'paths']],
    ]);
  });

  it('rejects the lookahead fixture with the feature and offset', async () => {
    const result = parseAndValidateArtifact(await read('invalid/regex-lookahead.proofissue'));

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'semantic_violation',
          message:
            'Regular expression is not supported: Lookahead assertions are not supported. (offset 9).',
          path: '/expect/stderr/0',
        },
      ],
    });
  });

  it('a consumer that predates regex rejects the new fixture and accepts every earlier one', async () => {
    const earlier = JSON.parse(
      await read('legacy-schema/artifact-v1-before-regex.schema.json'),
    ) as object;
    const validateEarlier = new Ajv2020({ allErrors: false, strict: true }).compile(earlier);
    const accepts = async (relative: string): Promise<boolean> =>
      validateEarlier(parse(await read(relative), { schema: 'core' }) as unknown);

    for (const old of [
      'minimal',
      'canonical',
      'with-dependencies',
      'exact-output',
      'normalized-output',
    ]) {
      expect(await accepts(`valid/${old}.proofissue`), old).toBe(true);
    }
    expect(await accepts('valid/regex-output.proofissue')).toBe(false);
    // The consumer before regex also lacks nothing else: it knew modes contains and exact.
    expect(
      JSON.stringify(
        (earlier as { properties: { expect: { properties: { stderr: unknown } } } }).properties
          .expect.properties.stderr,
      ),
    ).not.toContain('regex');
  });
});
