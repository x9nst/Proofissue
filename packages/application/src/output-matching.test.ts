import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  parseAndValidateArtifact,
  serializeArtifact,
  type ArtifactOutputExpectationV1,
  type ArtifactV1,
} from '@proofissue/artifact-schema';
import { createMatcher } from '@proofissue/matcher';
import { DEFAULT_OUTPUT_NORMALIZATION, EMPTY_OUTPUT_PATH_CONTEXT } from '@proofissue/output-rules';
import type { RecordCapture, Recorder } from '@proofissue/recorder';
import type { Runner } from '@proofissue/runner';

import {
  createRecordApplicationService,
  createReplayApplicationService,
  createStaticArtifactApplicationServices,
  type RecordConfirmation,
  type RecordPreview,
} from './index.js';

const ESC = String.fromCharCode(27);
const CANONICAL = 'tests/fixtures/artifacts/v1/valid/canonical.proofissue';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-output-matching-'));
  roots.push(root);
  return root;
};

const baseArtifact = async (): Promise<ArtifactV1> => {
  const parsed = parseAndValidateArtifact(await readFile(CANONICAL));
  if (!parsed.ok) throw new Error('The canonical fixture is invalid.');
  const { artifact } = parsed;
  // Only the artifact's own fields: a validated artifact carries a digest the schema rejects.
  return {
    version: 1,
    environment: artifact.environment,
    capture: artifact.capture,
    command: artifact.command,
    files: artifact.files,
    expect: artifact.expect,
    limits: artifact.limits,
    redaction: artifact.redaction,
  };
};

const artifactFile = async (
  stdout: readonly ArtifactOutputExpectationV1[],
  stderr: readonly ArtifactOutputExpectationV1[],
): Promise<string> => {
  const base = await baseArtifact();
  const file = path.join(await scratch(), 'artifact.proofissue');
  await writeFile(file, serializeArtifact({ ...base, expect: { exit_code: 1, stdout, stderr } }));
  return file;
};

const stream = (text: string) => ({
  decoded_text: text,
  discarded_bytes: 0,
  had_decoding_replacement: false,
  retained_bytes: Buffer.byteLength(text),
  total_bytes: Buffer.byteLength(text),
  truncated: false,
});

const runnerPrinting = (stdout: string, stderr: string, exitCode = 1): Runner => ({
  run: () =>
    Promise.resolve({
      cleanup: { completed: true, attempted_resources: [], residual_resources: [] },
      effective_limits: {
        cpus: 1,
        memory_mb: 512,
        output_bytes_per_stream: 1_048_576,
        processes: 64,
        timeout_seconds: 60,
        writable_workspace_mb: 64,
      },
      events: [],
      execution: {
        duration_ms: 25,
        exit_code: exitCode,
        stdout: stream(stdout),
        stderr: stream(stderr),
        termination_reason: 'exited',
      },
      substituted_paths: [],
    }),
});

// What the replayed program prints inside the container, as a reporter's Windows run, a
// color terminal, and the container would each print it differently.
const CONTAINER_STDERR = [
  `${ESC}[31mExpected 4 from calculate(2) (12.3ms)${ESC}[0m`,
  '    at file:///workspace/reproduction.mjs:3:9',
  '',
].join('\r\n');

const replay = async (
  artifactPath: string,
  stdout: string,
  stderr: string,
  mode: 'current_checkout' | 'snapshot' = 'snapshot',
) =>
  await createReplayApplicationService({ runner: runnerPrinting(stdout, stderr) }).replay({
    artifact_path: artifactPath,
    mode,
  });

