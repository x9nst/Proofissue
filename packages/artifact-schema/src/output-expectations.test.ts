import { readFile } from 'node:fs/promises';

import { Ajv2020 } from 'ajv/dist/2020.js';
import fc from 'fast-check';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OUTPUT_NORMALIZATION,
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
const ESC = String.fromCharCode(27);
const MARKER = ['[REDACTED', ':api_key]'].join('');

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

describe('output expectation modes', () => {
  it('accepts exact, normalized contains, and normalized exact expectations', () => {
    const value = artifact(
      [{ mode: 'exact', value: 'checking\n' }],
      [
        { mode: 'contains', value: 'raw literal' },
        { mode: 'contains', normalize: ['line_endings', 'paths'], value: 'at <project>/a.mjs' },
        {
          mode: 'exact',
          normalize: ['durations'],
          value: 'took <duration>\n',
        },
        { mode: 'exact', normalize: [...DEFAULT_OUTPUT_NORMALIZATION], value: 'all rules\n' },
      ],
    );

    const result = validateArtifactValue(value);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.expect.stderr.map((item) => item.mode)).toEqual([
        'contains',
        'contains',
        'exact',
        'exact',
      ]);
      expect(result.artifact.expect.stderr[1]?.normalize).toEqual(['line_endings', 'paths']);
      expect(result.artifact.expect.stderr[0]).not.toHaveProperty('normalize');
    }
  });

  it('copies the rule list so a later change to the input cannot change the validated artifact', () => {
    const rules: ('line_endings' | 'paths')[] = ['line_endings', 'paths'];
    const result = validateArtifactValue(
      artifact([], [{ mode: 'contains', normalize: rules, value: 'at <project>/a' }]),
    );

    rules.reverse();

    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.artifact.expect.stderr[0]?.normalize).toEqual(['line_endings', 'paths']);
  });

  it('keeps every existing version 1 fixture valid and byte-identical', async () => {
    for (const name of ['minimal', 'canonical', 'with-dependencies']) {
      const text = await read(`valid/${name}.proofissue`);
      const parsed = parseAndValidateArtifact(text);

      expect(parsed.ok, name).toBe(true);
      if (parsed.ok) {
        for (const item of [...parsed.artifact.expect.stdout, ...parsed.artifact.expect.stderr]) {
          expect(item.mode).toBe('contains');
          expect(item).not.toHaveProperty('normalize');
        }
        if (name !== 'minimal') expect(serializeArtifact(parsed.artifact)).toBe(text);
      }
    }
  });

  it('rejects an unknown mode, an unknown rule, an empty rule list, and a repeated rule', () => {
    const withExpectation = (expectation: unknown): unknown => ({
      ...artifact([], []),
      expect: { exit_code: 1, stdout: [], stderr: [expectation] },
    });

    for (const bad of [
      { mode: 'fuzzy', value: 'x' },
      { mode: 'contains', normalize: ['unknown_rule'], value: 'x' },
      { mode: 'contains', normalize: [], value: 'x' },
      { mode: 'contains', normalize: ['paths', 'paths'], value: 'x' },
      { mode: 'contains', normalize: 'paths', value: 'x' },
      { mode: 'contains', normalize: ['paths'], value: 'x', extra: true },
      { mode: 'contains', normalize: [...OUTPUT_NORMALIZATION_RULES, 'paths'], value: 'x' },
    ]) {
      expect(errorsOf(withExpectation(bad)).map((error) => error.code)).toEqual([
        'schema_violation',
      ]);
    }
  });

  it('rejects rules out of the documented order', () => {
    const errors = errorsOf(
      artifact([], [{ mode: 'contains', normalize: ['paths', 'line_endings'], value: 'x' }]),
    );

    expect(errors).toEqual([
      {
        code: 'semantic_violation',
        message: 'Normalization rules must be listed once each, in the documented order.',
        path: '/expect/stderr/0/normalize',
      },
    ]);
  });

  it.each([
    ['exact', undefined],
    ['exact', ['line_endings']],
    ['contains', ['paths']],
  ] as const)('rejects redaction markers in %s values with rules %j', (mode, normalize) => {
    const expectation: ArtifactOutputExpectationV1 = {
      mode,
      ...(normalize === undefined ? {} : { normalize }),
      value: `token ${MARKER}`,
    };

    for (const value of [artifact([expectation], []), artifact([], [expectation])]) {
      expect(errorsOf(value)).toEqual([
        expect.objectContaining({
          code: 'semantic_violation',
          message: 'Redaction replacements cannot be used as matching evidence.',
        }) as unknown,
      ]);
    }
  });

  it.each([
    ['a duration', 'durations', 'took 5ms'],
    ['a Node.js version', 'node_version', 'Node.js v24.15.0'],
    ['a Node.js internal location', 'node_internal_locations', 'node:internal/x:12:3'],
    ['a process ID', 'process_ids', '(node:123) x'],
    ['a carriage return', 'line_endings', 'a\r\nb'],
    ['an escape sequence', 'ansi_escapes', `${ESC}[31mred`],
    ['trailing whitespace', 'trailing_whitespace', 'line  \nnext'],
  ] as const)(
    'rejects normalized values that their own rules would change: %s',
    (_name, rule, value) => {
      for (const mode of ['contains', 'exact'] as const) {
        expect(errorsOf(artifact([], [{ mode, normalize: [rule], value }]))).toEqual([
          {
            code: 'semantic_violation',
            message: 'Normalized value contains text its normalization rules would change.',
            path: '/expect/stderr/0',
          },
        ]);
        // The same text is a perfectly good raw value, or a value for other rules.
        expect(errorsOf(artifact([], [{ mode, value }]))).toEqual([]);
      }
    },
  );

  it('does not apply path rules when validating, because a stored value never holds a host path', () => {
    const result = errorsOf(
      artifact(
        [],
        [{ mode: 'contains', normalize: ['paths'], value: 'at /workspace/test/a.mjs:1:1' }],
      ),
    );

    expect(result).toEqual([]);
  });

  it('keeps the limits that already applied to output expectations', () => {
    const tooMany = Array.from({ length: 17 }, (_, index) => ({
      mode: 'exact' as const,
      value: `value ${String(index)}`,
    }));
    const tooLong = 'é'.repeat(4097);

    expect(errorsOf(artifact([], tooMany)).map((error) => error.code)).toEqual([
      'schema_violation',
    ]);
    expect(
      errorsOf(artifact([], [{ mode: 'exact', value: tooLong }])).map((error) => error.message),
    ).toEqual(['Output expectation exceeds 8 KiB.']);
    expect(
      errorsOf({
        ...artifact([], []),
        expect: { exit_code: 1, stdout: [], stderr: [] },
      }).map((error) => error.message),
    ).toEqual(['A failing expectation must include output evidence.']);
  });
});

