/**
 * Runs the real `npm ci` against a prepared store.
 *
 * These tests exist because the whole offline-install design rests on facts about npm that
 * no type system can check: that it installs from a cache that has only content files, that
 * it never reaches for the network, that a damaged entry is refused, that install scripts do
 * not run, and that a hostile archive cannot write outside its package directory. If an npm
 * release changes any of them, these fail.
 *
 * They use the same arguments the replay sandbox uses, plus a registry address that nothing
 * listens on, so a missing --offline would fail instead of silently reaching the internet.
 * Cases that need real symbolic links skip on hosts that cannot create them; the Linux
 * container tests cover those.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { offlineInstallArguments } from './install.js';
import { openPackageStore, type PackageStore } from './store.js';
import { buildTarball, entryPathFor, everythingStored, type TarEntry } from './test-support.js';

const npmAvailable =
  (process.platform === 'win32'
    ? spawnSync('npm --version', { shell: true })
    : spawnSync('npm', ['--version'])
  ).status === 0;
const withNpm = describe.runIf(npmAvailable);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const quote = (value: string): string => (process.platform === 'win32' ? `"${value}"` : value);

const cleanEnvironment = (): NodeJS.ProcessEnv => {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Settings inherited from a parent `npm run` must not leak into the install under test.
    if (!key.toLowerCase().startsWith('npm_')) environment[key] = value;
  }
  return environment;
};

interface NpmResult {
  readonly status: number | null;
  readonly stderr: string;
}

const runNpm = async (args: readonly string[], cwd: string): Promise<NpmResult> =>
  await new Promise((resolve, reject) => {
    const options = {
      cwd,
      env: cleanEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe'] as ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    };
    // On Windows npm is a script that needs a shell, so build the command line ourselves
    // instead of passing arguments alongside a shell.
    const child =
      process.platform === 'win32'
        ? spawn(`npm ${args.map(quote).join(' ')}`, { ...options, shell: true })
        : spawn('npm', [...args], options);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status) => {
      resolve({ status, stderr });
    });
  });

const integrityOf = (content: Uint8Array): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

async function* once(content: Uint8Array): AsyncGenerator<Uint8Array> {
  yield content;
  await Promise.resolve();
}

interface Fixture {
  readonly logs: string;
  readonly nothing: string;
  readonly nothingGlobal: string;
  readonly outside: string;
  readonly project: string;
  readonly root: string;
  readonly store: PackageStore;
  readonly tarball: Buffer;
}

interface FixtureOptions {
  readonly entries?: readonly TarEntry[];
  readonly hasInstallScript?: boolean;
  readonly manifest?: Record<string, unknown>;
}

const fixture = async (options: FixtureOptions = {}): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-npm-'));
  roots.push(root);
  const project = path.join(root, 'outer', 'project');
  const outside = path.join(root, 'outside');
  const logs = path.join(root, 'logs');
  const nothing = path.join(root, 'empty-config');
  const nothingGlobal = path.join(root, 'empty-global-config');
  await mkdir(project, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(logs, { recursive: true });
  await writeFile(nothing, '');
  await writeFile(nothingGlobal, '');

  const tarball = buildTarball(
    options.entries ?? [
      {
        name: 'package/package.json',
        content: JSON.stringify({ name: 'dep', version: '1.0.0', main: 'index.js' }),
      },
      { name: 'package/index.js', content: 'module.exports = "dep loaded";' },
    ],
  );
  const store = await openPackageStore(path.join(root, 'store'));
  await store.add(integrityOf(tarball), once(tarball));

  await writeFile(
    path.join(project, 'package.json'),
    JSON.stringify({
      name: 'proj',
      version: '1.0.0',
      dependencies: { dep: '1.0.0' },
      ...options.manifest,
    }),
  );
  await writeFile(
    path.join(project, 'package-lock.json'),
    JSON.stringify({
      name: 'proj',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'proj', version: '1.0.0', dependencies: { dep: '1.0.0' } },
        'node_modules/dep': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/dep/-/dep-1.0.0.tgz',
          integrity: integrityOf(tarball),
          ...(options.hasInstallScript === true ? { hasInstallScript: true } : {}),
        },
      },
    }),
  );
  return { logs, nothing, nothingGlobal, outside, project, root, store, tarball };
};

const install = async (
  f: Fixture,
  options: { readonly withoutIgnoreScripts?: boolean } = {},
): Promise<NpmResult> => {
  const arguments_ = offlineInstallArguments({
    cache_directory: f.store.directory,
    global_config: f.nothingGlobal,
    logs_directory: f.logs,
    user_config: f.nothing,
  }).filter((item) => options.withoutIgnoreScripts !== true || item !== '--ignore-scripts');
  // Nothing listens here, so an install that tried the network would fail rather than pass.
  return await runNpm([...arguments_, '--registry', 'http://127.0.0.1:1'], f.project);
};

const installed = async (f: Fixture): Promise<string[]> =>
  (await readdir(path.join(f.project, 'node_modules')).catch(() => [])).filter(
    (name) => !name.startsWith('.'),
  );

/** Every file under the fixture except the store, the logs, and the project's node_modules. */
const strayFiles = async (f: Fixture): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const full = path.join(directory, name);
      if ([f.store.directory, f.logs, path.join(f.project, 'node_modules')].includes(full))
        continue;
      if ((await stat(full)).isDirectory()) await walk(full);
      else found.push(path.relative(f.root, full).replaceAll('\\', '/'));
    }
  };
  await walk(f.root);
  return found.sort();
};

