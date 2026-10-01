import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLI_HELP, parseRecordArguments, RECORD_HELP, runCli, type CliIo } from './index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const required = [
  '--project',
  '.',
  '--output',
  'failure.proofissue',
  '--image',
  `node@sha256:${'1'.repeat(64)}`,
  '--reproduction',
  'test/a.mjs',
  '--subject',
  'src/a.mjs',
];
const command = ['--', 'node', 'test/a.mjs'];

const parse = (...options: readonly string[]) =>
  parseRecordArguments([...required, ...options, ...command]).request;

const capture = (): { io: CliIo; output: () => string } => {
  let written = '';
  return {
    io: {
      confirm: () => Promise.resolve(false),
      write: (text) => {
        written += text;
      },
    },
    output: () => written,
  };
};

const exists = async (location: string): Promise<boolean> => {
  try {
    await access(location);
    return true;
  } catch {
    return false;
  }
};

const project = async (reproduction: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-expectations-'));
  roots.push(root);
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'test', 'reproduction.mjs'), reproduction);
  await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
  return root;
};

const recordArguments = (root: string, ...options: readonly string[]): readonly string[] => [
  'record',
  '--project',
  root,
  '--output',
  path.join(root, 'failure.proofissue'),
  '--image',
  `node@sha256:${'1'.repeat(64)}`,
  '--reproduction',
  'test/reproduction.mjs',
  '--subject',
  'src/subject.mjs',
  ...options,
  '--yes',
  '--',
  'node',
  'test/reproduction.mjs',
];

describe('record expectation options', () => {
  it('parses each new option into the matching expectation in command-line order', () => {
    const request = parse(
      '--expect-stderr',
      'raw one',
      '--expect-stderr-normalized',
      'took 5ms',
      '--expect-stdout',
      'out',
      '--expect-stderr-exact',
      '--expect-stdout-exact-normalized',
      '--expect-stderr',
      'raw two',
      '--expect-stdout-normalized',
      'at <project>/a.mjs',
    );

    expect(request.expect_stderr).toEqual([
      'raw one',
      { mode: 'contains', normalized: true, value: 'took 5ms' },
      { mode: 'exact', normalized: false },
      'raw two',
    ]);
    expect(request.expect_stdout).toEqual([
      'out',
      { mode: 'exact', normalized: true },
      { mode: 'contains', normalized: true, value: 'at <project>/a.mjs' },
    ]);
  });

  it('keeps plain literals as plain strings', () => {
    const request = parse('--expect-stderr', 'failure marker', '--expect-stdout', 'ok');

    expect(request.expect_stderr).toEqual(['failure marker']);
    expect(request.expect_stdout).toEqual(['ok']);
  });

  it('treats exact options as flags that do not consume the next argument', () => {
    const parsed = parseRecordArguments([
      '--expect-stderr-exact',
      '--expect-stdout-exact-normalized',
      ...required,
      ...command,
    ]);

    expect(parsed.request.project_root).toBe('.');
    expect(parsed.request.output_path).toBe('failure.proofissue');
    expect(parsed.request.expect_stderr).toEqual([{ mode: 'exact', normalized: false }]);
    expect(parsed.request.expect_stdout).toEqual([{ mode: 'exact', normalized: true }]);
  });

  it('allows one exact expectation on each stream', () => {
    const request = parse('--expect-stdout-exact', '--expect-stderr-exact-normalized');

    expect(request.expect_stdout).toEqual([{ mode: 'exact', normalized: false }]);
    expect(request.expect_stderr).toEqual([{ mode: 'exact', normalized: true }]);
  });

  it.each([
    ['a repeated option', ['--expect-stderr-exact', '--expect-stderr-exact'], 'stderr'],
    [
      'a repeated normalized option',
      ['--expect-stdout-exact-normalized', '--expect-stdout-exact-normalized'],
      'stdout',
    ],
    [
      'raw and normalized exact options together',
      ['--expect-stdout-exact', '--expect-stdout-exact-normalized'],
      'stdout',
    ],
  ])('rejects %s with exit code 2', async (_name, options, stream) => {
    const { io, output } = capture();

    const result = await runCli(['record', ...required, ...options, ...command], io);

    expect(result.exit_code).toBe(2);
    expect(output()).toContain(`At most one exact expectation is allowed for ${stream}`);
    expect(output()).toContain('Usage:');
  });

  it('still requires a value for the value options', () => {
    for (const option of ['--expect-stdout-normalized', '--expect-stderr-normalized']) {
      expect(() => parseRecordArguments([...required, option, '--', 'node', 'a.mjs'])).toThrow(
        `${option} requires a value.`,
      );
    }
  });

  it('rejects an unknown expectation option', () => {
    expect(() => parse('--expect-stderr-fuzzy', 'x')).toThrow(
      'Unknown record option: --expect-stderr-fuzzy',
    );
  });

  it('documents every expectation option in the help', () => {
    for (const option of [
      '--expect-stdout',
      '--expect-stderr',
      '--expect-stdout-normalized',
      '--expect-stderr-normalized',
      '--expect-stdout-exact',
      '--expect-stderr-exact',
      '--expect-stdout-exact-normalized',
      '--expect-stderr-exact-normalized',
    ]) {
      expect(RECORD_HELP, option).toContain(option);
      expect(CLI_HELP, option).toContain(option);
    }
    for (const topic of [
      'line endings',
      'terminal',
      'trailing whitespace',
      'temporary directories',
      'durations',
      'process IDs',
      'at most once per stream',
    ]) {
      expect(RECORD_HELP.replaceAll('\n', ' ').replace(/\s+/gu, ' '), topic).toContain(topic);
    }
  });
});

