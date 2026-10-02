import { BOUNDED_REGEX_LIMITS, parsePattern } from './parse.js';
import type { AssertionKind, BoundedRegexError, CodePointRange, RegexNode } from './parse.js';

/**
 * One instruction of the compiled program. The program is a Thompson/Pike automaton: a thread is a
 * program counter, and `split` and `jump` never consume input.
 */
export type RegexInstruction =
  | { readonly op: 'char'; readonly code: number }
  | {
      readonly op: 'set';
      readonly negated: boolean;
      /** Sorted, non-overlapping, flattened as low, high, low, high, and so on. */
      readonly bounds: readonly number[];
    }
  | { readonly op: 'assert'; readonly assertion: AssertionKind }
  | { readonly op: 'split'; readonly first: number; readonly second: number }
  | { readonly op: 'jump'; readonly target: number }
  | { readonly op: 'match' };

export interface BoundedRegexProgram {
  readonly instructions: readonly RegexInstruction[];
}

export type CompileResult =
  | { readonly ok: true; readonly program: BoundedRegexProgram }
  | { readonly ok: false; readonly error: BoundedRegexError };

export interface CompileOptions {
  /**
   * Reject patterns that can match without consuming output. Always on for the public entry point;
   * the differential tests turn it off to cover nullable sub-patterns.
   */
  readonly reject_empty?: boolean;
}

class SizeFailure extends Error {
  constructor(readonly offset: number) {
    super('program too large');
  }
}

/** The number of instructions a node compiles to. Computed before anything is emitted. */
const sizeOf = (node: RegexNode): number => {
  let size: number;
  switch (node.kind) {
    case 'empty':
      size = 0;
      break;
    case 'set':
    case 'assertion':
      size = 1;
      break;
    case 'concat':
      size = node.items.reduce((total, item) => total + sizeOf(item), 0);
      break;
    case 'alternation':
      size =
        node.alternatives.reduce((total, item) => total + sizeOf(item), 0) +
        2 * (node.alternatives.length - 1);
      break;
    case 'repeat': {
      const body = sizeOf(node.item);
      if (node.max === null) size = node.min === 0 ? body + 2 : node.min * body + 1;
      else size = node.min * body + (node.max - node.min) * (body + 1);
      break;
    }
  }
  // The final match instruction takes one more slot.
  if (size + 1 > BOUNDED_REGEX_LIMITS.program_instructions) throw new SizeFailure(node.offset);
  return size;
};

const nullable = (node: RegexNode): boolean => {
  switch (node.kind) {
    case 'empty':
    case 'assertion':
      return true;
    case 'set':
      return false;
    case 'concat':
      return node.items.every(nullable);
    case 'alternation':
      return node.alternatives.some(nullable);
    case 'repeat':
      return node.min === 0 || nullable(node.item);
  }
};

const mergeRanges = (ranges: readonly CodePointRange[]): number[] => {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const bounds: number[] = [];
  for (const [low, high] of sorted) {
    const lastHigh = bounds.at(-1);
    if (lastHigh !== undefined && low <= lastHigh + 1) {
      if (high > lastHigh) bounds[bounds.length - 1] = high;
    } else {
      bounds.push(low, high);
    }
  }
  return bounds;
};

class Emitter {
  readonly instructions: RegexInstruction[] = [];

  emit(node: RegexNode): void {
    switch (node.kind) {
      case 'empty':
        return;
      case 'set': {
        const bounds = mergeRanges(node.ranges);
        const [low, high] = bounds;
        if (!node.negated && bounds.length === 2 && low !== undefined && low === high) {
          this.instructions.push({ op: 'char', code: low });
        } else {
          this.instructions.push({ op: 'set', negated: node.negated, bounds });
        }
        return;
      }
      case 'assertion':
        this.instructions.push({ op: 'assert', assertion: node.assertion });
        return;
      case 'concat':
        for (const item of node.items) this.emit(item);
        return;
      case 'alternation':
        this.emitAlternation(node.alternatives);
        return;
      case 'repeat':
        this.emitRepeat(node);
        return;
    }
  }

  private emitAlternation(alternatives: readonly RegexNode[]): void {
    const jumps: number[] = [];
    alternatives.forEach((alternative, position) => {
      if (position === alternatives.length - 1) {
        this.emit(alternative);
        return;
      }
      const split = this.instructions.length;
      this.instructions.push({ op: 'split', first: split + 1, second: -1 });
      this.emit(alternative);
      jumps.push(this.instructions.length);
      this.instructions.push({ op: 'jump', target: -1 });
      this.instructions[split] = {
        op: 'split',
        first: split + 1,
        second: this.instructions.length,
      };
    });
    for (const jump of jumps) {
      this.instructions[jump] = { op: 'jump', target: this.instructions.length };
    }
  }

  private emitRepeat(node: Extract<RegexNode, { kind: 'repeat' }>): void {
    const { item, max, min } = node;
    if (max === null) {
      if (min === 0) {
        const start = this.instructions.length;
        this.instructions.push({ op: 'split', first: start + 1, second: -1 });
        this.emit(item);
        this.instructions.push({ op: 'jump', target: start });
        this.instructions[start] = {
          op: 'split',
          first: start + 1,
          second: this.instructions.length,
        };
        return;
      }
      for (let copy = 0; copy < min - 1; copy += 1) this.emit(item);
      const start = this.instructions.length;
      this.emit(item);
      this.instructions.push({ op: 'split', first: start, second: this.instructions.length + 1 });
      return;
    }
    for (let copy = 0; copy < min; copy += 1) this.emit(item);
    const splits: number[] = [];
    for (let copy = min; copy < max; copy += 1) {
      splits.push(this.instructions.length);
      this.instructions.push({ op: 'split', first: this.instructions.length + 1, second: -1 });
      this.emit(item);
    }
    for (const split of splits) {
      this.instructions[split] = {
        op: 'split',
        first: split + 1,
        second: this.instructions.length,
      };
    }
  }
}

/**
 * Parses and compiles a pattern. The result is a program for {@link searchBoundedRegex}, or the
 * reason the pattern is not accepted.
 */
export const compilePattern = (pattern: string, options: CompileOptions = {}): CompileResult => {
  const parsed = parsePattern(pattern);
  if (!parsed.ok) return parsed;
  try {
    sizeOf(parsed.ast);
  } catch (error) {
    if (error instanceof SizeFailure) {
      return {
        ok: false,
        error: {
          code: 'too_large',
          message: `Pattern compiles to more than the limit of ${String(BOUNDED_REGEX_LIMITS.program_instructions)} instructions.`,
          offset: error.offset,
        },
      };
    }
    throw error;
  }
  if (options.reject_empty !== false && nullable(parsed.ast)) {
    return {
      ok: false,
      error: {
        code: 'matches_empty',
        message:
          'Pattern can match without consuming output, so it cannot identify a failure; require at least one character.',
        offset: 0,
      },
    };
  }
  const emitter = new Emitter();
  emitter.emit(parsed.ast);
  emitter.instructions.push({ op: 'match' });
  return { ok: true, program: { instructions: emitter.instructions } };
};
