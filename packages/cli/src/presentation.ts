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