describe('serialization of output expectations', () => {
  const ruleSubset = fc.subarray([...OUTPUT_NORMALIZATION_RULES], { minLength: 1 });
  const fragments = fc
    .array(
      fc.constantFrom(
        'a',
        'b',
        ' ',
        '\t',
        '\n',
        '\r',
        ESC,
        '1',
        '5ms',
        ':',
        '"',
        '\\',
        '[',
        '<project>',
      ),
      { minLength: 1, maxLength: 12 },
    )
    .map((parts) => parts.join(''));

  it(
    'serializes normalization lists canonically and round-trips',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom('contains', 'exact'),
          fc.option(ruleSubset, { nil: undefined }),
          fragments,
          (mode, rules, raw) => {
            const value =
              rules === undefined
                ? raw
                : normalizeOutput(raw, rules, EMPTY_OUTPUT_PATH_CONTEXT).text;
            fc.pre(value.length > 0);
            const expectation: ArtifactOutputExpectationV1 = {
              mode,
              ...(rules === undefined ? {} : { normalize: rules }),
              value,
            };
            const text = serializeArtifact(artifact([], [expectation]));
            const parsed = parseAndValidateArtifact(text);

            expect(parsed.ok).toBe(true);
            if (!parsed.ok) return;
            expect(parsed.artifact.expect.stderr).toEqual([expectation]);
            expect(serializeArtifact(parsed.artifact)).toBe(text);
            expect(text.includes('normalize:')).toBe(rules !== undefined);
          },
        ),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it('writes the rule list between the mode and the value, one rule per line', () => {
    const text = serializeArtifact(
      artifact(
        [],
        [{ mode: 'contains', normalize: ['line_endings', 'paths'], value: 'at <project>/a' }],
      ),
    );

    expect(text).toContain(
      [
        '  stderr:',
        '    - mode: contains',
        '      normalize:',
        '        - line_endings',
        '        - paths',
        '      value: "at <project>/a"',
        '',
      ].join('\n'),
    );
  });

  it('refuses to serialize an expectation that does not validate', () => {
    expect(() =>
      serializeArtifact(
        artifact([], [{ mode: 'contains', normalize: ['paths', 'line_endings'], value: 'x' }]),
      ),
    ).toThrow('Normalization rules must be listed once each, in the documented order.');
  });
});

describe('output-mode compatibility fixtures', () => {
  it.each(['exact-output', 'normalized-output'])(
    'the %s fixture validates and is byte-canonical',
    async (name) => {
      const text = await read(`valid/${name}.proofissue`);
      const parsed = parseAndValidateArtifact(text);

      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(serializeArtifact(parsed.artifact)).toBe(text);
    },
  );

  it('the fixtures use each new form', async () => {
    const exact = parseAndValidateArtifact(await read('valid/exact-output.proofissue'));
    const normalized = parseAndValidateArtifact(await read('valid/normalized-output.proofissue'));

    expect(exact.ok && normalized.ok).toBe(true);
    if (!exact.ok || !normalized.ok) return;
    expect(exact.artifact.expect.stdout).toEqual([
      { mode: 'exact', value: 'checking calculate(2)\n' },
    ]);
    expect(exact.artifact.expect.stderr[0]).toMatchObject({
      mode: 'exact',
      normalize: [...OUTPUT_NORMALIZATION_RULES],
    });
    expect(normalized.artifact.expect.stderr.map((item) => item.normalize)).toEqual([
      [...OUTPUT_NORMALIZATION_RULES],
      ['line_endings', 'paths'],
    ]);
  });

  it('a consumer that predates output modes rejects every new fixture and accepts the old ones', async () => {
    const legacySchema = JSON.parse(
      await read('legacy-schema/artifact-v1-contains-only.schema.json'),
    ) as object;
    const validateLegacy = new Ajv2020({ allErrors: false, strict: true }).compile(legacySchema);
    const legacyAccepts = async (relative: string): Promise<boolean> =>
      validateLegacy(parse(await read(relative), { schema: 'core' }) as unknown);

    for (const old of ['minimal', 'canonical', 'with-dependencies']) {
      expect(await legacyAccepts(`valid/${old}.proofissue`), old).toBe(true);
    }
    for (const added of ['exact-output', 'normalized-output', 'regex-output']) {
      expect(await legacyAccepts(`valid/${added}.proofissue`), added).toBe(false);
    }
  });

  it('rejects the invalid output-mode fixtures', async () => {
    const result = parseAndValidateArtifact(
      await read('invalid/normalize-out-of-order.proofissue'),
    );

    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: 'semantic_violation',
          message: 'Normalization rules must be listed once each, in the documented order.',
          path: '/expect/stderr/1/normalize',
        },
      ],
    });
  });
});