describe('replay interprets output expectations by their mode', () => {
  it('interprets every expectation by its declared mode, not as a literal', async () => {
    const file = await artifactFile([], [{ mode: 'exact', value: 'Expected 4' }]);

    const result = await replay(file, '', 'Expected 4 from calculate(2)');

    // The old mapping dropped the mode, so this exact expectation matched as a substring.
    expect(result.status).toBe('not_reproduced');
    expect(result.differences).toEqual([
      {
        kind: 'stderr_differs',
        message:
          'Replay stderr differed from the expected output at line 1, column 11 (expected 10 characters, received 28).',
      },
    ]);
  });

  it('reproduces normalized contains and exact expectations from container-shaped output', async () => {
    const file = await artifactFile(
      [{ mode: 'exact', value: 'checking\n' }],
      [
        {
          mode: 'contains',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value: 'Expected 4 from calculate(2) (<duration>)',
        },
        {
          mode: 'exact',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value:
            'Expected 4 from calculate(2) (<duration>)\n    at <project>/reproduction.mjs:3:9\n',
        },
      ],
    );

    const result = await replay(file, 'checking\n', CONTAINER_STDERR);

    expect(result.status).toBe('reproduced');
    expect(result.evidence.map((item) => item.kind)).toEqual([
      'exit_code',
      'stdout_exact',
      'stderr_contains',
      'stderr_exact',
    ]);
    expect(result.evidence[1]).not.toHaveProperty('normalization');
    expect(result.evidence[3]).toMatchObject({
      message:
        'Normalized replay stderr matched the expected output exactly; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.',
      normalization: {
        rules: [...DEFAULT_OUTPUT_NORMALIZATION],
        changes: [
          { rule: 'line_endings', count: 2 },
          { rule: 'ansi_escapes', count: 2 },
          { rule: 'paths', count: 1 },
          { rule: 'durations', count: 1 },
        ],
      },
    });
  });

  it('replays the exact and normalized compatibility fixtures from container-shaped output', async () => {
    const stdout = 'checking calculate(2)\n';
    const stderr =
      'Expected 4 from calculate(2) (7ms)\n    at file:///workspace/reproduction.mjs\n';

    for (const name of ['exact-output', 'normalized-output']) {
      const result = await replay(
        `tests/fixtures/artifacts/v1/valid/${name}.proofissue`,
        stdout,
        stderr,
      );

      expect(result.status, name).toBe('reproduced');
    }
  });

  it('classifies a corrected program as not reproduced for normalized expectations', async () => {
    const file = await artifactFile(
      [],
      [
        {
          mode: 'contains',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value: 'Expected 4 from calculate(2) (<duration>)',
        },
      ],
    );

    const fixed = await createReplayApplicationService({
      runner: runnerPrinting('', '', 0),
    }).replay({ artifact_path: file, mode: 'snapshot' });

    expect(fixed.status).toBe('not_reproduced');
    expect(fixed.differences.map((item) => item.kind)).toEqual(['exit_code', 'stderr_missing']);
  });

  it('explains normalized differences without publishing output', async () => {
    const secretish = 'synthetic-output-text-that-must-not-appear';
    const file = await artifactFile(
      [],
      [
        {
          mode: 'contains',
          normalize: ['line_endings', 'durations'],
          value: 'Expected 5 from calculate(2) (<duration>)',
        },
        { mode: 'exact', normalize: ['line_endings'], value: 'something else\n' },
      ],
    );

    const result = await replay(
      file,
      '',
      `Expected 4 from calculate(2) (9ms) ${secretish}\r\nnext\r\n`,
    );

    expect(result.status).toBe('not_reproduced');
    expect(result.differences).toEqual([
      {
        kind: 'stderr_missing',
        message:
          'Expected stderr text was not present after normalization; normalization changed 2 line endings and 1 duration in the replay output.',
        normalization: {
          rules: ['line_endings', 'durations'],
          changes: [
            { rule: 'line_endings', count: 2 },
            { rule: 'durations', count: 1 },
          ],
        },
      },
      {
        kind: 'stderr_differs',
        message: expect.stringMatching(
          /^Normalized replay stderr differed from the expected output at line 1, column 1 \(expected 15 characters, received \d+\); normalization changed 2 line endings in the replay output\.$/u,
        ) as string,
        normalization: { rules: ['line_endings'], changes: [{ rule: 'line_endings', count: 2 }] },
      },
    ]);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(secretish);
    expect(encoded).not.toContain('something else');
    expect(encoded).not.toContain('decoded_text');
  });

  it('redacts replay output before the normalized comparison', async () => {
    const token = ['sk', '-proj-', 'abcdefghijklmnopqrstuv'].join('');
    const file = await artifactFile(
      [],
      [{ mode: 'contains', normalize: ['line_endings'], value: 'token' }],
    );

    const result = await replay(file, '', `token ${token}\r\n`);

    expect(result.status).toBe('reproduced');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'replay_output_redacted' }),
    );
  });
});

