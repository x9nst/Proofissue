import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { sha256 } from '@proofissue/artifact-schema';
import {
  createOutputPathContext,
  DEFAULT_OUTPUT_NORMALIZATION,
  normalizeOutput,
} from '@proofissue/output-rules';

import { finalizeRecording, DEFAULT_RECORD_LIMITS } from './index.js';
import type { RecordObservation } from './index.js';
import {
  LISTING_LIMITS,
  listObservation,
  parseLineId,
  SUGGESTION_RULES,
  splitLines,
} from './observation.js';

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 20_000 + RUNS * 10;

const ESC = String.fromCharCode(27);
const bearer = ['Bear', 'er'].join('');

// The project directory is replaced by output normalization; the second directory stands for
// a home directory, which only the host context knows about.
const contexts = {
  host: createOutputPathContext({
    platform: 'posix',
    project_roots: ['/work/project', '/srv/otherhome'],
    temporary_roots: [],
  }),
  output: createOutputPathContext({
    platform: 'posix',
    project_roots: ['/work/project'],
    temporary_roots: ['/tmp'],
  }),
};

const stream = (text: string, truncated = false) => ({
  decoded_text: text,
  discarded_bytes: 0,
  had_decoding_replacement: false,
  retained_bytes: Buffer.byteLength(text, 'utf8'),
  total_bytes: Buffer.byteLength(text, 'utf8'),
  truncated,
});

const observation = (
  stdout: string,
  stderr: string,
  overrides: Partial<RecordObservation> = {},
): RecordObservation => ({
  arguments: ['test/reproduction.mjs'],
  contexts,
  duration_ms: 5,
  environment_image: `node@sha256:${'1'.repeat(64)}`,
  exit_code: 1,
  files: [
    {
      path: 'test/reproduction.mjs',
      role: 'reproduction',
      encoding: 'utf8',
      content: 'a\n',
      sha256: sha256('a\n'),
    },
    {
      path: 'src/subject.mjs',
      role: 'subject',
      encoding: 'utf8',
      content: 'b\n',
      sha256: sha256('b\n'),
    },
  ],
  findings: [],
  limits: DEFAULT_RECORD_LIMITS,
  stdout: stream(stdout),
  stderr: stream(stderr),
  ...overrides,
});

