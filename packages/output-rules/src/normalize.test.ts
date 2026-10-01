import { performance } from 'node:perf_hooks';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { OutputNormalizationRule } from '@proofissue/contracts';

import {
  DEFAULT_OUTPUT_NORMALIZATION,
  EMPTY_OUTPUT_PATH_CONTEXT,
  NORMALIZATION_TOKENS,
  OUTPUT_NORMALIZATION_RULES,
  createOutputPathContext,
  isCanonicalNormalizationRuleList,
  normalizeOutput,
} from './index.js';

const RUNS = Number(process.env['PROOFISSUE_PROPERTY_RUNS'] ?? '1000');
const PROPERTY_TIMEOUT_MS = 20_000 + RUNS * 5;
const BUDGET_MS = 2000;
const MIB = 1_048_576;

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const C1_CSI = String.fromCharCode(0x9b);
const BACKSLASH = String.fromCharCode(92);

const replayContext = createOutputPathContext({
  platform: 'posix',
  project_roots: ['/workspace'],
  temporary_roots: ['/tmp'],
});

const only = (rule: OutputNormalizationRule, text: string, context = EMPTY_OUTPUT_PATH_CONTEXT) =>
  normalizeOutput(text, [rule], context);

describe('rule list', () => {
  it('names every rule once, in canonical order, and defaults to all of them', () => {
    const exhaustive = {
      line_endings: true,
      ansi_escapes: true,
      trailing_whitespace: true,
      paths: true,
      node_version: true,
      node_internal_locations: true,
      process_ids: true,
      durations: true,
    } satisfies Record<OutputNormalizationRule, true>;

    expect([...OUTPUT_NORMALIZATION_RULES].sort()).toEqual(Object.keys(exhaustive).sort());
    expect(OUTPUT_NORMALIZATION_RULES).toEqual([
      'line_endings',
      'ansi_escapes',
      'trailing_whitespace',
      'paths',
      'node_version',
      'node_internal_locations',
      'process_ids',
      'durations',
    ]);
    expect(DEFAULT_OUTPUT_NORMALIZATION).toEqual(OUTPUT_NORMALIZATION_RULES);
    expect(Object.isFrozen(OUTPUT_NORMALIZATION_RULES)).toBe(true);
  });

  it('accepts only non-empty, known, unique lists in canonical order', () => {
    expect(isCanonicalNormalizationRuleList(OUTPUT_NORMALIZATION_RULES)).toBe(true);
    expect(isCanonicalNormalizationRuleList(['line_endings', 'paths'])).toBe(true);
    expect(isCanonicalNormalizationRuleList(['durations'])).toBe(true);
    expect(isCanonicalNormalizationRuleList([])).toBe(false);
    expect(isCanonicalNormalizationRuleList(['paths', 'line_endings'])).toBe(false);
    expect(isCanonicalNormalizationRuleList(['paths', 'paths'])).toBe(false);
    expect(isCanonicalNormalizationRuleList(['line_endings', 'unknown_rule'])).toBe(false);
  });

  it('keeps the token spellings that the rule definitions promise', () => {
    expect(NORMALIZATION_TOKENS).toEqual({
      column: '<column>',
      duration: '<duration>',
      line: '<line>',
      node_version: '<node-version>',
      pid: '<pid>',
      project: '<project>',
      temporary: '<tmp>',
    });
  });
});

