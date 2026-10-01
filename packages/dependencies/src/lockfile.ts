/**
 * Validation of an npm lockfile before anything is fetched from it.
 *
 * A lockfile inside an artifact is attacker-controlled. This module decides, as a pure
 * function with no I/O, which packages a later preparation step may download. Everything
 * not explicitly accepted is rejected: only lockfile version 3, only tarballs on the public
 * registry at exactly the address the package's name and version imply, only SHA-512
 * integrity hashes, and only install locations beneath `node_modules`.
 *
 * See docs/decisions/0002-dependency-strategy.md and docs/dependencies.md.
 */

import { hasDuplicateJsonKeys } from './duplicate-keys.js';

export const REGISTRY_ORIGIN = 'https://registry.npmjs.org';

export const LOCKFILE_LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  packages: 2000,
} as const);

export type LockfileErrorCode =
  | 'duplicate_key'
  | 'inconsistent_entry'
  | 'invalid_structure'
  | 'malformed_json'
  | 'missing_integrity'
  | 'too_large'
  | 'too_many_packages'
  | 'unsafe_package_path'
  | 'unsupported_entry'
  | 'unsupported_lockfile_version'
  | 'unsupported_source'
  | 'weak_integrity';

export interface LockfileError {
  readonly code: LockfileErrorCode;
  readonly message: string;
  /** The `packages` key the problem belongs to, when it belongs to one. */
  readonly package_path?: string;
}

export interface LockfileWarning {
  readonly code: 'install_script_not_run';
  readonly message: string;
  readonly package_path: string;
}

export interface LockedPackage {
  readonly has_install_script: boolean;
  /** `sha512-` followed by 88 base64 characters. */
  readonly integrity: string;
  readonly name: string;
  /** The lockfile key, for example `node_modules/a/node_modules/b`. */
  readonly package_path: string;
  readonly resolved: string;
  readonly version: string;
}

export type LockfileValidation =
  | {
      readonly ok: true;
      /** Sorted by `package_path` so the result does not depend on key order. */
      readonly packages: readonly LockedPackage[];
      readonly warnings: readonly LockfileWarning[];
    }
  | { readonly ok: false; readonly errors: readonly LockfileError[] };

const MAX_ERRORS = 50;

// Letters, digits, and the punctuation the registry allows, beginning with a letter or
// digit. Legacy upper-case names such as JSONStream are real and common.
const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,213}$/u;
const NODE_MODULES = 'node_modules/';
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;

type JsonObject = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPackageName = (value: string): boolean => {
  if (value.startsWith('@')) {
    const parts = value.split('/');
    const [scope, name, ...rest] = parts;
    return (
      rest.length === 0 &&
      scope !== undefined &&
      name !== undefined &&
      NAME_SEGMENT.test(scope.slice(1)) &&
      NAME_SEGMENT.test(name)
    );
  }
  return NAME_SEGMENT.test(value);
};

/**
 * Splits `node_modules/a/node_modules/@s/b` into its package names, or returns undefined
 * if the key is not exactly a chain of `node_modules/<name>` steps with valid names.
 */
const packageNamesOf = (key: string): readonly string[] | undefined => {
  const names: string[] = [];
  let rest = key;
  while (rest.length > 0) {
    if (!rest.startsWith(NODE_MODULES)) return undefined;
    rest = rest.slice(NODE_MODULES.length);
    const next = rest.indexOf(`/${NODE_MODULES}`);
    const name = next === -1 ? rest : rest.slice(0, next);
    if (!isPackageName(name)) return undefined;
    names.push(name);
    rest = next === -1 ? '' : rest.slice(next + 1);
  }
  return names;
};

const expectedTarball = (name: string, version: string): string => {
  const base = name.startsWith('@') ? (name.split('/')[1] ?? name) : name;
  return `${REGISTRY_ORIGIN}/${name}/-/${base}-${version}.tgz`;
};

