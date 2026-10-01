import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRegistryFetcher,
  PackageFetchError,
  type FetchOptions,
  type PackageFetcher,
} from './fetcher.js';
import { REGISTRY_ORIGIN } from './lockfile.js';
import { prepareDependencies, type PrepareResult } from './prepare.js';
import { openPackageStore, type PackageStore } from './store.js';

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(async (server) => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    }),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const freshStore = async (): Promise<PackageStore> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-prepare-'));
  roots.push(root);
  return await openPackageStore(path.join(root, 'store'));
};

const tarballFor = (name: string, version: string): Buffer =>
  Buffer.from(`synthetic tarball for ${name}@${version} `.repeat(20));

const integrityOf = (content: Uint8Array): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

interface Spec {
  readonly extra?: Record<string, unknown>;
  readonly location?: string;
  readonly name: string;
  readonly version?: string;
}

const entryFor = (spec: Spec): [string, Record<string, unknown>] => {
  const version = spec.version ?? '1.0.0';
  const base = spec.name.startsWith('@') ? (spec.name.split('/')[1] ?? spec.name) : spec.name;
  return [
    spec.location ?? `node_modules/${spec.name}`,
    {
      version,
      resolved: `${REGISTRY_ORIGIN}/${spec.name}/-/${base}-${version}.tgz`,
      integrity: integrityOf(tarballFor(spec.name, version)),
      ...spec.extra,
    },
  ];
};

const lockfileFor = (specs: readonly Spec[]): string =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { '': { name: 'synthetic' }, ...Object.fromEntries(specs.map(entryFor)) },
  });

const urlFor = (name: string, version = '1.0.0'): string => {
  const base = name.startsWith('@') ? (name.split('/')[1] ?? name) : name;
  return `${REGISTRY_ORIGIN}/${name}/-/${base}-${version}.tgz`;
};

async function* chunked(content: Uint8Array, size = 97): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < content.byteLength; offset += size) {
    yield content.subarray(offset, offset + size);
    await Promise.resolve();
  }
}

interface FakeFetcher extends PackageFetcher {
  readonly calls: string[];
  readonly peak: () => number;
}

const fakeFetcher = (
  behavior?: (url: string, options: FetchOptions) => Promise<AsyncIterable<Uint8Array>> | undefined,
  bodies: Readonly<Record<string, Buffer>> = {},
): FakeFetcher => {
  const calls: string[] = [];
  let active = 0;
  let peak = 0;
  return {
    calls,
    peak: () => peak,
    fetch: async (url, options) => {
      calls.push(url);
      active += 1;
      peak = Math.max(peak, active);
      try {
        const custom = behavior?.(url, options);
        if (custom !== undefined) return await custom;
        const match = /\/(@?[^/]+(?:\/[^/]+)?)\/-\/[^/]+-(\d+\.\d+\.\d+)\.tgz$/u.exec(
          url.slice(REGISTRY_ORIGIN.length),
        );
        const name = match?.[1];
        const version = match?.[2];
        const body =
          bodies[url] ??
          (name === undefined || version === undefined ? undefined : tarballFor(name, version));
        if (body === undefined) throw new PackageFetchError('http_status', 'not found', 404);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 5);
        });
        return chunked(body);
      } finally {
        active -= 1;
      }
    },
  };
};

const failed = (result: PrepareResult) => {
  if (result.status !== 'failed') throw new Error(`Expected failure, got ${result.status}.`);
  return result.errors;
};

const prepared = (result: PrepareResult) => {
  if (result.status !== 'prepared') {
    throw new Error(`Expected success, got ${JSON.stringify(result)}.`);
  }
  return result;
};

