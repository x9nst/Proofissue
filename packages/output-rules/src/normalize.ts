import type { NormalizationChange, OutputNormalizationRule } from '@proofissue/contracts';

import { applyPathRule } from './path-context.js';
import type { OutputPathContext } from './path-context.js';

/**
 * The normalization rules in canonical order. The canonical order is also the order in which
 * the rules are applied, and an artifact must list a rule subset in this order.
 *
 * Each name has one frozen definition (see docs/output-matching.md). A changed definition
 * gets a new name, so an older consumer rejects it instead of reading it differently.
 */
export const OUTPUT_NORMALIZATION_RULES: readonly OutputNormalizationRule[] = Object.freeze([
  'line_endings',
  'ansi_escapes',
  'trailing_whitespace',
  'paths',
  'node_version',
  'node_internal_locations',
  'process_ids',
  'durations',
] as const);

/** What the command-line options ask for: every rule. */
export const DEFAULT_OUTPUT_NORMALIZATION: readonly OutputNormalizationRule[] =
  OUTPUT_NORMALIZATION_RULES;

/** The text a rule leaves in place of what it removed. Part of each rule's definition. */
export const NORMALIZATION_TOKENS = Object.freeze({
  column: '<column>',
  duration: '<duration>',
  line: '<line>',
  node_version: '<node-version>',
  pid: '<pid>',
  project: '<project>',
  temporary: '<tmp>',
} as const);

export interface NormalizedOutput {
  readonly text: string;
  /** Only rules that changed something, in rule order. */
  readonly changes: readonly NormalizationChange[];
}

interface RuleResult {
  readonly count: number;
  readonly text: string;
}

const unchanged = (text: string): RuleResult => ({ count: 0, text });

const countingReplace = (
  text: string,
  pattern: RegExp,
  replacement: (match: string, ...groups: string[]) => string,
): RuleResult => {
  let count = 0;
  const replaced = text.replace(pattern, (match: string, ...groups: string[]) => {
    count += 1;
    return replacement(match, ...groups);
  });
  return count === 0 ? unchanged(text) : { count, text: replaced };
};

const LINE_FEED = 0x0a;
const ESCAPE = 0x1b;
const CONTROL_SEQUENCE_INTRODUCER = 0x9b;
const BELL = 0x07;
const BACKSLASH = 0x5c;
const SPACE = 0x20;
const TAB = 0x09;

const lineEndings = (text: string): RuleResult => countingReplace(text, /\r\n?/g, () => '\n');

const inRange = (code: number, low: number, high: number): boolean => code >= low && code <= high;

// A control sequence: parameter bytes 0x30-0x3F, intermediate bytes 0x20-0x2F, then one final
// byte 0x40-0x7E. Returns the index after the final byte, or undefined when the text ends or
// a byte outside those classes comes first.
const controlSequenceEnd = (text: string, start: number): number | undefined => {
  let index = start;
  while (index < text.length && inRange(text.charCodeAt(index), 0x30, 0x3f)) index += 1;
  while (index < text.length && inRange(text.charCodeAt(index), 0x20, 0x2f)) index += 1;
  if (index < text.length && inRange(text.charCodeAt(index), 0x40, 0x7e)) return index + 1;
  return undefined;
};

// An operating-system command ends at BEL or at ESC followed by a backslash. The body scan
// stops at the first BEL or ESC, so a failed attempt never rescans the same bytes later.
const operatingSystemCommandEnd = (text: string, start: number): number | undefined => {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === BELL) return index + 1;
    if (code === ESCAPE) {
      return text.charCodeAt(index + 1) === BACKSLASH ? index + 2 : undefined;
    }
    index += 1;
  }
  return undefined;
};

// The end of the sequence that starts at `start`, or start + 1 for a lone escape character.
const escapeSequenceEnd = (text: string, start: number): number => {
  if (text.charCodeAt(start) === CONTROL_SEQUENCE_INTRODUCER) {
    return controlSequenceEnd(text, start + 1) ?? start + 1;
  }
  const next = text.charCodeAt(start + 1);
  if (next === 0x5b) return controlSequenceEnd(text, start + 2) ?? start + 1;
  if (next === 0x5d) return operatingSystemCommandEnd(text, start + 2) ?? start + 1;
  if (inRange(next, 0x20, 0x2f)) {
    let index = start + 2;
    while (index < text.length && inRange(text.charCodeAt(index), 0x20, 0x2f)) index += 1;
    return index < text.length && inRange(text.charCodeAt(index), 0x30, 0x7e)
      ? index + 1
      : start + 1;
  }
  if (inRange(next, 0x30, 0x7e)) return start + 2;
  return start + 1;
};

