import {
  containsContextPath,
  DEFAULT_OUTPUT_NORMALIZATION,
  normalizeOutput,
} from '@proofissue/output-rules';
import { createRedactor } from '@proofissue/redactor';
import type { Redactor } from '@proofissue/redactor';

import type { RecordPathContexts } from './expectations.js';
import type { RecordObservation } from './index.js';

/**
 * Listing what a command printed, so a reporter can choose which lines the artifact should
 * expect instead of guessing text before seeing any output.
 *
 * Everything here is derived from the redacted, normalized streams. The listing holds output
 * text, so it may be shown to the person who ran the command and must never be placed in a
 * result, a log, or an artifact except through a line the person chose.
 */

export type ObservedStreamName = 'stderr' | 'stdout';

/** The most bytes a selectable line may have: the artifact's limit for one expected value. */
export const MAX_SELECTABLE_LINE_BYTES = 8192;

/** How many lines of one stream are listed, and which of them when there are more. */
export const LISTING_LIMITS = Object.freeze({
  first_lines: 50,
  last_lines: 150,
  lines: 200,
});

/** Why a line cannot be chosen as an expectation. */
export type UnselectableReason =
  'empty' | 'local_path' | 'likely_secret' | 'redaction_marker' | 'too_long' | 'unchecked';

export interface ObservedLine {
  /** `o<N>` for stdout and `e<N>` for stderr, where N is the line number in the normalized stream. */
  readonly id: string;
  /** The line number in the normalized stream, starting at 1. */
  readonly number: number;
  readonly reason?: UnselectableReason;
  readonly selectable: boolean;
  readonly stream: ObservedStreamName;
  /** The normalized line without its leading whitespace: the value a choice would store. */
  readonly text: string;
}

export interface StreamListing {
  readonly lines: readonly ObservedLine[];
  /** How many lines are not listed because the stream has more than the listing limit. */
  readonly omitted_lines: number;
  readonly stream: ObservedStreamName;
  readonly total_lines: number;
  readonly truncated: boolean;
}

/** The rules that pick a suggested line, in priority order. */
export interface SuggestionRule {
  readonly description: string;
  readonly name: string;
  readonly pattern: RegExp;
}

export const SUGGESTION_RULES: readonly SuggestionRule[] = Object.freeze([
  {
    name: 'assertion_error',
    description: 'a line naming an AssertionError',
    pattern: /\bAssertionError\b/u,
  },
  {
    name: 'named_error',
    description: 'a line that starts with an error name and a message',
    pattern: /^(?:Uncaught )?(?:[A-Z][A-Za-z]*)?Error(?: \[[A-Z0-9_]+\])?: \S/u,
  },
  {
    name: 'expected_line',
    description: 'a line that starts with "Expected"',
    pattern: /^Expected\b/u,
  },
  {
    name: 'expected_to',
    description: 'a line saying what was expected to happen',
    pattern: /\bexpected\b.+\bto\b/u,
  },
  {
    name: 'tap_not_ok',
    description: 'a TAP "not ok" line',
    pattern: /^not ok \d+/u,
  },
  {
    name: 'failing_count',
    description: 'a failing-tests count line',
    pattern: /^\d+ failing$/u,
  },
]);

export interface LineSuggestion {
  readonly description: string;
  readonly id: string;
  readonly number: number;
  readonly rule: string;
  readonly stream: ObservedStreamName;
}

export interface ObservationListing {
  readonly exit_code: number;
  /** Absent when no listed line is selectable or none matches a rule. */
  readonly suggestion?: LineSuggestion;
  readonly stderr: StreamListing;
  readonly stdout: StreamListing;
}

/**
 * The lines of a normalized stream, without the empty element a final line feed leaves.
 * An empty stream has no lines.
 */
export const splitLines = (text: string): readonly string[] => {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
};

/**
 * Why a normalized line cannot be an expectation, or undefined when it can. The text is the
 * line without its leading whitespace.
 */