describe('listObservation', () => {
  it('lists normalized lines with stable ids per stream', () => {
    const listing = listObservation(
      observation('first\r\nsecond   \n', `  indented ${ESC}[31mred${ESC}[0m\n\nlast\n`),
    );

    expect(listing.stdout.lines.map((line) => [line.id, line.text])).toEqual([
      ['o1', 'first'],
      ['o2', 'second'],
    ]);
    expect(listing.stderr.lines.map((line) => [line.id, line.text, line.selectable])).toEqual([
      ['e1', 'indented red', true],
      ['e2', '', false],
      ['e3', 'last', true],
    ]);
    expect(listing.stderr.lines[1]?.reason).toBe('empty');
    expect(listing.stdout.total_lines).toBe(2);
    expect(listing.stdout.omitted_lines).toBe(0);
  });

  it('replaces the project directory and durations in the listed text', () => {
    const listing = listObservation(
      observation('', 'Error at /work/project/test/a.mjs after 12ms\n'),
    );

    expect(listing.stderr.lines[0]?.text).toBe('Error at <project>/test/a.mjs after <duration>');
  });

  it('marks redaction markers, local paths, likely secrets, and oversized lines as not selectable', () => {
    const secretLine = `Authorization: ${bearer} abcdefghijklmnop1234567890`;
    const listing = listObservation(
      observation(
        [
          'password=[REDACTED:password]',
          'opened /srv/otherhome/notes.txt',
          secretLine,
          'x'.repeat(8193),
          'x'.repeat(8192),
          'plain line',
          '',
        ].join('\n'),
        '',
      ),
    );

    expect(
      listing.stdout.lines.map((line) => [line.id, line.selectable, line.reason ?? null]),
    ).toEqual([
      ['o1', false, 'redaction_marker'],
      ['o2', false, 'local_path'],
      ['o3', false, 'likely_secret'],
      ['o4', false, 'too_long'],
      ['o5', true, null],
      ['o6', true, null],
    ]);
  });

  it('bounds the listing to 200 lines per stream and reports the omitted count', () => {
    const many = Array.from({ length: 1000 }, (_, index) => `line ${String(index + 1)}`).join('\n');

    const listing = listObservation(observation(many, 'only\n'));

    expect(listing.stdout.lines).toHaveLength(LISTING_LIMITS.lines);
    expect(listing.stdout.total_lines).toBe(1000);
    expect(listing.stdout.omitted_lines).toBe(800);
    expect(listing.stdout.lines[0]?.id).toBe('o1');
    expect(listing.stdout.lines[49]?.id).toBe('o50');
    expect(listing.stdout.lines[50]?.id).toBe('o851');
    expect(listing.stdout.lines.at(-1)?.id).toBe('o1000');
    expect(listing.stderr.omitted_lines).toBe(0);
  });

  it('lists exactly 200 lines without omitting any', () => {
    const exact = Array.from({ length: 200 }, (_, index) => `line ${String(index + 1)}`).join('\n');

    const listing = listObservation(observation(exact, ''));

    expect(listing.stdout.omitted_lines).toBe(0);
    expect(listing.stdout.lines).toHaveLength(200);
  });

  it('never suggests a line from the omitted middle', () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${String(index + 1)}`);
    lines[200] = 'AssertionError: hidden in the middle';

    const listing = listObservation(observation(lines.join('\n'), ''));

    expect(listing.suggestion).toBeUndefined();
  });
});

describe('suggestion rules', () => {
  const suggest = (stdout: string, stderr: string) =>
    listObservation(observation(stdout, stderr)).suggestion;

  it('suggests by the documented rule priority', () => {
    // Rule 1 beats every later rule, and stderr beats stdout within a rule.
    expect(
      suggest(
        'not ok 1 - adds\n1 failing\n',
        [
          'Expected 4 from calculate(2)',
          'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal',
        ].join('\n'),
      ),
    ).toMatchObject({ id: 'e2', rule: 'assertion_error', stream: 'stderr' });

    // node:test: the failure message, not the TAP line.
    expect(
      suggest(
        ['not ok 1 - adds', '  failureType: testCodeFailure'].join('\n'),
        'Error: Expected 4 from calculate(2)\n    at file:///x\n',
      ),
    ).toMatchObject({ id: 'e1', rule: 'named_error' });

    // mocha plus chai: "expected 3 to equal 4" under an AssertionError heading.
    expect(
      suggest('  1 failing\n\n  1) adds:\n     AssertionError: expected 3 to equal 4\n', ''),
    ).toMatchObject({ id: 'o4', rule: 'assertion_error' });

    // A thrown Error on stderr, with an optional code in brackets.
    expect(suggest('', 'Uncaught TypeError [ERR_X]: cannot read properties\n')).toMatchObject({
      id: 'e1',
      rule: 'named_error',
    });

    // The remaining rules, one each.
    expect(suggest('', 'Expected 4 from calculate(2)\n')).toMatchObject({
      id: 'e1',
      rule: 'expected_line',
    });
    expect(suggest('we expected the result to be 4\n', '')).toMatchObject({
      id: 'o1',
      rule: 'expected_to',
    });
    expect(suggest('ok 1 - a\nnot ok 2 - b\n', '')).toMatchObject({
      id: 'o2',
      rule: 'tap_not_ok',
    });
    expect(suggest('3 passing\n2 failing\n', '')).toMatchObject({
      id: 'o2',
      rule: 'failing_count',
    });
  });

  it('suggests nothing when no line matches a rule', () => {
    expect(suggest('hello\nworld\n', 'it broke\n')).toBeUndefined();
  });

  it('never suggests a line that cannot be chosen', () => {
    expect(suggest('', 'Error: [REDACTED:password] leaked\nError: second\n')).toMatchObject({
      id: 'e2',
    });
  });

  it('keeps the rule table stable', () => {
    expect(SUGGESTION_RULES.map((rule) => [rule.name, rule.pattern.source])).toEqual([
      ['assertion_error', '\\bAssertionError\\b'],
      ['named_error', '^(?:Uncaught )?(?:[A-Z][A-Za-z]*)?Error(?: \\[[A-Z0-9_]+\\])?: \\S'],
      ['expected_line', '^Expected\\b'],
      ['expected_to', '\\bexpected\\b.+\\bto\\b'],
      ['tap_not_ok', '^not ok \\d+'],
      ['failing_count', '^\\d+ failing$'],
    ]);
  });
});

describe('parseLineId', () => {
  it.each([
    ['o1', { number: 1, stream: 'stdout' }],
    ['e12', { number: 12, stream: 'stderr' }],
  ] as const)('reads %s', (value, expected) => {
    expect(parseLineId(value)).toEqual(expected);
  });

  it.each(['', 'o', 'o0', 'o01', 'x1', 'e-1', 'e1.5', ' e1', 'e1 ', 'e12345678'])(
    'rejects %j',
    (value) => {
      expect(parseLineId(value)).toBeUndefined();
    },
  );
});

describe('selected lines', () => {
  it('stores a chosen line as a normalized contains expectation', () => {
    const capture = finalizeRecording(
      observation('', '  Expected 4 from calculate(2) after 12ms\n'),
      { expect_stdout: [], expect_stderr: [{ mode: 'line', line: 1 }] },
    );

    expect(capture.artifact.expect.stderr).toEqual([
      {
        mode: 'contains',
        normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
        value: 'Expected 4 from calculate(2) after <duration>',
      },
    ]);
  });

  it.each([
    ['empty', '\n\n', 2, 'it is empty'],
    ['a redaction marker', 'token=[REDACTED:token]\n', 1, 'redaction marker'],
    ['a host path', 'see /srv/otherhome/x\n', 1, 'local path'],
    ['a missing line', 'one\n', 2, 'has no line 2'],
  ])('refuses %s without repeating the line', (_name, text, line, message) => {
    let failure: unknown;
    try {
      finalizeRecording(observation('', text), {
        expect_stdout: [],
        expect_stderr: [{ mode: 'line', line }],
      });
    } catch (error: unknown) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    const text_ = (failure as Error).message;
    expect(text_).toContain(message);
    expect(text_).not.toContain('REDACTED');
    expect(text_).not.toContain('otherhome');
  });

  it('refuses a likely secret with a redaction error', () => {
    expect(() =>
      finalizeRecording(observation('', `Authorization: ${bearer} abcdefghijklmnop1234567890\n`), {
        expect_stdout: [],
        expect_stderr: [{ mode: 'line', line: 1 }],
      }),
    ).toThrow(/likely secret/u);
  });

  const lineParts = [
    'Error',
    'Expected 4',
    '  indented',
    '\tTabbed',
    'at /work/project/src/a.mjs:3:9',
    'took 15ms',
    `${ESC}[31mred${ESC}[0m`,
    '<project>/x',
    '<duration>',
    '/tmp/abc',
    'v24.1.0',
    'pid 1234',
    '[REDACTED:token]',
    '/srv/otherhome/f',
    ' ',
    '',
    ' nbsp',
    ' ',
    'x'.repeat(40),
  ];
  const arbitraryText = fc
    .array(
      fc.array(fc.constantFrom(...lineParts), { maxLength: 4 }).map((p) => p.join(' ')),
      {
        maxLength: 12,
      },
    )
    .chain((lines) =>
      fc
        .constantFrom('\n', '\r\n', '\r')
        .map((separator) => `${lines.join(separator)}${lines.length > 0 ? separator : ''}`),
    );

  it(
    'every selectable line stored as a normalized contains expectation matches its own recording',
    () => {
      fc.assert(
        fc.property(arbitraryText, arbitraryText, fc.nat(), (stdout, stderr, pick) => {
          const recorded = observation(stdout, stderr);
          const listing = listObservation(recorded);
          const selectable = [...listing.stdout.lines, ...listing.stderr.lines].filter(
            (line) => line.selectable,
          );
          if (selectable.length === 0) return;
          const chosen = selectable[pick % selectable.length];
          if (chosen === undefined) return;

          const capture = finalizeRecording(recorded, {
            expect_stdout:
              chosen.stream === 'stdout' ? [{ mode: 'line', line: chosen.number }] : [],
            expect_stderr:
              chosen.stream === 'stderr' ? [{ mode: 'line', line: chosen.number }] : [],
          });

          const stored = capture.artifact.expect[chosen.stream];
          expect(stored).toHaveLength(1);
          const value = stored[0]?.value;
          expect(value).toBe(chosen.text);
          const normalized = normalizeOutput(
            chosen.stream === 'stdout' ? stdout : stderr,
            DEFAULT_OUTPUT_NORMALIZATION,
            contexts.output,
          ).text;
          expect(normalized.includes(value ?? '')).toBe(true);
          expect(splitLines(normalized).some((line) => line.trimStart() === value)).toBe(true);
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
