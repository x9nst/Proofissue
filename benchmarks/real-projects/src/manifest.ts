/**
 * The declarative case manifest for the real-project trials.
 *
 * Everything here is pure: it parses untrusted JSON, rejects anything outside the documented
 * shape, and selects cases. The manifest drives `git`, `npm`, and the ProofIssue CLI, so every
 * value that reaches a command line is validated to the same bounds the CLI itself applies.
 */

export type ExpectationStream = 'stderr' | 'stdout';
export type ExpectationMode = 'contains' | 'contains_normalized' | 'exact' | 'exact_normalized';

export interface TrialExpectation {
  readonly stream: ExpectationStream;
  readonly mode: ExpectationMode;
  /** Present for the `contains*` modes and absent for the `exact*` modes. */
  readonly value?: string;
}

export interface TrialCase {
  readonly id: string;
  readonly sets: readonly string[];
  readonly title: string;
  readonly repository: string;
  readonly links: readonly string[];
  readonly pre_fix_commit: string;
  readonly fix_commit: string;
  readonly dependencies: boolean;
  readonly reproduction_files: readonly string[];
  readonly subject_files: readonly string[];
  readonly command: readonly string[];
  readonly expected_exit_code: number;
  readonly expectations: readonly TrialExpectation[];
  readonly notes?: string;
}

export interface TrialManifest {
  readonly manifest_version: 1;
  readonly image: string;
  readonly cases: readonly TrialCase[];
}

export interface ManifestIssue {
  /** A JSON-pointer-like location, for example `/cases/0/command`. */
  readonly path: string;
  readonly message: string;
}

export type ManifestParseResult =
  | { readonly ok: true; readonly manifest: TrialManifest }
  | { readonly ok: false; readonly errors: readonly ManifestIssue[] };

const ID_PATTERN = /^[A-Z][A-Z0-9-]{0,15}$/u;
const SET_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;
const IMAGE_PATTERN = /^node@sha256:[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/u;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const HTTPS_URL_PATTERN = /^https:\/\/[^\s]+$/u;

export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTES_LENGTH = 2000;
export const MAX_LINKS = 10;
export const MAX_PATH_LENGTH = 512;
export const MAX_ARGUMENT_LENGTH = 8192;
export const MAX_EXPECTATION_LENGTH = 8192;
export const MAX_EXPECTATIONS = 16;
export const MAX_COMMAND_LENGTH = 129;
/** The artifact allows 100 files; dependency recording adds package.json and the lockfile. */
export const MAX_FILES_WITH_DEPENDENCIES = 98;
export const MAX_FILES_WITHOUT_DEPENDENCIES = 100;
export const MAX_URL_LENGTH = 2048;

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set(['manifest_version', 'image', 'cases']);
const CASE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'sets',
  'title',
  'repository',
  'links',
  'pre_fix_commit',
  'fix_commit',
  'dependencies',
  'reproduction_files',
  'subject_files',
  'command',
  'expected_exit_code',
  'expectations',
  'notes',
]);
const EXPECTATION_KEYS: ReadonlySet<string> = new Set(['stream', 'mode', 'value']);
const EXPECTATION_MODES: ReadonlySet<string> = new Set([
  'contains',
  'contains_normalized',
  'exact',
  'exact_normalized',
]);
const FORBIDDEN_SELECTED_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'package-lock.json',
]);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isExactMode = (mode: string): boolean => mode === 'exact' || mode === 'exact_normalized';

/** Code points the CLI refuses in a command argument: C0 controls other than tab, and DEL. */
export const hasForbiddenControl = (value: string): boolean => {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0 && code <= 8) || (code >= 10 && code <= 31) || code === 127) return true;
  }
  return false;
};

class Issues {
  readonly list: ManifestIssue[] = [];

  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

const rejectUnknownKeys = (
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: Issues,
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.add(`${path}/${key}`, 'Unknown key.');
  }
};

const readString = (
  value: unknown,
  path: string,
  issues: Issues,
  bounds: { readonly min: number; readonly max: number },
): string | undefined => {
  if (typeof value !== 'string') {
    issues.add(path, 'Must be a string.');
    return undefined;
  }
  if (value.length < bounds.min || value.length > bounds.max) {
    issues.add(path, `Must be ${String(bounds.min)} to ${String(bounds.max)} characters long.`);
    return undefined;
  }
  return value;
};

