export { LOCKFILE_LIMITS, REGISTRY_ORIGIN, validateNpmLockfile } from './lockfile.js';
export type {
  LockedPackage,
  LockfileError,
  LockfileErrorCode,
  LockfileValidation,
  LockfileWarning,
  PlatformRestrictions,
} from './lockfile.js';
export { createRegistryFetcher, PackageFetchError } from './fetcher.js';
export type {
  FetchOptions,
  PackageFetchErrorCode,
  PackageFetcher,
  RegistryFetcherConfig,
} from './fetcher.js';
export { appliesToPlatform, REPLAY_PLATFORM } from './platform.js';
export type { TargetPlatform } from './platform.js';
export { DEFAULT_PREPARE_LIMITS, MAX_PREPARE_CONCURRENCY, prepareDependencies } from './prepare.js';
export type {
  PrepareError,
  PrepareErrorCode,
  PrepareLimits,
  PrepareOptions,
  PrepareResult,
  PreparedPackage,
} from './prepare.js';
export { openPackageStore, StoreError } from './store.js';
export type { PackageStore, StoreErrorCode, StoredPackage } from './store.js';
