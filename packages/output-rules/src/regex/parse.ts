import { codePointAtIndex } from './code-point.js';

/**
 * Parser for the bounded regular-expression language.
 *
 * The language is a documented subset of ECMAScript syntax. Every pattern this parser accepts means
 * the same as `new RegExp(pattern, 'mu')` in V8: case-sensitive, Unicode code points, multiline
 * anchors, no other flags. Everything else is rejected with a named reason and the offset (in UTF-16
 * code units from the start of the pattern) where the problem starts.
 */

export const BOUNDED_REGEX_LIMITS = Object.freeze({
  /** Pattern length in UTF-16 code units. */
  pattern_characters: 1024,
  /** Instructions in the compiled program, including the final match instruction. */
  program_instructions: 2048,
  /** The largest count in `{n}`, `{n,}`, and `{n,m}`. */
  repetition_count: 100,
  /** Nesting depth of groups. */
  group_depth: 16,
  /** Instruction visits in one search. */
  steps: 20_000_000,
});

export type BoundedRegexErrorCode = 'syntax' | 'unsupported' | 'too_large' | 'matches_empty';

export interface BoundedRegexError {
  readonly code: BoundedRegexErrorCode;
  readonly message: string;
  /** UTF-16 offset into the pattern where the problem starts. */
  readonly offset: number;
}

/** An inclusive range of code points. */
export type CodePointRange = readonly [number, number];

export type AssertionKind = 'line_start' | 'line_end' | 'word_boundary' | 'not_word_boundary';

export type RegexNode =
  | { readonly kind: 'empty'; readonly offset: number }
  | {
      readonly kind: 'set';
      readonly negated: boolean;
      readonly ranges: readonly CodePointRange[];
      readonly offset: number;
    }
  | {
      readonly kind: 'concat';
      readonly items: readonly RegexNode[];
      readonly offset: number;
    }
  | {
      readonly kind: 'alternation';
      readonly alternatives: readonly RegexNode[];
      readonly offset: number;
    }
  | {
      readonly kind: 'repeat';
      readonly item: RegexNode;
      readonly max: number | null;
      readonly min: number;
      readonly offset: number;
    }
  | { readonly kind: 'assertion'; readonly assertion: AssertionKind; readonly offset: number };

export type ParseResult =
  | { readonly ok: true; readonly ast: RegexNode }
  | { readonly ok: false; readonly error: BoundedRegexError };

const END = -1;

const cp = (character: string): number => character.codePointAt(0) ?? END;

const BACKSLASH = cp(String.fromCharCode(92));
const SYNTAX_CHARACTERS = new Set(
  Array.from({ length: 13 }, (_unused, index) => cp('^$.*+?()[]{}|'.charAt(index))).concat(
    BACKSLASH,
  ),
);

/** The characters an escape may name literally: the syntax characters and the slash. */
const isIdentityEscape = (code: number): boolean => SYNTAX_CHARACTERS.has(code) || code === cp('/');

/** U+000A, U+000D, U+2028, U+2029. */
export const LINE_TERMINATORS: readonly CodePointRange[] = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];

const DIGIT_RANGES: readonly CodePointRange[] = [[0x30, 0x39]];

const WORD_RANGES: readonly CodePointRange[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];

/** The ECMAScript `\s` set, from numeric code points. */
const SPACE_RANGES: readonly CodePointRange[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];

const CLASS_ESCAPES: Readonly<Record<string, readonly CodePointRange[]>> = {
  d: DIGIT_RANGES,
  s: SPACE_RANGES,
  w: WORD_RANGES,
};

const NEGATED_CLASS_ESCAPES = new Set(['D', 'S', 'W']);

const CONTROL_ESCAPES: Readonly<Record<string, number>> = {
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
};

class ParseFailure extends Error {
  constructor(readonly detail: BoundedRegexError) {
    super(detail.message);
  }
}

