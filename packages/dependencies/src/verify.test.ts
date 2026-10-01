import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { offlineInstallArguments } from './install.js';
import { REGISTRY_ORIGIN } from './lockfile.js';
import { openPackageStore, type PackageStore } from './store.js';
import { entryPathFor, everythingStored } from './test-support.js';
import { verifyPrepared } from './verify.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-verify-'));
  roots.push(root);
  return root;
};

const tarballFor = (name: string, version = '1.0.0'): Buffer =>
  Buffer.from(`synthetic tarball for ${name}@${version} `.repeat(10));

const integrityOf = (content: Uint8Array): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

interface Spec {
  readonly extra?: Record<string, unknown>;
  readonly location?: string;
  readonly name: string;
  readonly version?: string;
}

const lockfileFor = (specs: readonly Spec[]): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'synthetic' },
      ...Object.fromEntries(
        specs.map((spec) => {
          const version = spec.version ?? '1.0.0';
          const base = spec.name.startsWith('@')
            ? (spec.name.split('/')[1] ?? spec.name)
            : spec.name;
          return [
            spec.location ?? `node_modules/${spec.name}`,
            {
              version,
              resolved: `${REGISTRY_ORIGIN}/${spec.name}/-/${base}-${version}.tgz`,
              integrity: integrityOf(tarballFor(spec.name, version)),
              ...spec.extra,
            },
          ];
        }),
      ),
    },
  });

async function* chunked(content: Uint8Array): AsyncGenerator<Uint8Array> {
  yield content;
  await Promise.resolve();
}

const storeWith = async (names: readonly string[]): Promise<PackageStore> => {
  const store = await openPackageStore(path.join(await workspace(), 'store'));
  for (const name of names) {
    await store.add(integrityOf(tarballFor(name)), chunked(tarballFor(name)));
  }
  return store;
};

