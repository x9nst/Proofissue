/**
 * Path scrubbing and log escaping for trial results.
 *
 * Results and diagnostics must never carry the runner's directories or a user's home path, and
 * third-party text must never reach the job log in a form that could issue a workflow command.
 */

const BACKSLASH = String.fromCharCode(92);

/**
 * The repository's local-path hygiene pattern, copied from scripts/check-repository-hygiene.mjs.
 * A test keeps the two in agreement. Keep them identical.
 */
const LOCAL_PATH_SOURCE = /(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:home|Users)\/[^/\s]+)/u;

export const LOCAL_PATH_PATTERN_SOURCE = LOCAL_PATH_SOURCE.source;

export const findLocalPath = (text: string): boolean => LOCAL_PATH_SOURCE.test(text);

const LOCAL_PATH_FALLBACK = new RegExp(LOCAL_PATH_SOURCE.source, 'gu');

export interface ScrubRoot {
  /** The directory to replace. Ignored unless it is a usable absolute path. */
  readonly path: string | undefined;
  /** What replaces it, for example `<work>`. */
  readonly token: string;
}

export type Scrubber = (text: string) => string;

const MAX_ROOT_LENGTH = 1024;

const hasControlCharacter = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) return true;
  }
  return false;
};

const looksAbsolute = (value: string): boolean =>
  value.startsWith('/') ||
  /^[A-Za-z]:[\\/]/u.test(value) ||
  value.startsWith(`${BACKSLASH}${BACKSLASH}`);

const isFilesystemRoot = (value: string): boolean => /^(?:\/+|[A-Za-z]:[\\/]*)$/u.test(value);

const stripTrailingSeparators = (value: string): string => {
  let end = value.length;
  while (end > 1 && (value[end - 1] === '/' || value[end - 1] === BACKSLASH)) end -= 1;
  return value.slice(0, end);
};

const usableRoot = (path: string | undefined): string | undefined => {
  if (path === undefined || path.length === 0 || path.length > MAX_ROOT_LENGTH) return undefined;
  if (hasControlCharacter(path) || !looksAbsolute(path)) return undefined;
  const trimmed = stripTrailingSeparators(path);
  return isFilesystemRoot(trimmed) ? undefined : trimmed;
};

const PRECEDING_PATH_CHARACTER = /[A-Za-z0-9_.@+~/\\-]/u;
const NAME_CHARACTER = /[A-Za-z0-9_@+~-]/u;

const startsAtPathBoundary = (text: string, index: number): boolean => {
  if (index === 0) return true;
  const previous = text[index - 1];
  return previous === undefined || !PRECEDING_PATH_CHARACTER.test(previous);
};

const endsAtPathBoundary = (text: string, index: number): boolean => {
  const next = text[index];
  if (next === undefined) return true;
  if (next === '.') {
    const afterDot = text[index + 1];
    return afterDot === undefined || /\s/u.test(afterDot);
  }
  return !NAME_CHARACTER.test(next);
};

const replaceRoot = (text: string, root: string, token: string): string => {
  let result = '';
  let cursor = 0;
  for (;;) {
    const found = text.indexOf(root, cursor);
    if (found === -1) break;
    const end = found + root.length;
    if (startsAtPathBoundary(text, found) && endsAtPathBoundary(text, end)) {
      result += text.slice(cursor, found) + token;
      cursor = end;
    } else {
      result += text.slice(cursor, found + 1);
      cursor = found + 1;
    }
  }
  return result + text.slice(cursor);
};

/**
 * Builds a scrubber. Roots are replaced longest first, only as whole path components; unusable
 * roots (relative, a filesystem root, very long, or containing control characters) are ignored.
 * A generic fallback then replaces any home-directory path of the kinds the hygiene check rejects.
 */
export const createScrubber = (roots: readonly ScrubRoot[]): Scrubber => {
  const usable = roots
    .map((root) => ({ path: usableRoot(root.path), token: root.token }))
    .flatMap((root) => (root.path === undefined ? [] : [{ path: root.path, token: root.token }]))
    .sort((left, right) => right.path.length - left.path.length);

  return (text) => {
    let scrubbed = text;
    for (const root of usable) scrubbed = replaceRoot(scrubbed, root.path, root.token);
    return scrubbed.replace(LOCAL_PATH_FALLBACK, '<home>');
  };
};

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const scrubUnknown = (value: unknown, scrub: Scrubber): unknown => {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((item: unknown) => scrubUnknown(item, scrub));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, scrubUnknown(item, scrub)]),
    );
  }
  return value;
};

/** Scrubs every string in a JSON-shaped value. Keys are left unchanged. */
export const scrubValue = <T>(value: T, scrub: Scrubber): T => scrubUnknown(value, scrub) as T;

const isUnsafeLogCode = (code: number): boolean =>
  code < 32 ||
  code === 127 ||
  (code >= 0x80 && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * Makes text safe for one job-log line: control and bidirectional-control characters are written
 * as \u{...} escapes and `::` is broken up so no workflow command can be formed. Only enum
 * values, case IDs, and numbers are meant to be logged, so this is a second line of defence.
 */
export const escapeForLog = (text: string): string =>
  Array.from(text)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return isUnsafeLogCode(code)
        ? `${BACKSLASH}u{${code.toString(16).padStart(4, '0')}}`
        : character;
    })
    .join('')
    .replaceAll('::', `${BACKSLASH}:${BACKSLASH}:`);
