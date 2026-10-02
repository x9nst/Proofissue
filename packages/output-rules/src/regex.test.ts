import { describe, expect, it } from 'vitest';

import {
  BOUNDED_REGEX_LIMITS,
  compileBoundedRegex,
  searchBoundedRegex,
  type BoundedRegexErrorCode,
  type BoundedRegexProgram,
} from './index.js';
import { compilePattern } from './regex/compile.js';

const raw = String.raw;

const compile = (pattern: string): BoundedRegexProgram => {
  const result = compileBoundedRegex(pattern);
  if (!result.ok) {
    throw new Error(`"${pattern}" was rejected: ${result.error.message}`);
  }
  return result.program;
};

const found = (pattern: string, text: string): boolean =>
  searchBoundedRegex(compile(pattern), text).status === 'matched';

/**
 * What V8 says about an unanchored search, evaluated the way the ECMAScript specification defines
 * it: a sticky match attempted at every code point boundary, and nowhere else. A plain
 * `RegExp.prototype.test` agrees except for one V8 quirk: a pattern that starts with an assertion
 * (`\B`, for example) can also be tried in the middle of a surrogate pair, so `\B` "matches"
 * `b` + U+1F600 + `1` there, where the specification (and this engine) finds no position.
 */
const v8 = (pattern: string, text: string): boolean => {
  const sticky = new RegExp(pattern, 'muy');
  let index = 0;
  for (;;) {
    sticky.lastIndex = index;
    if (sticky.test(text)) return true;
    if (index >= text.length) return false;
    const high = text.charCodeAt(index);
    const low = text.charCodeAt(index + 1);
    const pair = high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
    index += pair ? 2 : 1;
  }
};

const BACKSLASH = String.fromCharCode(92);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xa0);
const BOM = String.fromCharCode(0xfeff);
const IDEOGRAPHIC_SPACE = String.fromCharCode(0x3000);
const EM_SPACE = String.fromCharCode(0x2003);
const ASTRAL = String.fromCodePoint(0x1f600);
const OTHER_ASTRAL = String.fromCodePoint(0x10437);
const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);

