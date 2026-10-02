import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { ARTIFACT_LIMITS } from '@proofissue/artifact-schema';

import { isSafeRegularFile, prepareProjectRoot, readProjectTextFile } from './safe-files.js';
import { scanRelativeSpecifiers } from './source-scan.js';

/**
 * Suggestions for the files of a recording.
 *
 * Starting from the files the command names, it follows relative imports through the project
 * and proposes which files are reproduction files (tests and fixtures kept as recorded) and
 * which are subject files (code a fix may change). Everything it returns is only a suggestion:
 * the caller shows it with its reasons and the reporter confirms it. It never records,
 * collects, or shows file contents. It reads each file as the recorder would (no symbolic
 * links, nothing outside the project, strict UTF-8) and never reads `node_modules` or anything
 * beneath a directory whose name begins with a dot.
 */

export const SUGGESTION_LIMITS = Object.freeze({
  /** Files read while following imports. */
  files: 100,
  /** Bytes of source read in total. */
  total_bytes: 4 * 1024 * 1024,
  /** Bytes of one file; a larger one is neither read nor suggested. */
  file_bytes: Math.min(1024 * 1024, ARTIFACT_LIMITS.scalar_bytes),
  /** Import specifiers looked up in the file system in total. */
  specifier_lookups: 2000,
  /** Entries of the project root examined for runner configuration files. */
  root_entries: 10_000,
  /** Configuration files listed. */
  config_files: 20,
} as const);

export interface SuggestRequest {
  /** The Node.js arguments after `node`, as typed. */
  readonly arguments: readonly string[];
  /** Whether package.json is going to be recorded as a dependency file instead. */
  readonly include_dependencies?: boolean;
  /** Which separators an argument may use. Defaults to this process's platform. */
  readonly platform?: 'posix' | 'win32';
  readonly project_root: string;
}

export interface SuggestedFile {
  /** Portable, project-relative. */
  readonly path: string;
  /** Why the file is suggested, for example `imported by test/a.mjs`. Holds paths only. */
  readonly reason: string;
  readonly role: 'reproduction' | 'subject';
}

export type SuggestionLimit = 'bytes' | 'files' | 'lookups';

export interface FileSuggestions {
  readonly files: readonly SuggestedFile[];
  /** Which bounds stopped the scan early. Empty when it finished. */
  readonly limits_reached: readonly SuggestionLimit[];
  /**
   * Whether package.json sets "type". It is among `files` as a reproduction file unless
   * dependency capture will record it.
   */
  readonly manifest_sets_type: boolean;
  /** Runner configuration files at the project root that are not suggested. Never .npmrc or .env. */
  readonly uncollected_config_files: readonly string[];
  /** Fixed sentences about commands outside the support boundary. */
  readonly warnings: readonly string[];
}

const REPRODUCTION_DIRECTORIES: ReadonlySet<string> = new Set([
  'test',
  'tests',
  '__tests__',
  'spec',
  'specs',
  'fixtures',
  '__fixtures__',
  '__mocks__',
]);

/**
 * Whether a project path is a reproduction file (a test, spec, fixture, or mock) by its
 * directories or its name; every other reached file is a subject file.
 */
export const roleOfPath = (projectPath: string): 'reproduction' | 'subject' => {
  const segments = projectPath.split('/');
  const name = segments.pop() ?? '';
  if (segments.some((segment) => REPRODUCTION_DIRECTORIES.has(segment.toLowerCase()))) {
    return 'reproduction';
  }
  return /\.(?:test|spec)\./iu.test(name) ? 'reproduction' : 'subject';
};

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set(['.js', '.mjs', '.cjs']);

const RESOLUTION_SUFFIXES: readonly string[] = ['', '.js', '.mjs', '.cjs', '.json'];
const DIRECTORY_INDEXES: readonly string[] = ['index.js', 'index.mjs', 'index.cjs'];

const RUNNER_CONFIGURATION: readonly RegExp[] = [
  /^\.mocharc\.(?:js|cjs|json|yml|yaml|jsonc)$/u,
  /^\.babelrc$/u,
  /^babel\.config\.[A-Za-z]+$/u,
  /^\.c8rc(?:\.[A-Za-z]+)?$/u,
  /^\.nycrc(?:\.[A-Za-z]+)?$/u,
  /^jest\.config\.[A-Za-z]+$/u,
];