describe('prepareDependencies', () => {
  it('downloads, verifies, and stores every package, sorted by location', async () => {
    const store = await freshStore();
    const fetcher = fakeFetcher();

    const result = prepared(
      await prepareDependencies(
        lockfileFor([{ name: 'b' }, { name: '@scope/pkg', version: '2.0.0' }, { name: 'a' }]),
        { fetcher, store },
      ),
    );

    expect(result.packages.map((item) => item.package_path)).toEqual([
      'node_modules/@scope/pkg',
      'node_modules/a',
      'node_modules/b',
    ]);
    expect(result.downloaded).toBe(3);
    expect(result.reused).toBe(0);
    expect(result.skipped_for_platform).toBe(0);
    for (const item of result.packages) {
      expect(item.source).toBe('downloaded');
      expect((await readFile(item.file)).equals(tarballFor(item.name, item.version))).toBe(true);
      expect(item.file.startsWith(store.directory)).toBe(true);
    }
  });

  it('prepares an empty lockfile without any download', async () => {
    const fetcher = fakeFetcher();

    const result = prepared(
      await prepareDependencies(lockfileFor([]), { fetcher, store: await freshStore() }),
    );

    expect(result).toMatchObject({ downloaded: 0, packages: [], reused: 0 });
    expect(fetcher.calls).toEqual([]);
  });

  it('downloads only the packages that apply to the replay platform', async () => {
    const fetcher = fakeFetcher();

    const result = prepared(
      await prepareDependencies(
        lockfileFor([
          { name: 'plain' },
          { name: 'esbuild-linux-x64', extra: { os: ['linux'], cpu: ['x64'] } },
          { name: 'esbuild-linux-arm64', extra: { os: ['linux'], cpu: ['arm64'] } },
          { name: 'esbuild-darwin-x64', extra: { os: ['darwin'], cpu: ['x64'] } },
          { name: 'esbuild-win32-x64', extra: { os: ['win32'], cpu: ['x64'] } },
          { name: 'rollup-linux-musl', extra: { os: ['linux'], libc: ['musl'] } },
          { name: 'fsevents', extra: { os: ['darwin'], hasInstallScript: true } },
        ]),
        { fetcher, store: await freshStore() },
      ),
    );

    expect(fetcher.calls.map((url) => url.split('/')[3]).sort()).toEqual([
      'esbuild-linux-x64',
      'plain',
    ]);
    expect(result.skipped_for_platform).toBe(5);
    expect(result.packages.map((item) => item.name).sort()).toEqual(['esbuild-linux-x64', 'plain']);
  });

  it('downloads one tarball once however many places install it', async () => {
    const fetcher = fakeFetcher();

    const result = prepared(
      await prepareDependencies(
        lockfileFor([
          { name: 'dup' },
          { name: 'dup', location: 'node_modules/a/node_modules/dup' },
          { name: 'dup', location: 'node_modules/b/node_modules/dup' },
        ]),
        { fetcher, store: await freshStore() },
      ),
    );

    expect(fetcher.calls).toHaveLength(1);
    expect(result.packages).toHaveLength(3);
    expect(new Set(result.packages.map((item) => item.file)).size).toBe(1);
    expect(result.downloaded).toBe(1);
  });

  it('reuses what is already stored and downloads nothing the second time', async () => {
    const store = await freshStore();
    const text = lockfileFor([{ name: 'a' }, { name: 'b' }]);
    await prepareDependencies(text, { fetcher: fakeFetcher(), store });
    const second = fakeFetcher();

    const result = prepared(await prepareDependencies(text, { fetcher: second, store }));

    expect(second.calls).toEqual([]);
    expect(result).toMatchObject({ downloaded: 0, reused: 2 });
    expect(result.packages.every((item) => item.source === 'reused')).toBe(true);
  });

  it('downloads again when a stored entry no longer matches its hash', async () => {
    const store = await freshStore();
    const text = lockfileFor([{ name: 'a' }]);
    const first = prepared(await prepareDependencies(text, { fetcher: fakeFetcher(), store }));
    const file = first.packages[0]?.file ?? '';
    await rm(file);
    await (await import('node:fs/promises')).writeFile(file, 'corrupted');
    const second = fakeFetcher();

    const result = prepared(await prepareDependencies(text, { fetcher: second, store }));

    expect(second.calls).toHaveLength(1);
    expect(result.downloaded).toBe(1);
    expect((await readFile(file)).equals(tarballFor('a', '1.0.0'))).toBe(true);
  });

  it('is deterministic: the same inputs give the same result', async () => {
    const text = lockfileFor([{ name: 'c' }, { name: 'a' }, { name: 'b' }]);
    const results: PrepareResult[] = [];
    for (let run = 0; run < 3; run += 1) {
      results.push(
        await prepareDependencies(text, { fetcher: fakeFetcher(), store: await freshStore() }),
      );
    }

    const names = results.map((result) =>
      result.status === 'prepared' ? result.packages.map((item) => item.package_path) : [],
    );
    expect(names[0]).toEqual(names[1]);
    expect(names[1]).toEqual(names[2]);
  });

  it('reports warnings for packages that declare install scripts, and never runs them', async () => {
    const result = prepared(
      await prepareDependencies(
        lockfileFor([{ name: 'native', extra: { hasInstallScript: true } }]),
        {
          fetcher: fakeFetcher(),
          store: await freshStore(),
        },
      ),
    );

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'install_script_not_run',
        package_path: 'node_modules/native',
      }),
    ]);
  });
});