describe('record with output expectations', () => {
  it('records a normalized expectation end to end and writes no host path', async () => {
    const root = await project(
      "console.log('checking'); console.error('cwd=' + process.cwd()); console.error('took 12ms'); process.exitCode = 1;\n",
    );
    const resolved = await realpath(root);
    const { io, output } = capture();

    const result = await runCli(
      recordArguments(
        root,
        '--expect-stdout-exact',
        '--expect-stderr-normalized',
        `cwd=${resolved}`,
        '--expect-stderr-normalized',
        'took 12ms',
      ),
      io,
    );

    expect(result.exit_code).toBe(0);
    expect(output()).toContain('  stdout is exactly: "checking\\n"');
    expect(output()).toContain('  stderr contains after normalization: "cwd=<project>"');
    expect(output()).toContain('  stderr contains after normalization: "took <duration>"');
    expect(output()).toContain(
      '  normalization: line endings, terminal escape sequences, trailing whitespace, paths (<project>, <tmp>), Node.js version, Node.js internal locations, process IDs, durations',
    );
    expect(output()).toContain('Artifact created.');
    expect(output()).not.toContain(root);
    expect(output()).not.toContain(resolved);

    const written = await readFile(path.join(root, 'failure.proofissue'), 'utf8');
    expect(written).not.toContain(root);
    expect(written).not.toContain(resolved);
    expect(written).toContain('- mode: exact');
    expect(written).toContain('value: "cwd=<project>"');

    const inspected = capture();
    const inspection = await runCli(
      ['inspect', path.join(root, 'failure.proofissue'), '--json'],
      inspected.io,
    );
    expect(inspection.exit_code).toBe(0);
    const summary = JSON.parse(inspected.output()) as {
      inspection: { expectations: Record<string, unknown> };
    };
    expect(summary.inspection.expectations['stdout_expectations']).toEqual([
      { mode: 'exact', normalize: [] },
    ]);
    expect(summary.inspection.expectations['stderr_expectations']).toHaveLength(2);
    expect(inspected.output()).not.toContain('<project>');
  });

  it('fails before running the command for an expectation that cannot be stored', async () => {
    const root = await project(
      "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'x'); console.error('x'); process.exitCode = 1;\n",
    );
    const { io, output } = capture();

    const result = await runCli(
      recordArguments(root, '--expect-stderr-normalized', 'x'.repeat(9000)),
      io,
    );

    expect(result.exit_code).toBe(1);
    expect(output()).toContain(
      'Recording failed: Expected output literals exceed artifact limits.',
    );
    expect(await exists(path.join(root, 'ran.txt'))).toBe(false);
    expect(await exists(path.join(root, 'failure.proofissue'))).toBe(false);
  });

  it('explains why an exact expectation cannot be recorded', async () => {
    const root = await project("process.stderr.write('x'.repeat(9000)); process.exitCode = 1;\n");
    const { io, output } = capture();

    const result = await runCli(recordArguments(root, '--expect-stderr-exact'), io);

    expect(result.exit_code).toBe(1);
    expect(output()).toContain(
      'Recording failed: The recorded stderr is larger than 8192 bytes, so an exact expectation cannot store it. Match part of it with a normalized literal instead.',
    );
    expect(await exists(path.join(root, 'failure.proofissue'))).toBe(false);
  });

  it('refuses a normalized literal the recording does not contain', async () => {
    const root = await project("console.error('failure'); process.exitCode = 1;\n");
    const { io, output } = capture();

    const result = await runCli(recordArguments(root, '--expect-stderr-normalized', 'other'), io);

    expect(result.exit_code).toBe(1);
    expect(output()).toContain(
      'Recording failed: An expected stderr literal was not observed in the normalized output.',
    );
  });
});