/** An argument with Windows separators converted and any leading `./` removed. */
const toProjectPath = (value: string, platform: 'posix' | 'win32'): string => {
  let result = platform === 'win32' ? value.replaceAll('\\', '/') : value;
  while (result.startsWith('./')) result = result.slice(2);
  return result;
};

// A path the walk may read: portable, and neither inside node_modules nor beneath (or named
// like) a dot-directory.
const isWalkablePath = (projectPath: string): boolean => {
  const segments = projectPath.split('/');
  return (
    segments.length > 0 &&
    segments.every(
      (segment) => segment !== '' && segment !== 'node_modules' && !segment.startsWith('.'),
    ) &&
    /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/u.test(projectPath)
  );
};

interface Seed {
  readonly path: string;
  readonly reason: string;
}

const REQUIRE_OPTIONS: ReadonlySet<string> = new Set(['--require', '-r', '--import']);

/**
 * The files a command names: its plain path arguments and the relative values of `--require`,
 * `-r`, and `--import`. An option-looking argument is never a path, and neither is a script
 * under node_modules. Whether the file exists is decided when it is read.
 */
const seedsOf = (arguments_: readonly string[], platform: 'posix' | 'win32'): readonly Seed[] => {
  const seeds: Seed[] = [];
  const add = (value: string, reason: string): void => {
    const candidate = toProjectPath(value, platform);
    if (isWalkablePath(candidate) && !seeds.some((seed) => seed.path === candidate)) {
      seeds.push({ path: candidate, reason });
    }
  };
  const relativeValue = (value: string): boolean =>
    value.startsWith('./') ||
    value.startsWith('../') ||
    (platform === 'win32' && (value.startsWith('.\\') || value.startsWith('..\\')));
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (REQUIRE_OPTIONS.has(argument)) {
      const value = arguments_[index + 1];
      index += 1;
      if (value !== undefined && relativeValue(value)) add(value, `named by ${argument}`);
      continue;
    }
    const equals = argument.indexOf('=');
    if (argument.startsWith('--') && equals > 0) {
      const option = argument.slice(0, equals);
      const value = argument.slice(equals + 1);
      if (REQUIRE_OPTIONS.has(option) && relativeValue(value)) add(value, `named by ${option}`);
      continue;
    }
    if (argument.startsWith('-')) continue;
    add(argument, 'named in the command');
  }
  return seeds;
};

const warningsFor = (
  arguments_: readonly string[],
  platform: 'posix' | 'win32',
): readonly string[] => {
  const warnings = new Set<string>();
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    const normalized = toProjectPath(argument, platform);
    if (normalized.startsWith('node_modules/vitest/')) {
      warnings.add(
        'vitest is outside the supported test runners (pure-JavaScript runners only); the failure may not replay.',
      );
    }
    if (normalized.startsWith('node_modules/tsx/')) {
      warnings.add(
        'tsx is outside the supported test runners (TypeScript is not supported); the failure may not replay.',
      );
    }
    const next = arguments_[index + 1];
    const importValue =
      argument === '--import'
        ? next
        : argument.startsWith('--import=')
          ? argument.slice(9)
          : undefined;
    if (importValue === 'tsx' || importValue?.startsWith('tsx/') === true) {
      warnings.add(
        'tsx is outside the supported test runners (TypeScript is not supported); the failure may not replay.',
      );
    }
    if (
      argument === '--loader' ||
      argument === '--experimental-loader' ||
      argument.startsWith('--loader=') ||
      argument.startsWith('--experimental-loader=')
    ) {
      warnings.add(
        'Module loader hooks (--loader) are outside the supported workflow; the failure may not replay.',
      );
    }
  }
  return [...warnings];
};

/**
 * The project files a relative specifier can name, in the fixed order they are tried: the exact
 * path, then it with .js, .mjs, .cjs, and .json added, then a directory's index.js, index.mjs,
 * and index.cjs. Nothing outside the project, in node_modules, or beneath a dot-directory.
 */
export const specifierCandidates = (importer: string, specifier: string): readonly string[] => {
  const directory = path.posix.dirname(importer);
  const asDirectory = specifier.endsWith('/');
  const joined = path.posix.normalize(path.posix.join(directory, specifier)).replace(/\/$/u, '');
  if (joined === '' || joined === '.' || joined === '..' || joined.startsWith('../')) return [];
  if (path.posix.isAbsolute(joined) || !isWalkablePath(joined)) return [];
  const exact = asDirectory ? [] : RESOLUTION_SUFFIXES.map((suffix) => `${joined}${suffix}`);
  return [...exact, ...DIRECTORY_INDEXES.map((name) => `${joined}/${name}`)];
};