describe('prepareDependencies refusals', () => {
  it.each([
    ['a git source', { resolved: 'git+ssh://git@example.test/a.git' }],
    ['another registry', { resolved: 'https://registry.example.test/a/-/a-1.0.0.tgz' }],
    ['a missing hash', { integrity: undefined }],
    ['a weak hash', { integrity: `sha1-${'A'.repeat(27)}=` }],
  ])(
    'refuses a lockfile with %s without touching the network or the store',
    async (_name, patch) => {
      const store = await freshStore();
      const fetcher = fakeFetcher();
      const [location, entry] = entryFor({ name: 'a' });
      const text = JSON.stringify({
        lockfileVersion: 3,
        packages: { [location]: { ...entry, ...patch } },
      });

      const result = await prepareDependencies(text, { fetcher, store });

      expect(result.status).toBe('invalid_lockfile');
      expect(fetcher.calls).toEqual([]);
      expect(await readdir(path.join(store.directory, 'v1'))).toEqual([]);
    },
  );

  it('refuses text that is not a lockfile', async () => {
    const result = await prepareDependencies('not json', {
      fetcher: fakeFetcher(),
      store: await freshStore(),
    });

    expect(result).toMatchObject({
      status: 'invalid_lockfile',
      lockfile_errors: [{ code: 'malformed_json' }],
    });
  });

  it('rejects a package whose bytes do not match its hash, and stores nothing for it', async () => {
    const store = await freshStore();
    const tampered = { [urlFor('a')]: Buffer.from('attacker supplied bytes') };

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }]), {
        fetcher: fakeFetcher(undefined, tampered),
        store,
      }),
    );

    expect(errors).toEqual([
      expect.objectContaining({ code: 'integrity_mismatch', package_path: 'node_modules/a' }),
    ]);
    expect(await readdir(path.join(store.directory, 'v1'))).toEqual([]);
  });

  it('keeps good packages stored and reports only the bad one', async () => {
    const store = await freshStore();
    const tampered = { [urlFor('z-bad')]: Buffer.from('attacker supplied bytes') };

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a-good' }, { name: 'z-bad' }]), {
        concurrency: 1,
        fetcher: fakeFetcher(undefined, tampered),
        store,
      }),
    );

    expect(errors.map((error) => error.package_path)).toEqual(['node_modules/z-bad']);
    expect(await readdir(path.join(store.directory, 'v1'))).toHaveLength(1);
  });

  it('reports the status code for a failed request, without any response body', async () => {
    const fetcher = fakeFetcher(() => {
      throw new PackageFetchError('http_status', 'The registry answered with status 503.', 503);
    });

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }]), {
        fetcher,
        store: await freshStore(),
      }),
    );

    expect(errors).toEqual([
      {
        code: 'http_status',
        message: 'The registry answered with status 503.',
        package_path: 'node_modules/a',
        status: 503,
      },
    ]);
  });

  it('passes through a refused redirect and a refused encoding', async () => {
    for (const code of ['redirect_refused', 'content_encoding_refused'] as const) {
      const fetcher = fakeFetcher(() => {
        throw new PackageFetchError(code, 'refused');
      });

      const errors = failed(
        await prepareDependencies(lockfileFor([{ name: 'a' }]), {
          fetcher,
          store: await freshStore(),
        }),
      );

      expect(errors[0]?.code).toBe(code);
    }
  });

  it('enforces the per-package size limit through the fetcher options', async () => {
    const seen: FetchOptions[] = [];
    const fetcher = fakeFetcher((_url, options) => {
      seen.push(options);
      return undefined;
    });

    await prepareDependencies(lockfileFor([{ name: 'a' }]), {
      fetcher,
      limits: { max_package_bytes: 1234, request_timeout_ms: 4321 },
      store: await freshStore(),
    });

    expect(seen[0]).toMatchObject({ max_bytes: 1234, timeout_ms: 4321 });
  });

  it('stops when the total download limit is exceeded', async () => {
    const store = await freshStore();

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }, { name: 'b' }, { name: 'c' }]), {
        concurrency: 1,
        fetcher: fakeFetcher(),
        limits: { max_total_bytes: tarballFor('a', '1.0.0').byteLength * 2 - 1 },
        store,
      }),
    );

    expect(errors.map((error) => error.code)).toEqual(['total_size_limit_exceeded']);
    expect(
      (await readdir(path.join(store.directory, 'v1'))).every((name) => !name.startsWith('.tmp')),
    ).toBe(true);
  });

  it('does not count stored entries against the download limit', async () => {
    const store = await freshStore();
    const text = lockfileFor([{ name: 'a' }, { name: 'b' }]);
    await prepareDependencies(text, { fetcher: fakeFetcher(), store });

    const result = await prepareDependencies(text, {
      fetcher: fakeFetcher(),
      limits: { max_total_bytes: 1 },
      store,
    });

    expect(result.status).toBe('prepared');
  });
});

