import { pathToFileURL } from 'node:url';

/** Which spelling rules the roots follow: the recording host's platform, or `posix` for replay. */
export type OutputPathPlatform = 'posix' | 'win32';

export type OutputPathToken = '<project>' | '<tmp>';

/** One literal spelling of a directory, and the token that replaces it. */
export interface OutputPathForm {
  readonly text: string;
  readonly token: OutputPathToken;
}

/** A relative artifact path spelled with backslashes, and the forward-slash path it becomes. */
export interface DeclaredPathSpelling {
  readonly replacement: string;
  readonly spelling: string;
}

/**
 * The exact directories the `paths` rule replaces. It holds host paths, so it must never be
 * serialized, logged, previewed, or placed in a result. Build one with
 * `createOutputPathContext`.
 */
export interface OutputPathContext {
  readonly declared_spellings: readonly DeclaredPathSpelling[];
  readonly forms: readonly OutputPathForm[];
}

export interface OutputPathContextInput {
  /** Relative artifact file paths; their backslash spellings are rewritten on win32 only. */
  readonly declared_paths?: readonly string[];
  readonly platform: OutputPathPlatform;
  /** Absolute directories that become `<project>`. */
  readonly project_roots: readonly string[];
  /** Absolute directories that become `<tmp>`. `<project>` wins when both name the same text. */
  readonly temporary_roots: readonly string[];
}

const MAX_ROOT_CHARACTERS = 1024;
const MAX_ROOTS_PER_KIND = 16;
const MAX_DECLARED_PATHS = 128;

const hasControlCharacter = (value: string): boolean => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
};

const trimTrailing = (value: string, separator: string): string => {
  let end = value.length;
  while (end > 0 && value[end - 1] === separator) end -= 1;
  return value.slice(0, end);
};

const posixForms = (root: string): readonly string[] => {
  if (!root.startsWith('/')) return [];
  const trimmed = trimTrailing(root, '/');
  if (trimmed === '') return [];
  return [trimmed, pathToFileURL(trimmed, { windows: false }).href];
};

const DRIVE_ROOT = /^([A-Za-z]):\\(.+)$/su;

const win32Forms = (root: string): readonly string[] => {
  const match = DRIVE_ROOT.exec(root.replaceAll('/', '\\'));
  const drive = match?.[1];
  const rest = match?.[2];
  if (drive === undefined || rest === undefined) return [];
  const trimmedRest = trimTrailing(rest, '\\');
  if (trimmedRest === '') return [];
  const forms: string[] = [];
  for (const letter of new Set([drive.toUpperCase(), drive.toLowerCase()])) {
    const native = `${letter}:\\${trimmedRest}`;
    forms.push(
      native,
      native.replaceAll('\\', '\\\\'),
      native.replaceAll('\\', '/'),
      pathToFileURL(native, { windows: true }).href,
    );
  }
  return forms;
};

const rootForms = (platform: OutputPathPlatform, root: string): readonly string[] => {
  if (root.length === 0 || root.length > MAX_ROOT_CHARACTERS || hasControlCharacter(root)) {
    return [];
  }
  return platform === 'win32' ? win32Forms(root) : posixForms(root);
};

