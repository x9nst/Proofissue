import type {
  BoundedExecutionResult,
  BoundedStreamCapture,
  Difference,
  MatchEvidence,
  NormalizationChange,
  NormalizationSummary,
  OutputNormalizationRule,
} from '@proofissue/contracts';
import { OUTPUT_NORMALIZATION_RULES, normalizeOutput } from '@proofissue/output-rules';
import type { OutputPathContext } from '@proofissue/output-rules';

/** How an output expectation compares its value with a stream. */
export type OutputMatchMode = 'contains' | 'exact';

export interface OutputExpectation {
  readonly mode: OutputMatchMode;
  /**
   * When present, the stream is normalized with these rules (in canonical order) before the
   * comparison, and `value` is already normalized. Absent means the raw redacted stream.
   */
  readonly normalize?: readonly OutputNormalizationRule[];
  readonly value: string;
}

export interface MatchExpectation {
  readonly exit_code: number;
  readonly stderr: readonly OutputExpectation[];
  readonly stdout: readonly OutputExpectation[];
}

export interface MatchInput {
  readonly execution: BoundedExecutionResult;
  readonly expectation: MatchExpectation;
  /** The directories the `paths` rule replaces in the replay output. */
  readonly path_context: OutputPathContext;
}

export interface MatchResult {
  readonly reproduced: boolean;
  readonly evidence: readonly MatchEvidence[];
  readonly differences: readonly Difference[];
}

export interface Matcher {
  match(input: MatchInput): MatchResult;
}

type StreamName = 'stderr' | 'stdout';

const exitCodeEvidence = (exitCode: number): MatchEvidence => ({
  kind: 'exit_code',
  message: `Exit code matched: ${String(exitCode)}.`,
});

// The wording of each rule's replacements. Plain nouns only: never the replaced text.
const CHANGE_LABELS: Readonly<Record<OutputNormalizationRule, readonly [string, string]>> = {
  line_endings: ['line ending', 'line endings'],
  ansi_escapes: ['terminal escape sequence', 'terminal escape sequences'],
  trailing_whitespace: ['line with trailing whitespace', 'lines with trailing whitespace'],
  paths: ['path', 'paths'],
  node_version: ['Node.js version', 'Node.js versions'],
  node_internal_locations: ['Node.js internal location', 'Node.js internal locations'],
  process_ids: ['process ID', 'process IDs'],
  durations: ['duration', 'durations'],
};