const readStringArray = (
  value: unknown,
  path: string,
  issues: Issues,
  bounds: { readonly min: number; readonly max: number },
): readonly string[] | undefined => {
  if (!Array.isArray(value)) {
    issues.add(path, 'Must be an array of strings.');
    return undefined;
  }
  if (value.length < bounds.min || value.length > bounds.max) {
    issues.add(path, `Must contain ${String(bounds.min)} to ${String(bounds.max)} items.`);
    return undefined;
  }
  const items: string[] = [];
  const issuesBefore = issues.list.length;
  value.forEach((item: unknown, index) => {
    if (typeof item === 'string') {
      items.push(item);
    } else {
      issues.add(`${path}/${String(index)}`, 'Must be a string.');
    }
  });
  return issues.list.length === issuesBefore ? items : undefined;
};

/** A portable POSIX relative path: the CLI and the artifact format both require this. */
export const portablePathProblem = (candidate: string): string | undefined => {
  if (candidate.length === 0) return 'Must not be empty.';
  if (candidate.length > MAX_PATH_LENGTH) {
    return `Must be at most ${String(MAX_PATH_LENGTH)} characters long.`;
  }
  if (candidate.startsWith('/')) return 'Must be relative, not absolute.';
  if (candidate.includes(String.fromCharCode(92))) return 'Must use forward slashes only.';
  if (hasForbiddenControl(candidate)) return 'Must not contain control characters.';
  for (const segment of candidate.split('/')) {
    if (segment === '') return 'Must not contain an empty segment.';
    if (segment === '.' || segment === '..') return 'Must not contain a . or .. segment.';
  }
  return undefined;
};

const readFileList = (
  value: unknown,
  path: string,
  issues: Issues,
): readonly string[] | undefined => {
  const items = readStringArray(value, path, issues, { min: 1, max: 100 });
  if (items === undefined) return undefined;
  const issuesBefore = issues.list.length;
  items.forEach((item, index) => {
    const problem = portablePathProblem(item);
    if (problem !== undefined) {
      issues.add(`${path}/${String(index)}`, problem);
    } else if (FORBIDDEN_SELECTED_FILES.has(item)) {
      issues.add(
        `${path}/${String(index)}`,
        'package.json and package-lock.json are recorded by --dependencies, never selected.',
      );
    }
  });
  return issues.list.length === issuesBefore ? items : undefined;
};

const readCommand = (
  value: unknown,
  path: string,
  issues: Issues,
): readonly string[] | undefined => {
  const items = readStringArray(value, path, issues, { min: 2, max: MAX_COMMAND_LENGTH });
  if (items === undefined) return undefined;
  const issuesBefore = issues.list.length;
  if (items[0] !== 'node') {
    issues.add(`${path}/0`, 'The command must start with node.');
  }
  items.forEach((item, index) => {
    if (item.length === 0 || item.length > MAX_ARGUMENT_LENGTH) {
      issues.add(
        `${path}/${String(index)}`,
        `Must be 1 to ${String(MAX_ARGUMENT_LENGTH)} characters long.`,
      );
    } else if (hasForbiddenControl(item)) {
      issues.add(`${path}/${String(index)}`, 'Must not contain control characters.');
    }
  });
  return issues.list.length === issuesBefore ? items : undefined;
};

