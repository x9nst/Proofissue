import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_PROBE_REASONS, probeDependencyFiles } from './dependency-probe.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

const integrity = `sha512-${'A'.repeat(86)}==`;
const entry = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: '1.0.0',
  resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
  integrity,
  ...extra,
});
const lockfile = (packages: Record<string, unknown>): string =>
  JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } });

const project = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-probe-'));
  directories.push(root);
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(root, name), content);
  }
  return root;
};

describe('probeDependencyFiles', () => {
  it('reports absent unless both files exist', async () => {
    expect(await probeDependencyFiles(await project({}))).toEqual({ status: 'absent' });
    expect(await probeDependencyFiles(await project({ 'package.json': '{}' }))).toEqual({
      status: 'absent',
    });
    expect(
      await probeDependencyFiles(await project({ 'package-lock.json': lockfile({}) })),
    ).toEqual({ status: 'absent' });
  });

  it('counts packages and install scripts of a usable lockfile', async () => {
    const root = await project({
      'package.json': '{"devDependencies":{"mocha":"^10.0.0"}}',
      'package-lock.json': lockfile({
        'node_modules/a': entry('a'),
        'node_modules/b': entry('b', { hasInstallScript: true }),
      }),
    });
    expect(await probeDependencyFiles(root)).toEqual({
      declares_dependencies: true,
      install_script_packages: 1,
      package_count: 2,
      status: 'usable',
    });
  });

  it('reports whether the manifest declares dependencies or devDependencies', async () => {
    const lock = lockfile({});
    const none = await probeDependencyFiles(
      await project({
        'package.json': '{"name":"x","dependencies":{}}',
        'package-lock.json': lock,
      }),
    );
    const runtime = await probeDependencyFiles(
      await project({ 'package.json': '{"dependencies":{"a":"1"}}', 'package-lock.json': lock }),
    );
    const peerOnly = await probeDependencyFiles(
      await project({
        'package.json': '{"peerDependencies":{"a":"1"}}',
        'package-lock.json': lock,
      }),
    );
    expect(none).toMatchObject({ declares_dependencies: false, status: 'usable' });
    expect(runtime).toMatchObject({ declares_dependencies: true, status: 'usable' });
    expect(peerOnly).toMatchObject({ declares_dependencies: false });
  });

  it('gives the first three reasons when the lockfile cannot be used', async () => {
    const root = await project({
      'package.json': '{"dependencies":{"a":"1"}}',
      'package-lock.json': lockfile({
        'node_modules/a': { version: '1.0.0', resolved: 'https://example.com/a.tgz' },
        'node_modules/b': { version: '1.0.0', resolved: 'https://example.com/b.tgz' },
        'node_modules/c': { version: '1.0.0', resolved: 'https://example.com/c.tgz' },
        'node_modules/d': { version: '1.0.0', resolved: 'https://example.com/d.tgz' },
        'node_modules/e': { version: '1.0.0', resolved: 'https://example.com/e.tgz' },
      }),
    });
    const probe = await probeDependencyFiles(root);
    expect(probe).toMatchObject({ declares_dependencies: true, status: 'unusable' });
    if (probe.status !== 'unusable') return;
    expect(probe.reasons).toHaveLength(MAX_PROBE_REASONS);
    expect(probe.unlisted_reasons).toBe(2);
    expect(probe.reasons[0]).toContain('public npm registry');
  });

  it('reports an unreadable manifest or lockfile as reasons, never their contents', async () => {
    const root = await project({
      'package.json': '{ "secret": "synthetic-value" ',
      'package-lock.json': 'lockfile with synthetic-value',
    });
    const probe = await probeDependencyFiles(root);
    expect(probe).toMatchObject({ declares_dependencies: false, status: 'unusable' });
    expect(JSON.stringify(probe)).not.toContain('synthetic-value');
    if (probe.status !== 'unusable') return;
    expect(probe.reasons[0]).toContain('package.json');
  });

  it('refuses a project directory that is missing', async () => {
    await expect(
      probeDependencyFiles(path.join(tmpdir(), 'proofissue-probe-none')),
    ).rejects.toMatchObject({ code: 'unsafe_project' });
  });
});