export const validateNpmLockfile = (text: string): LockfileValidation => {
  const errors: LockfileError[] = [];
  const fail = (error: LockfileError): void => {
    if (errors.length < MAX_ERRORS) errors.push(error);
  };

  if (Buffer.byteLength(text, 'utf8') > LOCKFILE_LIMITS.bytes) {
    return {
      ok: false,
      errors: [{ code: 'too_large', message: 'The lockfile exceeds the 1 MiB limit.' }],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      errors: [{ code: 'malformed_json', message: 'The lockfile is not valid JSON.' }],
    };
  }
  if (hasDuplicateJsonKeys(text)) {
    return {
      ok: false,
      errors: [
        {
          code: 'duplicate_key',
          message: 'The lockfile repeats a key; duplicate keys are not accepted.',
        },
      ],
    };
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      errors: [{ code: 'invalid_structure', message: 'The lockfile must be a JSON object.' }],
    };
  }
  if (parsed.lockfileVersion !== 3) {
    return {
      ok: false,
      errors: [
        {
          code: 'unsupported_lockfile_version',
          message: 'Only npm lockfile version 3 is supported.',
        },
      ],
    };
  }
  const entries = parsed.packages;
  if (!isObject(entries)) {
    return {
      ok: false,
      errors: [
        { code: 'invalid_structure', message: 'The lockfile must contain a packages object.' },
      ],
    };
  }

  const keys = Object.keys(entries);
  if (keys.length > LOCKFILE_LIMITS.packages + 1) {
    return {
      ok: false,
      errors: [
        {
          code: 'too_many_packages',
          message: `The lockfile lists more than ${String(LOCKFILE_LIMITS.packages)} packages.`,
        },
      ],
    };
  }

  const packages: LockedPackage[] = [];
  const warnings: LockfileWarning[] = [];

  for (const key of keys.sort()) {
    // The empty key is the project itself. It is not fetched and carries no source.
    if (key === '') continue;
    const names = packageNamesOf(key);
    if (names === undefined) {
      fail({
        code: 'unsafe_package_path',
        message: 'A package location is not a node_modules path with valid package names.',
        package_path: key.slice(0, 200),
      });
      continue;
    }
    const entry = entries[key];
    if (!isObject(entry)) {
      fail({
        code: 'invalid_structure',
        message: 'A package entry must be an object.',
        package_path: key,
      });
      continue;
    }
    if (entry.link === true || entry.inBundle === true) {
      fail({
        code: 'unsupported_entry',
        message: 'Linked and bundled packages cannot be fetched and are not supported.',
        package_path: key,
      });
      continue;
    }

    const alias = entry.name;
    if (alias !== undefined && (typeof alias !== 'string' || !isPackageName(alias))) {
      fail({
        code: 'invalid_structure',
        message: 'A package alias is not a valid package name.',
        package_path: key,
      });
      continue;
    }
    const name = alias ?? names[names.length - 1];
    const version = entry.version;
    if (name === undefined || typeof version !== 'string' || !VERSION.test(version)) {
      fail({
        code: 'invalid_structure',
        message: 'A package entry needs a plain semantic version without build metadata.',
        package_path: key,
      });
      continue;
    }

    const resolved = entry.resolved;
    if (typeof resolved !== 'string') {
      fail({
        code: 'unsupported_source',
        message: 'A package entry has no registry tarball address.',
        package_path: key,
      });
      continue;
    }
    if (resolved !== expectedTarball(name, version)) {
      fail({
        code: resolved.startsWith(`${REGISTRY_ORIGIN}/`)
          ? 'inconsistent_entry'
          : 'unsupported_source',
        message: resolved.startsWith(`${REGISTRY_ORIGIN}/`)
          ? 'A tarball address does not match its package name and version.'
          : 'Only tarballs on the public npm registry are supported.',
        package_path: key,
      });
      continue;
    }

    const integrity = entry.integrity;
    if (typeof integrity !== 'string') {
      fail({
        code: 'missing_integrity',
        message: 'A package entry has no integrity hash.',
        package_path: key,
      });
      continue;
    }
    if (!INTEGRITY.test(integrity)) {
      fail({
        code: 'weak_integrity',
        message: 'Each package needs exactly one well-formed SHA-512 integrity hash.',
        package_path: key,
      });
      continue;
    }

    const hasInstallScript = entry.hasInstallScript === true;
    if (hasInstallScript) {
      warnings.push({
        code: 'install_script_not_run',
        message: 'This package declares install scripts, which are never run.',
        package_path: key,
      });
    }
    packages.push({
      has_install_script: hasInstallScript,
      integrity,
      name,
      package_path: key,
      resolved,
      version,
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, packages, warnings };
};
