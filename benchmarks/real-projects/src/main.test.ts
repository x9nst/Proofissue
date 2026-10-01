import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseOptions, runMain, type ExitCode, type MainDeps, type MainIo } from './main.js';
import {
  SAMPLE_CLI_PATH,
  SAMPLE_IMAGE,
  SAMPLE_NODE_PATH,
  cleanupTrialHarnesses,
  createFakeWorld,
  failedOutcome,
  sampleCase,
  temporaryDirectory,
  type FakeOptions,
  type FakeWorld,
} from './test-support.js';

afterEach(cleanupTrialHarnesses);

const committedManifest = readFileSync(
  fileURLToPath(new URL('../cases.json', import.meta.url)),
  'utf8',
);

const sampleManifest = JSON.stringify({
  manifest_version: 1,
  image: SAMPLE_IMAGE,
  cases: [sampleCase],
});

interface Run {
  readonly code: ExitCode;
  readonly out: string;
  readonly err: string;
}

const execute = async (argv: readonly string[], deps: MainDeps): Promise<Run> => {
  let out = '';
  let err = '';
  const io: MainIo = {
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  };
  const code = await runMain(argv, deps, io);
  return { code, out, err };
};

const baseDeps = (overrides: Partial<MainDeps> = {}): MainDeps => {
  let tick = 0;
  return {
    platform: 'linux',
    arch: 'x64',
    env: { PATH: '/mnt/ci/bin' },
    exec: () => Promise.reject(new Error('No executor was expected.')),
    now: () => {
      tick += 100;
      return tick;
    },
    readText: () => Promise.resolve(committedManifest),
    fileExists: () => Promise.resolve(true),
    systemInfo: () => ({
      platform: 'linux',
      arch: 'x64',
      kernelRelease: '6.11.0',
      cpuCount: 4,
      cpuModel: 'Example CPU',
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      nodeVersion: '24.18.0',
    }),
    nodePath: SAMPLE_NODE_PATH,
    moduleDirectory: path.resolve('benchmarks', 'real-projects', 'dist'),
    homeDirectory: undefined,
    tmpDirectory: path.resolve('tmp-not-used'),
    ...overrides,
  };
};

const cliPath = path.resolve(SAMPLE_CLI_PATH);

interface RunFixture {
  readonly deps: MainDeps;
  readonly world: FakeWorld;
  readonly work: string;
  readonly output: string;
  readonly diagnostics: string;
  readonly args: readonly string[];
}

const runFixture = async (
  options: FakeOptions = {},
  overrides: Partial<MainDeps> = {},
): Promise<RunFixture> => {
  const root = await temporaryDirectory('trial-main-');
  const world = createFakeWorld({
    cliPath,
    nodePath: SAMPLE_NODE_PATH,
    files: [...sampleCase.reproduction_files, ...sampleCase.subject_files],
    options,
  });
  const work = path.join(root, 'work');
  const output = path.join(root, 'out');
  const diagnostics = path.join(root, 'diag');
  return {
    deps: baseDeps({
      exec: world.exec,
      readText: () => Promise.resolve(sampleManifest),
      moduleDirectory: root,
      tmpDirectory: root,
      ...overrides,
    }),
    world,
    work,
    output,
    diagnostics,
    args: [
      'run',
      '--cases',
      'X1',
      '--work-dir',
      work,
      '--output',
      output,
      '--diagnostics',
      diagnostics,
      '--cli',
      cliPath,
    ],
  };
};

describe('parseOptions', () => {
  it('reads name and value pairs, including empty values', () => {
    const parsed = parseOptions('list', ['--set', 'pilot', '--cases', '']);

    expect(parsed).toEqual({
      ok: true,
      values: new Map([
        ['--set', 'pilot'],
        ['--cases', ''],
      ]),
    });
  });

  it('rejects unknown, repeated, and valueless options', () => {
    expect(parseOptions('list', ['--bogus', 'x']).ok).toBe(false);
    expect(parseOptions('list', ['--set', 'a', '--set', 'b']).ok).toBe(false);
    expect(parseOptions('list', ['--set']).ok).toBe(false);
    expect(parseOptions('list', ['pilot']).ok).toBe(false);
    expect(parseOptions('list', ['--work-dir', 'x']).ok).toBe(false);
  });
});

