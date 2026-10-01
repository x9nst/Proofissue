import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { BoundedExecutionResult } from '@proofissue/contracts';
import { createOutputPathContext, EMPTY_OUTPUT_PATH_CONTEXT } from '@proofissue/output-rules';

import { createMatcher, matchExecution } from './index.js';
import type { MatchInput, OutputExpectation } from './index.js';

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 20_000 + RUNS * 5;

const ESC = String.fromCharCode(27);

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

const contains = (value: string): OutputExpectation => ({ mode: 'contains', value });
const exact = (value: string): OutputExpectation => ({ mode: 'exact', value });

const replayContext = createOutputPathContext({
  platform: 'posix',
  project_roots: ['/workspace'],
  temporary_roots: ['/tmp'],
});

const match = (
  run: BoundedExecutionResult,
  expectation: {
    readonly stderr?: readonly OutputExpectation[];
    readonly stdout?: readonly OutputExpectation[];
  },
  exitCode = 1,
) =>
  matchExecution({
    execution: run,
    expectation: { exit_code: exitCode, stderr: [], stdout: [], ...expectation },
    path_context: replayContext,
  });

describe('basic matcher', () => {
  it('requires the exact exit code and every literal output expectation', () => {
    expect(
      matchExecution({
        execution: execution(),
        expectation: {
          exit_code: 1,
          stderr: [contains('failure marker')],
          stdout: [contains('details')],
        },
        path_context: EMPTY_OUTPUT_PATH_CONTEXT,
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
    const result = match(execution({ stderr: stream('a different failure') }), {
      stderr: [contains('failure marker')],
    });

    expect(result.reproduced).toBe(false);
    expect(result.evidence).toContainEqual({ kind: 'exit_code', message: 'Exit code matched: 1.' });
    expect(result.differences).toContainEqual({
      kind: 'stderr_missing',
      message: 'Expected stderr text was not present.',
    });
  });

  it('reports insufficient evidence when required text may be beyond retained output', () => {
    const result = match(execution({ stderr: stream('retained prefix', true) }), {
      stderr: [contains('failure marker')],
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
      expectation: {
        exit_code: 1,
        stderr: [contains('failure'), exact('failure marker')],
        stdout: [contains('details')],
      },
      path_context: replayContext,
    } as const;

    expect(matchExecution(input)).toEqual(matchExecution(input));
    expect(createMatcher().match(input)).toEqual(matchExecution(input));
  });

  it('reports a missing exit code and a different exit code', () => {
    const withoutExitCode: BoundedExecutionResult = {
      duration_ms: 10,
      stderr: stream('x'),
      stdout: stream('y'),
      termination_reason: 'timeout',
    };

    expect(match(withoutExitCode, {}).differences).toEqual([
      {
        kind: 'exit_code',
        message: 'Expected exit code 1, but execution did not return one.',
      },
    ]);
    expect(match(execution({ exit_code: 2 }), {}).differences).toEqual([
      { kind: 'exit_code', message: 'Expected exit code 1 but received 2.' },
    ]);
  });
});

describe('contains-only expectations keep the prototype results', () => {
  it('keeps the prototype evidence and differences for contains-only expectations', () => {
    const result = match(execution({ exit_code: 2, stderr: stream('x', true) }), {
      stdout: [contains('details'), contains('absent')],
      stderr: [contains('absent')],
    });

    expect(result).toEqual({
      reproduced: false,
      evidence: [{ kind: 'stdout_contains', message: 'Expected stdout text was present.' }],
      differences: [
        { kind: 'exit_code', message: 'Expected exit code 1 but received 2.' },
        { kind: 'stdout_missing', message: 'Expected stdout text was not present.' },
        {
          kind: 'insufficient_output',
          message: 'Retained stderr was truncated before the expected text could be established.',
        },
      ],
    });
    for (const item of [...result.evidence, ...result.differences]) {
      expect(item).not.toHaveProperty('normalization');
    }
  });

  it('treats an empty rule list like a raw expectation', () => {
    const result = match(execution(), {
      stdout: [{ mode: 'contains', normalize: [], value: 'details' }],
    });

    expect(result.evidence[1]).toEqual({
      kind: 'stdout_contains',
      message: 'Expected stdout text was present.',
    });
  });
});

describe('normalized contains', () => {
  const containerFailure = (): BoundedExecutionResult =>
    execution({
      stderr: stream(
        [
          `${ESC}[31mAssertionError: Expected 4 (took 3.1ms)${ESC}[0m`,
          '    at file:///workspace/test/reproduction.mjs:3:9',
          '    at async node:internal/test_runner/test:1190:21',
          '',
          'Node.js v24.15.0',
        ].join('\r\n'),
      ),
    });

  it('normalized contains reports which rules changed the replay output', () => {
    const result = match(containerFailure(), {
      stderr: [
        {
          mode: 'contains',
          normalize: ['durations', 'paths', 'ansi_escapes', 'line_endings'],
          value: 'Expected 4 (took <duration>)\n    at <project>/test/reproduction.mjs:3:9',
        },
      ],
    });

    expect(result.reproduced).toBe(true);
    expect(result.evidence[1]).toEqual({
      kind: 'stderr_contains',
      message:
        'Expected stderr text was present after normalization; normalization changed 4 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.',
      normalization: {
        rules: ['line_endings', 'ansi_escapes', 'paths', 'durations'],
        changes: [
          { rule: 'line_endings', count: 4 },
          { rule: 'ansi_escapes', count: 2 },
          { rule: 'paths', count: 1 },
          { rule: 'durations', count: 1 },
        ],
      },
    });
  });

  it('reports a missing normalized value with the same explanation', () => {
    const result = match(containerFailure(), {
      stderr: [
        { mode: 'contains', normalize: ['line_endings', 'ansi_escapes'], value: 'Expected 5' },
      ],
    });

    expect(result.reproduced).toBe(false);
    expect(result.differences).toEqual([
      {
        kind: 'stderr_missing',
        message:
          'Expected stderr text was not present after normalization; normalization changed 4 line endings and 2 terminal escape sequences in the replay output.',
        normalization: {
          rules: ['line_endings', 'ansi_escapes'],
          changes: [
            { rule: 'line_endings', count: 4 },
            { rule: 'ansi_escapes', count: 2 },
          ],
        },
      },
    ]);
  });

  it('says so when normalization changed nothing', () => {
    const result = match(execution(), {
      stdout: [{ mode: 'contains', normalize: ['durations'], value: 'details' }],
    });

    expect(result.evidence[1]).toMatchObject({
      message:
        'Expected stdout text was present after normalization; normalization changed nothing in the replay output.',
      normalization: { rules: ['durations'], changes: [] },
    });
  });

  it('does not match raw text against normalized output or the reverse', () => {
    const run = execution({ stderr: stream('took 5ms') });

    expect(match(run, { stderr: [contains('took <duration>')] }).reproduced).toBe(false);
    expect(
      match(run, { stderr: [{ mode: 'contains', normalize: ['durations'], value: 'took 5ms' }] })
        .reproduced,
    ).toBe(false);
    expect(
      match(run, {
        stderr: [{ mode: 'contains', normalize: ['durations'], value: 'took <duration>' }],
      }).reproduced,
    ).toBe(true);
  });

  it('keeps insufficient output for a truncated normalized stream and still names the rules', () => {
    const result = match(execution({ stderr: stream('took 5ms', true) }), {
      stderr: [{ mode: 'contains', normalize: ['durations'], value: 'absent' }],
    });

    expect(result.differences).toEqual([
      {
        kind: 'insufficient_output',
        message: 'Retained stderr was truncated before the expected text could be established.',
        normalization: { rules: ['durations'], changes: [{ rule: 'durations', count: 1 }] },
      },
    ]);
  });

  it('normalizes each stream with the replay path context', () => {
    const result = match(
      execution({ stdout: stream('cwd=/workspace and /tmp/x and /opt/dev/p') }),
      {
        stdout: [
          {
            mode: 'contains',
            normalize: ['paths'],
            value: 'cwd=<project> and <tmp>/x and /opt/dev/p',
          },
        ],
      },
    );

    expect(result.reproduced).toBe(true);
  });

  it('names a single change without a list', () => {
    const result = match(execution({ stdout: stream('(node:12) a') }), {
      stdout: [{ mode: 'contains', normalize: ['process_ids'], value: '(node:<pid>) a' }],
    });

    expect(result.evidence[1]?.message).toBe(
      'Expected stdout text was present after normalization; normalization changed 1 process ID in the replay output.',
    );
  });
});

describe('exact expectations', () => {
  it('exact matches the whole stream and reports the first differing line and column', () => {
    const run = execution({ stdout: stream('line one\nline two\nline three') });

    expect(match(run, { stdout: [exact('line one\nline two\nline three')] })).toMatchObject({
      reproduced: true,
      evidence: [
        { kind: 'exit_code' },
        { kind: 'stdout_exact', message: 'Replay stdout matched the expected output exactly.' },
      ],
    });
    expect(match(run, { stdout: [exact('line one\nline twx\nline three')] }).differences).toEqual([
      {
        kind: 'stdout_differs',
        message:
          'Replay stdout differed from the expected output at line 2, column 8 (expected 28 characters, received 28).',
      },
    ]);
  });

  it('is not satisfied by output that merely contains the expected value', () => {
    const run = execution({ stderr: stream('failure marker\n') });

    expect(match(run, { stderr: [exact('failure marker')] }).differences).toEqual([
      {
        kind: 'stderr_differs',
        message:
          'Replay stderr differed from the expected output at line 1, column 15 (expected 14 characters, received 15).',
      },
    ]);
    expect(
      match(run, { stderr: [exact('failure marker\nand more')] }).differences[0]?.message,
    ).toBe(
      'Replay stderr differed from the expected output at line 2, column 1 (expected 23 characters, received 15).',
    );
  });

  it('counts code points, not UTF-16 units, in positions and lengths', () => {
    const astral = String.fromCodePoint(0x1f600);
    const run = execution({ stdout: stream(`${astral}${astral}x`) });

    expect(match(run, { stdout: [exact(`${astral}${astral}y`)] }).differences).toEqual([
      {
        kind: 'stdout_differs',
        message:
          'Replay stdout differed from the expected output at line 1, column 3 (expected 3 characters, received 3).',
      },
    ]);
    expect(
      match(run, { stdout: [exact(`${astral}${String.fromCodePoint(0x1f601)}x`)] }).differences[0]
        ?.message,
    ).toContain('at line 1, column 2 ');
  });

  it('normalized exact compares the normalized stream with the stored value', () => {
    const run = execution({
      stdout: stream('ok (12.5ms)\r\nat /workspace/test/a.mjs:1:1  \r\n'),
    });
    const expected = 'ok (<duration>)\nat <project>/test/a.mjs:1:1\n';
    const rules = ['line_endings', 'trailing_whitespace', 'paths', 'durations'] as const;

    const result = match(run, { stdout: [{ mode: 'exact', normalize: rules, value: expected }] });

    expect(result.reproduced).toBe(true);
    expect(result.evidence[1]).toEqual({
      kind: 'stdout_exact',
      message:
        'Normalized replay stdout matched the expected output exactly; normalization changed 2 line endings, 1 line with trailing whitespace, 1 path, and 1 duration in the replay output.',
      normalization: {
        rules,
        changes: [
          { rule: 'line_endings', count: 2 },
          { rule: 'trailing_whitespace', count: 1 },
          { rule: 'paths', count: 1 },
          { rule: 'durations', count: 1 },
        ],
      },
    });
    expect(
      match(run, { stdout: [{ mode: 'exact', normalize: rules, value: 'ok (<duration>)\n' }] })
        .differences[0],
    ).toMatchObject({
      kind: 'stdout_differs',
      message: expect.stringContaining(
        'Normalized replay stdout differed from the expected output at line 2, column 1 (expected 16 characters, received 44); normalization changed',
      ) as string,
    });
  });

  it('exact never matches truncated output', () => {
    const run = execution({ stdout: stream('whole', true) });

    for (const expectation of [
      exact('whole'),
      { mode: 'exact', normalize: ['durations'], value: 'whole' } as const,
    ]) {
      const result = match(run, { stdout: [expectation] });
      expect(result.reproduced).toBe(false);
      expect(result.differences).toMatchObject([
        {
          kind: 'insufficient_output',
          message: 'Retained stdout was truncated, so its exact content could not be established.',
        },
      ]);
    }
  });

  it('matches an empty stream only against its own normalization of nothing', () => {
    expect(
      match(execution({ stdout: stream('') }), { stdout: [exact('x')] }).differences[0]?.message,
    ).toBe(
      'Replay stdout differed from the expected output at line 1, column 1 (expected 1 characters, received 0).',
    );
  });
});

describe('explanations', () => {
  const rich = (): MatchInput => ({
    execution: execution({
      stderr: stream(`${ESC}[31mTook 5ms at /workspace/a.mjs${ESC}[0m\r\n`),
      stdout: stream('alpha\nbeta'),
    }),
    expectation: {
      exit_code: 1,
      stderr: [
        {
          mode: 'contains',
          normalize: ['ansi_escapes', 'durations', 'paths'],
          value: 'Took <duration> at <project>/a.mjs',
        },
        { mode: 'contains', normalize: ['durations'], value: 'never printed' },
        { mode: 'exact', normalize: ['line_endings'], value: 'different' },
      ],
      stdout: [contains('alpha'), exact('alpha\nbeta'), contains('gamma'), exact('alpha\nbetx')],
    },
    path_context: replayContext,
  });

  it('explanations are identical for the same bounded input', () => {
    const input = rich();

    expect(matchExecution(input)).toEqual(matchExecution(rich()));
    expect(JSON.stringify(matchExecution(input))).toBe(JSON.stringify(matchExecution(input)));
  });

  it('messages never contain expected values or output text', () => {
    const secretish = 'synthetic-value-that-must-not-appear';
    const run = execution({
      stderr: stream(`prefix ${secretish} suffix 12ms`),
      stdout: stream(`${secretish}\nsecond`),
    });
    const result = match(run, {
      stderr: [
        contains(secretish.toUpperCase()),
        { mode: 'contains', normalize: ['durations'], value: `${secretish}-x` },
        exact(secretish),
        { mode: 'exact', normalize: ['durations'], value: secretish },
      ],
      stdout: [contains(`${secretish}!`), exact(`${secretish}\nsecond!`)],
    });

    expect(result.differences.length).toBeGreaterThan(5);
    const everything = JSON.stringify([...result.evidence, ...result.differences]);
    expect(everything).not.toContain(secretish);
    expect(everything).not.toContain(secretish.toUpperCase());
    expect(everything).not.toContain('prefix');
    expect(everything).not.toContain('second');
  });

  it(
    'evaluation order does not change the evidence meaning',
    () => {
      const pool: readonly OutputExpectation[] = [
        contains('alpha'),
        contains('absent'),
        exact('alpha\nbeta'),
        exact('alpha'),
        { mode: 'contains', normalize: ['line_endings'], value: 'alpha\nbeta' },
        { mode: 'exact', normalize: ['durations'], value: 'alpha\nbeta' },
        { mode: 'contains', normalize: ['paths', 'durations'], value: 'nothing' },
      ];
      const run = execution({ stdout: stream('alpha\r\nbeta'), stderr: stream('') });
      const meaning = (items: readonly { readonly kind: string; readonly message: string }[]) =>
        items.map((item) => `${item.kind}|${item.message}`).sort();
      fc.assert(
        fc.property(fc.shuffledSubarray([...pool], { minLength: 1 }), (expectations) => {
          const original = match(run, { stdout: expectations });
          const reversed = match(run, { stdout: [...expectations].reverse() });

          expect(reversed.reproduced).toBe(original.reproduced);
          expect(meaning(reversed.evidence)).toEqual(meaning(original.evidence));
          expect(meaning(reversed.differences)).toEqual(meaning(original.differences));
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'exact matching agrees with string equality for every stream the property generates',
    () => {
      fc.assert(
        fc.property(
          fc.string({ maxLength: 20 }),
          fc.string({ maxLength: 20 }),
          (stored, replayed) => {
            fc.pre(stored.length > 0);
            const result = match(execution({ stdout: stream(replayed) }), {
              stdout: [exact(stored)],
            });

            expect(result.reproduced).toBe(stored === replayed);
          },
        ),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