describe('bounded regular-expression grammar', () => {
  // [description, pattern, text that matches, text that does not]
  const accepted: readonly (readonly [string, string, string, string])[] = [
    ['a literal', 'abc', 'xxabcxx', 'abxc'],
    ['a dot', 'a.c', 'abc', 'a\nc'],
    ['a line start anchor', '^abc', 'x\nabc', 'xabc'],
    ['a line end anchor', 'abc$', 'abc\nx', 'abcx'],
    ['a word boundary', raw`\bcat\b`, 'a cat.', 'concatenate'],
    ['a non-boundary', raw`\Bat`, 'cat', 'at'],
    ['digit classes', raw`\d\D`, '1a', '12'],
    ['word classes', raw`\w\W`, 'a-', 'ab'],
    ['space classes', raw`\s\S`, ' a', '  '],
    ['control escapes', raw`\n\r\t\f\v`, '\n\r\t\f\v', '\n\r\t\f'],
    ['identity escapes', raw`\^\$\\\.\*\+\?\(\)\[\]\{\}\|\/`, '^$\\.*+?()[]{}|/', '^$'],
    ['a class', '[abc]x', 'bx', 'dx'],
    ['a negated class', '[^abc]x', 'dx', 'ax'],
    ['a class range', '[a-c]x', 'bx', 'dx'],
    ['a class with escapes', raw`[\d_\s]x`, '_x', 'ax'],
    ['an escaped dash in a class', raw`[a\-z]x`, '-x', 'bx'],
    ['a trailing dash in a class', '[az-]x', '-x', 'bx'],
    ['a leading dash in a class', '[-az]x', '-x', 'bx'],
    ['a class escape before a trailing dash', raw`[\d-]x`, '-x', 'ax'],
    ['an empty class', '[]|x', 'x', 'a'],
    ['a negated empty class', '[^]x', '\nx', 'x'],
    ['a group', '(ab)c', 'abc', 'ac'],
    ['a non-capturing group', '(?:ab)c', 'abc', 'ac'],
    ['an alternation', 'cat|dog', 'hotdog', 'cow'],
    ['a star', 'ab*c', 'ac', 'adc'],
    ['a plus', 'ab+c', 'abbc', 'ac'],
    ['an optional', 'ab?c', 'ac', 'abbc'],
    ['an exact count', 'ab{2}c', 'abbc', 'abc'],
    ['an open count', 'ab{2,}c', 'abbbc', 'abc'],
    ['a bounded count', 'ab{1,2}c', 'abbc', 'abbbc'],
    ['a lazy quantifier', 'a.*?b', 'a--b', 'a--'],
    ['nested groups', '((a|b)c)+d', 'acbcd', 'cd'],
    ['a quantified group', '(?:ab){2}', 'abab', 'aab'],
    ['a zero count', 'ab{0}c', 'ac', 'abc'],
    ['an astral literal', ASTRAL, `x${ASTRAL}`, 'x'],
    ['an astral class range', '[\u{10000}-\u{10FFFF}]', ASTRAL, 'a'],
  ];

  it.each(accepted)('accepts %s', (_description, pattern, hit, miss) => {
    expect(found(pattern, hit)).toBe(true);
    expect(found(pattern, miss)).toBe(false);
    // The language is a subset of ECMAScript with the flags m and u.
    expect(v8(pattern, hit)).toBe(true);
    expect(v8(pattern, miss)).toBe(false);
  });

  it('compiles to exactly the size that was computed before emitting', () => {
    for (const [pattern, size] of [
      ['a', 2],
      ['ab', 3],
      ['a|b', 5],
      ['a*', 4],
      ['a+', 3],
      ['a?', 3],
      ['a{3}', 4],
      ['a{2,4}', 7],
      ['a{2,}', 4],
      ['(?:ab){2,3}', 8],
      ['a{0}', 1],
    ] as const) {
      const result = compilePattern(pattern, { reject_empty: false });
      if (!result.ok) throw new Error(pattern);
      expect(result.program.instructions).toHaveLength(size);
    }
  });
});

