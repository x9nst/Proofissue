import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { LOCKFILE_LIMITS } from '@proofissue/dependencies';

import { hintForCommand } from './bin-hint.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

interface LockEntry {
  readonly bin?: Readonly<Record<string, string>> | string;
}

const project = async (
  packages: Readonly<Record<string, LockEntry>>,
  files: Readonly<Record<string, string>> = {},
  rawLockfile?: string,
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-bin-hint-'));
  directories.push(root);
  await writeFile(
    path.join(root, 'package-lock.json'),
    rawLockfile ?? JSON.stringify({ lockfileVersion: 3, packages: { '': {}, ...packages } }),
  );
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
};

describe('hintForCommand', () => {
  it('resolves a lockfile bin to node and its script', async () => {
    const root = await project(
      {
        'node_modules/mocha': { bin: { mocha: 'bin/mocha.js', _mocha: 'bin/_mocha' } },
        'node_modules/@scope/tool': { bin: './cli/run.mjs' },
        'node_modules/other': { bin: { mocha: 'bin/other.js' } },
        'node_modules/missing': { bin: { missing: 'bin/gone.js' } },
        'node_modules/escape': { bin: { escape: '../../outside.js' } },
      },
      {
        'node_modules/mocha/bin/mocha.js': '\n',
        'node_modules/other/bin/other.js': '\n',
        'node_modules/@scope/tool/cli/run.mjs': '\n',
        'outside.js': '\n',
      },
    );
    expect(
      await hintForCommand({ command: ['mocha', 'test/a.js', '--bail'], project_root: root }),
    ).toEqual({
      kind: 'lockfile_bin',
      package_name: 'mocha',
      rest_arguments: ['test/a.js', '--bail'],
      script: 'bin/mocha.js',
    });
    expect(
      await hintForCommand({
        command: ['npx', '--yes', 'mocha@10', 'test/a.js'],
        project_root: root,
      }),
    ).toEqual({
      kind: 'lockfile_bin',
      package_name: 'mocha',
      rest_arguments: ['test/a.js'],
      script: 'bin/mocha.js',
    });
    expect(
      await hintForCommand({ command: ['npx', '@scope/tool', 'x'], project_root: root }),
    ).toEqual({
      kind: 'lockfile_bin',
      package_name: '@scope/tool',
      rest_arguments: ['x'],
      script: 'cli/run.mjs',
    });
    expect(await hintForCommand({ command: ['mocha.cmd'], project_root: root })).toMatchObject({
      package_name: 'mocha',
    });
    // The script must exist as a regular file in the project, and stay inside its package.
    expect(await hintForCommand({ command: ['missing'], project_root: root })).toBeUndefined();
    expect(await hintForCommand({ command: ['escape'], project_root: root })).toBeUndefined();
    expect(await hintForCommand({ command: ['unknown-tool'], project_root: root })).toBeUndefined();
    expect(await hintForCommand({ command: ['npx'], project_root: root })).toBeUndefined();
    expect(
      await hintForCommand({ command: ['./local-script'], project_root: root }),
    ).toBeUndefined();
  });

  it('prefers the package named like the executable, then the first in sorted order', async () => {
    const root = await project(
      {
        'node_modules/aaa': { bin: { run: 'bin/aaa.js' } },
        'node_modules/run': { bin: { run: 'bin/run.js' } },
        'node_modules/zzz': { bin: { go: 'bin/zzz.js' } },
        'node_modules/yyy': { bin: { go: 'bin/yyy.js' } },
      },
      {
        'node_modules/aaa/bin/aaa.js': '\n',
        'node_modules/run/bin/run.js': '\n',
        'node_modules/zzz/bin/zzz.js': '\n',
        'node_modules/yyy/bin/yyy.js': '\n',
      },
    );
    expect(await hintForCommand({ command: ['run'], project_root: root })).toMatchObject({
      package_name: 'run',
    });
    expect(await hintForCommand({ command: ['go'], project_root: root })).toMatchObject({
      package_name: 'yyy',
    });
  });

  it('explains npm and npx commands without running them', async () => {
    const root = await project(
      { 'node_modules/mocha': { bin: { mocha: 'bin/mocha.js' } } },
      {
        'node_modules/mocha/bin/mocha.js':
          "require('node:fs').writeFileSync('ran.marker', 'ran');\n",
      },
    );
    expect(await hintForCommand({ command: ['npm', 'test'], project_root: root })).toEqual({
      kind: 'package_manager',
      manager: 'npm',
    });
    expect(await hintForCommand({ command: ['yarn', 'test'], project_root: root })).toEqual({
      kind: 'package_manager',
      manager: 'yarn',
    });
    expect(
      await hintForCommand({ command: ['pnpm.cmd', 'exec', 'mocha'], project_root: root }),
    ).toEqual({
      kind: 'package_manager',
      manager: 'pnpm',
    });
    expect(await hintForCommand({ command: ['npx', 'mocha'], project_root: root })).toMatchObject({
      kind: 'lockfile_bin',
    });
    expect(await hintForCommand({ command: ['node', 'a.js'], project_root: root })).toBeUndefined();
    await expect(access(path.join(root, 'ran.marker'))).rejects.toThrow();
  });

  it('ignores a lockfile beyond the size limit', async () => {
    const padding = 'x'.repeat(LOCKFILE_LIMITS.bytes);
    const root = await project(
      { 'node_modules/mocha': { bin: { mocha: 'bin/mocha.js' } } },
      { 'node_modules/mocha/bin/mocha.js': '\n' },
      JSON.stringify({
        lockfileVersion: 3,
        padding,
        packages: { 'node_modules/mocha': { bin: { mocha: 'bin/mocha.js' } } },
      }),
    );
    expect(await hintForCommand({ command: ['mocha'], project_root: root })).toBeUndefined();
  });

  it('ignores a lockfile that is not JSON, has no packages, or does not exist', async () => {
    const notJson = await project({}, {}, 'not json');
    expect(await hintForCommand({ command: ['mocha'], project_root: notJson })).toBeUndefined();
    const noPackages = await project({}, {}, '{"lockfileVersion":3}');
    expect(await hintForCommand({ command: ['mocha'], project_root: noPackages })).toBeUndefined();
    const empty = await mkdtemp(path.join(tmpdir(), 'proofissue-bin-hint-'));
    directories.push(empty);
    expect(await hintForCommand({ command: ['mocha'], project_root: empty })).toBeUndefined();
    expect(
      await hintForCommand({ command: ['mocha'], project_root: path.join(empty, 'missing') }),
    ).toBeUndefined();
  });
});