const ansiEscapes = (text: string): RuleResult => {
  const kept: string[] = [];
  let keepFrom = 0;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code !== ESCAPE && code !== CONTROL_SEQUENCE_INTRODUCER) {
      index += 1;
      continue;
    }
    const end = escapeSequenceEnd(text, index);
    kept.push(text.slice(keepFrom, index));
    keepFrom = end;
    index = end;
    count += 1;
  }
  if (count === 0) return unchanged(text);
  kept.push(text.slice(keepFrom));
  return { count, text: kept.join('') };
};

const trailingWhitespace = (text: string): RuleResult => {
  const kept: string[] = [];
  let count = 0;
  let lineStart = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index !== text.length && text.charCodeAt(index) !== LINE_FEED) continue;
    let end = index;
    while (end > lineStart) {
      const code = text.charCodeAt(end - 1);
      if (code !== SPACE && code !== TAB) break;
      end -= 1;
    }
    if (end !== index) count += 1;
    kept.push(text.slice(lineStart, end));
    if (index !== text.length) kept.push('\n');
    lineStart = index + 1;
  }
  return count === 0 ? unchanged(text) : { count, text: kept.join('') };
};

const nodeVersion = (text: string): RuleResult =>
  countingReplace(
    text,
    /(?<![A-Za-z0-9_>])Node\.js v\d+\.\d+\.\d+\b/g,
    () => `Node.js ${NORMALIZATION_TOKENS.node_version}`,
  );

const nodeInternalLocations = (text: string): RuleResult =>
  countingReplace(
    text,
    /(?<![A-Za-z0-9_>])(node:[A-Za-z0-9_/-]+):\d+:\d+/g,
    (_match, location) => `${location}:${NORMALIZATION_TOKENS.line}:${NORMALIZATION_TOKENS.column}`,
  );

const processIds = (text: string): RuleResult =>
  countingReplace(text, /\(node:\d+\)/g, () => `(node:${NORMALIZATION_TOKENS.pid})`);

const durations = (text: string): RuleResult => {
  const reporterField = countingReplace(
    text,
    /(?<![A-Za-z0-9_>])duration_ms(:? )\d+(?:\.\d+)?/g,
    (_match, separator) => `duration_ms${separator}${NORMALIZATION_TOKENS.duration}`,
  );
  const milliseconds = countingReplace(
    reporterField.text,
    /(?<![A-Za-z0-9_.>])\d+(?:\.\d+)? ?ms(?![A-Za-z0-9_])/g,
    () => NORMALIZATION_TOKENS.duration,
  );
  const seconds = countingReplace(
    milliseconds.text,
    /(?<![A-Za-z0-9_.>])\d+\.\d+ ?s(?![A-Za-z0-9_])/g,
    () => NORMALIZATION_TOKENS.duration,
  );
  return {
    count: reporterField.count + milliseconds.count + seconds.count,
    text: seconds.text,
  };
};

type RuleApplier = (text: string, context: OutputPathContext) => RuleResult;

const RULE_APPLIERS: Readonly<Record<OutputNormalizationRule, RuleApplier>> = {
  line_endings: lineEndings,
  ansi_escapes: ansiEscapes,
  trailing_whitespace: trailingWhitespace,
  paths: applyPathRule,
  node_version: nodeVersion,
  node_internal_locations: nodeInternalLocations,
  process_ids: processIds,
  durations,
};

/**
 * True when `rules` is a usable `normalize` list: non-empty, known rule names only, each at
 * most once, in canonical order. There is one spelling per intent, so equal artifacts compare
 * equal.
 */
export const isCanonicalNormalizationRuleList = (rules: readonly string[]): boolean => {
  if (rules.length === 0) return false;
  let previous = -1;
  for (const rule of rules) {
    const position = (OUTPUT_NORMALIZATION_RULES as readonly string[]).indexOf(rule);
    if (position <= previous) return false;
    previous = position;
  }
  return true;
};

/**
 * Applies the listed rules to already redacted text. Rules always run in canonical order,
 * whatever order `rules` lists them in. Never run this on raw bytes or before redaction.
 *
 * Every rule is linear in the length of the text.
 */
export const normalizeOutput = (
  text: string,
  rules: readonly OutputNormalizationRule[],
  context: OutputPathContext,
): NormalizedOutput => {
  const selected = new Set<OutputNormalizationRule>(rules);
  const changes: NormalizationChange[] = [];
  let current = text;
  for (const rule of OUTPUT_NORMALIZATION_RULES) {
    if (!selected.has(rule)) continue;
    const result = RULE_APPLIERS[rule](current, context);
    current = result.text;
    if (result.count > 0) changes.push({ rule, count: result.count });
  }
  return { text: current, changes };
};