describe('normalizeOutput', () => {
  it('applies rules in the documented order regardless of list order', () => {
    // Trailing-whitespace removal only sees the space once the escape sequence and the
    // carriage return have been handled, so the result depends on the rule order.
    const text = `x ${ESC}[0m\r`;
    const forward = normalizeOutput(
      text,
      ['line_endings', 'ansi_escapes', 'trailing_whitespace'],
      EMPTY_OUTPUT_PATH_CONTEXT,
    );
    const reversed = normalizeOutput(
      text,
      ['trailing_whitespace', 'ansi_escapes', 'line_endings'],
      EMPTY_OUTPUT_PATH_CONTEXT,
    );

    expect(forward.text).toBe('x\n');
    expect(reversed).toEqual(forward);
  });

  it('returns the text unchanged when no rule is listed', () => {
    expect(normalizeOutput('a\r\n  ', [], EMPTY_OUTPUT_PATH_CONTEXT)).toEqual({
      text: 'a\r\n  ',
      changes: [],
    });
  });

  it('line_endings converts CRLF and lone CR and counts them', () => {
    expect(only('line_endings', 'a\r\nb\rc\nd\r\r\ne')).toEqual({
      text: 'a\nb\nc\nd\n\ne',
      changes: [{ rule: 'line_endings', count: 4 }],
    });
  });

  it.each([
    ['a color sequence', `${ESC}[31mred${ESC}[0m`, 'red', 2],
    ['parameters and an intermediate byte', `a${ESC}[1;2 qb`, 'ab', 1],
    ['a private-mode sequence', `${ESC}[?25lhidden${ESC}[?25h`, 'hidden', 2],
    ['an operating-system command ended by BEL', `${ESC}]0;window title${BEL}text`, 'text', 1],
    [
      'an operating-system command ended by ST',
      `${ESC}]8;;https://example.test${ESC}${BACKSLASH}link${ESC}]8;;${ESC}${BACKSLASH}`,
      'link',
      2,
    ],
    ['an nF sequence', `${ESC}(Btext`, 'text', 1],
    ['a two-character sequence', `${ESC}7saved${ESC}8`, 'saved', 2],
    ['the single-character CSI introducer', `${C1_CSI}31mred${C1_CSI}0m`, 'red', 2],
    ['a lone escape at the end', `text${ESC}`, 'text', 1],
    ['an escape before a control character', `a${ESC}\nb`, 'a\nb', 1],
    ['an unterminated CSI leaves its bytes', `a${ESC}[31`, 'a[31', 1],
    ['an unterminated OSC leaves its body', `a${ESC}]0;title`, 'a]0;title', 1],
    ['an OSC cut off by another escape', `${ESC}]0;t${ESC}[0mx`, ']0;tx', 2],
    ['an escape before another escape', `${ESC}${ESC}[0mx`, 'x', 2],
    ['a CSI interrupted by a control character', `${ESC}[3\n1mx`, '[3\n1mx', 1],
  ])('ansi_escapes removes %s', (_name, input, expected, count) => {
    expect(only('ansi_escapes', input)).toEqual({
      text: expected,
      changes: [{ rule: 'ansi_escapes', count }],
    });
  });

  it('ansi_escapes leaves text with no escape character alone', () => {
    expect(only('ansi_escapes', 'plain [31m text ]0; and (B')).toEqual({
      text: 'plain [31m text ]0; and (B',
      changes: [],
    });
  });

  it('trailing_whitespace strips spaces and tabs before line ends and at the end only', () => {
    expect(only('trailing_whitespace', 'a  \nb\t\n c \n  ')).toEqual({
      text: 'a\nb\n c\n',
      changes: [{ rule: 'trailing_whitespace', count: 4 }],
    });
  });

  it('trailing_whitespace keeps leading and interior whitespace and other Unicode spaces', () => {
    const nbsp = String.fromCharCode(0xa0);
    const verticalTab = String.fromCharCode(11);
    const input = `  a  b\n${nbsp}\n${verticalTab}`;

    expect(only('trailing_whitespace', input)).toEqual({ text: input, changes: [] });
  });

  it('node_version replaces the uncaught-error trailer', () => {
    expect(only('node_version', 'Error: boom\n\nNode.js v24.15.0\n')).toEqual({
      text: 'Error: boom\n\nNode.js <node-version>\n',
      changes: [{ rule: 'node_version', count: 1 }],
    });
    expect(only('node_version', 'Node.js v24.15 and node v1.2.3').changes).toEqual([]);
  });

  it('node_internal_locations replaces line and column of node: frames only', () => {
    const input = [
      '    at async node:internal/test_runner/test:1201:25',
      '    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
      '    at TestContext.<anonymous> (file:///workspace/test/a.mjs:3:9)',
      '    at foo (/srv/p/a.js:10:2)',
      '    at node:async_hooks:227:14',
    ].join('\n');

    expect(only('node_internal_locations', input)).toEqual({
      text: [
        '    at async node:internal/test_runner/test:<line>:<column>',
        '    at process.processTicksAndRejections (node:internal/process/task_queues:<line>:<column>)',
        '    at TestContext.<anonymous> (file:///workspace/test/a.mjs:3:9)',
        '    at foo (/srv/p/a.js:10:2)',
        '    at node:async_hooks:<line>:<column>',
      ].join('\n'),
      changes: [{ rule: 'node_internal_locations', count: 3 }],
    });
  });

  it('process_ids replaces Node warning prefixes', () => {
    expect(only('process_ids', '(node:2196) Warning: x\n(node:abc) (node:7)')).toEqual({
      text: '(node:<pid>) Warning: x\n(node:abc) (node:<pid>)',
      changes: [{ rule: 'process_ids', count: 2 }],
    });
  });

  it.each([
    ['node --test spec', '✖ failing test (2.4784ms)', '✖ failing test (<duration>)', 1],
    ['node --test summary', 'ℹ duration_ms 9.9138', 'ℹ duration_ms <duration>', 1],
    ['node --test TAP', '  duration_ms: 48.6749', '  duration_ms: <duration>', 1],
    ['mocha', '  ✔ works (52ms)', '  ✔ works (<duration>)', 1],
    ['a spaced unit', 'done (3 ms)', 'done (<duration>)', 1],
    ['jest total time', 'Time:        1.234 s', 'Time:        <duration>', 1],
    [
      'vitest duration',
      'Duration  1.23s (transform 20ms, setup 0ms)',
      'Duration  <duration> (transform <duration>, setup <duration>)',
      3,
    ],
  ])('durations covers %s output', (_name, input, expected, count) => {
    expect(only('durations', input)).toEqual({
      text: expected,
      changes: [{ rule: 'durations', count }],
    });
  });

  it.each([
    'version v1.2.3ms',
    'identifier id12ms',
    'seconds 3s',
    'about 5 sec',
    'dotted 1.5.3ms',
    'suffix 12msg',
    'prefix x1.5s',
    'total_duration_ms: 5',
    'line 12 of 40',
  ])('does not treat %s as a duration', (input) => {
    expect(only('durations', input)).toEqual({ text: input, changes: [] });
  });

  it('reports changes only for rules that changed something, in rule order', () => {
    const result = normalizeOutput(
      `took 5ms\r\n(node:12) x`,
      ['line_endings', 'ansi_escapes', 'process_ids', 'durations'],
      EMPTY_OUTPUT_PATH_CONTEXT,
    );

    expect(result.text).toBe('took <duration>\n(node:<pid>) x');
    expect(result.changes).toEqual([
      { rule: 'line_endings', count: 1 },
      { rule: 'process_ids', count: 1 },
      { rule: 'durations', count: 1 },
    ]);
  });

  it('applies the paths rule with the supplied context only', () => {
    const text = 'at /workspace/test/a.mjs:3:9';

    expect(only('paths', text)).toEqual({ text, changes: [] });
    expect(only('paths', text, replayContext)).toEqual({
      text: 'at <project>/test/a.mjs:3:9',
      changes: [{ rule: 'paths', count: 1 }],
    });
  });

  it('normalizes a container-shaped failure and a locally recorded one to the same text', () => {
    const recordContext = createOutputPathContext({
      platform: 'win32',
      project_roots: ['D:\\src\\project'],
      temporary_roots: ['C:\\Windows\\temp'],
      declared_paths: ['test/reproduction.mjs'],
    });
    const local = [
      `${ESC}[31mAssertionError: Expected 4 (took 12.5ms)${ESC}[0m   `,
      '    at TestContext.<anonymous> (file:///D:/src/project/test/reproduction.mjs:3:9)',
      '    at async node:internal/test_runner/test:1201:25',
      '',
      'Node.js v24.15.0',
    ].join('\r\n');
    const container = [
      'AssertionError: Expected 4 (took 3.1ms)',
      '    at TestContext.<anonymous> (file:///workspace/test/reproduction.mjs:3:9)',
      '    at async node:internal/test_runner/test:1190:21',
      '',
      'Node.js v24.15.0',
    ].join('\n');

    const recorded = normalizeOutput(local, OUTPUT_NORMALIZATION_RULES, recordContext).text;
    const replayed = normalizeOutput(container, OUTPUT_NORMALIZATION_RULES, replayContext).text;

    expect(recorded).toBe(replayed);
    expect(replayed).toContain('(<project>/test/reproduction.mjs:3:9)');
  });
});

