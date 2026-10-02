import {
  MAX_GUIDED_SELECTIONS,
  MAX_SELECTABLE_LINE_BYTES,
  parseLineId,
  type ExpectationChoice,
  type ObservedLine,
  type RecordObservationView,
  type SelectExpectations,
  type StreamListing,
  type UnselectableReason,
} from '@proofissue/application';

import { escapePresentationText } from './presentation.js';

/** The most characters of one line shown in the listing; the preview shows the stored value in full. */
export const MAX_DISPLAYED_LINE_CHARACTERS = 200;

/** How many unusable answers are tolerated before the recording is cancelled. */
export const MAX_INVALID_ANSWERS = 3;

/** What guided selection needs from the terminal. */
export interface GuidedIo {
  /** Resolves to the typed line, or undefined when input ended. */
  readonly ask: (question: string) => Promise<string | undefined>;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly write: (text: string) => void;
}

const REASON_TEXT: Readonly<Record<UnselectableReason, string>> = {
  empty: 'empty',
  likely_secret: 'looks like a secret',
  local_path: 'holds a path from this computer',
  redaction_marker: 'contains a redaction marker',
  too_long: `longer than ${String(MAX_SELECTABLE_LINE_BYTES)} bytes`,
  unchecked: 'could not be checked for secrets',
};

// A line that holds a path or a likely secret is not echoed at all: the reason is enough, and
// the terminal may be shared or recorded.
const HIDDEN_REASONS: ReadonlySet<UnselectableReason> = new Set([
  'likely_secret',
  'local_path',
  'unchecked',
]);

/**
 * Output text for a terminal: bounded, then escaped, so a command's output cannot move the
 * cursor, recolor text, reorder it, or fake a prompt or another listed line.
 */
export const displayLine = (text: string): string => {
  const characters = Array.from(text);
  const shown = characters.slice(0, MAX_DISPLAYED_LINE_CHARACTERS).join('');
  const more = characters.length - MAX_DISPLAYED_LINE_CHARACTERS;
  return `${escapePresentationText(shown)}${more > 0 ? ` ... (${String(more)} more characters)` : ''}`;
};

const renderLine = (line: ObservedLine): string => {
  if (line.selectable) return `  ${line.id}  ${displayLine(line.text)}`;
  const reason = line.reason === undefined ? 'not usable' : REASON_TEXT[line.reason];
  const mark = `[not selectable: ${reason}]`;
  const hidden = line.reason !== undefined && HIDDEN_REASONS.has(line.reason);
  return line.text === '' || hidden
    ? `  ${line.id}  ${mark}`
    : `  ${line.id}  ${mark} ${displayLine(line.text)}`;
};

const renderStream = (listing: StreamListing): readonly string[] => {
  const heading = `${listing.stream} (${String(listing.total_lines)} ${listing.total_lines === 1 ? 'line' : 'lines'}${listing.truncated ? ', truncated at the retained byte limit' : ''}):`;
  if (listing.total_lines === 0) return [heading, '  (nothing printed)'];
  const lines: string[] = [heading];
  let omittedShown = false;
  let previous = 0;
  for (const line of listing.lines) {
    if (!omittedShown && previous !== 0 && line.number !== previous + 1) {
      lines.push(`  ... ${String(listing.omitted_lines)} lines not shown ...`);
      omittedShown = true;
    }
    lines.push(renderLine(line));
    previous = line.number;
  }
  return lines;
};

/** The numbered listing the person chooses from. */
export const renderObservationListing = (view: RecordObservationView): string =>
  [
    `The command exited with code ${String(view.exit_code)}. What it printed, normalized and with secrets removed:`,
    '',
    ...renderStream(view.stdout),
    '',
    ...renderStream(view.stderr),
    '',
  ].join('\n');

const findSelectable = (view: RecordObservationView, id: string): ObservedLine | undefined => {
  const parsed = parseLineId(id);
  if (parsed === undefined) return undefined;
  const listing = parsed.stream === 'stdout' ? view.stdout : view.stderr;
  const line = listing.lines.find((item) => item.number === parsed.number);
  return line !== undefined && line.selectable ? line : undefined;
};

type Answer =
  | { readonly ids: readonly string[]; readonly status: 'valid' }
  | { readonly message: string; readonly status: 'invalid' };

const interpretAnswer = (view: RecordObservationView, answer: string): Answer => {
  const tokens = answer.trim() === '' ? [] : answer.trim().split(/\s+/u);
  if (tokens.length === 0) {
    return view.suggestion === undefined
      ? { status: 'invalid', message: 'Type at least one line id, for example e3.' }
      : { status: 'valid', ids: [view.suggestion.id] };
  }
  const ids: string[] = [];
  for (const token of tokens) {
    if (findSelectable(view, token) === undefined) {
      const shown = escapePresentationText(Array.from(token).slice(0, 24).join(''));
      return {
        status: 'invalid',
        message: `"${shown}" is not a listed line id that can be chosen. Ids look like e3 or o12; lines marked not selectable cannot be used.`,
      };
    }
    if (!ids.includes(token)) ids.push(token);
  }
  if (ids.length > MAX_GUIDED_SELECTIONS) {
    return {
      status: 'invalid',
      message: `Choose at most ${String(MAX_GUIDED_SELECTIONS)} lines.`,
    };
  }
  return { status: 'valid', ids };
};

const CANCELLED: ExpectationChoice = { status: 'cancelled' };

/**
 * Shows what the command printed and asks which lines the artifact should expect. Pressing
 * Enter chooses the suggested line when there is one. Nothing is chosen on the person's behalf
 * without that Enter: the choice is always shown again in the recording preview and confirmed.
 */
export const createLineSelector =
  (io: GuidedIo): SelectExpectations =>
  async (view) => {
    io.write(renderObservationListing(view));
    if (view.exit_code === 0) {
      const proceed = await io.confirm('The command exited 0; it did not fail. Record it anyway?');
      if (!proceed) return CANCELLED;
    }
    if (view.suggestion !== undefined) {
      io.write(`Suggested: ${view.suggestion.id}, ${view.suggestion.description}.\n`);
    }
    const prompt =
      view.suggestion === undefined
        ? 'Enter line ids separated by spaces (e.g. e3 o12): '
        : `Enter line ids separated by spaces (e.g. e3 o12), or press Enter to use the suggested line ${view.suggestion.id}: `;
    for (let attempt = 1; attempt <= MAX_INVALID_ANSWERS; attempt += 1) {
      const answer = await io.ask(prompt);
      if (answer === undefined) {
        io.write('\nNo answer was given.\n');
        return CANCELLED;
      }
      const interpreted = interpretAnswer(view, answer);
      if (interpreted.status === 'valid') {
        return { status: 'chosen', line_ids: interpreted.ids };
      }
      io.write(`${interpreted.message}\n`);
    }
    io.write(`No valid line was chosen after ${String(MAX_INVALID_ANSWERS)} attempts.\n`);
    return CANCELLED;
  };
