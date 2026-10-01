/**
 * Prepares the packages a lockfile names: validate it, choose the ones for the replay
 * platform, download each distinct tarball once, check it against its integrity hash, and
 * keep it in a local store. This is the one step that uses the network, and it is separate
 * from replay on purpose: replay never has a network.
 *
 * Nothing is extracted or executed here.
 */
import { createRegistryFetcher, PackageFetchError, type PackageFetcher } from './fetcher.js';
import {
  validateNpmLockfile,
  type LockedPackage,
  type LockfileError,
  type LockfileWarning,
} from './lockfile.js';
import { appliesToPlatform, REPLAY_PLATFORM, type TargetPlatform } from './platform.js';
import { StoreError, type PackageStore } from './store.js';

export type PrepareErrorCode =
  | 'cancelled'
  | 'content_encoding_refused'
  | 'http_status'
  | 'integrity_mismatch'
  | 'internal_error'
  | 'network_error'
  | 'redirect_refused'
  | 'size_limit_exceeded'
  | 'store_unsafe'
  | 'store_write_failed'
  | 'timeout'
  | 'total_size_limit_exceeded'
  | 'url_refused';

export interface PrepareError {
  readonly code: PrepareErrorCode;
  readonly message: string;
  readonly package_path?: string;
  readonly status?: number;
}

export interface PrepareLimits {
  /** Largest single tarball. */
  readonly max_package_bytes: number;
  /** Most bytes downloaded in one preparation. Entries already in the store are free. */
  readonly max_total_bytes: number;
  /** Time allowed for one download. */
  readonly request_timeout_ms: number;
  /** Time allowed for the whole preparation. */
  readonly total_timeout_ms: number;
}

export const DEFAULT_PREPARE_LIMITS: PrepareLimits = Object.freeze({
  max_package_bytes: 64 * 1024 * 1024,
  max_total_bytes: 512 * 1024 * 1024,
  request_timeout_ms: 60_000,
  total_timeout_ms: 600_000,
});

export const MAX_PREPARE_CONCURRENCY = 8;
const DEFAULT_CONCURRENCY = 4;
const MAX_REPORTED_ERRORS = 50;

export interface PrepareOptions {
  readonly concurrency?: number;
  readonly fetcher?: PackageFetcher;
  readonly limits?: Partial<PrepareLimits>;
  readonly platform?: TargetPlatform;
  readonly signal?: AbortSignal;
  readonly store: PackageStore;
}

export interface PreparedPackage {
  readonly bytes: number;
  /** Absolute path of the verified tarball in the store. */
  readonly file: string;
  readonly integrity: string;
  readonly name: string;
  readonly package_path: string;
  readonly source: 'downloaded' | 'reused';
  readonly version: string;
}

export type PrepareResult =
  | {
      readonly status: 'prepared';
      readonly downloaded: number;
      /** Sorted by `package_path`. */
      readonly packages: readonly PreparedPackage[];
      readonly reused: number;
      /** Packages whose os, cpu, or libc restrictions exclude the replay platform. */
      readonly skipped_for_platform: number;
      readonly warnings: readonly LockfileWarning[];
    }
  | { readonly status: 'invalid_lockfile'; readonly lockfile_errors: readonly LockfileError[] }
  | { readonly status: 'failed'; readonly errors: readonly PrepareError[] };

class TotalLimitExceeded extends Error {
  constructor() {
    super('The packages are larger in total than the download limit.');
    this.name = 'TotalLimitExceeded';
  }
}

