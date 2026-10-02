/**
 * The code point that starts at a UTF-16 index, which must be inside the text. A surrogate pair is
 * one code point; a lone surrogate is its own code point.
 *
 * This is written out instead of calling `String.prototype.codePointAt` because the search is the
 * hot loop of the engine and must give one answer for one input: a development run of this engine
 * on Node.js 24.15 saw `codePointAt` return a wrong lone surrogate for a string it had just read
 * correctly, which no code of ours can cause.
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