const readExpectations = (
  value: unknown,
  path: string,
  issues: Issues,
): readonly TrialExpectation[] | undefined => {
  if (!Array.isArray(value)) {
    issues.add(path, 'Must be an array.');
    return undefined;
  }
  if (value.length < 1 || value.length > MAX_EXPECTATIONS) {
    issues.add(path, `Must contain 1 to ${String(MAX_EXPECTATIONS)} items.`);
    return undefined;
  }
  const expectations: TrialExpectation[] = [];
  const exactStreams = new Set<string>();
  const issuesBefore = issues.list.length;
  value.forEach((item: unknown, index) => {
    const itemPath = `${path}/${String(index)}`;
    if (!isRecord(item)) {
      issues.add(itemPath, 'Must be an object.');
      return;
    }
    const before = issues.list.length;
    rejectUnknownKeys(item, EXPECTATION_KEYS, itemPath, issues);
    const stream = item['stream'];
    if (stream !== 'stdout' && stream !== 'stderr') {
      issues.add(`${itemPath}/stream`, 'Must be stdout or stderr.');
    }
    const mode = item['mode'];
    if (typeof mode !== 'string' || !EXPECTATION_MODES.has(mode)) {
      issues.add(
        `${itemPath}/mode`,
        'Must be contains, contains_normalized, exact, or exact_normalized.',
      );
    } else if (isExactMode(mode)) {
      if (item['value'] !== undefined) {
        issues.add(`${itemPath}/value`, 'The exact modes take no value.');
      }
      if (typeof stream === 'string') {
        if (exactStreams.has(stream)) {
          issues.add(itemPath, `At most one exact expectation is allowed for ${stream}.`);
        }
        exactStreams.add(stream);
      }
    } else {
      const literal = readString(item['value'], `${itemPath}/value`, issues, {
        min: 1,
        max: MAX_EXPECTATION_LENGTH,
      });
      if (literal?.startsWith('--') === true) {
        issues.add(`${itemPath}/value`, 'The CLI rejects option values that start with --.');
      }
    }
    if (issues.list.length > before) {
      return;
    }
    const rawValue = item['value'];
    expectations.push({
      stream: stream as ExpectationStream,
      mode: mode as ExpectationMode,
      ...(typeof rawValue === 'string' ? { value: rawValue } : {}),
    });
  });
  return issues.list.length === issuesBefore ? expectations : undefined;
};

const readSets = (value: unknown, path: string, issues: Issues): readonly string[] | undefined => {
  const sets = readStringArray(value, path, issues, { min: 1, max: 16 });
  if (sets === undefined) return undefined;
  const issuesBefore = issues.list.length;
  const seen = new Set<string>();
  sets.forEach((item, index) => {
    if (!SET_PATTERN.test(item)) {
      issues.add(`${path}/${String(index)}`, 'Must match ^[a-z][a-z0-9-]{0,31}$.');
    } else if (seen.has(item)) {
      issues.add(`${path}/${String(index)}`, 'Must be unique.');
    }
    seen.add(item);
  });
  return issues.list.length === issuesBefore ? sets : undefined;
};

const readLinks = (value: unknown, path: string, issues: Issues): readonly string[] | undefined => {
  const links = readStringArray(value, path, issues, { min: 0, max: MAX_LINKS });
  if (links === undefined) return undefined;
  const issuesBefore = issues.list.length;
  links.forEach((item, index) => {
    if (item.length > MAX_URL_LENGTH || !HTTPS_URL_PATTERN.test(item)) {
      issues.add(`${path}/${String(index)}`, 'Must be an https:// URL without whitespace.');
    }
  });
  return issues.list.length === issuesBefore ? links : undefined;
};

