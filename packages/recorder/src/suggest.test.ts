import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { TestContext } from 'vitest';

import { roleOfPath, SUGGESTION_LIMITS, specifierCandidates, suggestFiles } from './suggest.js';
import type { SuggestedFile } from './suggest.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});

/** Creates `<temp>/project` with the given files and returns the temporary parent. */
const workspace = async (
  files: Readonly<Record<string, string>>,
): Promise<{ readonly outer: string; readonly root: string }> => {
  const outer = await mkdtemp(path.join(tmpdir(), 'proofissue-suggest-'));
  directories.push(outer);
  const root = path.join(outer, 'project');
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await mkdir(root, { recursive: true });
  return { outer, root };
};

const summary = (files: readonly SuggestedFile[]): readonly string[] =>
  files.map((file) => `${file.role}:${file.path}`);

const symlinkOrSkip = async (
  context: TestContext,
  target: string,
  link: string,
  type: 'dir' | 'file' | 'junction',
): Promise<void> => {
  try {
    await symlink(target, link, type);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'EPERM')
      context.skip('Creating symbolic links needs a privilege this host lacks.');
    throw error;
  }
};

describe('suggestFiles', () => {
  it('treats files named in the command as reproduction files', async () => {
    const { root } = await workspace({
      'check.mjs': 'console.log(1);\n',
      'lib/helper.mjs': 'export const x = 1;\n',
    });
    const suggestions = await suggestFiles({
      arguments: ['--trace-warnings', './check.mjs', 'lib/helper.mjs', 'missing.mjs', 'lib'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files).toEqual([
      { path: 'check.mjs', reason: 'named in the command', role: 'reproduction' },
      { path: 'lib/helper.mjs', reason: 'named in the command', role: 'reproduction' },
    ]);
  });

  it('takes the relative values of --require, -r, and --import as reproduction files', async () => {
    const { root } = await workspace({
      'setup/register.mjs': 'export {};\n',
      'setup/preload.cjs': '\n',
      'run.mjs': '\n',
    });
    const suggestions = await suggestFiles({
      arguments: [
        '--import',
        './setup/register.mjs',
        '-r',
        './setup/preload.cjs',
        '--import',
        'tsx',
        'run.mjs',
      ],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files).toEqual([
      { path: 'setup/register.mjs', reason: 'named by --import', role: 'reproduction' },
      { path: 'setup/preload.cjs', reason: 'named by -r', role: 'reproduction' },
      { path: 'run.mjs', reason: 'named in the command', role: 'reproduction' },
    ]);
  });

  it('follows relative imports to subject files and test-directory imports to reproduction files', async () => {
    const { root } = await workspace({
      'test/a.test.mjs': [
        "import { calculate } from '../src/calculate.mjs';",
        "import { sample } from './fixtures/sample.mjs';",
        "import data from '../fixtures/data.json';",
        "import { helper } from './helper.mjs';",
        '',
      ].join('\n'),
      'src/calculate.mjs':
        "import { util } from './util/format.mjs';\nexport const calculate = util;\n",
      'src/util/format.mjs': 'export const util = 1;\n',
      'test/fixtures/sample.mjs': 'export const sample = 1;\n',
      'fixtures/data.json': '{}\n',
      'test/helper.mjs': "import '../src/calculate.mjs';\n",
    });
    const suggestions = await suggestFiles({
      arguments: ['test/a.test.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(summary(suggestions.files)).toEqual([
      'reproduction:test/a.test.mjs',
      'subject:src/calculate.mjs',
      'reproduction:test/fixtures/sample.mjs',
      'reproduction:fixtures/data.json',
      'reproduction:test/helper.mjs',
      'subject:src/util/format.mjs',
    ]);
    expect(suggestions.files.find((file) => file.path === 'src/calculate.mjs')?.reason).toBe(
      'imported by test/a.test.mjs',
    );
    expect(suggestions.limits_reached).toEqual([]);
  });

  it('classifies roles by directory and by name', () => {
    expect(roleOfPath('test/a.mjs')).toBe('reproduction');
    expect(roleOfPath('src/__tests__/a.mjs')).toBe('reproduction');
    expect(roleOfPath('src/__mocks__/fs.mjs')).toBe('reproduction');
    expect(roleOfPath('lib/Specs/a.mjs')).toBe('reproduction');
    expect(roleOfPath('src/a.test.mjs')).toBe('reproduction');
    expect(roleOfPath('src/a.spec.js')).toBe('reproduction');
    expect(roleOfPath('src/calculate.mjs')).toBe('subject');
    expect(roleOfPath('src/tester.mjs')).toBe('subject');
    expect(roleOfPath('test')).toBe('subject');
  });

  it('resolves extensionless and directory-index specifiers in a fixed order', async () => {
    expect(specifierCandidates('test/a.mjs', '../src/x')).toEqual([
      'src/x',
      'src/x.js',
      'src/x.mjs',
      'src/x.cjs',
      'src/x.json',
      'src/x/index.js',
      'src/x/index.mjs',
      'src/x/index.cjs',
    ]);
    expect(specifierCandidates('a.mjs', './dir/')).toEqual([
      'dir/index.js',
      'dir/index.mjs',
      'dir/index.cjs',
    ]);

    const { root } = await workspace({
      'main.mjs': [
        "import './both';",
        "import './onlymjs';",
        "import './lib';",
        "import './cfg';",
        "import './mixed';",
        '',
      ].join('\n'),
      'both.js': '\n',
      'both.mjs': '\n',
      'onlymjs.mjs': '\n',
      'lib/index.cjs': '\n',
      'lib/index.mjs': '\n',
      'cfg.json': '{}\n',
      'mixed/index.js': '\n',
      'mixed.cjs': '\n',
    });
    const suggestions = await suggestFiles({
      arguments: ['main.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files.map((file) => file.path)).toEqual([
      'main.mjs',
      'both.js',
      'onlymjs.mjs',
      'lib/index.mjs',
      'cfg.json',
      'mixed.cjs',
    ]);
  });

  it('never leaves the project, enters node_modules, or reads dot-directories', async () => {
    const { outer, root } = await workspace({
      'main.mjs': [
        "import '../outside.mjs';",
        "import './node_modules/pkg/index.mjs';",
        "import './.hidden/secret.mjs';",
        "import './ok.mjs';",
        '',
      ].join('\n'),
      'node_modules/pkg/index.mjs': 'export {};\n',
      '.hidden/secret.mjs': 'export {};\n',
      'ok.mjs': 'export {};\n',
      'node_modules/mocha/bin/mocha.js': '\n',
    });
    await writeFile(path.join(outer, 'outside.mjs'), 'export {};\n');
    const suggestions = await suggestFiles({
      arguments: ['main.mjs', 'node_modules/mocha/bin/mocha.js', '.hidden/secret.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files.map((file) => file.path)).toEqual(['main.mjs', 'ok.mjs']);
    expect(specifierCandidates('a.mjs', '../outside.mjs')).toEqual([]);
    expect(specifierCandidates('a/b.mjs', '../../x.mjs')).toEqual([]);
  });

  it('never follows a linked directory out of the project', async (context) => {
    const { outer, root } = await workspace({
      'main.mjs': "import './linked/secret.mjs';\nimport './plain.mjs';\n",
      'plain.mjs': 'export {};\n',
    });
    await mkdir(path.join(outer, 'elsewhere'));
    await writeFile(path.join(outer, 'elsewhere', 'secret.mjs'), 'export {};\n');
    await symlinkOrSkip(
      context,
      path.join(outer, 'elsewhere'),
      path.join(root, 'linked'),
      'junction',
    );
    const suggestions = await suggestFiles({
      arguments: ['main.mjs', 'linked/secret.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files.map((file) => file.path)).toEqual(['main.mjs', 'plain.mjs']);
  });

  it('never follows a symbolic link to a file', async (context) => {
    const { outer, root } = await workspace({
      'main.mjs': "import './link.mjs';\nimport './plain.mjs';\n",
      'plain.mjs': 'export {};\n',
    });
    await writeFile(path.join(outer, 'target.mjs'), 'export {};\n');
    await symlinkOrSkip(
      context,
      path.join(outer, 'target.mjs'),
      path.join(root, 'link.mjs'),
      'file',
    );
    const suggestions = await suggestFiles({
      arguments: ['main.mjs', 'link.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files.map((file) => file.path)).toEqual(['main.mjs', 'plain.mjs']);
  });

  it('does not suggest files that are too large or not valid UTF-8', async () => {
    const { root } = await workspace({
      'main.mjs': "import './big.mjs';\nimport './binary.mjs';\nimport './ok.mjs';\n",
      'ok.mjs': '\n',
    });
    await writeFile(
      path.join(root, 'big.mjs'),
      '// x\n'.repeat(SUGGESTION_LIMITS.file_bytes / 5 + 10),
    );
    await writeFile(path.join(root, 'binary.mjs'), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const suggestions = await suggestFiles({
      arguments: ['main.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files.map((file) => file.path)).toEqual(['main.mjs', 'ok.mjs']);
  });

  it('stops at the file limit and says so', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < SUGGESTION_LIMITS.files + 20; index += 1) {
      files[`m${String(index)}.mjs`] = `import './m${String(index + 1)}.mjs';\n`;
    }
    const { root } = await workspace(files);
    const suggestions = await suggestFiles({
      arguments: ['m0.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.files).toHaveLength(SUGGESTION_LIMITS.files);
    expect(suggestions.limits_reached).toEqual(['files']);
  });

  it('stops at the byte limit and says so', async () => {
    const pad = '// padding\n'.repeat(80_000);
    const files: Record<string, string> = {};
    for (let index = 0; index < 6; index += 1) {
      files[`big${String(index)}.mjs`] = `import './big${String(index + 1)}.mjs';\n${pad}`;
    }
    const { root } = await workspace(files);
    const suggestions = await suggestFiles({
      arguments: ['big0.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.limits_reached).toEqual(['bytes']);
    expect(suggestions.files.length).toBeGreaterThan(1);
    expect(suggestions.files.length).toBeLessThan(6);
  });

  it('suggests package.json for an ES module project recorded without dependencies', async () => {
    const { root } = await workspace({
      'package.json': '{"type":"module","name":"x"}\n',
      'test/a.mjs': '\n',
    });
    const without = await suggestFiles({
      arguments: ['test/a.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(without.manifest_sets_type).toBe(true);
    expect(without.files.at(-1)).toEqual({
      path: 'package.json',
      reason: 'package.json sets "type": "module", which decides how Node.js reads .js files',
      role: 'reproduction',
    });

    const withDependencies = await suggestFiles({
      arguments: ['test/a.mjs'],
      include_dependencies: true,
      platform: 'posix',
      project_root: root,
    });
    expect(withDependencies.files.map((file) => file.path)).toEqual(['test/a.mjs']);

    const plain = await workspace({ 'package.json': '{"name":"x"}\n', 'a.mjs': '\n' });
    const noType = await suggestFiles({
      arguments: ['a.mjs'],
      platform: 'posix',
      project_root: plain.root,
    });
    expect(noType.manifest_sets_type).toBe(false);
    expect(noType.files.map((file) => file.path)).toEqual(['a.mjs']);
  });

  it('does not echo an unexpected package.json type value', async () => {
    const { root } = await workspace({
      'package.json': '{"type":"<script>secret</script>"}\n',
      'a.mjs': '\n',
    });
    const suggestions = await suggestFiles({
      arguments: ['a.mjs'],
      platform: 'posix',
      project_root: root,
    });
    const manifest = suggestions.files.find((file) => file.path === 'package.json');
    expect(manifest?.reason).toBe(
      'package.json sets "type", which decides how Node.js reads .js files',
    );
    expect(JSON.stringify(suggestions)).not.toContain('secret');
  });

  it('lists unselected runner configuration files but never .npmrc or .env', async () => {
    const { root } = await workspace({
      'a.mjs': '\n',
      '.mocharc.json': '{}\n',
      '.mocharc.yml': '\n',
      '.babelrc': '{}\n',
      'babel.config.cjs': '\n',
      '.c8rc.json': '{}\n',
      '.nycrc': '{}\n',
      'jest.config.js': '\n',
      '.npmrc': '//registry.example/:_authToken=synthetic\n',
      '.env': 'SECRET=synthetic\n',
      '.env.local': 'SECRET=synthetic\n',
      '.eslintrc.json': '{}\n',
      'webpack.config.js': '\n',
    });
    const suggestions = await suggestFiles({
      arguments: ['a.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(suggestions.uncollected_config_files).toEqual([
      '.babelrc',
      '.c8rc.json',
      '.mocharc.json',
      '.mocharc.yml',
      '.nycrc',
      'babel.config.cjs',
      'jest.config.js',
    ]);
    expect(JSON.stringify(suggestions)).not.toMatch(/npmrc|\.env/u);
  });

  it('suggests test/reproduction.mjs and src/calculate.mjs for the example', async () => {
    const suggestions = await suggestFiles({
      arguments: ['test/reproduction.mjs'],
      project_root: 'examples/failing-node-test',
    });
    expect(suggestions.files).toEqual([
      { path: 'test/reproduction.mjs', reason: 'named in the command', role: 'reproduction' },
      {
        path: 'src/calculate.mjs',
        reason: 'imported by test/reproduction.mjs',
        role: 'subject',
      },
    ]);
    expect(suggestions.warnings).toEqual([]);
    expect(suggestions.uncollected_config_files).toEqual([]);
  });

  it('warns about vitest and tsx commands', async () => {
    const { root } = await workspace({ 'a.test.mjs': '\n' });
    const vitest = await suggestFiles({
      arguments: ['node_modules/vitest/vitest.mjs', 'run'],
      platform: 'posix',
      project_root: root,
    });
    expect(vitest.warnings).toEqual([expect.stringContaining('vitest')]);

    const tsxFile = await suggestFiles({
      arguments: ['./node_modules/tsx/dist/cli.mjs', 'a.ts'],
      platform: 'posix',
      project_root: root,
    });
    expect(tsxFile.warnings).toEqual([expect.stringContaining('tsx')]);

    const tsxImport = await suggestFiles({
      arguments: ['--import', 'tsx', 'a.test.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(tsxImport.warnings).toEqual([expect.stringContaining('tsx')]);

    const loader = await suggestFiles({
      arguments: ['--loader=ts-node/esm', 'a.test.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(loader.warnings).toEqual([expect.stringContaining('--loader')]);

    const clean = await suggestFiles({
      arguments: ['--test', 'a.test.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(clean.warnings).toEqual([]);
  });

  it('accepts Windows separators only on win32', async () => {
    const { root } = await workspace({ 'test/a.mjs': '\n' });
    const windows = await suggestFiles({
      arguments: ['.\\test\\a.mjs'],
      platform: 'win32',
      project_root: root,
    });
    expect(windows.files.map((file) => file.path)).toEqual(['test/a.mjs']);
    const posix = await suggestFiles({
      arguments: ['.\\test\\a.mjs'],
      platform: 'posix',
      project_root: root,
    });
    expect(posix.files).toEqual([]);
  });

  it('refuses a project directory that is missing', async () => {
    await expect(
      suggestFiles({ arguments: ['a.mjs'], project_root: path.join(tmpdir(), 'proofissue-none') }),
    ).rejects.toMatchObject({ code: 'unsafe_project' });
  });
});
