import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { createStaticArtifactApplicationServices } from '@proofissue/application';

import { runCli, type CliIo } from './index.js';
import { renderSuggestedFlags } from './record-suggestions.js';

const roots: string[] = [];
const originalDirectory = process.cwd();

afterEach(async () => {
  process.chdir(originalDirectory);
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const exists = async (location: string): Promise<boolean> => {
  try {
    await access(location);
    return true;
  } catch {
    return false;
  }
};

const MARKER = 'ran.marker';

const integrity = `sha512-${'A'.repeat(86)}==`;
const lockfile = (packages: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': {},
      ...packages,
    },
  })}\n`;
const validPackages = {
  'node_modules/left-pad': {
    version: '1.0.0',
    resolved: 'https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz',
    integrity,
  },
};
const invalidPackages = {
  'node_modules/a': { version: '1.0.0', resolved: 'https://example.com/a.tgz' },
  'node_modules/b': { version: '1.0.0', resolved: 'https://example.com/b.tgz' },
  'node_modules/c': { version: '1.0.0', resolved: 'https://example.com/c.tgz' },
  'node_modules/d': { version: '1.0.0', resolved: 'https://example.com/d.tgz' },
};

const project = async (
  extra: Readonly<Record<string, string>> = {},
  exitCode = 1,
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-suggest-cli-'));
  roots.push(root);
  const files: Record<string, string> = {
    'test/reproduction.mjs': [
      "import { writeFileSync } from 'node:fs';",
      "import { value } from '../src/subject.mjs';",
      `writeFileSync(new URL('../${MARKER}', import.meta.url), 'ran');`,
      "console.log('checking 3 inputs');",
      "console.error('Expected 4 from calculate(2)');",
      `process.exitCode = ${String(exitCode)} + value - value;`,
      '',
    ].join('\n'),
    'src/subject.mjs': 'export const value = 3;\n',
    ...extra,
  };
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, ...name.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
};

interface Session {
  readonly asked: string[];
  readonly confirmations: string[];
  readonly errors: () => string;
  readonly io: CliIo;
  readonly output: () => string;
}

const session = (
  answers: readonly (string | undefined)[],
  options: {
    readonly confirm?: (question: string) => boolean;
    readonly interactive?: boolean;
  } = {},
): Session => {
  let written = '';
  let errors = '';
  const asked: string[] = [];
  const confirmations: string[] = [];
  const queue = [...answers];
  return {
    asked,
    confirmations,
    errors: () => errors,
    io: {
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(queue.shift());
      },
      confirm: (question) => {
        confirmations.push(question);
        return Promise.resolve(options.confirm?.(question) ?? true);
      },
      interactive: options.interactive ?? true,
      write: (text) => {
        written += text;
      },
      writeError: (text) => {
        errors += text;
      },
    },
    output: () => written,
  };
};

const base = (root: string, ...extra: readonly string[]): readonly string[] => [
  'record',
  '--project',
  root,
  '--output',
  path.join(root, 'failure.proofissue.yaml'),
  ...extra,
  '--',
  'node',
  'test/reproduction.mjs',
];

const inspectFiles = async (root: string): Promise<readonly string[]> => {
  const inspected = await createStaticArtifactApplicationServices().inspect({
    artifact_path: path.join(root, 'failure.proofissue.yaml'),
  });
  if (inspected.status !== 'inspected') throw new Error('The artifact did not inspect.');
  return (inspected.inspection?.files ?? []).map((file) => `${file.role}:${file.path}`);
};

describe('file suggestions', () => {
  it('shows suggested files with reasons and records them after confirmation', async () => {
    const root = await project();
    const terminal = session(['']);

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    const text = terminal.output();
    expect(text).toContain('Suggested files');
    expect(text).toContain('    test/reproduction.mjs  (named in the command)');
    expect(text).toContain('    src/subject.mjs  (imported by test/reproduction.mjs)');
    // The files are confirmed before the command runs, and the preview confirms them again.
    expect(terminal.confirmations[0]).toBe('Use these files?');
    expect(terminal.confirmations).toHaveLength(4);
    expect(text.indexOf('Suggested files')).toBeLessThan(text.indexOf('The command exited'));
    expect(await inspectFiles(root)).toEqual([
      'subject:src/subject.mjs',
      'reproduction:test/reproduction.mjs',
    ]);
  });

  it('runs nothing and records nothing when the suggestions are not confirmed and no paths are given', async () => {
    const root = await project();
    const terminal = session([undefined], { confirm: () => false });

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).toContain('Recording cancelled; no artifact was written.');
    expect(await exists(path.join(root, MARKER))).toBe(false);
  });

  it('asks for paths per role when the suggestions are declined, and Enter keeps a suggestion', async () => {
    const root = await project({ 'src/other.mjs': 'export const other = 1;\n' });
    const terminal = session(['', 'src/other.mjs ./src/subject.mjs', ''], {
      confirm: (question) => question !== 'Use these files?',
    });

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.asked[0]).toBe(
      'Reproduction files (paths relative to the project, separated by spaces, or press Enter to keep 1 suggested file): ',
    );
    expect(terminal.asked[1]).toBe(
      'Subject files (paths relative to the project, separated by spaces, or press Enter to keep 1 suggested file): ',
    );
    expect(await inspectFiles(root)).toEqual([
      'subject:src/other.mjs',
      'subject:src/subject.mjs',
      'reproduction:test/reproduction.mjs',
    ]);
  });

  it('keeps roles given on the command line unchanged', async () => {
    const root = await project({ 'test/helper.mjs': 'export const helper = 1;\n' });
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      [
        "import './helper.mjs';",
        "import { value } from '../src/subject.mjs';",
        "console.error('Expected 4 from calculate(2)');",
        'process.exitCode = value - 2;',
        '',
      ].join('\n'),
    );
    const terminal = session(['']);

    const result = await runCli(base(root, '--reproduction', 'test/reproduction.mjs'), terminal.io);

    expect(result.exit_code).toBe(0);
    const text = terminal.output();
    // Only the empty role is suggested for, and the given role is not extended with the helper.
    expect(text).not.toContain('Kept exactly as recorded during a fix check (reproduction):');
    expect(text).toContain('    src/subject.mjs  (imported by test/reproduction.mjs)');
    expect(text).not.toContain('test/helper.mjs');
    expect(await inspectFiles(root)).toEqual([
      'subject:src/subject.mjs',
      'reproduction:test/reproduction.mjs',
    ]);
  });

  it('does not suggest anything when both roles are given', async () => {
    const root = await project();
    const terminal = session(['']);

    const result = await runCli(
      base(root, '--reproduction', 'test/reproduction.mjs', '--subject', 'src/subject.mjs'),
      terminal.io,
    );

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).not.toContain('Suggested files');
    expect(terminal.confirmations).toHaveLength(3);
  });

  it('lists suggested flags instead of guessing under --yes', async () => {
    const root = await project();
    const terminal = session([]);

    const result = await runCli(
      base(root, '--yes', '--expect-stderr', 'Expected 4 from calculate(2)'),
      terminal.io,
    );

    expect(result.exit_code).toBe(1);
    const text = terminal.output();
    expect(text).toContain('Recording failed: Select at least one reproduction file');
    expect(text).toContain('--reproduction test/reproduction.mjs  (named in the command)');
    expect(text).toContain('--subject src/subject.mjs  (imported by test/reproduction.mjs)');
    expect(text).toContain('  --reproduction test/reproduction.mjs --subject src/subject.mjs\n');
    expect(terminal.asked).toHaveLength(0);
    expect(terminal.confirmations).toHaveLength(0);
    // Nothing was applied: the command did not run and no artifact exists.
    expect(await exists(path.join(root, MARKER))).toBe(false);
    expect(await exists(path.join(root, 'failure.proofissue.yaml'))).toBe(false);
  });

  it('puts the flags on stderr under --json and keeps stdout to the result line', async () => {
    const root = await project();
    const terminal = session([]);

    const result = await runCli(
      base(root, '--yes', '--json', '--expect-stderr', 'Expected 4'),
      terminal.io,
    );

    expect(result.exit_code).toBe(1);
    expect(JSON.parse(terminal.output()) as unknown).toMatchObject({ status: 'invalid_input' });
    expect(terminal.errors()).toContain('--subject src/subject.mjs');
    expect(await exists(path.join(root, MARKER))).toBe(false);
  });

  it('lists the flags without a terminal too, and never prompts', async () => {
    const root = await project();
    const terminal = session([], { interactive: false });

    const result = await runCli(base(root, '--expect-stderr', 'Expected 4'), terminal.io);

    expect(result.exit_code).toBe(1);
    expect(terminal.output()).toContain('--reproduction test/reproduction.mjs --subject');
    expect(terminal.asked).toHaveLength(0);
    expect(terminal.confirmations).toHaveLength(0);
  });

  it('quotes and escapes suggested paths in the flags', () => {
    const text = renderSuggestedFlags({
      missing: { reproduction: true, subject: true },
      reproduction: [
        { path: 'test/a b.mjs', reason: 'named in the command', role: 'reproduction' },
      ],
      subject: [],
    });
    expect(text).toContain('--reproduction "test/a b.mjs"');
    expect(text).toContain('Nothing was suggested for --subject: name it yourself.');
  });

  it('reports nothing to suggest when the command names no project file', async () => {
    const root = await project();
    const terminal = session([], { interactive: false });

    const result = await runCli(
      ['record', '--project', root, '--yes', '--expect-stderr', 'x', '--', 'node', '-p', '1'],
      terminal.io,
    );

    expect(result.exit_code).toBe(1);
    expect(terminal.output()).toContain('No files could be suggested from the command.');
  });

  it('notes runner configuration, a manifest type, and unsupported runners', async () => {
    const root = await project({
      'package.json': '{"type":"module"}\n',
      '.mocharc.json': '{}\n',
      '.npmrc': '//registry.example/:_authToken=synthetic\n',
    });
    const terminal = session(['']);

    const result = await runCli(
      base(root, '--reproduction', 'test/reproduction.mjs', '--subject', 'src/subject.mjs'),
      terminal.io,
    );

    expect(result.exit_code).toBe(0);
    const text = terminal.output();
    expect(text).toContain('package.json sets "type"');
    expect(text).toContain(
      'Not collected (add with --reproduction <file> if your test runner reads it):\n    .mocharc.json',
    );
    expect(text).not.toContain('npmrc');
  });

  it('suggests package.json for an ES module project and records it with the files', async () => {
    const root = await project({ 'package.json': '{"type":"module"}\n' });
    const terminal = session(['']);

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).toContain('package.json  (package.json sets "type": "module"');
    expect(await inspectFiles(root)).toContain('reproduction:package.json');
  });
});

describe('dependency files', () => {
  const withLockfile = async (
    packages: Record<string, unknown>,
    manifest = '{"name":"x","devDependencies":{"left-pad":"1.0.0"}}\n',
  ): Promise<string> =>
    await project({ 'package.json': manifest, 'package-lock.json': lockfile(packages) });

  it('asks about dependency files when a lockfile exists, with a default of yes when dependencies are declared', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session(['', '']);

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    const text = terminal.output();
    expect(text).toContain(
      'package.json and package-lock.json found: 1 package locked, and the lockfile can be used for dependency replay.',
    );
    expect(terminal.asked[0]).toBe(
      'Record package.json and package-lock.json so replay can install the locked packages? [Y/n] ',
    );
    expect(text.indexOf('1 package locked')).toBeLessThan(text.indexOf('[Y/n]') + 1000);
    expect(text).toContain('Dependency files (recorded exactly as they are');
    // package.json is recorded as a dependency file, so it is not also suggested.
    expect(await inspectFiles(root)).toEqual([
      'dependency:package-lock.json',
      'dependency:package.json',
      'subject:src/subject.mjs',
      'reproduction:test/reproduction.mjs',
    ]);
  });

  it('records no dependency files when the answer is no', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session(['n', '']);

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).not.toContain('Dependency files (recorded');
    // Answering was a decision, so the preview does not warn.
    expect(terminal.output()).not.toContain('are not being recorded');
    expect(await inspectFiles(root)).not.toContain('dependency:package.json');
  });

  it('defaults to no when no dependencies are declared', async () => {
    const root = await withLockfile(validPackages, '{"name":"x"}\n');
    const terminal = session(['', '']);

    await runCli(base(root), terminal.io);

    expect(terminal.asked[0]).toContain('[y/N] ');
    expect(await inspectFiles(root)).not.toContain('dependency:package.json');
  });

  it('shows the first three reasons and defaults to no for an invalid lockfile', async () => {
    const root = await withLockfile(invalidPackages);
    const terminal = session(['', '']);

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    const text = terminal.output();
    expect(text).toContain('the lockfile cannot be used for dependency replay:');
    expect(text.match(/^ {2}- Only tarballs/gmu)).toHaveLength(3);
    expect(text).toContain('  - and 1 more');
    expect(terminal.asked[0]).toContain('[y/N] ');
    expect(await inspectFiles(root)).not.toContain('dependency:package.json');
  });

  it('asks again after an unusable answer and cancels after three', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session(['maybe', 'perhaps', '??']);

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.asked).toHaveLength(3);
    expect(terminal.output()).toContain('Answer y or n, or press Enter for the default.');
    expect(terminal.output()).toContain('Recording cancelled; no artifact was written.');
    expect(await exists(path.join(root, MARKER))).toBe(false);
  });

  it('cancels when input ends at the question', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session([undefined]);

    const result = await runCli(base(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).toContain('Recording cancelled; no artifact was written.');
  });

  it('does not ask when --dependencies is given', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session(['']);

    const result = await runCli(base(root, '--dependencies'), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.asked.some((question) => question.includes('Record package.json'))).toBe(false);
    expect(await inspectFiles(root)).toContain('dependency:package.json');
  });

  it('--no-dependencies suppresses the question and the warning', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session(['']);

    const interactive = await runCli(base(root, '--no-dependencies'), terminal.io);

    expect(interactive.exit_code).toBe(0);
    expect(terminal.asked.some((question) => question.includes('Record package.json'))).toBe(false);
    expect(terminal.output()).not.toContain('are not being recorded');

    const unattended = session([]);
    const yes = await runCli(
      [
        'record',
        '--project',
        root,
        '--output',
        path.join(root, 'second.proofissue.yaml'),
        '--yes',
        '--no-dependencies',
        '--reproduction',
        'test/reproduction.mjs',
        '--subject',
        'src/subject.mjs',
        '--expect-stderr',
        'Expected 4 from calculate(2)',
        '--',
        'node',
        'test/reproduction.mjs',
      ],
      unattended.io,
    );
    expect(yes.exit_code).toBe(0);
    expect(unattended.output()).not.toContain('are not being recorded');
  });

  it('rejects --dependencies together with --no-dependencies', async () => {
    const root = await project();
    const terminal = session([]);

    const result = await runCli(base(root, '--dependencies', '--no-dependencies'), terminal.io);

    expect(result.exit_code).toBe(2);
    expect(terminal.output()).toContain('--dependencies and --no-dependencies cannot be combined.');
  });

  it('warns in the preview when a lockfile exists and --yes records without dependencies', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session([]);

    const result = await runCli(
      base(
        root,
        '--yes',
        '--reproduction',
        'test/reproduction.mjs',
        '--subject',
        'src/subject.mjs',
        '--expect-stderr',
        'Expected 4 from calculate(2)',
      ),
      terminal.io,
    );

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).toContain(
      'Warning: package.json and package-lock.json exist in the project but are not being recorded.',
    );
    expect(terminal.asked).toHaveLength(0);
    expect(await inspectFiles(root)).not.toContain('dependency:package.json');
  });

  it('warns on stderr, not stdout, under --json', async () => {
    const root = await withLockfile(validPackages);
    const terminal = session([]);

    const result = await runCli(
      base(
        root,
        '--yes',
        '--json',
        '--reproduction',
        'test/reproduction.mjs',
        '--subject',
        'src/subject.mjs',
        '--expect-stderr',
        'Expected 4 from calculate(2)',
      ),
      terminal.io,
    );

    expect(result.exit_code).toBe(0);
    expect(terminal.errors()).toContain('are not being recorded');
    expect(terminal.output()).not.toContain('are not being recorded');
  });
});

describe('commands that do not start with node', () => {
  it('explains a lockfile bin as a node command, runs nothing, and exits 2', async () => {
    const root = await project({
      'package-lock.json': lockfile({
        'node_modules/mocha': { bin: { mocha: 'bin/mocha.js' } },
      }),
      'node_modules/mocha/bin/mocha.js': `require('node:fs').writeFileSync('${MARKER}', 'ran');\n`,
    });
    const terminal = session([]);

    const result = await runCli(
      ['record', '--project', root, '--', 'npx', 'mocha', 'test/a.js', '--bail'],
      terminal.io,
    );

    expect(result.exit_code).toBe(2);
    const text = terminal.output();
    expect(text).toContain('Error: The command after -- must start with node');
    expect(text).toContain('  -- node node_modules/mocha/bin/mocha.js test/a.js --bail\n');
    expect(text).toContain('Nothing was run.');
    expect(await exists(path.join(root, MARKER))).toBe(false);
    expect(terminal.asked).toHaveLength(0);
  });

  it('explains npm without running it', async () => {
    const root = await project();
    const terminal = session([]);

    const result = await runCli(['record', '--project', root, '--', 'npm', 'test'], terminal.io);

    expect(result.exit_code).toBe(2);
    expect(terminal.output()).toContain('Hint: npm commands are not run.');
    expect(terminal.output()).toContain('-- node node_modules/<package>/<script> <arguments>');
  });

  it('gives only the usage message when there is no hint', async () => {
    const root = await project();
    const terminal = session([]);

    const result = await runCli(['record', '--project', root, '--', 'mocha', 'x.js'], terminal.io);

    expect(result.exit_code).toBe(2);
    expect(terminal.output()).not.toContain('Hint:');
    expect(terminal.output()).toContain('Run "proofissue record --help" for all options.');
  });
});

describe('the headline example', () => {
  // proofissue record -- node test/reproduction.mjs, with nothing else, in a terminal.
  it('records examples/failing-node-test with only the command, choosing files and the expectation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-headline-'));
    roots.push(root);
    await cp(path.join(originalDirectory, 'examples', 'failing-node-test'), root, {
      recursive: true,
    });
    process.chdir(root);
    // The terminal answers: Enter takes the suggested expected line.
    const terminal = session(['']);

    const result = await runCli(['record', '--', 'node', 'test/reproduction.mjs'], terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.confirmations).toEqual([
      'Use these files?',
      'Are the files kept exactly as recorded classified correctly?',
      'Are the files replaceable from the current checkout classified correctly?',
      'Create the new .proofissue artifact?',
    ]);
    expect(terminal.asked).toEqual([
      'Enter line ids separated by spaces (e.g. e3 o12), or press Enter to use the suggested line e1: ',
    ]);
    const text = terminal.output();
    expect(text).toContain('    test/reproduction.mjs  (named in the command)');
    expect(text).toContain('    src/calculate.mjs  (imported by test/reproduction.mjs)');
    expect(text).toContain('  e1  Expected 4 from calculate(2)');
    expect(text).toContain('Artifact file: reproduction.proofissue.yaml');
    expect(text).toContain('Artifact created.');
    expect(text).toContain('Saved: reproduction.proofissue.yaml (sha256 ');

    const artifact = path.join(root, 'reproduction.proofissue.yaml');
    expect(await readFile(artifact, 'utf8')).toContain('Expected 4 from calculate(2)');
    const services = createStaticArtifactApplicationServices();
    expect(await services.validate({ artifact_path: artifact })).toMatchObject({
      status: 'valid',
    });
    expect(await services.inspect({ artifact_path: artifact })).toMatchObject({
      status: 'inspected',
      inspection: {
        files: [
          { path: 'src/calculate.mjs', role: 'subject' },
          { path: 'test/reproduction.mjs', role: 'reproduction' },
        ],
        expectations: { exit_code: 1, stderr_count: 1 },
      },
    });
  });
});