describe('committed result fixtures', () => {
  const fixtureExpectation = {
    stdout: [{ mode: 'exact', value: 'checking calculate(2)\n' }],
    stderr: [
      {
        mode: 'contains',
        normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
        value: 'Expected 4 from calculate(2) (<duration>)',
      },
      {
        mode: 'exact',
        normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
        value: 'Expected 4 from calculate(2) (<duration>)\n    at <project>/reproduction.mjs\n',
      },
    ],
  } as const;

  const readFixture = async (name: string) =>
    JSON.parse(await readFile(`tests/fixtures/results/v1/${name}`, 'utf8')) as {
      differences: unknown;
      evidence: unknown;
    };

  it('hold exactly the evidence and differences the matcher produces', async () => {
    const file = await artifactFile(fixtureExpectation.stdout, fixtureExpectation.stderr);
    const failing = await replay(
      file,
      'checking calculate(2)\n',
      `${ESC}[31mExpected 4 from calculate(2) (12ms)${ESC}[0m\r\n    at file:///workspace/reproduction.mjs\r\n`,
    );
    const corrected = await createReplayApplicationService({
      runner: runnerPrinting('checking calculate(2)\n', '', 0),
    }).replay({ artifact_path: file, mode: 'current_checkout', against_path: '.' });

    const reproducedFixture = await readFixture('reproduced-normalized.json');
    const correctedFixture = await readFixture('not-reproduced-output-modes.json');

    expect(failing.status).toBe('reproduced');
    expect(failing.evidence).toEqual(reproducedFixture.evidence);
    expect(failing.differences).toEqual(reproducedFixture.differences);
    expect(corrected.status).toBe('not_reproduced');
    expect(corrected.evidence).toEqual(correctedFixture.evidence);
    expect(corrected.differences).toEqual(correctedFixture.differences);
  });
});