describe('bounded regular-expression rejections', () => {
  // [feature, pattern, code, offset]
  const rejected: readonly (readonly [string, string, BoundedRegexErrorCode, number])[] = [
    ['a backreference', raw`a\1`, 'unsupported', 1],
    ['a named backreference', raw`\k<name>`, 'unsupported', 0],
    ['a lookahead', 'a(?=b)', 'unsupported', 1],
    ['a negative lookahead', '(?!a)', 'unsupported', 0],
    ['a lookbehind', '(?<=a)b', 'unsupported', 0],
    ['a negative lookbehind', '(?<!a)b', 'unsupported', 0],
    ['a named group', '(?<name>a)', 'unsupported', 0],
    ['an inline modifier', '(?i:a)', 'unsupported', 0],
    ['a property escape', raw`\p{L}`, 'unsupported', 0],
    ['a negated property escape', raw`a\P{L}`, 'unsupported', 1],
    ['a unicode escape', `${BACKSLASH}u0041`, 'unsupported', 0],
    ['a hexadecimal escape', raw`a\x41`, 'unsupported', 1],
    ['a control-letter escape', raw`\cA`, 'unsupported', 0],
    ['a NUL escape', raw`\0`, 'unsupported', 0],
    ['an unknown escape', raw`\a`, 'syntax', 0],
    ['an escaped dash outside a class', raw`x\-`, 'syntax', 1],
    ['a lone opening brace', 'a{', 'syntax', 1],
    ['a leading opening brace', '{a', 'syntax', 0],
    ['a malformed quantifier', 'a{,2}', 'syntax', 1],
    ['a lone closing brace', 'a}', 'syntax', 1],
    ['a lone closing bracket', 'a]', 'syntax', 1],
    ['a negated class escape inside a class (D)', raw`[\D]`, 'unsupported', 1],
    ['a negated class escape inside a class (W)', raw`[a\W]`, 'unsupported', 2],
    ['a negated class escape inside a class (S)', raw`[\S]`, 'unsupported', 1],
    ['a word boundary inside a class', raw`[\b]`, 'unsupported', 1],
    ['a class escape as a range start', raw`[\d-z]`, 'syntax', 3],
    ['a class escape as a range end', raw`[a-\d]`, 'syntax', 2],
    ['an inverted range', '[z-a]', 'syntax', 1],
    ['an inverted quantifier range', 'a{3,2}', 'syntax', 1],
    ['nothing to repeat', '*a', 'syntax', 0],
    ['a quantified line start', '^*', 'syntax', 1],
    ['a quantified word boundary', raw`a\b+`, 'syntax', 3],
    ['a double quantifier', 'a**', 'syntax', 2],
    ['a quantified quantifier', 'a+*', 'syntax', 2],
    ['a repeated counted quantifier', 'a{2}{3}', 'syntax', 4],
    ['an unterminated group', '(a', 'syntax', 0],
    ['an unmatched closing parenthesis', 'a)', 'syntax', 1],
    ['an unterminated class', '[a', 'syntax', 0],
    ['a trailing backslash', `a${String.fromCharCode(92)}`, 'syntax', 1],
    ['an empty group header', '(?)', 'syntax', 0],
  ];

  it.each(rejected)('rejects %s with its offset', (_feature, pattern, code, offset) => {
    const result = compileBoundedRegex(pattern);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(code);
    expect(result.error.offset).toBe(offset);
    expect(result.error.message.length).toBeGreaterThan(0);
    // A syntax error is also an error for V8; unsupported features are valid ECMAScript.
    if (code === 'syntax') expect(() => new RegExp(pattern, 'mu')).toThrow();
  });

  it('never echoes the pattern in an error message', () => {
    const result = compileBoundedRegex('secret-token(?=x)');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain('secret-token');
  });
});

describe('bounded regular-expression limits', () => {
  const limitOf = (pattern: string): { code: BoundedRegexErrorCode; offset: number } => {
    const result = compileBoundedRegex(pattern);
    if (result.ok) throw new Error(`"${pattern.slice(0, 20)}" was accepted`);
    return { code: result.error.code, offset: result.error.offset };
  };

  it('documents the limits', () => {
    expect(BOUNDED_REGEX_LIMITS).toEqual({
      pattern_characters: 1024,
      program_instructions: 2048,
      repetition_count: 100,
      group_depth: 16,
      steps: 20_000_000,
    });
  });

  it('accepts a pattern of exactly 1024 characters and rejects 1025', () => {
    expect(compileBoundedRegex('a'.repeat(1024)).ok).toBe(true);
    expect(limitOf('a'.repeat(1025)).code).toBe('too_large');
  });

  it('accepts a repetition of 100 and rejects 101, in every quantifier form', () => {
    expect(compileBoundedRegex('a{100}').ok).toBe(true);
    expect(compileBoundedRegex('xa{0,100}').ok).toBe(true);
    expect(compileBoundedRegex('a{100,}').ok).toBe(true);
    expect(limitOf('a{101}')).toEqual({ code: 'too_large', offset: 2 });
    expect(limitOf('a{1,101}').code).toBe('too_large');
    expect(limitOf('a{101,}').code).toBe('too_large');
    expect(limitOf('a{99999999999999999999}').code).toBe('too_large');
  });

  it('accepts groups nested 16 deep and rejects 17', () => {
    const nested = (depth: number): string => `${'('.repeat(depth)}a${')'.repeat(depth)}`;
    expect(compileBoundedRegex(nested(16)).ok).toBe(true);
    expect(limitOf(nested(17))).toEqual({ code: 'too_large', offset: 16 });
    const nonCapturing = (depth: number): string => `${'(?:'.repeat(depth)}a${')'.repeat(depth)}`;
    expect(compileBoundedRegex(nonCapturing(16)).ok).toBe(true);
    expect(limitOf(nonCapturing(17)).code).toBe('too_large');
  });

  it('accepts a program of exactly 2048 instructions and rejects 2049', () => {
    const base = 'a{100}'.repeat(20); // 2000 instructions
    const exact = compile(`${base}${'b'.repeat(47)}`);
    expect(exact.instructions).toHaveLength(2048);
    expect(limitOf(`${base}${'b'.repeat(48)}`).code).toBe('too_large');
  });

  it('rejects patterns whose repetition expands beyond the program limit', () => {
    expect(limitOf('(a{100}){100}')).toEqual({ code: 'too_large', offset: 0 });
    expect(limitOf('((a{100}){100}){100}').code).toBe('too_large');
    expect(limitOf('(?:(?:a|b){100}){100}').code).toBe('too_large');
    expect(limitOf('(?:a{0,100}){100}').code).toBe('too_large');
    expect(limitOf('x(?:[a-z0-9]{50}){50}y').code).toBe('too_large');
  });
});