// Fragments that stress the interactions between rules: sequences that rules remove or
// replace, partial sequences, and the tokens the rules produce.
const FRAGMENTS: readonly string[] = [
  ESC,
  `${ESC}[`,
  `${ESC}]`,
  `${ESC}${BACKSLASH}`,
  `${ESC}[31m`,
  C1_CSI,
  BEL,
  '[',
  ']',
  BACKSLASH,
  '\r',
  '\n',
  '\r\n',
  ' ',
  '\t',
  '0',
  '1',
  '12',
  '.',
  '1.5',
  'ms',
  ' ms',
  's',
  ' s',
  ':',
  'a',
  'node:',
  'node:internal/x:1:2',
  '(node:',
  '(node:12)',
  ')',
  'Node.js v1.2.3',
  'Node.js ',
  'duration_ms: 5',
  'duration_ms ',
  '/workspace',
  '/workspace/test/a.mjs',
  '/tmp',
  '/tmp/x',
  'file:///workspace/a',
  '<project>',
  '<tmp>',
  '<duration>',
  '<pid>',
  '<line>',
  '<column>',
  '<node-version>',
  '[REDACTED:api_key]',
];

const fragmentText = fc
  .array(fc.constantFrom(...FRAGMENTS), { maxLength: 24 })
  .map((parts) => parts.join(''));

