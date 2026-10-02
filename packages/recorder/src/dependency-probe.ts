import { LOCKFILE_LIMITS, validateNpmLockfile } from '@proofissue/dependencies';

import { isSafeRegularFile, prepareProjectRoot, readProjectTextFile } from './safe-files.js';

/**
 * A read-only look at the project's dependency files, so a reporter can be asked whether to
 * record them. Nothing is collected: it reports only counts and fixed or bounded reasons, never
 * file contents, and it uses the same lockfile validation a recording would.
 */

/** Longest reason shown, in characters. */
const MAX_REASON_CHARACTERS = 200;
/** How many reasons are kept. */
export const MAX_PROBE_REASONS = 3;

export type DependencyProbe =
  | {
      /** package.json and package-lock.json are not both regular files at the project root. */
      readonly status: 'absent';
    }
  | {
      readonly declares_dependencies: boolean;
      readonly install_script_packages: number;
      readonly package_count: number;
      readonly status: 'usable';
    }
  | {
      readonly declares_dependencies: boolean;
      /** At most `MAX_PROBE_REASONS`, in the order the validation found them. */
      readonly reasons: readonly string[];
      readonly status: 'unusable';
      /** How many further reasons were not kept. */
      readonly unlisted_reasons: number;
    };

const declaresDependencies = (manifest: unknown): boolean => {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return false;
  return (['dependencies', 'devDependencies'] as const).some((field) => {
    const value = (manifest as Readonly<Record<string, unknown>>)[field];
    return (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      Object.keys(value).length > 0
    );
  });
};

const bounded = (text: string): string =>
  text.length > MAX_REASON_CHARACTERS ? `${text.slice(0, MAX_REASON_CHARACTERS)}...` : text;

/**
 * Checks whether package.json and package-lock.json exist at the project root and whether the
 * lockfile could be recorded for dependency replay. Throws `RecorderError` only when the project
 * directory itself cannot be used.
 */
export const probeDependencyFiles = async (projectRoot: string): Promise<DependencyProbe> => {
  const root = await prepareProjectRoot(projectRoot);
  if (
    !(await isSafeRegularFile(root, 'package.json')) ||
    !(await isSafeRegularFile(root, 'package-lock.json'))
  ) {
    return { status: 'absent' };
  }
  const reasons: string[] = [];
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readProjectTextFile(root, 'package.json', LOCKFILE_LIMITS.bytes));
  } catch {
    reasons.push('package.json is not readable valid JSON.');
  }
  if (
    manifest !== undefined &&
    (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest))
  ) {
    reasons.push('package.json must be a JSON object.');
  }
  let lockfile: string | undefined;
  try {
    lockfile = await readProjectTextFile(root, 'package-lock.json', LOCKFILE_LIMITS.bytes);
  } catch {
    reasons.push(
      `package-lock.json could not be read (it must be UTF-8 text of at most ${String(LOCKFILE_LIMITS.bytes)} bytes).`,
    );
  }
  const declares = declaresDependencies(manifest);
  if (lockfile !== undefined) {
    const validation = validateNpmLockfile(lockfile);
    if (validation.ok && reasons.length === 0) {
      return {
        declares_dependencies: declares,
        install_script_packages: validation.packages.filter((item) => item.has_install_script)
          .length,
        package_count: validation.packages.length,
        status: 'usable',
      };
    }
    if (!validation.ok) {
      for (const error of validation.errors) {
        reasons.push(
          error.package_path === undefined
            ? error.message
            : `${error.message} (${JSON.stringify(error.package_path.slice(0, 80))})`,
        );
      }
    }
  }
  return {
    declares_dependencies: declares,
    reasons: reasons.slice(0, MAX_PROBE_REASONS).map(bounded),
    status: 'unusable',
    unlisted_reasons: Math.max(0, reasons.length - MAX_PROBE_REASONS),
  };
};
