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
const raw = String.raw;
const CANONICAL = 'tests/fixtures/artifacts/v1/valid/canonical.proofissue';
const REGEX_FIXTURE = 'tests/fixtures/artifacts/v1/valid/regex-output.proofissue';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const scratch = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-regex-matching-'));
  roots.push(root);
  return root;
};

const baseArtifact = async (): Promise<ArtifactV1> => {
  const parsed = parseAndValidateArtifact(await readFile(CANONICAL));
  if (!parsed.ok) throw new Error('The canonical fixture is invalid.');
  const { artifact } = parsed;
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

// What the replayed program prints inside the container: color codes, CRLF line endings, and the
// container's own paths and timings.
const CONTAINER_STDERR = [
  `${ESC}[31mExpected 4 from calculate(2) (12.3ms)${ESC}[0m`,
  '    at file:///workspace/reproduction.mjs:3:9',
  '',
].join('\r\n');

const replay = async (
  artifactPath: string,
  stdout: string,
  stderr: string,
  exitCode = 1,
  mode: 'current_checkout' | 'snapshot' = 'snapshot',
) =>
  await createReplayApplicationService({
    runner: runnerPrinting(stdout, stderr, exitCode),
  }).replay({
    artifact_path: artifactPath,
    mode,
    ...(mode === 'current_checkout' ? { against_path: '.' } : {}),
  });

const readFixture = async (name: string) =>
  JSON.parse(await readFile(`tests/fixtures/results/v1/${name}`, 'utf8')) as {
    differences: unknown;
    evidence: unknown;
  };

describe('replay interprets regex expectations by their mode', () => {
  it('interprets a regex expectation as a pattern, not as a literal', async () => {
    const file = await artifactFile([], [{ mode: 'regex', value: raw`Expected \d+ from` }]);

    const matched = await replay(file, '', 'Expected 4 from calculate(2)');
    const literal = await replay(file, '', raw`Expected \d+ from`);

    // A literal reading would only match the pattern's own spelling, which is the second output.
    expect(matched.status).toBe('reproduced');
    expect(matched.evidence.map((item) => item.kind)).toEqual(['exit_code', 'stderr_regex']);
    expect(literal.status).toBe('not_reproduced');
    expect(literal.differences.map((item) => item.kind)).toEqual(['stderr_no_match']);
  });

  it('reproduces raw and normalized regex expectations from container-shaped output', async () => {
    const file = await artifactFile(
      [{ mode: 'regex', value: raw`checking calculate\(\d+\)` }],
      [
        {
          mode: 'regex',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value: raw`Expected \d+ from calculate\(\d+\) \(<duration>\)`,
        },
        {
          mode: 'regex',
          normalize: ['line_endings', 'paths'],
          value: raw`at <project>/reproduction\.mjs:\d+:\d+`,
        },
      ],
    );

    const result = await replay(file, 'checking calculate(2)\n', CONTAINER_STDERR);

    expect(result.status).toBe('reproduced');
    expect(result.evidence.map((item) => item.kind)).toEqual([
      'exit_code',
      'stdout_regex',
      'stderr_regex',
      'stderr_regex',
    ]);
    expect(result.evidence[1]).not.toHaveProperty('normalization');
  });

  it('replays the regex compatibility fixture from container-shaped output', async () => {
    const stdout = 'checking calculate(2)\n';
    const stderr =
      'Expected 4 from calculate(2) (7ms)\n    at file:///workspace/reproduction.mjs\n';

    const reproduced = await replay(REGEX_FIXTURE, stdout, stderr);
    const fixed = await replay(REGEX_FIXTURE, stdout, '', 0, 'current_checkout');

    expect(reproduced.status).toBe('reproduced');
    expect(fixed.status).toBe('not_reproduced');
    expect(fixed.differences.map((item) => item.kind)).toEqual([
      'exit_code',
      'stderr_no_match',
      'stderr_no_match',
    ]);
  });

  it('explains regex differences without publishing the pattern or the output', async () => {
    const secretish = 'synthetic-output-text-that-must-not-appear';
    const file = await artifactFile(
      [],
      [
        {
          mode: 'regex',
          normalize: ['line_endings', 'durations'],
          value: raw`Expected 5 from calculate\(\d\) \(<duration>\)`,
        },
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
        kind: 'stderr_no_match',
        message:
          'Normalized replay stderr did not match the expected pattern; normalization changed 2 line endings and 1 duration in the replay output.',
        normalization: {
          rules: ['line_endings', 'durations'],
          changes: [
            { rule: 'line_endings', count: 2 },
            { rule: 'durations', count: 1 },
          ],
        },
      },
    ]);
    const encoded = JSON.stringify(result);
    expect(encoded).not.toContain(secretish);
    expect(encoded).not.toContain('Expected 5');
    expect(encoded).not.toContain('decoded_text');
  });

  it('redacts replay output before the pattern is searched', async () => {
    const token = ['sk', '-proj-', 'abcdefghijklmnopqrstuv'].join('');
    const file = await artifactFile([], [{ mode: 'regex', value: 'token ' }]);

    const result = await replay(
      file,
      '',
      `token ${token}

`,
    );

    expect(result.status).toBe('reproduced');
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'replay_output_redacted' }),
    );
  });
});

