import { readArtifactFile } from '@proofissue/artifact-schema';
import type {
  DependencyPreparationSummary,
  PrepareOperationResult,
  ProofIssueError,
  ProofIssueWarning,
} from '@proofissue/contracts';
import {
  openPackageStore,
  prepareDependencies,
  StoreError,
  validateNpmLockfile,
} from '@proofissue/dependencies';
import type {
  LockfileError,
  PackageFetcher,
  PrepareError,
  PrepareLimits,
  PreparedPackage,
} from '@proofissue/dependencies';

import { toProofIssueError } from './artifact-errors.js';

export interface PrepareApplicationRequest {
  readonly artifact_path: string;
  /** Where the verified packages are kept. Always explicit; never taken from the artifact. */
  readonly dependency_store: string;
  readonly signal?: AbortSignal;
}

export interface PrepareApplicationService {
  prepare(request: PrepareApplicationRequest): Promise<PrepareOperationResult>;
}

export interface PrepareApplicationDependencies {
  /** Defaults to the public npm registry fetcher. Tests inject a fake; nothing else should. */
  readonly fetcher?: PackageFetcher;
  readonly limits?: Partial<PrepareLimits>;
}

const MAX_LOCATION_CHARACTERS = 200;

const base = (): Pick<
  PrepareOperationResult,
  'errors' | 'operation' | 'result_schema_version' | 'warnings'
> => ({
  result_schema_version: 1,
  operation: 'prepare',
  warnings: [],
  errors: [],
});

const truncate = (value: string): string =>
  value.length > MAX_LOCATION_CHARACTERS ? value.slice(0, MAX_LOCATION_CHARACTERS) : value;

const lockfileRejection = (error: LockfileError): ProofIssueError => ({
  code: 'lockfile_rejected',
  message: error.message,
  details: {
    reason: error.code,
    ...(error.package_path === undefined ? {} : { package_path: truncate(error.package_path) }),
  },
});

const toPrepareFailure = (error: PrepareError): ProofIssueError => ({
  code:
    error.code === 'store_unsafe' || error.code === 'store_write_failed'
      ? 'dependency_store_unusable'
      : error.code === 'internal_error'
        ? 'internal_error'
        : 'dependency_download_failed',
  message: error.message,
  details: {
    reason: error.code,
    ...(error.package_path === undefined ? {} : { package_path: truncate(error.package_path) }),
    ...(error.status === undefined ? {} : { http_status: error.status }),
  },
});

const downloadedBytes = (packages: readonly PreparedPackage[]): number => {
  const seen = new Map<string, number>();
  for (const item of packages) {
    if (item.source === 'downloaded') seen.set(item.integrity, item.bytes);
  }
  let total = 0;
  for (const bytes of seen.values()) total += bytes;
  return total;
};

const installScriptWarning = (count: number): ProofIssueWarning[] =>
  count === 0
    ? []
    : [
        {
          code: 'install_scripts_not_run',
          message:
            count === 1
              ? '1 package declares install scripts, which are never run.'
              : `${String(count)} packages declare install scripts, which are never run.`,
        },
      ];

/**
 * Creates the prepare use case: download and verify the packages an artifact's lockfile names,
 * for a later offline replay.
 *
 * The order is the security property. Nothing is fetched and the store is not touched until the
 * artifact and its lockfile have both been validated.
 */
export const createPrepareApplicationService = (
  dependencies: PrepareApplicationDependencies = {},
): PrepareApplicationService => ({
  prepare: async (request): Promise<PrepareOperationResult> => {
    if (request.dependency_store.trim() === '') {
      return {
        ...base(),
        status: 'invalid_input',
        errors: [{ code: 'malformed_input', message: 'A dependency store directory is required.' }],
      };
    }

    try {
      const parsed = await readArtifactFile(request.artifact_path);
      if (!parsed.ok) {
        return {
          ...base(),
          status: 'invalid_artifact',
          errors: parsed.errors.map(toProofIssueError),
        };
      }
      const artifact = parsed.artifact;
      const identity = { artifact_version: 1 as const, artifact_digest: artifact.digest };

      const lockfile = artifact.files.find(
        (file) => file.role === 'dependency' && file.path === 'package-lock.json',
      );
      if (lockfile === undefined) {
        return { ...base(), ...identity, status: 'not_required' };
      }

      const validation = validateNpmLockfile(lockfile.content);
      if (!validation.ok) {
        return {
          ...base(),
          ...identity,
          status: 'invalid_artifact',
          errors: validation.errors.map(lockfileRejection),
        };
      }

      let store;
      try {
        store = await openPackageStore(request.dependency_store);
      } catch (error: unknown) {
        if (error instanceof StoreError) {
          return {
            ...base(),
            ...identity,
            status: 'execution_failed',
            errors: [
              {
                code: 'dependency_store_unusable',
                message: error.message,
                details: { reason: error.code },
              },
            ],
          };
        }
        throw error;
      }

      const result = await prepareDependencies(lockfile.content, {
        store,
        ...(dependencies.fetcher === undefined ? {} : { fetcher: dependencies.fetcher }),
        ...(dependencies.limits === undefined ? {} : { limits: dependencies.limits }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });

      if (result.status === 'invalid_lockfile') {
        return {
          ...base(),
          ...identity,
          status: 'invalid_artifact',
          errors: result.lockfile_errors.map(lockfileRejection),
        };
      }
      if (result.status === 'failed') {
        return {
          ...base(),
          ...identity,
          status: 'execution_failed',
          errors: result.errors.map(toPrepareFailure),
        };
      }

      // The only warning the lockfile validator raises is install_script_not_run.
      const installScripts = result.warnings.length;
      const preparation: DependencyPreparationSummary = {
        packages: result.packages.length,
        downloaded_tarballs: result.downloaded,
        downloaded_bytes: downloadedBytes(result.packages),
        reused_tarballs: result.reused,
        skipped_for_platform: result.skipped_for_platform,
        install_script_packages: installScripts,
      };
      return {
        ...base(),
        ...identity,
        status: 'prepared',
        warnings: installScriptWarning(installScripts),
        preparation,
      };
    } catch {
      return {
        ...base(),
        status: 'execution_failed',
        errors: [{ code: 'internal_error', message: 'Preparation could not be completed safely.' }],
      };
    }
  },
});