const readCase = (
  value: unknown,
  path: string,
  issues: Issues,
  seenIds: Set<string>,
): TrialCase | undefined => {
  if (!isRecord(value)) {
    issues.add(path, 'Must be an object.');
    return undefined;
  }
  const before = issues.list.length;
  rejectUnknownKeys(value, CASE_KEYS, path, issues);

  const id = readString(value['id'], `${path}/id`, issues, { min: 1, max: 16 });
  if (id !== undefined) {
    if (!ID_PATTERN.test(id)) issues.add(`${path}/id`, 'Must match ^[A-Z][A-Z0-9-]{0,15}$.');
    else if (seenIds.has(id)) issues.add(`${path}/id`, 'Case IDs must be unique.');
    seenIds.add(id);
  }
  const sets = readSets(value['sets'], `${path}/sets`, issues);
  const title = readString(value['title'], `${path}/title`, issues, {
    min: 1,
    max: MAX_TITLE_LENGTH,
  });
  const repository = readString(value['repository'], `${path}/repository`, issues, {
    min: 1,
    max: 256,
  });
  if (repository !== undefined && !REPOSITORY_PATTERN.test(repository)) {
    issues.add(`${path}/repository`, 'Must be an https://github.com/<owner>/<repository>.git URL.');
  }
  const links = readLinks(value['links'], `${path}/links`, issues);
  const preFix = readString(value['pre_fix_commit'], `${path}/pre_fix_commit`, issues, {
    min: 1,
    max: 64,
  });
  const fix = readString(value['fix_commit'], `${path}/fix_commit`, issues, { min: 1, max: 64 });
  if (preFix !== undefined && !COMMIT_PATTERN.test(preFix)) {
    issues.add(`${path}/pre_fix_commit`, 'Must be a full 40-character lowercase hex commit.');
  }
  if (fix !== undefined && !COMMIT_PATTERN.test(fix)) {
    issues.add(`${path}/fix_commit`, 'Must be a full 40-character lowercase hex commit.');
  }
  if (preFix !== undefined && preFix === fix) {
    issues.add(`${path}/fix_commit`, 'Must differ from pre_fix_commit.');
  }
  const dependencies = value['dependencies'];
  if (typeof dependencies !== 'boolean') issues.add(`${path}/dependencies`, 'Must be a boolean.');

  const reproductionFiles = readFileList(
    value['reproduction_files'],
    `${path}/reproduction_files`,
    issues,
  );
  const subjectFiles = readFileList(value['subject_files'], `${path}/subject_files`, issues);
  if (reproductionFiles !== undefined && subjectFiles !== undefined) {
    const seenPaths = new Set<string>();
    for (const file of [...reproductionFiles, ...subjectFiles]) {
      const key = file.toLowerCase();
      if (seenPaths.has(key)) {
        issues.add(path, `The path ${file} is selected more than once (compared ignoring case).`);
      }
      seenPaths.add(key);
    }
    const limit =
      dependencies === true ? MAX_FILES_WITH_DEPENDENCIES : MAX_FILES_WITHOUT_DEPENDENCIES;
    if (reproductionFiles.length + subjectFiles.length > limit) {
      issues.add(path, `At most ${String(limit)} files can be selected for this case.`);
    }
  }

  const command = readCommand(value['command'], `${path}/command`, issues);
  const exitCode = value['expected_exit_code'];
  if (
    typeof exitCode !== 'number' ||
    !Number.isInteger(exitCode) ||
    exitCode < 1 ||
    exitCode > 255
  ) {
    issues.add(`${path}/expected_exit_code`, 'Must be an integer from 1 to 255.');
  }
  const expectations = readExpectations(value['expectations'], `${path}/expectations`, issues);
  const notes =
    value['notes'] === undefined
      ? undefined
      : readString(value['notes'], `${path}/notes`, issues, { min: 0, max: MAX_NOTES_LENGTH });

  if (issues.list.length > before) return undefined;
  if (
    id === undefined ||
    sets === undefined ||
    title === undefined ||
    repository === undefined ||
    links === undefined ||
    preFix === undefined ||
    fix === undefined ||
    typeof dependencies !== 'boolean' ||
    reproductionFiles === undefined ||
    subjectFiles === undefined ||
    command === undefined ||
    typeof exitCode !== 'number' ||
    expectations === undefined
  ) {
    return undefined;
  }
  return {
    id,
    sets,
    title,
    repository,
    links,
    pre_fix_commit: preFix,
    fix_commit: fix,
    dependencies,
    reproduction_files: reproductionFiles,
    subject_files: subjectFiles,
    command,
    expected_exit_code: exitCode,
    expectations,
    ...(notes === undefined ? {} : { notes }),
  };
};

/** Parses manifest JSON text. Never throws: every problem is a typed issue with a path. */
export const parseManifest = (text: string): ManifestParseResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: [{ path: '', message: 'The manifest is not valid JSON.' }] };
  }
  return parseManifestValue(raw);
};