describe('inspection of output expectations', () => {
  it('inspection reports modes and rules but never expected values', async () => {
    const file = await artifactFile(
      [{ mode: 'exact', value: 'synthetic stdout value 1' }],
      [
        { mode: 'contains', value: 'synthetic stderr value 2' },
        {
          mode: 'contains',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value: 'synthetic stderr value 3 <duration>',
        },
        { mode: 'exact', normalize: ['line_endings', 'paths'], value: 'synthetic value 4\n' },
      ],
    );

    const result = await createStaticArtifactApplicationServices().inspect({
      artifact_path: file,
    });

    expect(result.status).toBe('inspected');
    expect(result.inspection?.expectations).toEqual({
      exit_code: 1,
      stdout_count: 1,
      stderr_count: 3,
      stdout_expectations: [{ mode: 'exact', normalize: [] }],
      stderr_expectations: [
        { mode: 'contains', normalize: [] },
        { mode: 'contains', normalize: [...DEFAULT_OUTPUT_NORMALIZATION] },
        { mode: 'exact', normalize: ['line_endings', 'paths'] },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('synthetic');
  });

  it('reports raw contains for artifacts that predate the output modes', async () => {
    const result = await createStaticArtifactApplicationServices().inspect({
      artifact_path: CANONICAL,
    });

    expect(result.inspection?.expectations).toEqual({
      exit_code: 1,
      stdout_count: 0,
      stderr_count: 1,
      stdout_expectations: [],
      stderr_expectations: [{ mode: 'contains', normalize: [] }],
    });
  });
});

describe('record application service output expectations', () => {
  const confirmed: RecordConfirmation = {
    reproduction_files_confirmed: true,
    subject_files_confirmed: true,
    write_confirmed: true,
  };

  const setup = async (reproduction: string) => {
    const root = await scratch();
    await mkdir(path.join(root, 'test'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'test', 'reproduction.mjs'), reproduction);
    await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
    return {
      root,
      output: path.join(root, 'failure.proofissue'),
      request: {
        arguments: ['test/reproduction.mjs'],
        environment_image: `node@sha256:${'1'.repeat(64)}`,
        expect_stderr: [],
        expect_stdout: [],
        output_path: path.join(root, 'failure.proofissue'),
        program: 'node' as const,
        project_root: root,
        reproduction_paths: ['test/reproduction.mjs'],
        subject_paths: ['src/subject.mjs'],
      },
    };
  };

  it('the record preview shows normalized values and no host path', async () => {
    const fixture = await setup(
      "console.error('cwd=' + process.cwd()); console.error('took 12ms'); process.exitCode = 1;\n",
    );
    let preview: RecordPreview | undefined;

    const result = await createRecordApplicationService((value) => {
      preview = value;
      return Promise.resolve(confirmed);
    }).record({
      ...fixture.request,
      expect_stderr: [
        { mode: 'contains', normalized: true, value: `cwd=${await realpath(fixture.root)}` },
        { mode: 'contains', normalized: true, value: 'took 12ms' },
        'took',
      ],
      expect_stdout: [],
    });

    expect(result).toMatchObject({ status: 'created', errors: [] });
    expect(preview?.expectations.stderr).toEqual([
      { mode: 'contains', normalize: [...DEFAULT_OUTPUT_NORMALIZATION], value: 'cwd=<project>' },
      { mode: 'contains', normalize: [...DEFAULT_OUTPUT_NORMALIZATION], value: 'took <duration>' },
      { mode: 'contains', normalize: [], value: 'took' },
    ]);
    for (const text of [JSON.stringify(preview), await readFile(fixture.output, 'utf8')]) {
      expect(text).not.toContain(fixture.root);
      expect(text).not.toContain(await realpath(fixture.root));
    }
    const inspected = await createStaticArtifactApplicationServices().inspect({
      artifact_path: fixture.output,
    });
    expect(inspected.inspection?.expectations.stderr_expectations).toHaveLength(3);
  });

  it('previews an exact expectation as the whole normalized stream', async () => {
    const fixture = await setup(
      "console.log('checking'); console.error('failure 5ms'); process.exitCode = 1;\n",
    );
    let preview: RecordPreview | undefined;

    await createRecordApplicationService((value) => {
      preview = value;
      return Promise.resolve(confirmed);
    }).record({
      ...fixture.request,
      expect_stderr: [{ mode: 'exact', normalized: true }],
      expect_stdout: [{ mode: 'exact', normalized: false }],
    });

    expect(preview?.expectations).toEqual({
      exit_code: 1,
      stdout: [{ mode: 'exact', normalize: [], value: 'checking\n' }],
      stderr: [
        {
          mode: 'exact',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value: 'failure <duration>\n',
        },
      ],
    });
  });

  const fakeCapture = async (stderrText: string, claimed: string): Promise<RecordCapture> => {
    const base = await baseArtifact();
    return {
      artifact: {
        ...base,
        expect: {
          exit_code: 1,
          stdout: [],
          stderr: [{ mode: 'contains', value: claimed }],
        },
      },
      duration_ms: 5,
      path_context: EMPTY_OUTPUT_PATH_CONTEXT,
      stderr: stream(stderrText),
      stdout: stream(''),
    };
  };

  it('refuses to write a recording that does not satisfy its own expectations', async () => {
    const root = await scratch();
    const output = path.join(root, 'never.proofissue');
    const recorder: Recorder = {
      capture: async () => await fakeCapture('what was really printed', 'something else entirely'),
    };
    const confirm = vi.fn(() => Promise.resolve(confirmed));

    const result = await createRecordApplicationService(confirm, recorder).record({
      arguments: ['x.mjs'],
      environment_image: `node@sha256:${'1'.repeat(64)}`,
      expect_stderr: ['something else entirely'],
      expect_stdout: [],
      output_path: output,
      program: 'node',
      project_root: root,
      reproduction_paths: ['x.mjs'],
      subject_paths: ['y.mjs'],
    });

    expect(result.status).toBe('invalid_input');
    expect(result.errors).toEqual([
      {
        code: 'policy_rejection',
        message:
          'The recording does not satisfy its own expectations (Expected stderr text was not present.); no artifact was written.',
      },
    ]);
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(result)).not.toContain('what was really printed');
  });

  it('asks the matcher to check the recording and rejects when the matcher disagrees', async () => {
    const root = await scratch();
    const output = path.join(root, 'never.proofissue');
    const recorder: Recorder = {
      capture: async () => await fakeCapture('hello', 'hello'),
    };
    const confirm = vi.fn(() => Promise.resolve(confirmed));
    const disagreeing = {
      match: vi.fn(() => ({
        reproduced: false,
        evidence: [],
        differences: [
          { kind: 'stderr_differs' as const, message: 'A fixed, content-free explanation.' },
        ],
      })),
    };

    const result = await createRecordApplicationService(confirm, recorder, disagreeing).record({
      arguments: ['x.mjs'],
      environment_image: `node@sha256:${'1'.repeat(64)}`,
      expect_stderr: ['hello'],
      expect_stdout: [],
      output_path: output,
      program: 'node',
      project_root: root,
      reproduction_paths: ['x.mjs'],
      subject_paths: ['y.mjs'],
    });

    expect(disagreeing.match).toHaveBeenCalledTimes(1);
    expect(disagreeing.match).toHaveBeenCalledWith(
      expect.objectContaining({
        path_context: EMPTY_OUTPUT_PATH_CONTEXT,
        execution: expect.objectContaining({ exit_code: 1 }) as unknown,
      }),
    );
    expect(result.status).toBe('invalid_input');
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('writes a recording that satisfies its own expectations with the default matcher', async () => {
    const root = await scratch();
    const output = path.join(root, 'created.proofissue');
    const recorder: Recorder = { capture: async () => await fakeCapture('hello there', 'hello') };

    const result = await createRecordApplicationService(
      () => Promise.resolve(confirmed),
      recorder,
      createMatcher(),
    ).record({
      arguments: ['x.mjs'],
      environment_image: `node@sha256:${'1'.repeat(64)}`,
      expect_stderr: ['hello'],
      expect_stdout: [],
      output_path: output,
      program: 'node',
      project_root: root,
      reproduction_paths: ['x.mjs'],
      subject_paths: ['y.mjs'],
    });

    expect(result.status).toBe('created');
  });
});
