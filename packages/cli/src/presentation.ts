// The expected text is shown for review, so characters a terminal could use to hide or
// reorder text are escaped as well as control characters.
const isUnsafePresentationCode = (code: number): boolean =>
  code < 32 ||
  code === 127 ||
  (code >= 0x80 && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

export const quoteExpectation = (value: string): string =>
  Array.from(JSON.stringify(value))
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return isUnsafePresentationCode(code)
        ? `\\u{${code.toString(16).padStart(4, '0')}}`
        : character;
    })
    .join('');

/**
 * Quotes a path for the suggested commands. Plain paths stay plain; others are double-quoted,
 * or single-quoted when they hold a character a shell would still interpret inside double
 * quotes. The text is escaped first, so a control character never reaches the terminal.
 */
export const quotePathForCommand = (value: string): string => {
  const escaped = escapePresentationText(value);
  if (/^[A-Za-z0-9_./:@%+=\\-]+$/u.test(escaped)) return escaped;
  if (!/["$`!]/u.test(escaped)) return `"${escaped}"`;
  return `'${escaped.replaceAll("'", "'\\''")}'`;
};

export const escapePresentationText = (value: string): string =>
  Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (
        code < 32 ||
        code === 127 ||
        (code >= 0x80 && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      ) {
        return `\\u{${code.toString(16).padStart(4, '0')}}`;
      }
      return character;
    })
    .join('')
    .replaceAll('::', '\\:\\:');