export const parseManifestValue = (raw: unknown): ManifestParseResult => {
  const issues = new Issues();
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ path: '', message: 'The manifest must be a JSON object.' }] };
  }
  rejectUnknownKeys(raw, TOP_LEVEL_KEYS, '', issues);
  if (raw['manifest_version'] !== 1) issues.add('/manifest_version', 'Must be 1.');
  const image = raw['image'];
  if (typeof image !== 'string' || !IMAGE_PATTERN.test(image)) {
    issues.add('/image', 'Must be node@sha256: followed by 64 lowercase hex characters.');
  }
  const rawCases = raw['cases'];
  const cases: TrialCase[] = [];
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    issues.add('/cases', 'Must be a non-empty array.');
  } else {
    const seenIds = new Set<string>();
    rawCases.forEach((item: unknown, index) => {
      const parsed = readCase(item, `/cases/${String(index)}`, issues, seenIds);
      if (parsed !== undefined) cases.push(parsed);
    });
  }
  if (issues.list.length > 0 || typeof image !== 'string') {
    return { ok: false, errors: issues.list };
  }
  return { ok: true, manifest: { manifest_version: 1, image, cases } };
};

export interface SelectionInputs {
  readonly set?: string | undefined;
  readonly cases?: string | undefined;
  readonly ref?: string | undefined;
}

export type Selection =
  | { readonly kind: 'cases'; readonly ids: readonly string[] }
  | { readonly kind: 'set'; readonly set: string };

export type SelectionResult =
  | { readonly ok: true; readonly selection: Selection }
  | { readonly ok: false; readonly error: string };

const blank = (value: string | undefined): boolean => value === undefined || value.trim() === '';

/**
 * Chooses what to run. A non-empty `cases` list wins; otherwise a non-empty `set`; otherwise the
 * set named by a `trials/<set>[/...]` ref. An empty string means "not given".
 */
export const selectionFromInputs = (inputs: SelectionInputs): SelectionResult => {
  if (!blank(inputs.cases)) {
    const ids = (inputs.cases ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const seen = new Set<string>();
    for (const id of ids) {
      if (!ID_PATTERN.test(id)) return { ok: false, error: 'A case ID is not a valid case ID.' };
      if (seen.has(id)) return { ok: false, error: `The case ${id} is listed more than once.` };
      seen.add(id);
    }
    if (ids.length === 0) return { ok: false, error: 'No case IDs were given.' };
    return { ok: true, selection: { kind: 'cases', ids } };
  }
  if (!blank(inputs.set)) {
    const set = (inputs.set ?? '').trim();
    if (!SET_PATTERN.test(set)) return { ok: false, error: 'The set name is not valid.' };
    return { ok: true, selection: { kind: 'set', set } };
  }
  const match = /^trials\/([^/]+)(?:\/.*)?$/u.exec(inputs.ref ?? '');
  const fromRef = match?.[1];
  if (fromRef !== undefined) {
    if (!SET_PATTERN.test(fromRef)) {
      return { ok: false, error: 'The set named by the branch is not a valid set name.' };
    }
    return { ok: true, selection: { kind: 'set', set: fromRef } };
  }
  return {
    ok: false,
    error: 'Give a set or case IDs, or run from a branch named trials/<set>/<label>.',
  };
};

export type CaseSelectionResult =
  | { readonly ok: true; readonly cases: readonly TrialCase[] }
  | { readonly ok: false; readonly error: string };

/** Resolves a selection against the manifest, in manifest order for a set and request order for IDs. */
export const selectCases = (manifest: TrialManifest, selection: Selection): CaseSelectionResult => {
  if (selection.kind === 'set') {
    const cases = manifest.cases.filter((item) => item.sets.includes(selection.set));
    if (cases.length === 0) {
      return { ok: false, error: `No case belongs to the set ${selection.set}.` };
    }
    return { ok: true, cases };
  }
  const cases: TrialCase[] = [];
  for (const id of selection.ids) {
    const found = manifest.cases.find((item) => item.id === id);
    if (found === undefined) return { ok: false, error: `The manifest has no case ${id}.` };
    cases.push(found);
  }
  if (cases.length === 0) return { ok: false, error: 'The selection is empty.' };
  return { ok: true, cases };
};

/** The two lines the workflow reads from `$GITHUB_OUTPUT`: compact case IDs and the image. */
export const toGithubOutputs = (manifest: TrialManifest, cases: readonly TrialCase[]): string =>
  `cases=${JSON.stringify(cases.map((item) => item.id))}\nimage=${manifest.image}\n`;