describe('bounded regular-expression patterns that match without consuming output', () => {
  it.each([
    ['the empty pattern', ''],
    ['a star', 'a*'],
    ['an optional', 'a?'],
    ['a line start', '^'],
    ['a line end', '$'],
    ['a word boundary', raw`\b`],
    ['a non-boundary', raw`\B`],
    ['an empty group', '(?:)'],
    ['an empty alternative', 'a|'],
    ['a leading empty alternative', '|a'],
    ['a nullable group', '(a?)(b?)'],
    ['a zero count', 'a{0}'],
    ['a counted nullable group', '(?:a*){3}'],
    ['assertions only', raw`^\b$`],
    ['a repeated assertion group', '(?:^)+'],
    ['an alternative that can be empty', 'x|y*|z'],
  ])('rejects %s', (_name, pattern) => {
    const result = compileBoundedRegex(pattern);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('matches_empty');
  });

  it('accepts a pattern that must consume at least one character', () => {
    expect(compileBoundedRegex('a+').ok).toBe(true);
    expect(compileBoundedRegex('^a').ok).toBe(true);
    expect(compileBoundedRegex(raw`\bword\b`).ok).toBe(true);
    expect(compileBoundedRegex('(?:a|b)(?:c*)').ok).toBe(true);
  });

  it('compiles nullable patterns when the check is switched off, as the differential tests need', () => {
    expect(compilePattern('a*', { reject_empty: false }).ok).toBe(true);
    expect(compilePattern('', { reject_empty: false }).ok).toBe(true);
  });
});

