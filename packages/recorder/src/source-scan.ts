/**
 * A small scanner for the relative module specifiers of one JavaScript source file.
 *
 * It exists only to suggest files, so it is deliberately modest: it reads string-literal
 * specifiers that begin with `./` or `../` in `import ... from`, `export ... from`, bare
 * `import '...'`, `import('...')`, and `require('...')`. It skips comments, string literals,
 * template literals, and (heuristically) regular-expression literals, so a specifier written
 * inside them is not reported. Anything it cannot read as a literal, such as
 * `import(name)` or `require('./' + name)`, is ignored.
 *
 * It never throws, reads each character a bounded number of times, and returns at most
 * `MAX_SPECIFIERS` distinct specifiers of at most `MAX_SPECIFIER_LENGTH` characters. It runs no
 * code and is not a parser: unusual syntax may be missed, which only means a file is not
 * suggested.
 */

export const MAX_SPECIFIERS = 1000;
export const MAX_SPECIFIER_LENGTH = 1024;

export interface SourceScan {
  /** Distinct relative specifiers in source order. */
  readonly specifiers: readonly string[];
  /** Loop iterations used: at most a small constant times the source length. */
  readonly steps: number;
}

type Previous =
  | { readonly kind: 'none' }
  | { readonly kind: 'word'; readonly text: string }
  | { readonly kind: 'punct'; readonly text: string }
  | { readonly kind: 'string'; readonly text: string }
  | { readonly kind: 'value' };