describe('verifyPrepared', () => {
  it('is ready when every package is present, and names the cache to use', async () => {
    const store = await storeWith(['a', 'b']);

    const result = await verifyPrepared(
      lockfileFor([{ name: 'a' }, { name: 'b' }]),
      store.directory,
    );

    expect(result).toEqual({
      status: 'ready',
      cache_directory: store.directory,
      packages: 2,
      skipped_for_platform: 0,
      warnings: [],
    });
  });

  it('is ready for a lockfile with no packages', async () => {
    const store = await storeWith([]);

    expect(await verifyPrepared(lockfileFor([]), store.directory)).toMatchObject({
      status: 'ready',
      packages: 0,
    });
  });

  it('lists what is missing, by location, and says how many in all', async () => {
    const store = await storeWith(['a']);

    const result = await verifyPrepared(
      lockfileFor([{ name: 'a' }, { name: 'c' }, { name: 'b' }]),
      store.directory,
    );

    expect(result).toEqual({
      status: 'not_prepared',
      missing: [
        { name: 'b', package_path: 'node_modules/b', version: '1.0.0' },
        { name: 'c', package_path: 'node_modules/c', version: '1.0.0' },
      ],
      missing_count: 2,
    });
  });

  it('reports every place a missing tarball would be installed', async () => {
    const store = await storeWith([]);

    const result = await verifyPrepared(
      lockfileFor([{ name: 'dup' }, { name: 'dup', location: 'node_modules/x/node_modules/dup' }]),
      store.directory,
    );

    expect(result).toMatchObject({ status: 'not_prepared', missing_count: 2 });
  });

  it('reports at most fifty, but counts them all', async () => {
    const store = await storeWith([]);
    const specs = Array.from({ length: 80 }, (_, index) => ({ name: `p${String(index)}` }));

    const result = await verifyPrepared(lockfileFor(specs), store.directory);

    expect(result.status).toBe('not_prepared');
    if (result.status === 'not_prepared') {
      expect(result.missing).toHaveLength(50);
      expect(result.missing_count).toBe(80);
    }
  });

  it('treats an entry that no longer matches its hash as missing', async () => {
    const store = await storeWith(['a']);
    const file = entryPathFor(store.directory, tarballFor('a'));
    await rm(file);
    await writeFile(file, 'corrupted');

    const result = await verifyPrepared(lockfileFor([{ name: 'a' }]), store.directory);

    expect(result).toMatchObject({ status: 'not_prepared', missing_count: 1 });
  });

  it('does not require packages that do not apply to the replay platform', async () => {
    const store = await storeWith(['plain', 'linux-x64']);

    const result = await verifyPrepared(
      lockfileFor([
        { name: 'plain' },
        { name: 'linux-x64', extra: { os: ['linux'], cpu: ['x64'] } },
        { name: 'darwin-arm64', extra: { os: ['darwin'], cpu: ['arm64'] } },
        { name: 'win32-x64', extra: { os: ['win32'], cpu: ['x64'] } },
      ]),
      store.directory,
    );

    expect(result).toMatchObject({ status: 'ready', packages: 2, skipped_for_platform: 2 });
  });

  it('carries install-script warnings through', async () => {
    const store = await storeWith(['native']);

    const result = await verifyPrepared(
      lockfileFor([{ name: 'native', extra: { hasInstallScript: true } }]),
      store.directory,
    );

    expect(result).toMatchObject({
      status: 'ready',
      warnings: [{ code: 'install_script_not_run', package_path: 'node_modules/native' }],
    });
  });

  it('rejects an unusable lockfile before looking at the store', async () => {
    const result = await verifyPrepared('not json', path.join(await workspace(), 'nothing'));

    expect(result).toMatchObject({
      status: 'invalid_lockfile',
      lockfile_errors: [{ code: 'malformed_json' }],
    });
  });

  it('says the store is unusable when the directory does not exist, and creates nothing', async () => {
    const root = await workspace();

    const result = await verifyPrepared(lockfileFor([{ name: 'a' }]), path.join(root, 'nothing'));

    expect(result.status).toBe('store_unusable');
    expect(await readdir(root)).toEqual([]);
  });

  it('says the store is unusable when the directory is not a store, and adds nothing to it', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'file.txt'), 'x');

    const result = await verifyPrepared(lockfileFor([{ name: 'a' }]), root);

    expect(result.status).toBe('store_unusable');
    expect(await readdir(root)).toEqual(['file.txt']);
  });

  it('changes nothing on disk, whether the store is ready or not', async () => {
    const store = await storeWith(['a']);
    const before = await everythingStored(store.directory);
    const rootBefore = (await readdir(store.directory)).sort();

    await verifyPrepared(lockfileFor([{ name: 'a' }]), store.directory);
    await verifyPrepared(lockfileFor([{ name: 'a' }, { name: 'missing' }]), store.directory);

    expect(await everythingStored(store.directory)).toEqual(before);
    expect((await readdir(store.directory)).sort()).toEqual(rootBefore);
  });
});

describe('offlineInstallArguments', () => {
  const paths = {
    cache_directory: '/cache',
    global_config: '/tmp/npmrc-global',
    logs_directory: '/tmp/logs',
    user_config: '/tmp/npmrc-user',
  };

  it('pins the exact command, so changing it is a deliberate act', () => {
    expect(offlineInstallArguments(paths)).toEqual([
      'ci',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-progress',
      '--no-update-notifier',
      '--cache',
      '/cache',
      '--logs-dir',
      '/tmp/logs',
      '--userconfig',
      '/tmp/npmrc-user',
      '--globalconfig',
      '/tmp/npmrc-global',
    ]);
  });

  it('always forbids network access and install scripts', () => {
    const arguments_ = offlineInstallArguments(paths);

    expect(arguments_).toContain('--offline');
    expect(arguments_).toContain('--ignore-scripts');
    expect(arguments_).not.toContain('--registry');
    expect(arguments_.some((item) => item.includes('script') && item !== '--ignore-scripts')).toBe(
      false,
    );
  });
});