const toPrepareError = (error: unknown, packagePath: string): PrepareError => {
  if (error instanceof PackageFetchError) {
    return {
      code: error.code,
      message: error.message,
      package_path: packagePath,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
  if (error instanceof StoreError) {
    return { code: error.code, message: error.message, package_path: packagePath };
  }
  if (error instanceof TotalLimitExceeded) {
    return { code: 'total_size_limit_exceeded', message: error.message, package_path: packagePath };
  }
  return {
    code: 'internal_error',
    message: 'An unexpected error stopped the preparation.',
    package_path: packagePath,
  };
};

export const prepareDependencies = async (
  lockfileText: string,
  options: PrepareOptions,
): Promise<PrepareResult> => {
  const validation = validateNpmLockfile(lockfileText);
  if (!validation.ok) return { status: 'invalid_lockfile', lockfile_errors: validation.errors };

  const limits: PrepareLimits = { ...DEFAULT_PREPARE_LIMITS, ...options.limits };
  const platform = options.platform ?? REPLAY_PLATFORM;
  const fetcher = options.fetcher ?? createRegistryFetcher();
  const concurrency = Math.min(
    MAX_PREPARE_CONCURRENCY,
    Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)),
  );

  const wanted = validation.packages.filter((item) => appliesToPlatform(item, platform));
  const skipped = validation.packages.length - wanted.length;

  // One download per distinct tarball, however many places in the tree install it.
  const byIntegrity = new Map<string, LockedPackage[]>();
  for (const item of wanted) {
    byIntegrity.set(item.integrity, [...(byIntegrity.get(item.integrity) ?? []), item]);
  }
  const queue = [...byIntegrity.values()];

  const failure = new AbortController();
  const total = AbortSignal.timeout(limits.total_timeout_ms);
  const signals = [
    failure.signal,
    total,
    ...(options.signal === undefined ? [] : [options.signal]),
  ];
  const signal = AbortSignal.any(signals);

  const errors: PrepareError[] = [];
  const stored = new Map<
    string,
    { bytes: number; file: string; source: 'downloaded' | 'reused' }
  >();
  let downloadedBytes = 0;

  const countedChunks = async function* (
    chunks: AsyncIterable<Uint8Array>,
  ): AsyncGenerator<Uint8Array> {
    for await (const chunk of chunks) {
      downloadedBytes += chunk.byteLength;
      if (downloadedBytes > limits.max_total_bytes) throw new TotalLimitExceeded();
      yield chunk;
    }
  };

  const fetchOne = async (group: readonly LockedPackage[]): Promise<void> => {
    const first = group[0];
    if (first === undefined) return;
    const reused = await options.store.lookup(first.integrity);
    if (reused !== undefined) {
      stored.set(first.integrity, { bytes: reused.bytes, file: reused.file, source: 'reused' });
      return;
    }
    const chunks = await fetcher.fetch(first.resolved, {
      max_bytes: limits.max_package_bytes,
      signal,
      timeout_ms: limits.request_timeout_ms,
    });
    const added = await options.store.add(first.integrity, countedChunks(chunks));
    stored.set(first.integrity, { bytes: added.bytes, file: added.file, source: 'downloaded' });
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) return;
      const group = queue.shift();
      if (group === undefined) return;
      try {
        await fetchOne(group);
      } catch (error: unknown) {
        // Work stopped because something else failed or the caller gave up is not itself a
        // finding; report only the first real problem and the reason for stopping.
        const consequence = failure.signal.aborted && !total.aborted;
        const packagePath = group[0]?.package_path ?? '';
        const classified = toPrepareError(error, packagePath);
        // Downloads stopped by the overall time limit report that they were cancelled; say
        // what actually happened.
        const reported: PrepareError =
          classified.code === 'cancelled' && total.aborted
            ? {
                code: 'timeout',
                message: 'Preparation took longer than its time limit.',
                package_path: packagePath,
              }
            : classified;
        if (!(consequence && reported.code === 'cancelled')) {
          if (errors.length < MAX_REPORTED_ERRORS) errors.push(reported);
        }
        failure.abort();
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

  if (errors.length === 0 && signal.aborted) {
    errors.push({
      code: total.aborted ? 'timeout' : 'cancelled',
      message: total.aborted
        ? 'Preparation took longer than its time limit.'
        : 'Preparation was cancelled.',
    });
  }
  if (errors.length > 0) {
    return {
      status: 'failed',
      errors: [...errors].sort((a, b) =>
        (a.package_path ?? '') < (b.package_path ?? '')
          ? -1
          : (a.package_path ?? '') > (b.package_path ?? '')
            ? 1
            : 0,
      ),
    };
  }

  const packages: PreparedPackage[] = wanted.map((item) => {
    const entry = stored.get(item.integrity);
    if (entry === undefined) {
      throw new Error('A prepared package has no stored entry.');
    }
    return {
      bytes: entry.bytes,
      file: entry.file,
      integrity: item.integrity,
      name: item.name,
      package_path: item.package_path,
      source: entry.source,
      version: item.version,
    };
  });
  return {
    status: 'prepared',
    downloaded: [...stored.values()].filter((entry) => entry.source === 'downloaded').length,
    packages,
    reused: [...stored.values()].filter((entry) => entry.source === 'reused').length,
    skipped_for_platform: skipped,
    warnings: validation.warnings,
  };
};
