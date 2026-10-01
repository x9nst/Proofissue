/**
 * Checks, without changing anything, that everything a lockfile needs is in a prepared
 * store and still matches its hashes. Replay uses this right before it mounts the store, so
 * a missing or damaged package is reported plainly and early, and the container never starts
 * for a store that cannot satisfy the install.
 *
 * It reads only. It never contacts the registry and never creates or repairs anything.
 */
import {
  validateNpmLockfile,
  type LockedPackage,
  type LockfileError,
  type LockfileWarning,
} from './lockfile.js';
import { appliesToPlatform, REPLAY_PLATFORM, type TargetPlatform } from './platform.js';
import { openExistingPackageStore, StoreError } from './store.js';

export interface MissingPackage {
  readonly name: string;
  readonly package_path: string;
  readonly version: string;
}

export type VerifyPreparedResult =
  | {
      readonly status: 'ready';
      /** The directory to give npm as its cache. */
      readonly cache_directory: string;
      readonly packages: number;
      readonly skipped_for_platform: number;
      readonly warnings: readonly LockfileWarning[];
    }
  | { readonly status: 'invalid_lockfile'; readonly lockfile_errors: readonly LockfileError[] }
  | {
      readonly status: 'not_prepared';
      /** At most 50, sorted by location. */
      readonly missing: readonly MissingPackage[];
      readonly missing_count: number;
    }
  | { readonly status: 'store_unusable'; readonly message: string };

const MAX_REPORTED = 50;

export const verifyPrepared = async (
  lockfileText: string,
  storeDirectory: string,
  platform: TargetPlatform = REPLAY_PLATFORM,
): Promise<VerifyPreparedResult> => {
  const validation = validateNpmLockfile(lockfileText);
  if (!validation.ok) return { status: 'invalid_lockfile', lockfile_errors: validation.errors };

  const wanted = validation.packages.filter((item) => appliesToPlatform(item, platform));

  let store;
  try {
    store = await openExistingPackageStore(storeDirectory);
  } catch (error: unknown) {
    return {
      status: 'store_unusable',
      message: error instanceof StoreError ? error.message : 'The store could not be opened.',
    };
  }

  const absent: LockedPackage[] = [];
  const checked = new Set<string>();
  for (const item of wanted) {
    if (checked.has(item.integrity)) continue;
    checked.add(item.integrity);
    if ((await store.lookup(item.integrity)) === undefined) absent.push(item);
  }
  if (absent.length > 0) {
    // Report every place the missing tarballs would be installed.
    const absentIntegrity = new Set(absent.map((item) => item.integrity));
    const places = wanted.filter((item) => absentIntegrity.has(item.integrity));
    return {
      status: 'not_prepared',
      missing: places.slice(0, MAX_REPORTED).map((item) => ({
        name: item.name,
        package_path: item.package_path,
        version: item.version,
      })),
      missing_count: places.length,
    };
  }
  return {
    status: 'ready',
    cache_directory: store.directory,
    packages: wanted.length,
    skipped_for_platform: validation.packages.length - wanted.length,
    warnings: validation.warnings,
  };
};