describe('committed regex result fixtures', () => {
  it('hold exactly the evidence and differences the matcher produces', async () => {
    const stdout = 'checking calculate(2)\n';
    const reproducing = await artifactFile(
      [{ mode: 'regex', value: raw`checking calculate\(\d+\)` }],
      [
        {
          mode: 'regex',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value: raw`Expected \d+ from calculate\(\d+\) \(<duration>\)`,
        },
        {
          mode: 'regex',
          normalize: ['line_endings', 'paths'],
          value: raw`at <project>/reproduction\.mjs:\d+:\d+`,
        },
      ],
    );
    const failing = await replay(reproducing, stdout, CONTAINER_STDERR);

    const corrected = await artifactFile(
      [{ mode: 'regex', value: raw`checking calculate\(\d+\)` }],
      [
        {
          mode: 'regex',
          normalize: [...DEFAULT_OUTPUT_NORMALIZATION],
          value: raw`Expected \d+ from calculate\(\d+\)`,
        },
        { mode: 'regex', normalize: ['line_endings'], value: '(?:.?){100}x' },
      ],
    );
    // A long stream is what makes the second pattern run into the deterministic step limit.
    const fixed = await replay(corrected, stdout, 'a'.repeat(1_048_576), 0, 'current_checkout');

    const reproducedFixture = await readFixture('reproduced-regex.json');
    const correctedFixture = await readFixture('not-reproduced-regex.json');

    expect(failing.status).toBe('reproduced');
    expect(failing.evidence).toEqual(reproducedFixture.evidence);
    expect(failing.differences).toEqual([]);
    expect(fixed.status).toBe('not_reproduced');
    expect(fixed.evidence).toEqual(correctedFixture.evidence);
    expect(fixed.differences).toEqual(correctedFixture.differences);
  });
});

describe('inspection of regex expectations', () => {
  it('reports the mode and rules but never the pattern', async () => {
    const result = await createStaticArtifactApplicationServices().inspect({
      artifact_path: REGEX_FIXTURE,
    });

    expect(result.status).toBe('inspected');
    expect(result.inspection?.expectations).toEqual({
      exit_code: 1,
      stdout_count: 1,
      stderr_count: 2,
      stdout_expectations: [{ mode: 'regex', normalize: [] }],
      stderr_expectations: [
        { mode: 'regex', normalize: [...DEFAULT_OUTPUT_NORMALIZATION] },
        { mode: 'regex', normalize: ['line_endings', 'paths'] },
      ],
    });
    expect(JSON.stringify(result.inspection?.expectations)).not.toContain('checking');
    expect(JSON.stringify(result)).not.toContain('<duration>');
  });
});

describe('record application service regex expectations', () => {
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

  it('the record preview shows the pattern as typed and no host path', async () => {
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
        { mode: 'regex', normalized: true, pattern: raw`cwd=<project>$` },
        { mode: 'regex', normalized: true, pattern: raw`took <duration>` },
      ],
    });

    expect(result).toMatchObject({ status: 'created', errors: [] });
    expect(preview?.expectations.stderr).toEqual([
      { mode: 'regex', normalize: [...DEFAULT_OUTPUT_NORMALIZATION], value: raw`cwd=<project>$` },
      { mode: 'regex', normalize: [...DEFAULT_OUTPUT_NORMALIZATION], value: raw`took <duration>` },
    ]);
    for (const text of [JSON.stringify(preview), await readFile(fixture.output, 'utf8')]) {
      expect(text).not.toContain(fixture.root);
      expect(text).not.toContain(await realpath(fixture.root));
    }
    const inspected = await createStaticArtifactApplicationServices().inspect({
      artifact_path: fixture.output,
    });
    expect(inspected.inspection?.expectations.stderr_expectations).toEqual([
      { mode: 'regex', normalize: [...DEFAULT_OUTPUT_NORMALIZATION] },
      { mode: 'regex', normalize: [...DEFAULT_OUTPUT_NORMALIZATION] },
    ]);
  });

  it('rejects an unsupported pattern before the command runs and writes nothing', async () => {
    const fixture = await setup(
      "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'x'); process.exitCode = 1;\n",
    );
    const confirm = vi.fn(() => Promise.resolve(confirmed));

    const result = await createRecordApplicationService(confirm).record({
      ...fixture.request,
      expect_stderr: [{ mode: 'regex', normalized: true, pattern: '(?=a)b' }],
    });

    expect(result.status).toBe('invalid_input');
    expect(result.errors[0]?.message).toContain('An expected output pattern is not supported: ');
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(path.join(fixture.root, 'ran.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses to write a recording whose regex does not match its own output', async () => {
    const root = await scratch();
    const output = path.join(root, 'never.proofissue');
    const base = await baseArtifact();
    const capture: RecordCapture = {
      artifact: {
        ...base,
        expect: {
          exit_code: 1,
          stdout: [],
          stderr: [{ mode: 'regex', value: 'something+ else' }],
        },
      },
      duration_ms: 5,
      path_context: EMPTY_OUTPUT_PATH_CONTEXT,
      stderr: stream('what was really printed'),
      stdout: stream(''),
    };
    const recorder: Recorder = { capture: () => Promise.resolve(capture) };
    const confirm = vi.fn(() => Promise.resolve(confirmed));

    const result = await createRecordApplicationService(confirm, recorder).record({
      arguments: ['x.mjs'],
      environment_image: `node@sha256:${'1'.repeat(64)}`,
      expect_stderr: [{ mode: 'regex', normalized: false, pattern: 'something+ else' }],
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
          'The recording does not satisfy its own expectations (Replay stderr did not match the expected pattern.); no artifact was written.',
      },
    ]);
    expect(confirm).not.toHaveBeenCalled();
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(result)).not.toContain('what was really printed');
  });
});
