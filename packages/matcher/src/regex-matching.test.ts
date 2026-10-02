import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { BoundedExecutionResult } from '@proofissue/contracts';
import { createOutputPathContext } from '@proofissue/output-rules';

import { matchExecution } from './index.js';
import type { OutputExpectation } from './index.js';

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 20_000 + RUNS * 5;

const ESC = String.fromCharCode(27);
const MIB = 1_048_576;

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
) =>
  matchExecution({
    execution: run,
    expectation: { exit_code: 1, stderr: [], stdout: [], ...expectation },
    path_context: replayContext,
  });

const regex = (value: string): OutputExpectation => ({ mode: 'regex', value });
const contains = (value: string): OutputExpectation => ({ mode: 'contains', value });
const normalizedRegex = (
  value: string,
  normalize: NonNullable<OutputExpectation['normalize']>,
): OutputExpectation => ({ mode: 'regex', normalize, value });

describe('regex expectations', () => {
  it('regex matches raw output and says so without the pattern', () => {
    const result = match(execution({ stdout: stream('Expected 4 from f(2)') }), {
      stdout: [regex(String.raw`Expected \d+ from f\(\d\)`)],
    });

    expect(result.reproduced).toBe(true);
    expect(result.evidence[1]).toEqual({
      kind: 'stdout_regex',
      message: 'Replay stdout matched the expected pattern.',
    });
  });

  it('regex matches normalized output and reports no_match otherwise', () => {
    const run = execution({
      stderr: stream(`${ESC}[31mTook 3.5ms at /workspace/a.mjs:3:9${ESC}[0m\r\n`),
    });
    const rules = ['line_endings', 'ansi_escapes', 'paths', 'durations'] as const;
    const changes = [
      { rule: 'line_endings', count: 1 },
      { rule: 'ansi_escapes', count: 2 },
      { rule: 'paths', count: 1 },
      { rule: 'durations', count: 1 },
    ];
    const listed =
      '1 line ending, 2 terminal escape sequences, 1 path, and 1 duration in the replay output';

    const matched = match(run, {
      stderr: [normalizedRegex(String.raw`Took <duration> at <project>/a\.mjs:\d+:\d+`, rules)],
    });
    expect(matched.reproduced).toBe(true);
    expect(matched.evidence[1]).toEqual({
      kind: 'stderr_regex',
      message: `Normalized replay stderr matched the expected pattern; normalization changed ${listed}.`,
      normalization: { rules, changes },
    });

    const missed = match(run, { stderr: [normalizedRegex(String.raw`Took \d+ms`, rules)] });
    expect(missed.reproduced).toBe(false);
    expect(missed.differences).toEqual([
      {
        kind: 'stderr_no_match',
        message: `Normalized replay stderr did not match the expected pattern; normalization changed ${listed}.`,
        normalization: { rules, changes },
      },
    ]);
  });

  it('raw regex sees the raw stream, not a normalized one', () => {
    const run = execution({ stdout: stream('took 5ms') });

    expect(match(run, { stdout: [regex(String.raw`took \d+ms`)] }).reproduced).toBe(true);
    expect(match(run, { stdout: [regex('took <duration>')] }).reproduced).toBe(false);
    expect(
      match(run, { stdout: [normalizedRegex('took <duration>', ['durations'])] }).reproduced,
    ).toBe(true);
  });

  it('reports a raw no_match with the fixed sentence', () => {
    const result = match(execution(), { stdout: [regex('absent+')] });

    expect(result.differences).toEqual([
      { kind: 'stdout_no_match', message: 'Replay stdout did not match the expected pattern.' },
    ]);
  });

  it('regex reports insufficient_output when truncated and not matched', () => {
    const run = execution({ stderr: stream('retained prefix', true) });

    expect(match(run, { stderr: [regex('never+')] }).differences).toEqual([
      {
        kind: 'insufficient_output',
        message: 'Retained stderr was truncated before the expected pattern could be established.',
      },
    ]);
    // A match in the retained text is still a match.
    expect(match(run, { stderr: [regex('prefix')] }).reproduced).toBe(true);
  });

  it('regex reports regex_step_limit and never a match', () => {
    const run = execution({ stdout: stream('a'.repeat(MIB)) });
    const hostile = [regex('(?:.?){100}x')];

    const result = match(run, { stdout: hostile });

    expect(result.reproduced).toBe(false);
    expect(result.evidence).toHaveLength(1);
    expect(result.differences).toEqual([
      {
        kind: 'regex_step_limit',
        message:
          'The stdout pattern could not be evaluated within the deterministic limit of 20000000 steps.',
      },
    ]);
    expect(match(run, { stdout: hostile })).toEqual(result);
    // The step limit wins over truncation: the pattern was not evaluated to the end.
    expect(
      match(execution({ stdout: stream('a'.repeat(MIB), true) }), { stdout: hostile })
        .differences[0]?.kind,
    ).toBe('regex_step_limit');
  });

  it('names the normalization rules on a step-limit difference', () => {
    const run = execution({ stdout: stream('a'.repeat(MIB)) });

    expect(
      match(run, { stdout: [normalizedRegex('(?:.?){100}x', ['durations'])] }).differences[0],
    ).toMatchObject({ kind: 'regex_step_limit', normalization: { rules: ['durations'] } });
  });

  it('searches the whole stream, with multiline anchors', () => {
    const run = execution({ stdout: stream('first\nsecond ok\nthird') });

    expect(match(run, { stdout: [regex('^second ok$')] }).reproduced).toBe(true);
    expect(match(run, { stdout: [regex('^ok$')] }).reproduced).toBe(false);
  });

  it('keeps the order of evidence across modes', () => {
    const result = match(execution({ stdout: stream('abc') }), {
      stdout: [regex('a+'), contains('b'), regex('c+'), regex('z+')],
    });

    expect(result.evidence.map((item) => item.kind)).toEqual([
      'exit_code',
      'stdout_regex',
      'stdout_contains',
      'stdout_regex',
    ]);
    expect(result.differences.map((item) => item.kind)).toEqual(['stdout_no_match']);
  });

  it('throws for a pattern that validation should have rejected', () => {
    expect(() => match(execution(), { stdout: [regex('(?=a)b')] })).toThrow(
      /validation should have rejected/u,
    );
    expect(() => match(execution(), { stdout: [regex('a*')] })).toThrow(
      /validation should have rejected/u,
    );
  });

  it('never puts the pattern or the output in a message', () => {
    const marker = 'synthetic-pattern-text';
    const result = match(execution({ stdout: stream(`zebra ${marker}`), stderr: stream('') }), {
      stdout: [regex(`${marker}!+`), regex(marker)],
      stderr: [normalizedRegex(`${marker}+`, ['durations'])],
    });

    const everything = JSON.stringify([...result.evidence, ...result.differences]);
    expect(everything).not.toContain(marker);
    expect(everything).not.toContain('zebra');
  });

  it(
    'evaluation order does not change the evidence meaning for regex expectations',
    () => {
      const pool: readonly OutputExpectation[] = [
        regex('alpha'),
        regex('absent+'),
        normalizedRegex(String.raw`al.ha\n`, ['line_endings']),
        normalizedRegex('(?:.?){100}x', ['durations']),
        contains('beta'),
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
        { numRuns: Math.min(RUNS, 2000) },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'agrees with RegExp for generated patterns and streams',
    () => {
      const unit = fc.constantFrom('a', 'b', 'a+', 'b*', '[ab]', '.', '^', '$', 'a|b', '(?:ab)');
      const pattern = fc.array(unit, { minLength: 1, maxLength: 5 }).map((parts) => parts.join(''));
      const text = fc
        .array(fc.constantFrom('a', 'b', '\n'), { maxLength: 10 })
        .map((items) => items.join(''));
      fc.assert(
        fc.property(pattern, text, (value, output) => {
          let result;
          try {
            result = match(execution({ stdout: stream(output) }), { stdout: [regex(value)] });
          } catch {
            // A nullable pattern: validation would have rejected it, so the matcher refuses it.
            return;
          }
          expect(result.evidence.some((item) => item.kind === 'stdout_regex')).toBe(
            new RegExp(value, 'mu').test(output),
          );
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});
