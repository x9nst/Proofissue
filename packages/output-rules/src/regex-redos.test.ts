import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import { compilePattern } from './regex/compile.js';
import {
  BOUNDED_REGEX_LIMITS,
  compileBoundedRegex,
  searchBoundedRegex,
  type BoundedRegexSearchResult,
} from './index.js';

const MIB = 1_048_576;
const BUDGET_MS = 3000;
const raw = String.raw;

// The nullable classics are rejected by the public compiler; they are searched through the internal
// one so the engine itself is shown to be bounded on them too.
const run = (pattern: string, text: string): BoundedRegexSearchResult => {
  const compiled = compilePattern(pattern, { reject_empty: false });
  if (!compiled.ok) throw new Error(`"${pattern}" was rejected: ${compiled.error.message}`);
  return searchBoundedRegex(compiled.program, text);
};

const timed = (
  pattern: string,
  text: string,
): { elapsed: number; result: BoundedRegexSearchResult } => {
  const started = performance.now();
  const result = run(pattern, text);
  return { elapsed: performance.now() - started, result };
};

describe('bounded regular-expression time budget', () => {
  // Classic catastrophic-backtracking patterns, each against 1 MiB of the input that makes a
  // backtracking engine run for hours. The engine cannot do that: its cost is bounded by the
  // program size times the text length, and by the step limit.
  const classics: readonly (readonly [
    string,
    string,
    string,
    BoundedRegexSearchResult['status'],
  ])[] = [
    ['(a+)+$', 'nested quantifiers', `${'a'.repeat(MIB)}b`, 'not_matched'],
    ['(a|a)*b', 'overlapping alternatives', 'a'.repeat(MIB), 'not_matched'],
    ['(a|aa)+$', 'Fibonacci alternatives', `${'a'.repeat(MIB)}b`, 'not_matched'],
    [
      raw`^(\w+\s?)*$`,
      'optional separator in a loop',
      `${'word '.repeat(MIB / 5)}!`,
      'not_matched',
    ],
    ['(x+x+)+y', 'adjacent quantifiers', 'x'.repeat(MIB), 'not_matched'],
    ['(.*a){20}', 'repeated greedy dot', 'b'.repeat(MIB), 'not_matched'],
    ['(?:a?){30}a{30}', 'optional run then required run', 'a'.repeat(MIB), 'matched'],
    ['^(a*)*$', 'star of star', `${'a'.repeat(MIB)}b`, 'not_matched'],
    ['(a*)*b', 'star of star, unanchored', 'a'.repeat(MIB), 'not_matched'],
    ['(?:a|b|ab)+c', 'overlapping alternation', 'ab'.repeat(MIB / 2), 'not_matched'],
    ['[a-z]+[0-9]+@', 'adjacent classes', 'a1'.repeat(MIB / 2), 'not_matched'],
  ];

  it.each(classics)(
    'finishes %s (%s) on 1 MiB within the time budget',
    (pattern, _name, text, status) => {
      const { elapsed, result } = timed(pattern, text);
      expect(elapsed).toBeLessThan(BUDGET_MS);
      expect(result.status).toBe(status);
      // The same input gives the same step count on every run.
      expect(run(pattern, text).steps).toBe(result.steps);
    },
  );

  it('rejects the nullable classics at compile time, before any text exists', () => {
    for (const pattern of [raw`^(\w+\s?)*$`, '^(a*)*$', '(?:a?){30}']) {
      const compiled = compileBoundedRegex(pattern);
      expect(compiled.ok ? 'accepted' : compiled.error.code).toBe('matches_empty');
    }
  });

  it('reports step_limit_exceeded deterministically for a dense automaton', () => {
    const text = 'a'.repeat(MIB);
    const first = timed('(?:.?){100}x', text);
    expect(first.result.status).toBe('step_limit_exceeded');
    expect(first.result.steps).toBe(BOUNDED_REGEX_LIMITS.steps);
    expect(first.elapsed).toBeLessThan(BUDGET_MS);
    expect(run('(?:.?){100}x', text)).toEqual(first.result);
  });

  it('stays linear in the text for a pattern that fits the step limit', () => {
    const small = run('(a+)+$', `${'a'.repeat(100_000)}b`);
    const large = run('(a+)+$', `${'a'.repeat(1_000_000)}b`);
    expect(large.steps / small.steps).toBeLessThan(11);
    expect(large.steps / small.steps).toBeGreaterThan(9);
  });

  it('keeps a long match-less scan of a plain literal cheap', () => {
    const { elapsed, result } = timed('needle', 'hay '.repeat(MIB / 4));
    expect(result.status).toBe('not_matched');
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  // Hostile patterns that must be rejected before any text is searched, or bounded when searched.
  const hostile: readonly (readonly [string, string])[] = [
    ['an exponential counted nest', '((a{100}){100}){100}'],
    ['a counted alternation nest', '(?:(?:a|b){100}){100}'],
    ['a backreference loop', raw`(a+)\1`],
    ['a lookahead loop', '(?:(?=a)a)+'],
    ['a deeply nested group chain', `${'('.repeat(40)}a${')'.repeat(40)}`],
    ['a long alternation of nullable parts', `${'a?|'.repeat(300)}b`],
    ['an oversized pattern', 'a|'.repeat(1000)],
    ['a huge count', 'a{4294967296}'],
    ['a nested optional pile', `${'(?:a?'.repeat(40)}${')'.repeat(40)}`],
  ];

  it.each(hostile)('rejects or bounds %s', (_name, pattern) => {
    const compiled = compileBoundedRegex(pattern);
    if (!compiled.ok) {
      expect(['too_large', 'unsupported', 'matches_empty', 'syntax']).toContain(
        compiled.error.code,
      );
      return;
    }
    const started = performance.now();
    const result = searchBoundedRegex(compiled.program, 'a'.repeat(100_000));
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    expect(['matched', 'not_matched', 'step_limit_exceeded']).toContain(result.status);
  });

  it('calibration: the full step limit takes well under two seconds on a dense automaton', () => {
    const { elapsed, result } = timed('(?:.?){100}x', 'a'.repeat(MIB));
    expect(result.steps).toBe(BOUNDED_REGEX_LIMITS.steps);
    expect(elapsed).toBeLessThan(2000);
  });
});
