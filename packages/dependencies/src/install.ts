/**
 * The one definition of how packages are installed from a prepared store.
 *
 * Replay runs this inside the sandbox with no network, and the tests run the same arguments
 * on the host, so the two cannot drift apart. Every flag has a reason:
 *
 * - `ci` installs exactly what the lockfile says, and fails if `package.json` disagrees.
 * - `--offline` makes npm read only its cache and never contact a registry.
 * - `--ignore-scripts` is the control that stops a package running code at install time.
 *   Without it a package's postinstall script runs; a test proves that.
 * - `--cache` is the prepared store, laid out as npm's own cache.
 * - `--logs-dir` and `--no-update-notifier` stop npm writing into that cache, so it can be
 *   mounted read-only. A test checks that nothing in the store changes.
 * - `--userconfig` and `--globalconfig` stop any `.npmrc` on the machine from changing
 *   behavior, for example by naming a registry or enabling scripts.
 * - `--no-audit`, `--no-fund`, and `--no-progress` keep npm from reaching for the network or
 *   producing noise.
 */
export interface OfflineInstallPaths {
  /** The prepared store. May be read-only. */
  readonly cache_directory: string;
  /**
   * An empty file: no machine-wide npm configuration is read. It must not be the same path
   * as `user_config`, because npm refuses to load one file as both and will not start.
   */
  readonly global_config: string;
  /** A writable directory for npm's debug logs. */
  readonly logs_directory: string;
  /** An empty file: no per-user npm configuration is read. Distinct from `global_config`. */
  readonly user_config: string;
}

export const offlineInstallArguments = (paths: OfflineInstallPaths): readonly string[] => [
  'ci',
  '--offline',
  '--ignore-scripts',
  '--no-audit',
  '--no-fund',
  '--no-progress',
  '--no-update-notifier',
  '--cache',
  paths.cache_directory,
  '--logs-dir',
  paths.logs_directory,
  '--userconfig',
  paths.user_config,
  '--globalconfig',
  paths.global_config,
];