describe('prepareDependencies concurrency and cancellation', () => {
  it('never runs more downloads at once than the limit', async () => {
    const fetcher = fakeFetcher();
    const specs = Array.from({ length: 12 }, (_, index) => ({ name: `p${String(index)}` }));

    await prepareDependencies(lockfileFor(specs), {
      concurrency: 3,
      fetcher,
      store: await freshStore(),
    });

    expect(fetcher.peak()).toBeLessThanOrEqual(3);
    expect(fetcher.peak()).toBeGreaterThan(1);
    expect(fetcher.calls).toHaveLength(12);
  });

  it('caps the concurrency a caller can ask for', async () => {
    const fetcher = fakeFetcher();
    const specs = Array.from({ length: 30 }, (_, index) => ({ name: `p${String(index)}` }));

    await prepareDependencies(lockfileFor(specs), {
      concurrency: 1000,
      fetcher,
      store: await freshStore(),
    });

    expect(fetcher.peak()).toBeLessThanOrEqual(8);
  });

  it('stops everything after the first failure and reports only that failure', async () => {
    let siblingAborted = false;
    const fetcher = fakeFetcher((url, options) => {
      if (url.includes('/bad/')) {
        throw new PackageFetchError('http_status', 'The registry answered with status 500.', 500);
      }
      return new Promise<AsyncIterable<Uint8Array>>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          siblingAborted = true;
          reject(new PackageFetchError('cancelled', 'The download was cancelled.'));
          return;
        }
        options.signal?.addEventListener('abort', () => {
          siblingAborted = true;
          reject(new PackageFetchError('cancelled', 'The download was cancelled.'));
        });
      });
    });

    const errors = failed(
      await prepareDependencies(
        lockfileFor([{ name: 'bad' }, { name: 'slow1' }, { name: 'slow2' }, { name: 'slow3' }]),
        { concurrency: 4, fetcher, store: await freshStore() },
      ),
    );

    expect(siblingAborted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'http_status', package_path: 'node_modules/bad' });
  });

  it('does not start new downloads after a failure', async () => {
    const fetcher = fakeFetcher((url) => {
      if (url.includes('/p0/')) {
        throw new PackageFetchError('network_error', 'down');
      }
      return undefined;
    });
    const specs = Array.from({ length: 20 }, (_, index) => ({ name: `p${String(index)}` }));

    await prepareDependencies(lockfileFor(specs), {
      concurrency: 1,
      fetcher,
      store: await freshStore(),
    });

    expect(fetcher.calls).toHaveLength(1);
  });

  it('stops when the caller cancels and leaves no partial files', async () => {
    const store = await freshStore();
    const controller = new AbortController();
    const fetcher = fakeFetcher((_url, options) => {
      return new Promise<AsyncIterable<Uint8Array>>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new PackageFetchError('cancelled', 'The download was cancelled.'));
          return;
        }
        options.signal?.addEventListener('abort', () => {
          reject(new PackageFetchError('cancelled', 'The download was cancelled.'));
        });
        setTimeout(() => {
          controller.abort();
        }, 20);
      });
    });

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }, { name: 'b' }]), {
        fetcher,
        signal: controller.signal,
        store,
      }),
    );

    expect(errors[0]?.code).toBe('cancelled');
    expect(await readdir(path.join(store.directory, 'v1'))).toEqual([]);
  });

  it('refuses to start when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = fakeFetcher();

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }]), {
        fetcher,
        signal: controller.signal,
        store: await freshStore(),
      }),
    );

    expect(errors).toEqual([{ code: 'cancelled', message: expect.any(String) as string }]);
    expect(fetcher.calls).toEqual([]);
  });

  it('gives up when the whole preparation takes too long', async () => {
    const fetcher = fakeFetcher((_url, options) => {
      return new Promise<AsyncIterable<Uint8Array>>((_resolve, reject) => {
        if (options.signal?.aborted === true) {
          reject(new PackageFetchError('cancelled', 'The download was cancelled.'));
          return;
        }
        options.signal?.addEventListener('abort', () => {
          reject(new PackageFetchError('cancelled', 'The download was cancelled.'));
        });
      });
    });

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }]), {
        fetcher,
        limits: { total_timeout_ms: 80 },
        store: await freshStore(),
      }),
    );

    expect(errors.map((error) => error.code)).toContain('timeout');
  });
});