// Words after which a `/` starts a regular expression rather than dividing.
const REGEX_AFTER_WORDS: ReadonlySet<string> = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const isIdentifierStart = (code: number): boolean =>
  (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95;

const isIdentifierPart = (code: number): boolean =>
  isIdentifierStart(code) || (code >= 48 && code <= 57);

const isWhitespace = (code: number): boolean =>
  code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12;

const isRelativeSpecifier = (value: string): boolean =>
  (value.startsWith('./') || value.startsWith('../')) &&
  value.length <= MAX_SPECIFIER_LENGTH &&
  !value.includes('\n');

/**
 * Scans `source` for relative specifiers. See the file comment for what is and is not read.
 */
export const scanRelativeSpecifiers = (source: string): SourceScan => {
  const specifiers: string[] = [];
  const seen = new Set<string>();
  const length = source.length;
  let steps = 0;
  let index = 0;
  let previous: Previous = { kind: 'none' };
  // The word before the previous token, to see `import (` and `from '...'` in context.
  let beforePrevious: Previous = { kind: 'none' };
  // After a regex attempt fails on a line, no later `/` on that line is tried again.
  let regexBlockedUntil = -1;
  // `b` for a plain brace, `t` for the `${` of a template literal.
  const braces: ('b' | 't')[] = [];

  const add = (value: string): void => {
    if (specifiers.length >= MAX_SPECIFIERS || seen.has(value)) return;
    if (!isRelativeSpecifier(value)) return;
    seen.add(value);
    specifiers.push(value);
  };

  const push = (token: Previous): void => {
    beforePrevious = previous;
    previous = token;
  };

  // Reads a quoted string starting at the opening quote. Returns the index after it and its
  // value when it closed on the same line (a string cannot contain a raw newline).
  const readString = (start: number): { end: number; value: string | undefined } => {
    const quote = source.charCodeAt(start);
    let position = start + 1;
    let value = '';
    while (position < length) {
      steps += 1;
      const code = source.charCodeAt(position);
      if (code === quote) return { end: position + 1, value };
      if (code === 10 || code === 13) return { end: position, value: undefined };
      if (code === 92) {
        const next = source.charAt(position + 1);
        if (next === '\r' || next === '\n') {
          position += 2;
          continue;
        }
        // An escape makes the literal's value unlike its source; do not report it.
        value += '\0';
        position += 2;
        continue;
      }
      if (value.length <= MAX_SPECIFIER_LENGTH) value += source.charAt(position);
      position += 1;
    }
    return { end: length, value: undefined };
  };

  // Reads template text from just after a backtick or a closing brace until the next `${` or
  // closing backtick. Returns the index after it and whether an expression follows.
  const readTemplate = (start: number): { end: number; expression: boolean } => {
    let position = start;
    while (position < length) {
      steps += 1;
      const code = source.charCodeAt(position);
      if (code === 96) return { end: position + 1, expression: false };
      if (code === 36 && source.charCodeAt(position + 1) === 123) {
        return { end: position + 2, expression: true };
      }
      position += code === 92 ? 2 : 1;
    }
    return { end: length, expression: false };
  };

  const readRegex = (start: number): number | undefined => {
    let position = start + 1;
    let inClass = false;
    while (position < length) {
      steps += 1;
      const code = source.charCodeAt(position);
      if (code === 10 || code === 13) {
        regexBlockedUntil = position;
        return undefined;
      }
      if (code === 92) {
        position += 2;
        continue;
      }
      if (code === 91) inClass = true;
      else if (code === 93) inClass = false;
      else if (code === 47 && !inClass) {
        position += 1;
        while (position < length && isIdentifierPart(source.charCodeAt(position))) {
          steps += 1;
          position += 1;
        }
        return position;
      }
      position += 1;
    }
    regexBlockedUntil = length;
    return undefined;
  };

  const regexAllowed = (): boolean => {
    if (previous.kind === 'none') return true;
    if (previous.kind === 'word') return REGEX_AFTER_WORDS.has(previous.text);
    if (previous.kind === 'punct') {
      return previous.text !== ')' && previous.text !== ']' && previous.text !== '}';
    }
    return false;
  };

  // A specifier is reported when the string follows `from`, `import`, `import(`, or
  // `require(` and, for the call forms, is closed by `)` or followed by an argument list.
  const followsTrigger = (): 'from' | 'import' | 'call' | undefined => {
    if (previous.kind === 'word' && (previous.text === 'from' || previous.text === 'import')) {
      // `x.from('./a')` and `x.import` are member accesses, not syntax.
      if (beforePrevious.kind === 'punct' && beforePrevious.text === '.') return undefined;
      return previous.text;
    }
    if (previous.kind === 'punct' && previous.text === '(') {
      if (
        beforePrevious.kind === 'word' &&
        (beforePrevious.text === 'import' || beforePrevious.text === 'require')
      ) {
        return 'call';
      }
    }
    return undefined;
  };

  const closesCall = (position: number): boolean => {
    let next = position;
    while (next < length && isWhitespace(source.charCodeAt(next))) {
      steps += 1;
      next += 1;
    }
    const code = source.charCodeAt(next);
    return code === 41 || code === 44;
  };

  while (index < length) {
    steps += 1;
    const code = source.charCodeAt(index);

    if (isWhitespace(code)) {
      index += 1;
      continue;
    }

    if (code === 47) {
      const next = source.charCodeAt(index + 1);
      if (next === 47) {
        index += 2;
        while (
          index < length &&
          source.charCodeAt(index) !== 10 &&
          source.charCodeAt(index) !== 13
        ) {
          steps += 1;
          index += 1;
        }
        continue;
      }
      if (next === 42) {
        index += 2;
        while (
          index < length &&
          !(source.charCodeAt(index) === 42 && source.charCodeAt(index + 1) === 47)
        ) {
          steps += 1;
          index += 1;
        }
        index += 2;
        continue;
      }
      if (index >= regexBlockedUntil && regexAllowed()) {
        const end = readRegex(index);
        if (end !== undefined) {
          index = end;
          push({ kind: 'value' });
          continue;
        }
      }
      index += 1;
      push({ kind: 'punct', text: '/' });
      continue;
    }

    if (code === 39 || code === 34) {
      const literal = readString(index);
      const trigger = literal.value === undefined ? undefined : followsTrigger();
      if (
        literal.value !== undefined &&
        trigger !== undefined &&
        (trigger !== 'call' || closesCall(literal.end))
      ) {
        add(literal.value);
      }
      index = Math.max(literal.end, index + 1);
      push({ kind: 'string', text: literal.value ?? '' });
      continue;
    }

    if (code === 96) {
      const template = readTemplate(index + 1);
      index = template.end;
      if (template.expression) {
        braces.push('t');
        push({ kind: 'punct', text: '{' });
      } else {
        push({ kind: 'value' });
      }
      continue;
    }

    if (code === 123) {
      braces.push('b');
      index += 1;
      push({ kind: 'punct', text: '{' });
      continue;
    }

    if (code === 125) {
      index += 1;
      if (braces.pop() === 't') {
        const template = readTemplate(index);
        index = template.end;
        if (template.expression) {
          braces.push('t');
          push({ kind: 'punct', text: '{' });
        } else {
          push({ kind: 'value' });
        }
      } else {
        push({ kind: 'punct', text: '}' });
      }
      continue;
    }

    if (isIdentifierStart(code)) {
      const start = index;
      while (index < length && isIdentifierPart(source.charCodeAt(index))) {
        steps += 1;
        index += 1;
      }
      push({ kind: 'word', text: source.slice(start, index) });
      continue;
    }

    if (code >= 48 && code <= 57) {
      while (index < length && isIdentifierPart(source.charCodeAt(index))) {
        steps += 1;
        index += 1;
      }
      push({ kind: 'value' });
      continue;
    }

    index += 1;
    push({ kind: 'punct', text: String.fromCharCode(code) });
  }

  return { specifiers, steps };
};