const fail = (code: BoundedRegexErrorCode, message: string, offset: number): never => {
  throw new ParseFailure({ code, message, offset });
};

type ClassAtom =
  | { readonly kind: 'char'; readonly code: number }
  | { readonly kind: 'class'; readonly ranges: readonly CodePointRange[] };

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly pattern: string) {}

  parse(): RegexNode {
    const node = this.parseDisjunction();
    if (this.peek() !== END) {
      // Only an unmatched closing parenthesis stops the top-level disjunction early.
      return fail('syntax', 'Unmatched ")".', this.index);
    }
    return node;
  }

  private peek(at = this.index): number {
    return at >= this.pattern.length ? END : codePointAtIndex(this.pattern, at);
  }

  private widthAt(at: number): number {
    return this.peek(at) > 0xffff ? 2 : 1;
  }

  private advance(): number {
    const code = this.peek();
    this.index += code === END ? 0 : this.widthAt(this.index);
    return code;
  }

  private parseDisjunction(): RegexNode {
    const offset = this.index;
    const alternatives = [this.parseAlternative()];
    while (this.peek() === cp('|')) {
      this.advance();
      alternatives.push(this.parseAlternative());
    }
    const [only] = alternatives;
    if (alternatives.length === 1 && only !== undefined) return only;
    return { kind: 'alternation', alternatives, offset };
  }

  private parseAlternative(): RegexNode {
    const offset = this.index;
    const items: RegexNode[] = [];
    while (this.peek() !== END && this.peek() !== cp('|') && this.peek() !== cp(')')) {
      items.push(this.parseTerm());
    }
    const [only] = items;
    if (items.length === 0) return { kind: 'empty', offset };
    if (items.length === 1 && only !== undefined) return only;
    return { kind: 'concat', items, offset };
  }

  private parseTerm(): RegexNode {
    const start = this.index;
    const atom = this.parseAtom();
    const next = this.peek();
    const isQuantifierStart =
      next === cp('*') || next === cp('+') || next === cp('?') || next === cp('{');
    if (!isQuantifierStart) return atom;
    if (atom.kind === 'assertion') {
      return fail('syntax', 'Nothing to repeat: an assertion cannot be quantified.', this.index);
    }
    const { max, min } = this.parseQuantifier();
    if (this.peek() === cp('?')) this.advance(); // lazy; irrelevant to whether a match exists
    const after = this.peek();
    if (after === cp('*') || after === cp('+') || after === cp('?') || after === cp('{')) {
      return fail('syntax', 'Double quantifier: nothing to repeat.', this.index);
    }
    return { kind: 'repeat', item: atom, max, min, offset: start };
  }

  private parseQuantifier(): { max: number | null; min: number } {
    const start = this.index;
    const symbol = this.advance();
    if (symbol === cp('*')) return { max: null, min: 0 };
    if (symbol === cp('+')) return { max: null, min: 1 };
    if (symbol === cp('?')) return { max: 1, min: 0 };
    const min = this.parseCount(start);
    let max: number | null = min;
    if (this.peek() === cp(',')) {
      this.advance();
      max = this.peek() === cp('}') ? null : this.parseCount(start);
    }
    if (this.peek() !== cp('}')) return fail('syntax', 'Incomplete quantifier.', start);
    this.advance();
    if (max !== null && min > max) {
      return fail('syntax', 'Quantifier range is out of order.', start);
    }
    return { max, min };
  }

  private parseCount(quantifierStart: number): number {
    const digitsStart = this.index;
    let value = 0;
    while (this.peek() >= 0x30 && this.peek() <= 0x39) {
      value = value * 10 + (this.advance() - 0x30);
      if (value > BOUNDED_REGEX_LIMITS.repetition_count) {
        return fail(
          'too_large',
          `Repetition count exceeds the limit of ${String(BOUNDED_REGEX_LIMITS.repetition_count)}.`,
          digitsStart,
        );
      }
    }
    if (this.index === digitsStart)
      return fail('syntax', 'Incomplete quantifier.', quantifierStart);
    return value;
  }

  private parseAtom(): RegexNode {
    const offset = this.index;
    const code = this.peek();
    if (code === cp('(')) return this.parseGroup();
    if (code === cp('[')) return this.parseClass();
    if (code === BACKSLASH) return this.parseEscape();
    this.advance();
    if (code === cp('.')) return { kind: 'set', negated: true, ranges: LINE_TERMINATORS, offset };
    if (code === cp('^')) return { kind: 'assertion', assertion: 'line_start', offset };
    if (code === cp('$')) return { kind: 'assertion', assertion: 'line_end', offset };
    if (code === cp('*') || code === cp('+') || code === cp('?') || code === cp('{')) {
      return fail('syntax', 'Nothing to repeat.', offset);
    }
    if (code === cp('}') || code === cp(']')) {
      return fail(
        'syntax',
        'Lone bracket: escape it with a backslash to match it literally.',
        offset,
      );
    }
    return { kind: 'set', negated: false, ranges: [[code, code]], offset };
  }

  private parseGroup(): RegexNode {
    const offset = this.index;
    this.advance(); // (
    if (this.depth + 1 > BOUNDED_REGEX_LIMITS.group_depth) {
      return fail(
        'too_large',
        `Groups are nested deeper than the limit of ${String(BOUNDED_REGEX_LIMITS.group_depth)}.`,
        offset,
      );
    }
    if (this.peek() === cp('?')) {
      this.advance();
      const kind = this.peek();
      if (kind === cp(':')) {
        this.advance();
      } else if (kind === cp('=') || kind === cp('!')) {
        return fail('unsupported', 'Lookahead assertions are not supported.', offset);
      } else if (kind === cp('<')) {
        const following = this.peek(this.index + 1);
        if (following === cp('=') || following === cp('!')) {
          return fail('unsupported', 'Lookbehind assertions are not supported.', offset);
        }
        return fail('unsupported', 'Named groups are not supported.', offset);
      } else if (kind === END || kind === cp(')')) {
        return fail('syntax', 'Invalid group: nothing follows "(?".', offset);
      } else {
        return fail('unsupported', 'Inline modifiers are not supported.', offset);
      }
    }
    this.depth += 1;
    const inner = this.parseDisjunction();
    this.depth -= 1;
    if (this.peek() !== cp(')')) return fail('syntax', 'Unterminated group: missing ")".', offset);
    this.advance();
    // A group is quantifiable even when it holds only an assertion, as in `(?:^)+`.
    return inner.kind === 'assertion' ? { kind: 'concat', items: [inner], offset } : inner;
  }

  private parseEscape(): RegexNode {
    const offset = this.index;
    this.advance(); // backslash
    const code = this.peek();
    if (code === END) return fail('syntax', 'The pattern ends with a backslash.', offset);
    const letter = String.fromCodePoint(code);
    this.advance();
    const classRanges = CLASS_ESCAPES[letter];
    if (classRanges !== undefined)
      return { kind: 'set', negated: false, ranges: classRanges, offset };
    if (NEGATED_CLASS_ESCAPES.has(letter)) {
      const lower = letter.toLowerCase();
      return {
        kind: 'set',
        negated: true,
        ranges: CLASS_ESCAPES[lower] ?? [],
        offset,
      };
    }
    if (letter === 'b') return { kind: 'assertion', assertion: 'word_boundary', offset };
    if (letter === 'B') return { kind: 'assertion', assertion: 'not_word_boundary', offset };
    const control = CONTROL_ESCAPES[letter];
    if (control !== undefined)
      return { kind: 'set', negated: false, ranges: [[control, control]], offset };
    if (isIdentityEscape(code))
      return { kind: 'set', negated: false, ranges: [[code, code]], offset };
    return this.rejectEscape(letter, offset);
  }

  /** Names the reason for every escape that is not in the language. */
  private rejectEscape(letter: string, offset: number): never {
    if (letter >= '1' && letter <= '9') {
      return fail('unsupported', 'Backreferences are not supported.', offset);
    }
    if (letter === 'k')
      return fail('unsupported', 'Named backreferences are not supported.', offset);
    if (letter === 'p' || letter === 'P') {
      return fail('unsupported', 'Unicode property escapes are not supported.', offset);
    }
    if (letter === 'u' || letter === 'x') {
      return fail(
        'unsupported',
        `The \\${letter} escape is not supported; write the character itself.`,
        offset,
      );
    }
    if (letter === 'c' || letter === '0') {
      return fail('unsupported', `The \\${letter} escape is not supported.`, offset);
    }
    return fail('syntax', `Invalid escape \\${letter}.`, offset);
  }

  private parseClass(): RegexNode {
    const offset = this.index;
    this.advance(); // [
    let negated = false;
    if (this.peek() === cp('^')) {
      negated = true;
      this.advance();
    }
    const ranges: CodePointRange[] = [];
    for (;;) {
      const code = this.peek();
      if (code === END) return fail('syntax', 'Unterminated character class.', offset);
      if (code === cp(']')) {
        this.advance();
        break;
      }
      const atomStart = this.index;
      const first = this.parseClassAtom();
      if (this.peek() === cp('-') && this.peek(this.index + 1) !== cp(']')) {
        const dash = this.index;
        this.advance();
        if (this.peek() === END) return fail('syntax', 'Unterminated character class.', offset);
        const last = this.parseClassAtom();
        if (first.kind === 'class' || last.kind === 'class') {
          return fail('syntax', 'A character class escape cannot be a range endpoint.', dash);
        }
        if (first.code > last.code) return fail('syntax', 'Range out of order.', atomStart);
        ranges.push([first.code, last.code]);
        continue;
      }
      if (first.kind === 'class') ranges.push(...first.ranges);
      else ranges.push([first.code, first.code]);
    }
    return { kind: 'set', negated, ranges, offset };
  }

  private parseClassAtom(): ClassAtom {
    const offset = this.index;
    const code = this.advance();
    if (code !== BACKSLASH) return { kind: 'char', code };
    const escaped = this.peek();
    if (escaped === END) return fail('syntax', 'The pattern ends with a backslash.', offset);
    const letter = String.fromCodePoint(escaped);
    this.advance();
    const classRanges = CLASS_ESCAPES[letter];
    if (classRanges !== undefined) return { kind: 'class', ranges: classRanges };
    if (NEGATED_CLASS_ESCAPES.has(letter)) {
      return fail('unsupported', `\\${letter} is not supported inside a character class.`, offset);
    }
    if (letter === 'b') {
      return fail('unsupported', '\\b inside a character class is not supported.', offset);
    }
    const control = CONTROL_ESCAPES[letter];
    if (control !== undefined) return { kind: 'char', code: control };
    if (isIdentityEscape(escaped) || letter === '-') return { kind: 'char', code: escaped };
    if (letter === 'B')
      return fail('syntax', 'Invalid escape \\B inside a character class.', offset);
    return this.rejectEscape(letter, offset);
  }
}

/** Parses a pattern into an AST, or reports why the pattern is not in the language. */
export const parsePattern = (pattern: string): ParseResult => {
  if (pattern.length > BOUNDED_REGEX_LIMITS.pattern_characters) {
    return {
      ok: false,
      error: {
        code: 'too_large',
        message: `Pattern is longer than the limit of ${String(BOUNDED_REGEX_LIMITS.pattern_characters)} characters.`,
        offset: BOUNDED_REGEX_LIMITS.pattern_characters,
      },
    };
  }
  try {
    return { ok: true, ast: new Parser(pattern).parse() };
  } catch (error) {
    if (error instanceof ParseFailure) return { ok: false, error: error.detail };
    throw error;
  }
};
