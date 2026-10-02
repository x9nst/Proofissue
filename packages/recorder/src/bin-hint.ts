import { isArtifactPath } from '@proofissue/artifact-schema';
import { LOCKFILE_LIMITS } from '@proofissue/dependencies';

import { isSafeRegularFile, prepareProjectRoot, readProjectTextFile } from './safe-files.js';

/**
 * Hints for a command that does not start with `node`.
 *
 * A recording runs `node <arguments>` directly, with no shell, so `mocha test/a.js`,
 * `npx mocha`, and `npm test` cannot be recorded as typed. This looks up where the package's
 * executable script is in the project's own package-lock.json and says how to write the same
 * command for node. It is only a hint: the command is never rewritten or run, nothing is
 * installed, and the lockfile is only read, within the same size limit the dependency
 * validator applies.
 */

export type CommandHint =
  | {
      readonly kind: 'lockfile_bin';
      /** The package that provides the executable, such as `mocha` or `@scope/tool`. */
      readonly package_name: string;
      /** The arguments after the executable, as typed. */
      readonly rest_arguments: readonly string[];
      /** The executable script inside the package, relative to the package directory. */
      readonly script: string;
    }
  | {
      readonly kind: 'package_manager';
      readonly manager: 'npm' | 'pnpm' | 'yarn';
    };

export interface CommandHintRequest {
  /** The whole command after `--`, starting with the program as typed. */
  readonly command: readonly string[];
  readonly project_root: string;
}

const PACKAGE_MANAGERS: ReadonlySet<string> = new Set(['npm', 'pnpm', 'yarn']);

const NAME_CHARACTERS = '[A-Za-z0-9._~-]';
const TOP_LEVEL_PACKAGE = new RegExp(
  `^node_modules/((?:@${NAME_CHARACTERS}+/)?${NAME_CHARACTERS}+)$`,
  'u',
);
const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,213}$/u;

// `mocha`, `mocha.cmd`, `NPX.EXE`: the program name without a Windows launcher extension.
const programName = (value: string): string => value.toLowerCase().replace(/\.(?:cmd|exe)$/u, '');

// `mocha@10` and `@scope/tool@1.2.3` name the package without the version.
const withoutVersion = (spec: string): string => {
  const at = spec.lastIndexOf('@');
  return at > 0 ? spec.slice(0, at) : spec;
};

const unscoped = (packageName: string): string => packageName.split('/').pop() ?? packageName;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const binsOf = (packageName: string, entry: unknown): Readonly<Record<string, string>> => {
  if (!isObject(entry)) return {};
  const bin = entry.bin;
  if (typeof bin === 'string') return { [unscoped(packageName)]: bin };
  if (!isObject(bin)) return {};
  const result: Record<string, string> = {};
  for (const [name, script] of Object.entries(bin)) {
    if (typeof script === 'string') result[name] = script;
  }
  return result;
};

/**
 * Finds the package whose `bin` provides `binName` in a lockfile's `packages` object. A package
 * whose own name is the executable's name wins; otherwise the first match in sorted order.
 */
const findBin = (
  packages: Readonly<Record<string, unknown>>,
  binName: string,
  preferredPackage: string,
): { readonly package_name: string; readonly script: string } | undefined => {
  const keys = Object.keys(packages).sort();
  const matches: { package_name: string; script: string }[] = [];
  for (const key of keys) {
    const name = TOP_LEVEL_PACKAGE.exec(key)?.[1];
    if (name === undefined) continue;
    const bins = binsOf(name, packages[key]);
    const script = Object.hasOwn(bins, binName) ? bins[binName] : undefined;
    if (script !== undefined) matches.push({ package_name: name, script });
  }
  return matches.find((match) => match.package_name === preferredPackage) ?? matches[0];
};

const normalizeScript = (script: string): string => {
  let result = script;
  while (result.startsWith('./')) result = result.slice(2);
  return result;
};

/**
 * Explains a command that does not start with `node`. Returns undefined when there is nothing
 * useful to say: the command starts with `node`, the executable is not in the lockfile, or its
 * script is not a regular file in the project.
 */
export const hintForCommand = async (
  request: CommandHintRequest,
): Promise<CommandHint | undefined> => {
  const [program, ...rest] = request.command;
  if (program === undefined) return undefined;
  const name = programName(program);
  if (name === 'node') return undefined;
  if (PACKAGE_MANAGERS.has(name)) {
    return { kind: 'package_manager', manager: name as 'npm' | 'pnpm' | 'yarn' };
  }

  let spec = name === 'npx' ? undefined : program.replace(/\.(?:cmd|exe)$/iu, '');
  let restArguments = rest;
  if (name === 'npx') {
    const index = rest.findIndex((argument) => !argument.startsWith('-'));
    if (index === -1) return undefined;
    spec = rest[index];
    restArguments = rest.slice(index + 1);
  }
  if (spec === undefined) return undefined;
  const packageSpec = withoutVersion(spec);
  const binName = unscoped(packageSpec);
  if (!BIN_NAME.test(binName)) return undefined;

  try {
    const root = await prepareProjectRoot(request.project_root);
    const text = await readProjectTextFile(root, 'package-lock.json', LOCKFILE_LIMITS.bytes);
    const parsed: unknown = JSON.parse(text);
    if (!isObject(parsed) || !isObject(parsed.packages)) return undefined;
    if (Object.keys(parsed.packages).length > LOCKFILE_LIMITS.packages + 1) return undefined;
    const found = findBin(parsed.packages, binName, packageSpec);
    if (found === undefined) return undefined;
    const script = normalizeScript(found.script);
    if (!isArtifactPath(script)) return undefined;
    if (!(await isSafeRegularFile(root, `node_modules/${found.package_name}/${script}`))) {
      return undefined;
    }
    return {
      kind: 'lockfile_bin',
      package_name: found.package_name,
      rest_arguments: restArguments,
      script,
    };
  } catch {
    return undefined;
  }
};
