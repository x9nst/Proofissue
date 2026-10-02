import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { compileBoundedRegex, searchBoundedRegex } from './index.js';
import { compilePattern } from './regex/compile.js';

/*
 * The differential tests are the safety net for the engine: every pattern it accepts must mean
 * exactly what `new RegExp(pattern, 'mu')` means in V8, on every input.
 */

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 30_000 + RUNS * 12;

const BACKSLASH = String.fromCharCode(92);
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const ASTRAL = String.fromCodePoint(0x1f600);
const LONE_HIGH = String.fromCharCode(0xd83d);
const LONE_LOW = String.fromCharCode(0xde00);

/**
 * What V8 says about an unanchored search, evaluated the way the ECMAScript specification defines
 * it: a sticky match attempted at every code point boundary, and nowhere else. A plain
 * `RegExp.prototype.test` agrees except for one V8 quirk: a pattern that starts with an assertion
 * (`\B`, for example) can also be tried in the middle of a surrogate pair, so `\B` "matches"
 * `b` + U+1F600 + `1` there, where the specification (and this engine) finds no position.
 */
const v8Matches = (pattern: string, text: string): boolean => {
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

const engineMatches = (pattern: string, text: string): boolean | 'rejected' => {
  const compiled = compilePattern(pattern, { reject_empty: false });
  if (!compiled.ok) return 'rejected';
  const result = searchBoundedRegex(compiled.program, text);
  if (result.status === 'step_limit_exceeded') throw new Error('step limit on a tiny input');
  return result.status === 'matched';
};

// Inputs: short strings over letters, digits, an underscore, spaces, every line terminator the
// language knows, a space-like character, an astral character, and both lone surrogates.
const inputCharacter = fc.constantFrom(
  'a',
  'b',
  'A',
  '1',
  '_',
  ' ',
  '-',
  '\n',
  '\r',
  LINE_SEPARATOR,
  String.fromCharCode(0xa0),
  'é',
  ASTRAL,
  LONE_HIGH,
  LONE_LOW,
);
const inputText = fc.array(inputCharacter, { maxLength: 12 }).map((items) => items.join(''));

type Tree =
  | { readonly t: 'atom'; readonly src: string }
  | { readonly t: 'assert'; readonly src: string }
  | { readonly t: 'empty' }
  | { readonly t: 'cat'; readonly items: readonly Tree[] }
  | { readonly t: 'alt'; readonly items: readonly Tree[] }
  | { readonly t: 'group'; readonly capture: boolean; readonly item: Tree }
  | { readonly t: 'rep'; readonly item: Tree; readonly quantifier: string };

const atomSources = [
  'a',
  'b',
  '1',
  '_',
  ' ',
  '-',
  'é',
  ASTRAL,
  LONE_HIGH,
  '.',
  `${BACKSLASH}d`,
  `${BACKSLASH}D`,
  `${BACKSLASH}w`,
  `${BACKSLASH}W`,
  `${BACKSLASH}s`,
  `${BACKSLASH}S`,
  `${BACKSLASH}n`,
  `${BACKSLASH}r`,
  `${BACKSLASH}t`,
  `${BACKSLASH}.`,
  '[ab]',
  '[^ab]',
  '[a-b_]',
  `[${BACKSLASH}d_]`,
  `[${BACKSLASH}w${BACKSLASH}s]`,
  `[${BACKSLASH}n${BACKSLASH}r]`,
  `[^${BACKSLASH}s]`,
  `[${BACKSLASH}-a]`,
  '[a-]',
  '[-a]',
  '[]',
  '[^]',
  `[${ASTRAL}-${ASTRAL}]`,
  '[\u{10000}-\u{10FFFF}]',
  `[${LONE_HIGH}b]`,
];

const assertionSources = ['^', '$', `${BACKSLASH}b`, `${BACKSLASH}B`];

const quantifiers = [
  '*',
  '+',
  '?',
  '*?',
  '+?',
  '??',
  '{0}',
  '{1}',
  '{2}',
  '{0,1}',
  '{1,2}',
  '{2,}',
  '{0,}',
  '{2,3}',
  '{1,3}?',
  '{0,2}?',
];

const tree = fc.letrec<{ node: Tree }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    fc.constantFrom(...atomSources).map((src): Tree => ({ t: 'atom', src })),
    fc.constantFrom(...atomSources).map((src): Tree => ({ t: 'atom', src })),
    fc.constantFrom(...assertionSources).map((src): Tree => ({ t: 'assert', src })),
    fc.constant<Tree>({ t: 'empty' }),
    fc
      .array(tie('node'), { minLength: 2, maxLength: 4 })
      .map((items): Tree => ({ t: 'cat', items })),
    fc
      .array(tie('node'), { minLength: 2, maxLength: 3 })
      .map((items): Tree => ({ t: 'alt', items })),
    fc
      .tuple(fc.boolean(), tie('node'))
      .map(([capture, item]): Tree => ({ t: 'group', capture, item })),
    fc
      .tuple(tie('node'), fc.constantFrom(...quantifiers))
      .map(([item, quantifier]): Tree => ({ t: 'rep', item, quantifier })),
  ),
})).node;