const compareLongestFirst = (left: string, right: string): number => {
  if (left.length !== right.length) return right.length - left.length;
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

const declaredSpellings = (
  platform: OutputPathPlatform,
  declaredPaths: readonly string[],
): readonly DeclaredPathSpelling[] => {
  if (platform !== 'win32') return [];
  const spellings = new Map<string, string>();
  for (const declared of declaredPaths.slice(0, MAX_DECLARED_PATHS)) {
    if (!declared.includes('/') || declared.length > MAX_ROOT_CHARACTERS) continue;
    if (hasControlCharacter(declared) || declared.includes('\\')) continue;
    spellings.set(declared.replaceAll('/', '\\'), declared);
    spellings.set(declared.replaceAll('/', '\\\\'), declared);
  }
  return [...spellings.keys()]
    .sort(compareLongestFirst)
    .map((spelling) => ({ replacement: spellings.get(spelling) ?? spelling, spelling }));
};

/**
 * Turns absolute directories into the literal spellings a program can print for them. Roots
 * that are filesystem roots, relative, longer than 1024 characters, or contain a control
 * character are ignored, because replacing them would be a guess.
 */
export const createOutputPathContext = (input: OutputPathContextInput): OutputPathContext => {
  const tokens = new Map<string, OutputPathToken>();
  const add = (roots: readonly string[], token: OutputPathToken): void => {
    for (const root of roots.slice(0, MAX_ROOTS_PER_KIND)) {
      for (const form of rootForms(input.platform, root)) {
        if (!tokens.has(form)) tokens.set(form, token);
      }
    }
  };
  // Project first, so the project token wins when both kinds name the same text.
  add(input.project_roots, '<project>');
  add(input.temporary_roots, '<tmp>');
  const forms = [...tokens.keys()]
    .sort(compareLongestFirst)
    .map((text): OutputPathForm => ({ text, token: tokens.get(text) ?? '<project>' }));
  return Object.freeze({
    declared_spellings: declaredSpellings(input.platform, input.declared_paths ?? []),
    forms,
  });
};

/** A context that replaces nothing. */
export const EMPTY_OUTPUT_PATH_CONTEXT: OutputPathContext = createOutputPathContext({
  platform: 'posix',
  project_roots: [],
  temporary_roots: [],
});

// Characters that can continue a file name. A root must not run into one, and a root must not
// start inside one. A closing angle bracket also blocks a root. The later rules replace names
// and numbers with tokens that end in one, and a root that follows such a token was glued to
// that name before the replacement, so it is not a root afterwards either (idempotence).
const NAME_BEFORE = String.raw`(?<![A-Za-z0-9_.~@+%/\\>-])`;
const NAME_AFTER = String.raw`(?![A-Za-z0-9_.~@+%-])`;
const SEPARATED_NAME_AFTER = String.raw`(?![A-Za-z0-9_.~@+%/\\-])`;
// A tail is any run of separator-then-name segments. A separator is a slash, a backslash,
// or an escaped (doubled) backslash, and a name never contains one, so the run is unambiguous.
const TAIL = String.raw`((?:(?:\\\\|[\\/])[A-Za-z0-9_.~@+%-]+)*)`;
const TAIL_SEPARATORS = /\\\\|\\/g;

const escapeForRegularExpression = (value: string): string =>
  value.replace(/[\\^$.*+?()[\]{}|]/g, String.raw`\$&`);

interface CompiledContext {
  readonly declared: RegExp | undefined;
  readonly declared_replacements: ReadonlyMap<string, string>;
  readonly roots: RegExp | undefined;
  readonly tokens: ReadonlyMap<string, OutputPathToken>;
}

const compiled = new WeakMap<OutputPathContext, CompiledContext>();

const compile = (context: OutputPathContext): CompiledContext => {
  const cached = compiled.get(context);
  if (cached !== undefined) return cached;
  const roots =
    context.forms.length === 0
      ? undefined
      : new RegExp(
          `${NAME_BEFORE}(?:${context.forms.map((form) => escapeForRegularExpression(form.text)).join('|')})${NAME_AFTER}${TAIL}`,
          'g',
        );
  const declared =
    context.declared_spellings.length === 0
      ? undefined
      : new RegExp(
          `${NAME_BEFORE}(?:${context.declared_spellings.map((item) => escapeForRegularExpression(item.spelling)).join('|')})${SEPARATED_NAME_AFTER}`,
          'g',
        );
  const result: CompiledContext = {
    declared,
    declared_replacements: new Map(
      context.declared_spellings.map((item) => [item.spelling, item.replacement]),
    ),
    roots,
    tokens: new Map(context.forms.map((form) => [form.text, form.token])),
  };
  compiled.set(context, result);
  return result;
};

/**
 * The `paths` rule. Replaces each known directory with its token, then rewrites the separators
 * of the path that follows to forward slashes. Declared relative paths printed with
 * backslashes (win32 recordings) become forward-slash paths.
 */
export const applyPathRule = (
  text: string,
  context: OutputPathContext,
): { readonly count: number; readonly text: string } => {
  const parts = compile(context);
  let count = 0;
  let result = text;
  if (parts.roots !== undefined) {
    result = result.replace(parts.roots, (match: string, tail: string) => {
      const token = parts.tokens.get(match.slice(0, match.length - tail.length));
      if (token === undefined) return match;
      count += 1;
      return `${token}${tail.replace(TAIL_SEPARATORS, '/')}`;
    });
  }
  if (parts.declared !== undefined) {
    result = result.replace(parts.declared, (match: string) => {
      const replacement = parts.declared_replacements.get(match);
      if (replacement === undefined) return match;
      count += 1;
      return replacement;
    });
  }
  return { count, text: result };
};

/** True when `text` still contains one of the context's directories in any known spelling. */
export const containsContextPath = (text: string, context: OutputPathContext): boolean => {
  const parts = compile(context);
  return parts.roots !== undefined && text.search(parts.roots) !== -1;
};
