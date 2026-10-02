import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ReplayOperationResult } from '@proofissue/application';

import {
  CLI_HELP,
  parseRecordArguments,
  RECORD_HELP,
  renderReplayResult,
  runCli,
  type CliIo,
} from './index.js';

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

// The path the reporter chose for the artifact is echoed back as given, in the preview and in the
// suggested commands; everything else must
// stay free of host paths.
const withoutOutputPath = (text: string): string =>
  text.replace(/^(?:(?:Artifact file|Saved): | {2}proofissue ).*$/gmu, '');

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
    expect(output()).toContain('proofissue record --help');
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
    expect(output()).toContain('Artifact created.\nSaved: ');
    expect(output()).toContain('A maintainer replays it on x86-64 Linux with Docker:');
    expect(withoutOutputPath(output())).not.toContain(root);
    expect(withoutOutputPath(output())).not.toContain(resolved);

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

describe('replay rendering of output matching', () => {
  const read = async (name: string): Promise<ReplayOperationResult> =>
    JSON.parse(
      await readFile(`tests/fixtures/results/v1/${name}`, 'utf8'),
    ) as ReplayOperationResult;

  it('renders normalized evidence from the result fixture', async () => {
    const rendered = renderReplayResult(await read('reproduced-normalized.json'));

    expect(rendered).toContain('Replay result: reproduced');
    expect(rendered).toContain('Matched: Replay stdout matched the expected output exactly.');
    expect(rendered).toContain(
      'Matched: Expected stderr text was present after normalization; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.',
    );
    expect(rendered).toContain(
      'Matched: Normalized replay stderr matched the expected output exactly; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.',
    );
  });

  it('renders what a fix changed, with positions and without output text', async () => {
    const rendered = renderReplayResult(await read('not-reproduced-output-modes.json'));

    expect(rendered).toContain('Replay result: not_reproduced');
    expect(rendered).toContain('Different: Expected exit code 1 but received 0.');
    expect(rendered).toContain(
      'Different: Normalized replay stderr differed from the expected output at line 1, column 1 (expected 76 characters, received 0); normalization changed nothing in the replay output.',
    );
  });
});

describe('record --json', () => {
  const captureBoth = (): { io: CliIo; stderr: () => string; stdout: () => string } => {
    let out = '';
    let err = '';
    return {
      io: {
        confirm: () => Promise.resolve(false),
        write: (text) => {
          out += text;
        },
        writeError: (text) => {
          err += text;
        },
      },
      stderr: () => err,
      stdout: () => out,
    };
  };

  it('record --json --yes prints one versioned result line and writes the preview to stderr', async () => {
    const root = await project("console.error('failure marker'); process.exitCode = 1;\n");
    const { io, stderr, stdout } = captureBoth();

    const result = await runCli(
      recordArguments(root, '--json', '--expect-stderr', 'failure marker'),
      io,
    );

    expect(result.exit_code).toBe(0);
    expect(stdout().endsWith('\n')).toBe(true);
    expect(stdout().trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(stdout())).toMatchObject({
      result_schema_version: 1,
      operation: 'record',
      status: 'created',
      artifact_version: 1,
      artifact_digest: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
      errors: [],
    });
    expect(stdout()).not.toContain('failure marker');
    expect(stderr()).toContain('ProofIssue recording preview');
    expect(stderr()).toContain('failure marker');
    expect(await exists(path.join(root, 'failure.proofissue'))).toBe(true);
  });

  it('prints a failed recording as one result line with the exit code 1', async () => {
    const root = await project("console.error('failure marker'); process.exitCode = 1;\n");
    const { io, stderr, stdout } = captureBoth();

    const result = await runCli(
      recordArguments(root, '--json', '--expect-stderr', 'never printed'),
      io,
    );

    expect(result.exit_code).toBe(1);
    const parsed = JSON.parse(stdout()) as { errors: { message: string }[]; status: string };
    expect(parsed.status).toBe('invalid_input');
    expect(parsed.errors[0]?.message).toContain('was not observed in retained output.');
    expect(stderr()).toBe('');
  });

  it('shows no preview when the Io has no error stream, and still prints one line', async () => {
    const root = await project("console.error('failure marker'); process.exitCode = 1;\n");
    const { io, output } = capture();

    const result = await runCli(
      recordArguments(root, '--json', '--expect-stderr', 'failure marker'),
      io,
    );

    expect(result.exit_code).toBe(0);
    expect(output().trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(output())).toMatchObject({ operation: 'record', status: 'created' });
  });

  it('record --json without --yes is a usage error', async () => {
    const root = await project("console.error('failure marker'); process.exitCode = 1;\n");
    const { io, output } = capture();
    const withoutYes = recordArguments(root, '--json', '--expect-stderr', 'failure marker').filter(
      (argument) => argument !== '--yes',
    );

    const result = await runCli(withoutYes, io);

    expect(result.exit_code).toBe(2);
    expect(output()).toContain('--json needs --yes');
    expect(await exists(path.join(root, 'failure.proofissue'))).toBe(false);
  });
});