describe('prepareDependencies through the real fetcher', () => {
  it('prepares from a local registry, sending only the expected requests', async () => {
    const bodies = new Map<string, Buffer>([
      ['/a/-/a-1.0.0.tgz', tarballFor('a', '1.0.0')],
      ['/@scope/pkg/-/pkg-2.0.0.tgz', tarballFor('@scope/pkg', '2.0.0')],
      ['/b/-/b-1.0.0.tgz', tarballFor('b', '1.0.0')],
    ]);
    const requests: { path: string; headers: Record<string, unknown> }[] = [];
    const server = createServer((request, response) => {
      requests.push({ path: request.url ?? '', headers: request.headers });
      const body = bodies.get(request.url ?? '');
      if (body === undefined) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, { 'content-length': String(body.byteLength) });
      response.end(body);
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const store = await freshStore();

    const result = prepared(
      await prepareDependencies(
        lockfileFor([{ name: 'a' }, { name: '@scope/pkg', version: '2.0.0' }, { name: 'b' }]),
        { fetcher: createRegistryFetcher({ transport_origin: origin }), store },
      ),
    );

    expect(result.downloaded).toBe(3);
    expect(requests.map((item) => item.path).sort()).toEqual([...bodies.keys()].sort());
    for (const item of requests) {
      expect(item.headers.authorization).toBeUndefined();
      expect(item.headers.cookie).toBeUndefined();
      expect(item.headers['accept-encoding']).toBe('identity');
    }
    for (const item of result.packages) {
      expect((await readFile(item.file)).equals(tarballFor(item.name, item.version))).toBe(true);
    }
  });

  it('refuses a registry that serves different bytes than the lockfile promised', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end('a different tarball than the lockfile promised');
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    const store = await freshStore();

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }]), {
        fetcher: createRegistryFetcher({ transport_origin: origin }),
        store,
      }),
    );

    expect(errors[0]?.code).toBe('integrity_mismatch');
    expect(await readdir(path.join(store.directory, 'v1'))).toEqual([]);
  });

  it('refuses a registry that redirects, without following it', async () => {
    let followed = false;
    const target = createServer((_request, response) => {
      followed = true;
      response.writeHead(200);
      response.end(tarballFor('a', '1.0.0'));
    });
    servers.push(target);
    await new Promise<void>((resolve) => {
      target.listen(0, '127.0.0.1', resolve);
    });
    const targetOrigin = `http://127.0.0.1:${String((target.address() as AddressInfo).port)}`;
    const server = createServer((_request, response) => {
      response.writeHead(302, { location: `${targetOrigin}/evil.tgz` });
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

    const errors = failed(
      await prepareDependencies(lockfileFor([{ name: 'a' }]), {
        fetcher: createRegistryFetcher({ transport_origin: origin }),
        store: await freshStore(),
      }),
    );

    expect(errors[0]?.code).toBe('redirect_refused');
    expect(followed).toBe(false);
  });
});