describe('bounded regular-expression semantics', () => {
  // [description, pattern, text]. Each row is checked against the engine and against V8.
  const rows: readonly (readonly [string, string, string])[] = [
    ['caret at the start', '^a', 'ab'],
    ['caret after a line feed', '^b', 'a\nb'],
    ['caret after a carriage return', '^b', 'a\rb'],
    ['caret after U+2028', '^b', `a${LINE_SEPARATOR}b`],
    ['caret after U+2029', '^b', `a${PARAGRAPH_SEPARATOR}b`],
    ['caret in the middle of a line', '^b', 'ab'],
    ['caret on an empty last line', '^x|a\n', 'a\n'],
    ['dollar at the end', 'b$', 'ab'],
    ['dollar before a line feed', 'a$', 'a\nb'],
    ['dollar before a carriage return', 'a$', 'a\rb'],
    ['dollar before U+2028', 'a$', `a${LINE_SEPARATOR}b`],
    ['dollar before U+2029', 'a$', `a${PARAGRAPH_SEPARATOR}b`],
    ['dollar in the middle of a line', 'a$', 'ab'],
    ['dot against a line feed', 'a.b', 'a\nb'],
    ['dot against a carriage return', 'a.b', 'a\rb'],
    ['dot against U+2028', 'a.b', `a${LINE_SEPARATOR}b`],
    ['dot against U+2029', 'a.b', `a${PARAGRAPH_SEPARATOR}b`],
    ['dot against U+0085', 'a.b', `a${String.fromCharCode(0x85)}b`],
    ['dot against an astral character', '^.$', ASTRAL],
    ['two dots against an astral character', '^..$', ASTRAL],
    ['dot against a lone high surrogate', '^.$', LONE_HIGH],
    ['dot against a lone low surrogate', '^.$', LONE_LOW],
    ['dot against a reversed pair', '^..$', `${LONE_LOW}${LONE_HIGH}`],
    ['boundary between word and space', raw`a\b `, 'a '],
    ['boundary at the start of a word', raw`\ba`, 'a'],
    ['boundary at the end of a word', raw`a\b`, 'a'],
    ['boundary inside a word', raw`a\bb`, 'ab'],
    ['non-boundary inside a word', raw`a\Bb`, 'ab'],
    ['non-boundary between non-words', raw`-\B-`, '--'],
    ['non-boundary is never tried inside a surrogate pair', raw`\B`, `b${ASTRAL}1`],
    ['boundary against an accented letter', raw`\bé`, 'é'],
    ['boundary after an accented letter', raw`é\ba`, 'éa'],
    ['boundary against an underscore', raw`\b_`, '_'],
    ['boundary against a digit', raw`\b1`, '1'],
    ['digit against a non-ASCII digit', raw`\d`, String.fromCharCode(0x0663)],
    ['word against a non-ASCII letter', raw`\w`, 'é'],
    ['non-word against a non-ASCII letter', raw`^\W$`, 'é'],
    ['space against a no-break space', raw`^\s$`, NBSP],
    ['space against a byte order mark', raw`^\s$`, BOM],
    ['space against an ideographic space', raw`^\s$`, IDEOGRAPHIC_SPACE],
    ['space against an em space', raw`^\s$`, EM_SPACE],
    ['space against U+0085', raw`^\s$`, String.fromCharCode(0x85)],
    ['space against U+180E', raw`^\s$`, String.fromCharCode(0x180e)],
    ['space against U+200B', raw`^\s$`, String.fromCharCode(0x200b)],
    ['space against a vertical tab', raw`^\s$`, '\v'],
    ['space against a form feed', raw`^\s$`, '\f'],
    ['non-space against an astral character', raw`^\S$`, ASTRAL],
    ['negated class against an astral character', '^[^a]$', ASTRAL],
    ['negated class against a line feed', '^[^a]$', '\n'],
    ['negated class against a lone surrogate', '^[^a]$', LONE_HIGH],
    ['class range across the astral planes', '^[\u{10000}-\u{10FFFF}]$', OTHER_ASTRAL],
    ['class range does not match a lone surrogate', '^[\u{10000}-\u{10FFFF}]$', LONE_HIGH],
    ['astral literal against its own surrogates', ASTRAL, LONE_HIGH],
    ['lone surrogate literal against a pair', `^${LONE_HIGH}`, ASTRAL],
    ['lone surrogate literal against a lone surrogate', `^${LONE_HIGH}$`, LONE_HIGH],
    ['astral literal after a lone high surrogate', ASTRAL, `${LONE_HIGH}${ASTRAL}`],
    ['two astral characters', `${ASTRAL}${OTHER_ASTRAL}`, `a${ASTRAL}${OTHER_ASTRAL}`],
    ['case is significant', 'abc', 'ABC'],
    ['class case is significant', '[a-z]', 'A'],
    ['count against a long run', 'a{3,5}b', 'aaaaaaab'],
    ['count against a short run', '^a{3,5}b', 'aab'],
    ['lazy against greedy has the same answer', 'a.*?c', 'abcbc'],
    ['alternation with an empty branch inside a longer pattern', '(?:a|)b', 'b'],
    ['star of a nullable group', '(?:a*)*b', 'aab'],
    ['required count of a nullable group', '^(?:a?){3}b$', 'ab'],
    ['required count of a nullable group, too many', '^(?:a?){3}b$', 'aaaab'],
    ['anchored alternation', '^(?:ab|a)b$', 'ab'],
    ['dash range endpoints', '[--a]', 'A'],
    ['escaped dash range endpoint', raw`[\--a]`, '0'],
  ];

  it.each(rows)('agrees with ECMAScript for %s', (_name, pattern, text) => {
    const result = compilePattern(pattern, { reject_empty: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(searchBoundedRegex(result.program, text).status).toBe(
      v8(pattern, text) ? 'matched' : 'not_matched',
    );
  });

  it('treats a surrogate pair as one code point and a lone surrogate as its own', () => {
    expect(found('^.$', ASTRAL)).toBe(true);
    expect(found('^..$', ASTRAL)).toBe(false);
    expect(found('^.$', LONE_HIGH)).toBe(true);
    expect(found('^.$', LONE_LOW)).toBe(true);
    expect(found('^.$', `${LONE_LOW}${LONE_HIGH}`)).toBe(false);
    expect(found(`^${LONE_HIGH}$`, ASTRAL)).toBe(false);
    expect(found(ASTRAL, LONE_HIGH)).toBe(false);
  });

  it('does not start a match in the middle of a surrogate pair', () => {
    expect(found(LONE_LOW, ASTRAL)).toBe(false);
    expect(found(`^${LONE_LOW}`, `${LONE_HIGH}${LONE_LOW}`)).toBe(false);
  });

  it('searches the whole text, not only its start', () => {
    expect(found('needle', `${'hay'.repeat(1000)}needle${'hay'.repeat(1000)}`)).toBe(true);
    expect(found('needle', 'hay'.repeat(1000))).toBe(false);
  });
});

describe('bounded regular-expression determinism', () => {
  it('reports the same status and step count for the same input', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['(a|aa)+$', `${'a'.repeat(5000)}b`],
      [raw`^\w+\s\d{2,4}`, 'abc 123'],
      ['needle', 'hay'.repeat(5000)],
      ['x[^y]{3,9}z', 'x1234z'],
    ];
    for (const [pattern, text] of cases) {
      const program = compile(pattern);
      const first = searchBoundedRegex(program, text);
      const second = searchBoundedRegex(compile(pattern), text);
      expect(second).toEqual(first);
      expect(first.steps).toBeGreaterThan(0);
    }
  });

  it('gives up exactly at the step limit and never reports a match for it', () => {
    const program = compile('(?:.?){50}x');
    const text = 'a'.repeat(2000);
    const limited = searchBoundedRegex(program, text, { step_limit: 1000 });
    expect(limited).toEqual({ status: 'step_limit_exceeded', steps: 1000 });
    const unlimited = searchBoundedRegex(program, text);
    expect(unlimited.status).toBe('not_matched');
    expect(unlimited.steps).toBeGreaterThan(1000);
    // The same bound is hit on a repeat run.
    expect(searchBoundedRegex(program, text, { step_limit: 1000 })).toEqual(limited);
  });

  it('can match on the last step before the limit and not on the one after', () => {
    const program = compile('ab');
    const text = 'xxab';
    const full = searchBoundedRegex(program, text);
    expect(full.status).toBe('matched');
    expect(searchBoundedRegex(program, text, { step_limit: full.steps })).toEqual(full);
    expect(searchBoundedRegex(program, text, { step_limit: full.steps - 1 }).status).toBe(
      'step_limit_exceeded',
    );
  });
});
