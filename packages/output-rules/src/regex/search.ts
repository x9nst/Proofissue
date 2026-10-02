import { codePointAtIndex } from './code-point.js';
import { BOUNDED_REGEX_LIMITS } from './parse.js';
import type { BoundedRegexProgram, RegexInstruction } from './compile.js';

export interface BoundedRegexSearchOptions {
  /** Instruction visits allowed before the search gives up. Defaults to the documented limit. */
  readonly step_limit?: number;
}

export interface BoundedRegexSearchResult {
  readonly status: 'matched' | 'not_matched' | 'step_limit_exceeded';
  /** Instruction visits made. Identical for identical inputs on every machine. */
  readonly steps: number;
}

const END = -1;

/** A set of program counters with O(1) insert, membership, and clear. */
class SparseSet {
  readonly dense: Int32Array;
  size = 0;
  private readonly sparse: Int32Array;

  constructor(capacity: number) {
    this.dense = new Int32Array(capacity);
    this.sparse = new Int32Array(capacity);
  }

  has(value: number): boolean {
    const slot = this.sparse[value] ?? 0;
    return slot < this.size && this.dense[slot] === value;
  }

  add(value: number): void {
    this.sparse[value] = this.size;
    this.dense[this.size] = value;
    this.size += 1;
  }

  clear(): void {
    this.size = 0;
  }
}

const isLineTerminator = (code: number): boolean =>
  code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029;

const isWord = (code: number): boolean =>
  (code >= 0x30 && code <= 0x39) ||
  (code >= 0x41 && code <= 0x5a) ||
  code === 0x5f ||
  (code >= 0x61 && code <= 0x7a);

const inBounds = (bounds: readonly number[], code: number): boolean => {
  let low = 0;
  let high = bounds.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const start = bounds[middle * 2] ?? 0;
    if (code < start) {
      high = middle - 1;
    } else if (code > (bounds[middle * 2 + 1] ?? 0)) {
      low = middle + 1;
    } else {
      return true;
    }
  }
  return false;
};

const assertionHolds = (
  assertion: Extract<RegexInstruction, { op: 'assert' }>['assertion'],
  previous: number,
  next: number,
): boolean => {
  switch (assertion) {
    case 'line_start':
      return previous === END || isLineTerminator(previous);
    case 'line_end':
      return next === END || isLineTerminator(next);
    case 'word_boundary':
      return isWord(previous) !== isWord(next);
    case 'not_word_boundary':
      return isWord(previous) === isWord(next);
  }
};

const consumes = (instruction: RegexInstruction, code: number): boolean => {
  if (instruction.op === 'char') return instruction.code === code;
  if (instruction.op === 'set') return inBounds(instruction.bounds, code) !== instruction.negated;
  return false;
};

const MATCHED = 1;
const LIMIT = 2;

/**
 * Searches `text` for a match of the program anywhere in it (an unanchored search).
 *
 * The search runs every live thread in lock step, one code point at a time, so its cost is at most
 * the program size times the text length and never depends on how the pattern is written. Every
 * instruction visit counts as a step, and a search that would exceed `step_limit` stops with
 * `step_limit_exceeded`: a result that is never a match.
 */
export const searchBoundedRegex = (
  program: BoundedRegexProgram,
  text: string,
  options: BoundedRegexSearchOptions = {},
): BoundedRegexSearchResult => {
  const limit = options.step_limit ?? BOUNDED_REGEX_LIMITS.steps;
  const instructions = program.instructions;
  const count = instructions.length;
  let current = new SparseSet(count);
  let upcoming = new SparseSet(count);
  // Every program counter is processed once per list and pushes at most two more.
  const stack = new Int32Array(2 * count + 2);
  let steps = 0;

  /** Adds `start` and everything reachable without consuming input at this position. */
  const addThread = (list: SparseSet, start: number, previous: number, next: number): number => {
    let top = 0;
    stack[top] = start;
    top += 1;
    while (top > 0) {
      top -= 1;
      const pc = stack[top] ?? 0;
      if (list.has(pc)) continue;
      list.add(pc);
      steps += 1;
      if (steps > limit) return LIMIT;
      const instruction = instructions[pc];
      if (instruction === undefined) continue;
      switch (instruction.op) {
        case 'match':
          return MATCHED;
        case 'jump':
          stack[top] = instruction.target;
          top += 1;
          break;
        case 'split':
          stack[top] = instruction.second;
          stack[top + 1] = instruction.first;
          top += 2;
          break;
        case 'assert':
          if (assertionHolds(instruction.assertion, previous, next)) {
            stack[top] = pc + 1;
            top += 1;
          }
          break;
        default:
          break;
      }
    }
    return 0;
  };

  const finish = (status: BoundedRegexSearchResult['status']): BoundedRegexSearchResult => ({
    status,
    steps: Math.min(steps, limit),
  });

  let position = 0;
  let previous = END;
  let code = text.length === 0 ? END : codePointAtIndex(text, 0);
  for (;;) {
    const started = addThread(current, 0, previous, code);
    if (started === MATCHED) return finish('matched');
    if (started === LIMIT) return finish('step_limit_exceeded');
    if (code === END) return finish('not_matched');
    const width = code > 0xffff ? 2 : 1;
    const following =
      position + width >= text.length ? END : codePointAtIndex(text, position + width);
    upcoming.clear();
    for (let slot = 0; slot < current.size; slot += 1) {
      const pc = current.dense[slot] ?? 0;
      const instruction = instructions[pc];
      if (instruction === undefined) continue;
      if (instruction.op !== 'char' && instruction.op !== 'set') continue;
      steps += 1;
      if (steps > limit) return finish('step_limit_exceeded');
      if (!consumes(instruction, code)) continue;
      const added = addThread(upcoming, pc + 1, code, following);
      if (added === MATCHED) return finish('matched');
      if (added === LIMIT) return finish('step_limit_exceeded');
    }
    const swap = current;
    current = upcoming;
    upcoming = swap;
    previous = code;
    code = following;
    position += width;
  }
};
