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

const raw = String.raw;
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

// The path the reporter chose for the artifact is echoed back as given; everything else must
// stay free of host paths.
const withoutOutputPath = (text: string): string =>
  text.replace(/^(Artifact file|Saved): .*$/gmu, '');

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
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-regex-'));
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

describe('regex record options', () => {
  it('parses each regex option into a normalized pattern expectation in command-line order', () => {
    const request = parse(
      '--expect-stderr-regex',
      raw`took \d+ms`,
      '--expect-stderr',
      'raw one',
      '--expect-stdout-regex',
      raw`checking \w+`,
      '--expect-stderr-normalized',
      'literal',
      '--expect-stderr-regex',
      raw`at <project>/a\.mjs`,
    );

    expect(request.expect_stderr).toEqual([
      { mode: 'regex', normalized: true, pattern: raw`took \d+ms` },
      'raw one',
      { mode: 'contains', normalized: true, value: 'literal' },
      { mode: 'regex', normalized: true, pattern: raw`at <project>/a\.mjs` },
    ]);
    expect(request.expect_stdout).toEqual([
      { mode: 'regex', normalized: true, pattern: raw`checking \w+` },
    ]);
  });

  it('requires a value, so a pattern can never be taken from the next option', () => {
    for (const option of ['--expect-stdout-regex', '--expect-stderr-regex']) {
      expect(() => parseRecordArguments([...required, option, '--', 'node', 'a.mjs'])).toThrow(
        `${option} requires a value.`,
      );
    }
  });

  it('is not an exact option: a repeated regex is allowed, and regex combines with exact', () => {
    const request = parse(
      '--expect-stderr-regex',
      'one+',
      '--expect-stderr-regex',
      'two+',
      '--expect-stderr-exact',
    );

    expect(request.expect_stderr).toHaveLength(3);
  });

  it('documents the regex options and the pattern language in the help', () => {
    for (const option of ['--expect-stdout-regex', '--expect-stderr-regex']) {
      expect(RECORD_HELP, option).toContain(option);
      expect(CLI_HELP, option).toContain(option);
    }
    const help = RECORD_HELP.replaceAll('\n', ' ').replace(/\s+/gu, ' ');
    for (const topic of [
      'linear time',
      'lookaround',
      'backreferences',
      '1024 characters',
      'checked before the command runs',
      raw`<project>/test/a\.mjs:\d+:\d+`,
    ]) {
      expect(help, topic).toContain(topic);
    }
  });
});

describe('record with regex expectations', () => {
  it('records a pattern end to end, previews it, and writes no host path', async () => {
    const root = await project(
      "console.log('checking'); console.error('cwd=' + process.cwd()); console.error('took 12ms'); process.exitCode = 1;\n",
    );
    const resolved = await realpath(root);
    const { io, output } = capture();

    const result = await runCli(
      recordArguments(
        root,
        '--expect-stdout-regex',
        raw`^check\w+$`,
        '--expect-stderr-regex',
        raw`took <duration>`,
        '--expect-stderr-regex',
        raw`cwd=<project>$`,
      ),
      io,
    );

    expect(result.exit_code).toBe(0);
    expect(output()).toContain(`  stdout matches pattern after normalization: "^check\\\\w+$"`);
    expect(output()).toContain('  stderr matches pattern after normalization: "took <duration>"');
    expect(output()).toContain('  stderr matches pattern after normalization: "cwd=<project>$"');
    expect(output()).toContain(
      '  normalization: line endings, terminal escape sequences, trailing whitespace, paths (<project>, <tmp>), Node.js version, Node.js internal locations, process IDs, durations',
    );
    expect(output()).toContain('Artifact created.');
    expect(withoutOutputPath(output())).not.toContain(root);
    expect(withoutOutputPath(output())).not.toContain(resolved);

    const written = await readFile(path.join(root, 'failure.proofissue'), 'utf8');
    expect(written).not.toContain(root);
    expect(written).not.toContain(resolved);
    expect(written).toContain('- mode: regex');

    const inspected = capture();
    const inspection = await runCli(
      ['inspect', path.join(root, 'failure.proofissue'), '--json'],
      inspected.io,
    );
    const summary = JSON.parse(inspected.output()) as {
      inspection: { expectations: Record<string, unknown> };
    };
    expect(inspection.exit_code).toBe(0);
    expect(summary.inspection.expectations['stdout_expectations']).toEqual([
      expect.objectContaining({ mode: 'regex' }) as unknown,
    ]);
    expect(summary.inspection.expectations['stderr_expectations']).toHaveLength(2);
    expect(inspected.output()).not.toContain('took');
  });

  it('fails before running the command for an unsupported pattern', async () => {
    const root = await project(
      "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'x'); console.error('x'); process.exitCode = 1;\n",
    );

    for (const [pattern, message] of [
      ['(?<=a)x', 'Lookbehind assertions are not supported. (offset 0)'],
      [raw`(x)\1`, 'Backreferences are not supported. (offset 3)'],
      ['x*', 'Pattern can match without consuming output'],
    ] as const) {
      const { io, output } = capture();

      const result = await runCli(recordArguments(root, '--expect-stderr-regex', pattern), io);

      expect(result.exit_code).toBe(1);
      expect(output()).toContain(
        `Recording failed: An expected output pattern is not supported: ${message}`,
      );
      expect(await exists(path.join(root, 'ran.txt'))).toBe(false);
      expect(await exists(path.join(root, 'failure.proofissue'))).toBe(false);
    }
  });

  it('refuses a pattern the recording does not match', async () => {
    const root = await project("console.error('failure'); process.exitCode = 1;\n");
    const { io, output } = capture();

    const result = await runCli(recordArguments(root, '--expect-stderr-regex', 'other+'), io);

    expect(result.exit_code).toBe(1);
    expect(output()).toContain(
      'Recording failed: An expected stderr pattern did not match the normalized recorded output.',
    );
    expect(await exists(path.join(root, 'failure.proofissue'))).toBe(false);
  });
});

describe('replay rendering of pattern results', () => {
  const read = async (name: string): Promise<ReplayOperationResult> =>
    JSON.parse(
      await readFile(`tests/fixtures/results/v1/${name}`, 'utf8'),
    ) as ReplayOperationResult;

  it('renders pattern evidence from the result fixture', async () => {
    const rendered = renderReplayResult(await read('reproduced-regex.json'));

    expect(rendered).toContain('Replay result: reproduced');
    expect(rendered).toContain('Matched: Replay stdout matched the expected pattern.');
    expect(rendered).toContain(
      'Matched: Normalized replay stderr matched the expected pattern; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.',
    );
  });

  it('renders pattern differences and the step limit', async () => {
    const rendered = renderReplayResult(await read('not-reproduced-regex.json'));

    expect(rendered).toContain('Replay result: not_reproduced');
    expect(rendered).toContain(
      'Different: Normalized replay stderr did not match the expected pattern; normalization changed nothing in the replay output.',
    );
    expect(rendered).toContain(
      'Different: The stderr pattern could not be evaluated within the deterministic limit of 20000000 steps.',
    );
  });
});