const baseline = [
  'empty-config',
  'empty-global-config',
  'outer/project/package-lock.json',
  'outer/project/package.json',
];

withNpm('npm ci against a prepared store', () => {
  it('installs from the store alone, with no registry reachable', async () => {
    const f = await fixture();

    const result = await install(f);

    expect(result.status, result.stderr).toBe(0);
    expect(await installed(f)).toEqual(['dep']);
    expect(
      await readFile(path.join(f.project, 'node_modules', 'dep', 'index.js'), 'utf8'),
    ).toContain('dep loaded');
  }, 90_000);

  it('does not write anything into the store, so it can be mounted read-only', async () => {
    const f = await fixture();
    const before = await everythingStored(f.store.directory);
    const rootBefore = (await readdir(f.store.directory)).sort();

    const result = await install(f);

    expect(result.status, result.stderr).toBe(0);
    expect(await everythingStored(f.store.directory)).toEqual(before);
    expect((await readdir(f.store.directory)).sort()).toEqual(rootBefore);
    expect((await readdir(f.logs)).length).toBeGreaterThan(0);
  }, 90_000);

  it('fails fast and installs nothing when a package is missing from the store', async () => {
    const f = await fixture();
    await rm(entryPathFor(f.store.directory, f.tarball), { force: true });

    const result = await install(f);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('ENOTCACHED');
    expect(await installed(f)).toEqual([]);
  }, 90_000);

  it('refuses a store entry whose bytes were changed, and installs nothing', async () => {
    const f = await fixture();
    const file = entryPathFor(f.store.directory, f.tarball);
    await rm(file);
    await writeFile(file, Buffer.concat([f.tarball, Buffer.from('tampered')]));

    const result = await install(f);

    expect(result.status).not.toBe(0);
    expect(await installed(f)).toEqual([]);
  }, 90_000);

  it('refuses a lockfile that disagrees with package.json', async () => {
    const f = await fixture({ manifest: { dependencies: { dep: '2.0.0' } } });

    const result = await install(f);

    expect(result.status).not.toBe(0);
    expect(await installed(f)).toEqual([]);
  }, 90_000);

  it('does not run an install script of a package, but does when scripts are allowed', async () => {
    const entries: TarEntry[] = [
      {
        name: 'package/package.json',
        content: JSON.stringify({
          name: 'dep',
          version: '1.0.0',
          scripts: { postinstall: "node -e \"require('fs').writeFileSync('SCRIPT_RAN.txt','x')\"" },
        }),
      },
      { name: 'package/index.js', content: 'module.exports = 1;' },
    ];
    const guarded = await fixture({ entries, hasInstallScript: true });
    const control = await fixture({ entries, hasInstallScript: true });

    const withFlag = await install(guarded);
    const withoutFlag = await install(control, { withoutIgnoreScripts: true });

    expect(withFlag.status, withFlag.stderr).toBe(0);
    expect(withoutFlag.status, withoutFlag.stderr).toBe(0);
    // The control proves this test would notice a script running.
    const marker = (f: Fixture): string =>
      path.join(f.project, 'node_modules', 'dep', 'SCRIPT_RAN.txt');
    await expect(stat(marker(control))).resolves.toBeDefined();
    await expect(stat(marker(guarded))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 120_000);

  it('does not run the project’s own install scripts either', async () => {
    const f = await fixture({
      manifest: {
        scripts: {
          preinstall: "node -e \"require('fs').writeFileSync('ROOT_SCRIPT_RAN.txt','x')\"",
          postinstall: "node -e \"require('fs').writeFileSync('ROOT_SCRIPT_RAN.txt','x')\"",
          prepare: "node -e \"require('fs').writeFileSync('ROOT_SCRIPT_RAN.txt','x')\"",
        },
      },
    });

    const result = await install(f);

    expect(result.status, result.stderr).toBe(0);
    await expect(stat(path.join(f.project, 'ROOT_SCRIPT_RAN.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 90_000);

  it('writes nothing outside the package directory for path-traversal entries', async () => {
    const f = await fixture({
      entries: [
        {
          name: 'package/package.json',
          content: JSON.stringify({ name: 'dep', version: '1.0.0' }),
        },
        { name: 'package/../../ESCAPED_TRAVERSAL.txt', content: 'escaped' },
        { name: '../ESCAPED_DOTDOT.txt', content: 'escaped' },
        { name: 'package/a/../../../ESCAPED_NESTED.txt', content: 'escaped' },
        { name: 'package/../../../../outside/ESCAPED_TO_OUTSIDE.txt', content: 'escaped' },
      ],
    });

    const result = await install(f);

    expect(result.status, result.stderr).toBe(0);
    expect(await strayFiles(f)).toEqual(baseline);
    expect(await readdir(f.outside)).toEqual([]);
  }, 90_000);

  it('writes nothing outside the package directory through a symbolic link', async () => {
    const f = await fixture({
      entries: [
        {
          name: 'package/package.json',
          content: JSON.stringify({ name: 'dep', version: '1.0.0' }),
        },
        { name: 'package/link', type: 'symlink', link: '../../../../../outside' },
        { name: 'package/link/ESCAPED_VIA_SYMLINK.txt', content: 'escaped' },
      ],
    });

    await install(f);

    expect(await strayFiles(f)).toEqual(baseline);
    expect(await readdir(f.outside)).toEqual([]);
  }, 90_000);

  it('does not create a hard link to a file outside the package', async () => {
    await writeFile(path.join(tmpdir(), 'proofissue-hardlink-target.txt'), 'target');
    const f = await fixture({
      entries: [
        {
          name: 'package/package.json',
          content: JSON.stringify({ name: 'dep', version: '1.0.0' }),
        },
        { name: 'package/hard', type: 'hardlink', link: '../../../../outside/target.txt' },
      ],
    });
    await writeFile(path.join(f.outside, 'target.txt'), 'private');

    await install(f);

    await expect(
      readFile(path.join(f.project, 'node_modules', 'dep', 'hard'), 'utf8'),
    ).rejects.toBeDefined();
    expect(await readFile(path.join(f.outside, 'target.txt'), 'utf8')).toBe('private');
    await rm(path.join(tmpdir(), 'proofissue-hardlink-target.txt'), { force: true });
  }, 90_000);
});
