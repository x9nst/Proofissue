import { compilePattern } from './compile.js';
import type { BoundedRegexProgram } from './compile.js';
import type { BoundedRegexError } from './parse.js';

export { BOUNDED_REGEX_LIMITS } from './parse.js';
export type { BoundedRegexError, BoundedRegexErrorCode } from './parse.js';
export type { BoundedRegexProgram } from './compile.js';
export { searchBoundedRegex } from './search.js';
export type { BoundedRegexSearchOptions, BoundedRegexSearchResult } from './search.js';

export type BoundedRegexCompilation =
  | { readonly ok: true; readonly program: BoundedRegexProgram }
  | { readonly ok: false; readonly error: BoundedRegexError };

/**
 * Compiles a pattern in the bounded regular-expression language, or reports the first reason it is
 * not accepted. Accepted patterns mean the same as `new RegExp(pattern, 'mu')` and cannot match
 * without consuming output.
 */
export const compileBoundedRegex = (pattern: string): BoundedRegexCompilation =>
  compilePattern(pattern);