export const lineProblem = (
  text: string,
  contexts: RecordPathContexts,
  redactor: Redactor,
): UnselectableReason | undefined => {
  if (text === '') return 'empty';
  if (Buffer.byteLength(text, 'utf8') > MAX_SELECTABLE_LINE_BYTES) return 'too_long';
  if (text.includes('[REDACTED:')) return 'redaction_marker';
  if (containsContextPath(text, contexts.host)) return 'local_path';
  try {
    if (redactor.redact(text).findings.length > 0) return 'likely_secret';
  } catch {
    return 'unchecked';
  }
  return undefined;
};

const STREAM_PREFIX: Readonly<Record<ObservedStreamName, string>> = {
  stderr: 'e',
  stdout: 'o',
};

/** The id of a line: `o3` is the third normalized stdout line. */
export const lineId = (stream: ObservedStreamName, number: number): string =>
  `${STREAM_PREFIX[stream]}${String(number)}`;

/** Reads an id such as `e12`; anything else, including `e0` or `e012`, is not an id. */
export const parseLineId = (
  value: string,
): { readonly number: number; readonly stream: ObservedStreamName } | undefined => {
  const match = /^([oe])([1-9][0-9]{0,6})$/u.exec(value);
  if (match === null) return undefined;
  const [, prefix, digits] = match;
  if (prefix === undefined || digits === undefined) return undefined;
  return { number: Number(digits), stream: prefix === 'o' ? 'stdout' : 'stderr' };
};

/** The normalized lines of one recorded stream, exactly as a selection resolves them. */
export const normalizedLinesOf = (text: string, contexts: RecordPathContexts): readonly string[] =>
  splitLines(normalizeOutput(text, DEFAULT_OUTPUT_NORMALIZATION, contexts.output).text);

const listStream = (
  stream: ObservedStreamName,
  text: string,
  truncated: boolean,
  contexts: RecordPathContexts,
  redactor: Redactor,
): StreamListing => {
  const all = normalizedLinesOf(text, contexts);
  const total = all.length;
  const shown: number[] = [];
  if (total <= LISTING_LIMITS.lines) {
    for (let index = 0; index < total; index += 1) shown.push(index);
  } else {
    for (let index = 0; index < LISTING_LIMITS.first_lines; index += 1) shown.push(index);
    for (let index = total - LISTING_LIMITS.last_lines; index < total; index += 1)
      shown.push(index);
  }
  const lines = shown.map((index): ObservedLine => {
    const value = (all[index] ?? '').trimStart();
    const reason = lineProblem(value, contexts, redactor);
    return {
      id: lineId(stream, index + 1),
      number: index + 1,
      ...(reason === undefined ? {} : { reason }),
      selectable: reason === undefined,
      stream,
      text: value,
    };
  });
  return {
    lines,
    omitted_lines: total - lines.length,
    stream,
    total_lines: total,
    truncated,
  };
};

/**
 * Picks the line to suggest. The rules are tried in priority order; for one rule, stderr is
 * searched before stdout and lines in order. Only listed, selectable lines are considered.
 */
export const suggestLine = (
  stderr: StreamListing,
  stdout: StreamListing,
): LineSuggestion | undefined => {
  for (const rule of SUGGESTION_RULES) {
    for (const listing of [stderr, stdout]) {
      const line = listing.lines.find((item) => item.selectable && rule.pattern.test(item.text));
      if (line !== undefined) {
        return {
          description: rule.description,
          id: line.id,
          number: line.number,
          rule: rule.name,
          stream: line.stream,
        };
      }
    }
  }
  return undefined;
};

/** Lists the normalized lines of both streams, with the rule-based suggestion. */
export const listObservation = (
  observation: RecordObservation,
  redactor: Redactor = createRedactor(),
): ObservationListing => {
  const stdout = listStream(
    'stdout',
    observation.stdout.decoded_text,
    observation.stdout.truncated,
    observation.contexts,
    redactor,
  );
  const stderr = listStream(
    'stderr',
    observation.stderr.decoded_text,
    observation.stderr.truncated,
    observation.contexts,
    redactor,
  );
  const suggestion = suggestLine(stderr, stdout);
  return {
    exit_code: observation.exit_code,
    ...(suggestion === undefined ? {} : { suggestion }),
    stderr,
    stdout,
  };
};
