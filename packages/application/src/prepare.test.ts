import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseAndValidateArtifact, serializeArtifact, sha256 } from '@proofissue/artifact-schema';
import {
  PackageFetchError,
  REGISTRY_ORIGIN,
  verifyPrepared,
  type FetchOptions,
  type PackageFetcher,
} from '@proofissue/dependencies';
import { storedEntries, temporaryFiles } from '@proofissue/dependencies/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { createApplicationServices, createPrepareApplicationService } from './index.js';
import type { PrepareOperationResult } from './index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-prepare-app-'));
  roots.push(root);
  return root;
};

const exists = async (target: string): Promise<boolean> =>
  await stat(target).then(
    () => true,
    () => false,
  );

const tarballFor = (name: string, version: string): Buffer =>
  Buffer.from(`synthetic tarball for ${name}@${version} `.repeat(20));

const integrityOf = (content: Uint8Array): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

interface Spec {
  readonly extra?: Record<string, unknown>;
  readonly name: string;
  readonly version?: string;
}

const urlFor = (name: string, version = '1.0.0'): string =>
  `${REGISTRY_ORIGIN}/${name}/-/${name}-${version}.tgz`;

const lockfileFor = (specs: readonly Spec[]): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'synthetic' },
      ...Object.fromEntries(
        specs.map((spec) => {
          const version = spec.version ?? '1.0.0';
          return [
            `node_modules/${spec.name}`,
            {
              version,
              resolved: urlFor(spec.name, version),
              integrity: integrityOf(tarballFor(spec.name, version)),
              ...spec.extra,
            },
          ];
        }),
      ),
    },
  });

interface FakeFetcher extends PackageFetcher {
  readonly calls: string[];
}

async function* bodyOf(content: Uint8Array): AsyncGenerator<Uint8Array> {
  await Promise.resolve();
  yield content;
}

const fakeFetcher = (
  behavior?: (url: string, options: FetchOptions) => Promise<AsyncIterable<Uint8Array>>,
): FakeFetcher => {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url, options) => {
      calls.push(url);
      if (behavior !== undefined) return await behavior(url, options);
      const match = /\/([^/]+)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/u.exec(url);
      const name = match?.[1];
      const version = match?.[2];
      if (name === undefined || version === undefined) {
        throw new PackageFetchError(
          'http_status',
          'The registry answered with an error status.',
          404,
        );
      }
      return bodyOf(tarballFor(name, version));
    },
  };
};

const artifactWithLockfile = async (lockfile: string): Promise<string> => {
  const source = await readFile('tests/fixtures/artifacts/v1/valid/with-dependencies.proofissue');
  const parsed = parseAndValidateArtifact(source);
  if (!parsed.ok) throw new Error('Compatibility fixture is not valid.');
  const root = await workspace();
  const artifactPath = path.join(root, 'artifact.proofissue');
  await writeFile(
    artifactPath,
    serializeArtifact({
      ...parsed.artifact,
      files: parsed.artifact.files.map((file) =>
        file.path === 'package-lock.json'
          ? { ...file, content: lockfile, sha256: sha256(lockfile) }
          : file,
      ),
    }),
  );
  return artifactPath;
};

const storeIn = async (): Promise<string> => path.join(await workspace(), 'store');

const prepare = async (
  artifactPath: string,
  store: string,
  fetcher: PackageFetcher = fakeFetcher(),
  extra: { signal?: AbortSignal } = {},
): Promise<PrepareOperationResult> =>
  await createPrepareApplicationService({ fetcher }).prepare({
    artifact_path: artifactPath,
    dependency_store: store,
    ...extra,
  });