/** Prints a tree so that its structure, not operator precedence, decides what it means. */
const render = (node: Tree, top = false): string => {
  switch (node.t) {
    case 'atom':
    case 'assert':
      return node.src;
    case 'empty':
      return '';
    case 'cat':
      return node.items.map((item) => render(item)).join('');
    case 'alt': {
      const body = node.items.map((item) => render(item)).join('|');
      return top ? body : `(?:${body})`;
    }
    case 'group':
      return `(${node.capture ? '' : '?:'}${render(node.item, true)})`;
    case 'rep': {
      const quantifiable =
        node.item.t === 'atom' || node.item.t === 'group'
          ? render(node.item)
          : `(?:${render(node.item, true)})`;
      return `${quantifiable}${node.quantifier}`;
    }
  }
};

const printTree = (node: Tree): string => render(node, true);

describe('bounded regular expressions against V8', () => {
  it(
    'agrees with V8 RegExp test for generated subset patterns',
    () => {
      fc.assert(
        fc.property(tree, fc.array(inputText, { minLength: 3, maxLength: 5 }), (root, texts) => {
          const pattern = printTree(root);
          const compiled = compilePattern(pattern, { reject_empty: false });
          // Every generated pattern is in the subset, so the engine must accept it.
          expect(compiled.ok, `rejected ${JSON.stringify(pattern)}`).toBe(true);
          for (const text of texts) {
            expect(
              engineMatches(pattern, text),
              `${JSON.stringify(pattern)} on ${JSON.stringify(text)}`,
            ).toBe(v8Matches(pattern, text));
          }
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'agrees with V8 on the texts that make the generated patterns match',
    () => {
      // A random input rarely satisfies a long pattern, so also use texts built from the pattern's
      // own literal characters, which exercises the "matched" side much more often.
      const literalAlphabet = fc.constantFrom('a', 'b', '1', '_', ' ', '-', '\n', 'é', ASTRAL);
      const literalText = fc
        .array(literalAlphabet, { maxLength: 10 })
        .map((items) => items.join(''));
      fc.assert(
        fc.property(tree, fc.array(literalText, { minLength: 4, maxLength: 6 }), (root, texts) => {
          const pattern = printTree(root);
          for (const text of texts) {
            expect(
              engineMatches(pattern, text),
              `${JSON.stringify(pattern)} on ${JSON.stringify(text)}`,
            ).toBe(v8Matches(pattern, text));
          }
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  const metaCharacters = [
    'a',
    'b',
    '1',
    '^',
    '$',
    '.',
    '*',
    '+',
    '?',
    '(',
    ')',
    '[',
    ']',
    '{',
    '}',
    '|',
    BACKSLASH,
    '-',
    ',',
    ':',
    '=',
    '!',
    '<',
    '>',
    'd',
    'w',
    's',
    'b',
    'B',
    'n',
    'k',
    'p',
    'u',
    'x',
    'c',
    '0',
    '2',
    '/',
    ' ',
  ];
  const randomPattern = fc
    .array(fc.constantFrom(...metaCharacters), { maxLength: 12 })
    .map((items) => items.join(''));

  it(
    'every accepted generated pattern is also valid for V8 with flags mu',
    () => {
      fc.assert(
        fc.property(randomPattern, fc.array(inputText, { maxLength: 3 }), (pattern, texts) => {
          const compiled = compilePattern(pattern, { reject_empty: false });
          if (compiled.ok) {
            // The engine accepted it, so V8 must too, and they must agree on the texts.
            expect(() => new RegExp(pattern, 'mu'), JSON.stringify(pattern)).not.toThrow();
            for (const text of texts) {
              expect(
                engineMatches(pattern, text),
                `${JSON.stringify(pattern)} on ${JSON.stringify(text)}`,
              ).toBe(v8Matches(pattern, text));
            }
          } else if (compiled.error.code === 'syntax') {
            // A syntax error is an error for V8 as well; only unsupported features are valid there.
            expect(() => new RegExp(pattern, 'mu'), JSON.stringify(pattern)).toThrow();
          }
        }),
        { numRuns: RUNS * 2 },
      );
    },
    PROPERTY_TIMEOUT_MS * 2,
  );

  it(
    'the public compiler accepts exactly the patterns the internal one accepts that cannot be empty',
    () => {
      fc.assert(
        fc.property(randomPattern, (pattern) => {
          const internal = compilePattern(pattern, { reject_empty: false });
          const publicResult = compileBoundedRegex(pattern);
          if (!internal.ok) {
            expect(publicResult.ok).toBe(false);
            if (!publicResult.ok) expect(publicResult.error.code).toBe(internal.error.code);
            return;
          }
          if (publicResult.ok) {
            // A pattern the public compiler accepts cannot match the empty text.
            expect(engineMatches(pattern, '')).toBe(false);
          } else {
            expect(publicResult.error.code).toBe('matches_empty');
          }
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  // Counterexamples pinned from scale runs; each of these once disagreed or was rejected.
  const regressions: readonly (readonly [string, string])[] = [];

  it.each(regressions)('stays pinned: %s', (pattern, text) => {
    expect(engineMatches(pattern, text)).toBe(v8Matches(pattern, text));
  });
});