describe('list', () => {
  it('prints the compact GitHub output lines for a set', async () => {
    const result = await execute(
      ['list', '--set', 'pilot', '--cases', '', '--ref', 'main'],
      baseDeps(),
    );

    expect(result.code).toBe(0);
    expect(result.out).toMatch(/^cases=\["N1","T1","M3"\]\nimage=node@sha256:[a-f0-9]{64}\n$/u);
  });

  it('lets a case list win and takes the set from the branch name when nothing else is given', async () => {
    expect((await execute(['list', '--cases', 'T1,N1'], baseDeps())).out).toContain(
      'cases=["T1","N1"]',
    );
    expect(
      (
        await execute(
          ['list', '--set', '', '--cases', '', '--ref', 'trials/pilot/run-3'],
          baseDeps(),
        )
      ).out,
    ).toContain('cases=["N1","T1","M3"]');
  });

  it('exits 1 for an empty or invalid selection and prints nothing to the outputs', async () => {
    for (const argv of [
      ['list', '--set', '', '--cases', '', '--ref', 'main'],
      ['list', '--set', 'missing'],
      ['list', '--cases', 'Z9'],
      ['list', '--cases', 'not an id'],
    ]) {
      const result = await execute(argv, baseDeps());
      expect(result.code, argv.join(' ')).toBe(1);
      expect(result.out).toBe('');
      expect(result.err).not.toBe('');
    }
  });

  it('exits 1 for an unreadable or invalid manifest and 2 for bad options', async () => {
    const unreadable = await execute(
      ['list', '--set', 'pilot'],
      baseDeps({ readText: () => Promise.reject(new Error('nope')) }),
    );
    const invalid = await execute(
      ['list', '--set', 'pilot'],
      baseDeps({ readText: () => Promise.resolve('{') }),
    );

    expect(unreadable.code).toBe(1);
    expect(invalid.code).toBe(1);
    expect(invalid.err).toContain('manifest is invalid');
    expect((await execute(['list', '--bogus', 'x'], baseDeps())).code).toBe(2);
  });

  it('never echoes a hostile input into the output', async () => {
    const hostile = '::set-output name=x::y';
    const result = await execute(['list', '--cases', hostile], baseDeps());

    expect(result.code).toBe(1);
    expect(result.err).not.toContain('::');
    expect(result.err).not.toContain('set-output');
  });
});

describe('run', () => {
  it('runs the selected case, writes its outputs, and exits 0 when it is confirmed', async () => {
    const fixture = await runFixture();
    const result = await execute(fixture.args, fixture.deps);

    expect(result.code).toBe(0);
    expect(result.err).toBe('');
    expect(result.out).toContain('Running 1 case(s): X1');
    expect(result.out).toContain('[X1] outcome: confirmed all_stages_passed');
    for (const line of result.out.trimEnd().split('\n')) {
      expect(line.startsWith('Running ') || line.startsWith('[X1] ')).toBe(true);
    }
    const written = JSON.parse(
      await readFile(path.join(fixture.output, 'X1', 'X1.result.json'), 'utf8'),
    ) as { outcome: { classification: string } };
    expect(written.outcome.classification).toBe('confirmed');
    expect(await readFile(path.join(fixture.output, 'X1', 'X1.summary.md'), 'utf8')).toContain(
      '## Trial X1: confirmed',
    );
    expect(await stat(path.join(fixture.diagnostics, 'X1', 'README.txt'))).toBeTruthy();
  });

  it('exits 0 for a finding, because the evidence is valid', async () => {
    const fixture = await runFixture({
      recordFailure: 'An expected stdout literal was not observed in retained output.',
    });
    const result = await execute(fixture.args, fixture.deps);

    expect(result.code).toBe(0);
    expect(result.out).toContain('outcome: finding record_refused');
  });

  it('exits 1 for a setup failure', async () => {
    const fixture = await runFixture({ preflight: failedOutcome(1, 'unrelated output\n') });
    const result = await execute(fixture.args, fixture.deps);

    expect(result.code).toBe(1);
    expect(result.out).toContain('outcome: setup_failed preflight_expectation_missing');
  });

  it('exits 1 with a cli_missing harness error when the CLI build is absent', async () => {
    const fixture = await runFixture({}, { fileExists: () => Promise.resolve(false) });
    const result = await execute(fixture.args, fixture.deps);

    expect(result.code).toBe(1);
    expect(result.out).toContain('outcome: harness_error cli_missing');
    expect(fixture.world.cliCalls('record')).toHaveLength(0);
  });

  it('refuses a host that is not x64 Linux, before running anything', async () => {
    for (const host of [
      { platform: 'win32', arch: 'x64' },
      { platform: 'darwin', arch: 'arm64' },
      { platform: 'linux', arch: 'arm64' },
    ]) {
      const fixture = await runFixture({}, host);
      const result = await execute(fixture.args, fixture.deps);

      expect(result.code).toBe(2);
      expect(result.err).toContain('not supported');
      expect(fixture.world.calls).toHaveLength(0);
    }
  });

  it('rejects bad arguments with exit 2', async () => {
    const fixture = await runFixture();
    const without = (name: string): string[] => {
      const copy = [...fixture.args];
      const index = copy.indexOf(name);
      copy.splice(index, 2);
      return copy;
    };

    for (const argv of [
      without('--work-dir'),
      without('--output'),
      without('--diagnostics'),
      without('--cases'),
      [...fixture.args, '--runs', '11'],
      [...fixture.args, '--runs', '0'],
      [...fixture.args, '--runs', 'x'],
      [...fixture.args, '--baseline-runs', '6'],
      [...fixture.args, '--fix-runs', '4'],
      [...fixture.args, '--bogus', '1'],
      ['run', ...fixture.args.slice(1).map((value) => (value === 'X1' ? 'Z9' : value))],
    ]) {
      const result = await execute(argv, fixture.deps);
      expect(result.code, argv.join(' ')).toBe(2);
    }
    expect(fixture.world.calls).toHaveLength(0);
  });

  it('rejects directories that contain each other', async () => {
    const fixture = await runFixture();
    const nested = fixture.args.map((value) =>
      value === fixture.output ? path.join(fixture.work, 'out') : value,
    );

    expect((await execute(nested, fixture.deps)).code).toBe(2);
  });

  it('rejects an invalid manifest with exit 2', async () => {
    const fixture = await runFixture(
      {},
      { readText: () => Promise.resolve('{"manifest_version":1}') },
    );

    expect((await execute(fixture.args, fixture.deps)).code).toBe(2);
  });

  it('takes the set when --cases is empty', async () => {
    const fixture = await runFixture();
    const args = fixture.args.map((value, index, all) =>
      all[index - 1] === '--cases' ? '' : value,
    );
    args.push('--set', 'unit');
    const result = await execute(args, fixture.deps);

    expect(result.code).toBe(0);
    expect(result.out).toContain('Running 1 case(s): X1');
  });

  it('honors --runs, --baseline-runs, and --fix-runs', async () => {
    const fixture = await runFixture();
    const result = await execute(
      [...fixture.args, '--runs', '2', '--baseline-runs', '1', '--fix-runs', '2'],
      fixture.deps,
    );

    expect(result.code).toBe(0);
    expect(fixture.world.cliCalls('replay')).toHaveLength(1 + 2 + 1 + 2);
  });
});