describe('prepare application service', () => {
  it('reports not_required and creates no store for an artifact without dependency files', async () => {
    const store = await storeIn();
    const fetcher = fakeFetcher();

    const result = await prepare(
      'tests/fixtures/artifacts/v1/valid/minimal.proofissue',
      store,
      fetcher,
    );

    expect(result).toMatchObject({
      operation: 'prepare',
      result_schema_version: 1,
      status: 'not_required',
      artifact_version: 1,
      errors: [],
      warnings: [],
    });
    expect(result.artifact_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result).not.toHaveProperty('preparation');
    expect(fetcher.calls).toEqual([]);
    expect(await exists(store)).toBe(false);
  });

  it('rejects an invalid artifact before touching the store or the network', async () => {
    const store = await storeIn();
    const fetcher = fakeFetcher();

    const result = await prepare(
      'tests/fixtures/artifacts/v1/invalid/unknown-field.proofissue',
      store,
      fetcher,
    );

    expect(result.status).toBe('invalid_artifact');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(fetcher.calls).toEqual([]);
    expect(await exists(store)).toBe(false);
  });

  it('rejects an unusable lockfile with lockfile_rejected errors before creating the store', async () => {
    const store = await storeIn();
    const fetcher = fakeFetcher();
    const artifactPath = await artifactWithLockfile('{"lockfileVersion":2,"packages":{}}');

    const result = await prepare(artifactPath, store, fetcher);

    expect(result.status).toBe('invalid_artifact');
    expect(result.errors[0]).toMatchObject({
      code: 'lockfile_rejected',
      details: { reason: 'unsupported_lockfile_version' },
    });
    expect(fetcher.calls).toEqual([]);
    expect(await exists(store)).toBe(false);
  });

  it('rejects an empty store path as invalid_input', async () => {
    for (const blank of ['', '   ']) {
      const result = await prepare(
        'tests/fixtures/artifacts/v1/valid/with-dependencies.proofissue',
        blank,
      );

      expect(result.status).toBe('invalid_input');
      expect(result.errors).toEqual([
        { code: 'malformed_input', message: 'A dependency store directory is required.' },
      ]);
    }
  });

  it('downloads, verifies, and summarizes the locked packages', async () => {
    const store = await storeIn();
    const fetcher = fakeFetcher();
    const artifactPath = await artifactWithLockfile(
      lockfileFor([
        { name: 'alpha' },
        { name: 'beta', version: '2.0.0' },
        { name: 'mac-only', extra: { os: ['darwin'] } },
      ]),
    );

    const result = await prepare(artifactPath, store, fetcher);

    expect(result.status).toBe('prepared');
    expect(result.errors).toEqual([]);
    expect(result.preparation).toEqual({
      packages: 2,
      downloaded_tarballs: 2,
      downloaded_bytes: tarballFor('alpha', '1.0.0').length + tarballFor('beta', '2.0.0').length,
      reused_tarballs: 0,
      skipped_for_platform: 1,
      install_script_packages: 0,
    });
    expect(fetcher.calls).toHaveLength(2);
    expect(await storedEntries(store)).toHaveLength(2);
    expect(await temporaryFiles(store)).toEqual([]);
  });

  it('reuses verified packages on a second run without fetching', async () => {
    const store = await storeIn();
    const artifactPath = await artifactWithLockfile(lockfileFor([{ name: 'alpha' }]));
    await prepare(artifactPath, store);
    const second = fakeFetcher();

    const result = await prepare(artifactPath, store, second);

    expect(result.status).toBe('prepared');
    expect(result.preparation).toMatchObject({
      downloaded_tarballs: 0,
      downloaded_bytes: 0,
      reused_tarballs: 1,
      packages: 1,
    });
    expect(second.calls).toEqual([]);
  });

  it('reports a hash mismatch as dependency_download_failed and keeps nothing', async () => {
    const store = await storeIn();
    const artifactPath = await artifactWithLockfile(lockfileFor([{ name: 'alpha' }]));
    const tampering = fakeFetcher(() => Promise.resolve(bodyOf(Buffer.from('tampered content'))));

    const result = await prepare(artifactPath, store, tampering);

    expect(result.status).toBe('execution_failed');
    expect(result.errors[0]).toMatchObject({
      code: 'dependency_download_failed',
      details: { reason: 'integrity_mismatch', package_path: 'node_modules/alpha' },
    });
    expect(await storedEntries(store)).toEqual([]);
    expect(await temporaryFiles(store)).toEqual([]);
  });

  it('reports an HTTP failure with its status and location but no response body', async () => {
    const store = await storeIn();
    const artifactPath = await artifactWithLockfile(lockfileFor([{ name: 'alpha' }]));
    const failing = fakeFetcher(() =>
      Promise.reject(
        new PackageFetchError('http_status', 'The registry answered with an error status.', 404),
      ),
    );

    const result = await prepare(artifactPath, store, failing);

    expect(result.status).toBe('execution_failed');
    expect(result.errors).toEqual([
      {
        code: 'dependency_download_failed',
        message: 'The registry answered with an error status.',
        details: { reason: 'http_status', package_path: 'node_modules/alpha', http_status: 404 },
      },
    ]);
  });

  it('reports an unusable store location as dependency_store_unusable', async () => {
    const root = await workspace();
    const store = path.join(root, 'not-a-directory');
    await writeFile(store, 'a regular file');
    const artifactPath = await artifactWithLockfile(lockfileFor([{ name: 'alpha' }]));
    const fetcher = fakeFetcher();

    const result = await prepare(artifactPath, store, fetcher);

    expect(result.status).toBe('execution_failed');
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ code: 'dependency_store_unusable' });
    expect(fetcher.calls).toEqual([]);
  });

  it('reports cancellation as execution_failed', async () => {
    const store = await storeIn();
    const artifactPath = await artifactWithLockfile(lockfileFor([{ name: 'alpha' }]));
    const controller = new AbortController();
    controller.abort();

    const result = await prepare(artifactPath, store, fakeFetcher(), { signal: controller.signal });

    expect(result.status).toBe('execution_failed');
    expect(result.errors[0]).toMatchObject({ details: { reason: 'cancelled' } });
  });

  it('aggregates install-script warnings into one warning without package names', async () => {
    const store = await storeIn();
    const artifactPath = await artifactWithLockfile(
      lockfileFor([
        { name: 'alpha', extra: { hasInstallScript: true } },
        { name: 'beta', extra: { hasInstallScript: true } },
        { name: 'gamma' },
      ]),
    );

    const result = await prepare(artifactPath, store);

    expect(result.status).toBe('prepared');
    expect(result.preparation?.install_script_packages).toBe(2);
    expect(result.warnings).toEqual([
      {
        code: 'install_scripts_not_run',
        message: '2 packages declare install scripts, which are never run.',
      },
    ]);
  });

  it('never includes package names, tarball paths, or the store path in the result', async () => {
    const store = await storeIn();
    const artifactPath = await artifactWithLockfile(
      lockfileFor([{ name: 'secret-package-name', extra: { hasInstallScript: true } }]),
    );

    const result = await prepare(artifactPath, store);
    const encoded = JSON.stringify(result);

    expect(result.status).toBe('prepared');
    expect(encoded).not.toContain('secret-package-name');
    expect(encoded).not.toContain('_cacache');
    expect(encoded).not.toContain(store);
    expect(encoded).not.toContain(path.basename(path.dirname(store)));
    expect(encoded).not.toContain('.tgz');
  });

  it("prepares a store that replay's verifyPrepared accepts", async () => {
    const store = await storeIn();
    const lockfile = lockfileFor([{ name: 'alpha' }, { name: 'beta' }]);
    const artifactPath = await artifactWithLockfile(lockfile);

    const result = await prepare(artifactPath, store);

    expect(result.status).toBe('prepared');
    expect(await verifyPrepared(lockfile, store)).toMatchObject({ status: 'ready' });
  });

  it('prepares the zero-package fixture with the default fetcher and no request', async () => {
    const store = await storeIn();

    const result = await createPrepareApplicationService().prepare({
      artifact_path: 'tests/fixtures/artifacts/v1/valid/with-dependencies.proofissue',
      dependency_store: store,
    });

    expect(result.status).toBe('prepared');
    expect(result.preparation).toEqual({
      packages: 0,
      downloaded_tarballs: 0,
      downloaded_bytes: 0,
      reused_tarballs: 0,
      skipped_for_platform: 0,
      install_script_packages: 0,
    });
  });

  it('is exposed by the combined application services', () => {
    const services = createApplicationServices(() =>
      Promise.resolve({
        reproduction_files_confirmed: false,
        subject_files_confirmed: false,
        write_confirmed: false,
      }),
    );

    expect(typeof services.prepare).toBe('function');
  });
});
