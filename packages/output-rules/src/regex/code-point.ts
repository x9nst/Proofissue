/**
 * The code point that starts at a UTF-16 index, which must be inside the text. A surrogate pair is
 * one code point; a lone surrogate is its own code point.
 *
 * This is written out over `charCodeAt` so the engine's decoding of surrogates is explicit and
 * tested here, rather than relying on `String.prototype.codePointAt`. During development one
 * differential-test run on Node.js 24.15 appeared to get a wrong lone surrogate from `codePointAt`;
 * a standalone loop of two million reads on the same string did not reproduce it, so the cause is
 * unconfirmed and may have been in the test setup. Either reader gives the same results.
 */
export const codePointAtIndex = (text: string, index: number): number => {
  const high = text.charCodeAt(index);
  if (high >= 0xd800 && high <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      return (high - 0xd800) * 0x400 + (low - 0xdc00) + 0x10000;
    }
  }
  return high;
};
