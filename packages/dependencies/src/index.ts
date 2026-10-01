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
export { openExistingPackageStore, openPackageStore, StoreError } from './store.js';
export type { PackageStore, ReadablePackageStore, StoreErrorCode, StoredPackage } from './store.js';
export { verifyPrepared } from './verify.js';
export type { MissingPackage, VerifyPreparedResult } from './verify.js';
export { offlineInstallArguments } from './install.js';
export type { OfflineInstallPaths } from './install.js';