const characterText = fc.string({
  maxLength: 60,
  unit: fc.constantFrom(
    ESC,
    '[',
    ']',
    BACKSLASH,
    '\r',
    '\n',
    ' ',
    '\t',
    '0',
    '1',
    '.',
    'm',
    's',
    ':',
    'a',
    '(',
    ')',
    '/',
    '<',
    '>',
  ),
});

describe('normalization properties', () => {
  it(
    'the full rule chain is idempotent',
    () => {
      fc.assert(
        fc.property(fc.oneof(fragmentText, characterText), (text) => {
          for (const context of [EMPTY_OUTPUT_PATH_CONTEXT, replayContext]) {
            const once = normalizeOutput(text, OUTPUT_NORMALIZATION_RULES, context).text;
            const twice = normalizeOutput(once, OUTPUT_NORMALIZATION_RULES, context).text;
            expect(twice).toBe(once);
          }
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  // Each input was a counterexample: a token that ends in an angle bracket created a word
  // boundary, or removed a name character, that an earlier rule had been blocked by.
  it.each([
    ['duration_ms: 5/workspace/test/a.mjs', OUTPUT_NORMALIZATION_RULES],
    ['node:internal/x:1:2/tmp/x', ['paths', 'node_internal_locations']],
    ['duration_ms 1.5node:internal/x:1:2', OUTPUT_NORMALIZATION_RULES],
    ['duration_ms: 5duration_ms 0', OUTPUT_NORMALIZATION_RULES],
    ['duration_ms: 5Node.js v1.2.3', ['node_version', 'durations']],
  ] as const)('is idempotent for the pinned counterexample %j', (text, rules) => {
    const once = normalizeOutput(text, rules, replayContext).text;

    expect(normalizeOutput(once, rules, replayContext).text).toBe(once);
  });

  it(
    'every rule subset is idempotent on its own output',
    () => {
      const subset = fc.subarray([...OUTPUT_NORMALIZATION_RULES]);
      fc.assert(
        fc.property(fc.oneof(fragmentText, characterText), subset, (text, rules) => {
          const once = normalizeOutput(text, rules, replayContext).text;
          expect(normalizeOutput(once, rules, replayContext).text).toBe(once);
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'leaves redaction markers and normalization tokens unchanged',
    () => {
      const stable = [
        '[REDACTED:api_key]',
        '[REDACTED:password]',
        '[REDACTED:authorization_header]',
        '<project>/test/a.mjs:3:9',
        '<tmp>/x',
        'took <duration>',
        'duration_ms: <duration>',
        '(node:<pid>) Warning',
        'node:internal/x:<line>:<column>',
        'Node.js <node-version>',
        'plain words',
      ];
      fc.assert(
        fc.property(fc.array(fc.constantFrom(...stable), { maxLength: 12 }), (lines) => {
          const text = lines.join('\n');
          expect(normalizeOutput(text, OUTPUT_NORMALIZATION_RULES, replayContext)).toEqual({
            text,
            changes: [],
          });
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    'never changes the line count by more than the line-ending rule does',
    () => {
      fc.assert(
        fc.property(fc.oneof(fragmentText, characterText), (text) => {
          const afterLineEndings = normalizeOutput(text, ['line_endings'], replayContext).text;
          const all = normalizeOutput(text, OUTPUT_NORMALIZATION_RULES, replayContext).text;
          const lines = (value: string): number => value.split('\n').length;
          // Escape sequences can contain a line feed, so removing one can only join lines.
          expect(lines(all)).toBeLessThanOrEqual(lines(afterLineEndings));
        }),
        { numRuns: RUNS },
      );
    },
    PROPERTY_TIMEOUT_MS,
  );
});

describe('normalization time budget', () => {
  const repeat = (unit: string, characters: number): string =>
    unit.repeat(Math.ceil(characters / unit.length));

  const cases: readonly (readonly [string, () => string])[] = [
    ['a digit run', () => '1'.repeat(MIB)],
    ['a digit run ending in a unit', () => `${'1'.repeat(MIB)}ms`],
    ['repeated "1."', () => repeat('1.', MIB)],
    ['repeated "1.5 "', () => repeat('1.5 ', MIB)],
    ['a node: prefix without a location', () => `node:${'a'.repeat(MIB)}`],
    ['repeated node: prefixes', () => repeat('node:aaaa', MIB)],
    ['repeated unterminated OSC', () => repeat(`${ESC}]`, MIB)],
    ['repeated unterminated OSC with a body', () => repeat(`${ESC}]0;title`, MIB)],
    ['repeated unterminated CSI parameters', () => `${ESC}[${repeat('1;', MIB)}`],
    ['repeated escape then parameters', () => repeat(`${ESC}[1;1;1;1;`, MIB)],
    ['repeated nF introducers', () => repeat(`${ESC}  `, MIB)],
    ['spaces with no newline', () => `${' '.repeat(MIB)}x`],
    ['spaces and tabs between lines', () => repeat(' \t \n', MIB)],
    ['repeated carriage returns', () => repeat('\r', MIB)],
    ['repeated (node: without a closing parenthesis', () => repeat('(node:1', MIB)],
    ['repeated unterminated process id', () => `(node:${'1'.repeat(MIB)}`],
    ['repeated duration_ms with no number', () => repeat('duration_ms ', MIB)],
    ['repeated duration_ms with a long number', () => `duration_ms ${'1'.repeat(MIB)}`],
    ['repeated Node.js version prefixes', () => repeat('Node.js v1.2.', MIB)],
    ['a long root prefix repeated', () => repeat('/workspac', MIB)],
    ['a root repeated back to back', () => repeat('/workspace', MIB)],
    ['a root followed by a long tail', () => `/workspace${repeat('/a', MIB)}`],
    [
      'a root followed by backslash tails',
      () => `/workspace${repeat(`${BACKSLASH}${BACKSLASH}a`, MIB)}`,
    ],
  ];

  it.each(cases)('finishes within the time budget for %s', (_name, build) => {
    const input = build();
    const started = performance.now();
    normalizeOutput(input, OUTPUT_NORMALIZATION_RULES, replayContext);
    expect(performance.now() - started).toBeLessThan(BUDGET_MS);
  });
});