describe('summarize', () => {
  const summarize = async (
    fixture: RunFixture,
    extra: readonly string[],
  ): Promise<{ run: Run; directory: string }> => {
    await execute(fixture.args, fixture.deps);
    const directory = path.join(path.dirname(fixture.output), 'summary');
    const run = await execute(
      ['summarize', '--input', fixture.output, '--output', directory, ...extra],
      baseDeps(),
    );
    return { run, directory };
  };

  it('writes summary.json and summary.md and exits 0 when every expected case is present', async () => {
    const fixture = await runFixture();
    const { run, directory } = await summarize(fixture, ['--expected-cases', '["X1"]']);

    expect(run.code).toBe(0);
    expect(run.out).toContain('Summarized 1 case(s): 1 confirmed');
    const json = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8')) as {
      totals: { cases: number; confirmed: number };
      missing_cases: string[];
    };
    expect(json.totals).toMatchObject({ cases: 1, confirmed: 1 });
    expect(json.missing_cases).toEqual([]);
    expect(await readFile(path.join(directory, 'summary.md'), 'utf8')).toContain(
      '# Real-project trial summary',
    );
  });

  it('lists an expected case without a result as missing and exits 1', async () => {
    const fixture = await runFixture();
    const { run, directory } = await summarize(fixture, ['--expected-cases', '["X1","T1"]']);

    expect(run.code).toBe(1);
    const json = JSON.parse(await readFile(path.join(directory, 'summary.json'), 'utf8')) as {
      missing_cases: string[];
    };
    expect(json.missing_cases).toEqual(['T1']);
  });

  it('exits 1 when a case needed setup it did not get', async () => {
    const fixture = await runFixture({ hostInstall: failedOutcome(1) });
    const { run } = await summarize(fixture, []);

    expect(run.code).toBe(1);
  });

  it('exits 2 for bad arguments', async () => {
    const deps = baseDeps();

    expect((await execute(['summarize', '--input', 'x'], deps)).code).toBe(2);
    expect((await execute(['summarize', '--output', 'x'], deps)).code).toBe(2);
    expect(
      (
        await execute(
          ['summarize', '--input', 'a', '--output', 'b', '--expected-cases', 'nope'],
          deps,
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await execute(
          ['summarize', '--input', 'a', '--output', 'b', '--expected-cases', '{"a":1}'],
          deps,
        )
      ).code,
    ).toBe(2);
    expect(
      (
        await execute(
          ['summarize', '--input', 'a', '--output', 'b', '--expected-cases', '["bad id"]'],
          deps,
        )
      ).code,
    ).toBe(2);
  });
});

describe('runMain', () => {
  it('prints usage and exits 2 for an unknown or missing command', async () => {
    expect((await execute([], baseDeps())).code).toBe(2);
    const unknown = await execute(['frobnicate'], baseDeps());
    expect(unknown.code).toBe(2);
    expect(unknown.err).toContain('Usage');
  });
});