const joinList = (items: readonly string[]): string => {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items.join(' and ');
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1) ?? ''}`;
};

const describeChanges = (changes: readonly NormalizationChange[]): string => {
  if (changes.length === 0) return 'normalization changed nothing in the replay output';
  const items = changes.map((change) => {
    const [singular, plural] = CHANGE_LABELS[change.rule];
    return `${String(change.count)} ${change.count === 1 ? singular : plural}`;
  });
  return `normalization changed ${joinList(items)} in the replay output`;
};

interface PreparedStream {
  readonly summary?: NormalizationSummary;
  readonly text: string;
}

const canonicalRules = (
  rules: readonly OutputNormalizationRule[],
): readonly OutputNormalizationRule[] => {
  const selected = new Set(rules);
  return OUTPUT_NORMALIZATION_RULES.filter((rule) => selected.has(rule));
};

/** Normalizes each stream at most once for each distinct rule list. */
class StreamPreparer {
  private readonly cache = new Map<string, PreparedStream>();

  constructor(
    private readonly capture: BoundedStreamCapture,
    private readonly context: OutputPathContext,
  ) {}

  prepare(rules: readonly OutputNormalizationRule[] | undefined): PreparedStream {
    if (rules === undefined || rules.length === 0) return { text: this.capture.decoded_text };
    const canonical = canonicalRules(rules);
    const key = canonical.join(',');
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const normalized = normalizeOutput(this.capture.decoded_text, canonical, this.context);
    const prepared: PreparedStream = {
      text: normalized.text,
      summary: { rules: canonical, changes: normalized.changes },
    };
    this.cache.set(key, prepared);
    return prepared;
  }
}

const withNormalization = <Item extends { readonly message: string }>(
  item: Item,
  summary: NormalizationSummary | undefined,
): Item & { readonly normalization?: NormalizationSummary } =>
  summary === undefined ? item : { ...item, normalization: summary };

const suffixFor = (summary: NormalizationSummary | undefined): string =>
  summary === undefined ? '' : `; ${describeChanges(summary.changes)}`;

const insufficientContains = (
  stream: StreamName,
  summary: NormalizationSummary | undefined,
): Difference =>
  withNormalization<Difference>(
    {
      kind: 'insufficient_output',
      message: `Retained ${stream} was truncated before the expected text could be established.`,
    },
    summary,
  );

const insufficientExact = (
  stream: StreamName,
  summary: NormalizationSummary | undefined,
): Difference =>
  withNormalization<Difference>(
    {
      kind: 'insufficient_output',
      message: `Retained ${stream} was truncated, so its exact content could not be established.`,
    },
    summary,
  );

type Outcome = { readonly evidence: MatchEvidence } | { readonly difference: Difference };

const matchContains = (
  stream: StreamName,
  prepared: PreparedStream,
  capture: BoundedStreamCapture,
  value: string,
): Outcome => {
  const normalized = prepared.summary !== undefined;
  if (prepared.text.includes(value)) {
    return {
      evidence: withNormalization<MatchEvidence>(
        {
          kind: `${stream}_contains`,
          message: `Expected ${stream} text was present${normalized ? ' after normalization' : ''}${suffixFor(prepared.summary)}.`,
        },
        prepared.summary,
      ),
    };
  }
  if (capture.truncated) return { difference: insufficientContains(stream, prepared.summary) };
  return {
    difference: withNormalization<Difference>(
      {
        kind: stream === 'stderr' ? 'stderr_missing' : 'stdout_missing',
        message: `Expected ${stream} text was not present${normalized ? ' after normalization' : ''}${suffixFor(prepared.summary)}.`,
      },
      prepared.summary,
    ),
  };
};

interface FirstDifference {
  readonly column: number;
  readonly expected_characters: number;
  readonly line: number;
  readonly received_characters: number;
}

const codePointLength = (text: string): number => {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const next = text.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) index += 1;
    count += 1;
  }
  return count;
};

/** Where `received` first differs from `expected`: 1-based line and column in code points. */
const locateFirstDifference = (expected: string, received: string): FirstDifference => {
  let expectedIndex = 0;
  let receivedIndex = 0;
  let line = 1;
  let column = 1;
  while (expectedIndex < expected.length && receivedIndex < received.length) {
    const expectedPoint = expected.codePointAt(expectedIndex) ?? 0;
    const receivedPoint = received.codePointAt(receivedIndex) ?? 0;
    if (expectedPoint !== receivedPoint) break;
    if (expectedPoint === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    const width = expectedPoint > 0xffff ? 2 : 1;
    expectedIndex += width;
    receivedIndex += width;
  }
  return {
    column,
    expected_characters: codePointLength(expected),
    line,
    received_characters: codePointLength(received),
  };
};

const matchExact = (
  stream: StreamName,
  prepared: PreparedStream,
  capture: BoundedStreamCapture,
  value: string,
): Outcome => {
  const normalized = prepared.summary !== undefined;
  // A truncated stream may differ in bytes that were discarded, so it can never be exact.
  if (capture.truncated) return { difference: insufficientExact(stream, prepared.summary) };
  if (prepared.text === value) {
    return {
      evidence: withNormalization<MatchEvidence>(
        {
          kind: `${stream}_exact`,
          message: `${normalized ? 'Normalized replay' : 'Replay'} ${stream} matched the expected output exactly${suffixFor(prepared.summary)}.`,
        },
        prepared.summary,
      ),
    };
  }
  const where = locateFirstDifference(value, prepared.text);
  return {
    difference: withNormalization<Difference>(
      {
        kind: stream === 'stderr' ? 'stderr_differs' : 'stdout_differs',
        message: `${normalized ? 'Normalized replay' : 'Replay'} ${stream} differed from the expected output at line ${String(where.line)}, column ${String(where.column)} (expected ${String(where.expected_characters)} characters, received ${String(where.received_characters)})${suffixFor(prepared.summary)}.`,
      },
      prepared.summary,
    ),
  };
};

export const matchExecution = (input: MatchInput): MatchResult => {
  const evidence: MatchEvidence[] = [];
  const differences: Difference[] = [];
  const { execution, expectation } = input;

  if (execution.exit_code === expectation.exit_code) {
    evidence.push(exitCodeEvidence(expectation.exit_code));
  } else {
    differences.push({
      kind: 'exit_code',
      message:
        execution.exit_code === undefined
          ? `Expected exit code ${String(expectation.exit_code)}, but execution did not return one.`
          : `Expected exit code ${String(expectation.exit_code)} but received ${String(execution.exit_code)}.`,
    });
  }

  const streams: readonly (readonly [StreamName, readonly OutputExpectation[]])[] = [
    ['stdout', expectation.stdout],
    ['stderr', expectation.stderr],
  ];
  for (const [stream, expectations] of streams) {
    const capture = execution[stream];
    const preparer = new StreamPreparer(capture, input.path_context);
    for (const item of expectations) {
      const prepared = preparer.prepare(item.normalize);
      const outcome =
        item.mode === 'exact'
          ? matchExact(stream, prepared, capture, item.value)
          : matchContains(stream, prepared, capture, item.value);
      if ('evidence' in outcome) evidence.push(outcome.evidence);
      else differences.push(outcome.difference);
    }
  }

  return {
    reproduced: differences.length === 0,
    evidence,
    differences,
  };
};

export const createMatcher = (): Matcher => ({ match: matchExecution });