const isSourcePath = (projectPath: string): boolean =>
  SOURCE_EXTENSIONS.has(path.posix.extname(projectPath).toLowerCase());

interface QueueEntry {
  readonly path: string;
  readonly reason: string;
  readonly role: 'reproduction' | 'subject';
}

interface ManifestType {
  readonly sets_type: boolean;
  /** Only the two values Node.js defines; anything else is not echoed. */
  readonly value?: 'commonjs' | 'module';
}

const readManifestType = async (root: string): Promise<ManifestType> => {
  try {
    const text = await readProjectTextFile(root, 'package.json', SUGGESTION_LIMITS.file_bytes);
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { sets_type: false };
    }
    if (!Object.hasOwn(value, 'type')) return { sets_type: false };
    const type = (value as { readonly type?: unknown }).type;
    return type === 'module' || type === 'commonjs'
      ? { sets_type: true, value: type }
      : { sets_type: true };
  } catch {
    return { sets_type: false };
  }
};

const listConfigurationFiles = async (
  root: string,
  excluded: ReadonlySet<string>,
): Promise<readonly string[]> => {
  let names: string[];
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries
      .slice(0, SUGGESTION_LIMITS.root_entries)
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return names
    .filter(
      (name) =>
        !excluded.has(name.toLowerCase()) && RUNNER_CONFIGURATION.some((rule) => rule.test(name)),
    )
    .sort()
    .slice(0, SUGGESTION_LIMITS.config_files);
};

/**
 * Suggests reproduction and subject files for a command. Throws `RecorderError` only when the
 * project directory itself cannot be used; an unreadable or unsafe file is simply not suggested.
 */
export const suggestFiles = async (request: SuggestRequest): Promise<FileSuggestions> => {
  const platform = request.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const root = await prepareProjectRoot(request.project_root);
  const files: SuggestedFile[] = [];
  const limits = new Set<SuggestionLimit>();
  const visited = new Set<string>();
  const queue: QueueEntry[] = seedsOf(request.arguments, platform).map((seed) => ({
    ...seed,
    role: 'reproduction',
  }));
  let totalBytes = 0;
  let lookups = 0;

  for (let head = 0; head < queue.length; head += 1) {
    const entry = queue[head];
    if (entry === undefined) break;
    const key = entry.path.toLowerCase();
    if (visited.has(key)) continue;
    visited.add(key);
    if (files.length >= SUGGESTION_LIMITS.files) {
      limits.add('files');
      break;
    }
    let content: string;
    try {
      content = await readProjectTextFile(root, entry.path, SUGGESTION_LIMITS.file_bytes);
    } catch {
      continue;
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (totalBytes + bytes > SUGGESTION_LIMITS.total_bytes) {
      limits.add('bytes');
      break;
    }
    totalBytes += bytes;
    files.push({ path: entry.path, reason: entry.reason, role: entry.role });
    if (!isSourcePath(entry.path)) continue;

    for (const specifier of scanRelativeSpecifiers(content).specifiers) {
      if (lookups >= SUGGESTION_LIMITS.specifier_lookups) {
        limits.add('lookups');
        break;
      }
      lookups += 1;
      for (const candidate of specifierCandidates(entry.path, specifier)) {
        if (visited.has(candidate.toLowerCase())) break;
        if (await isSafeRegularFile(root, candidate)) {
          queue.push({
            path: candidate,
            reason: `imported by ${entry.path}`,
            role: roleOfPath(candidate),
          });
          break;
        }
      }
    }
  }

  const manifest = await readManifestType(root);
  const suggested: SuggestedFile[] = [...files];
  if (
    manifest.sets_type &&
    request.include_dependencies !== true &&
    !suggested.some((file) => file.path.toLowerCase() === 'package.json')
  ) {
    suggested.push({
      path: 'package.json',
      reason:
        manifest.value === undefined
          ? 'package.json sets "type", which decides how Node.js reads .js files'
          : `package.json sets "type": "${manifest.value}", which decides how Node.js reads .js files`,
      role: 'reproduction',
    });
  }

  return {
    files: suggested,
    limits_reached: [...limits],
    manifest_sets_type: manifest.sets_type,
    uncollected_config_files: await listConfigurationFiles(
      root,
      new Set(suggested.map((file) => file.path.toLowerCase())),
    ),
    warnings: warningsFor(request.arguments, platform),
  };
};
