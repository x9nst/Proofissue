import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateArtifactValue } from '@proofissue/artifact-schema';
import { OUTPUT_NORMALIZATION_RULES } from '@proofissue/output-rules';

import { captureRecording, type RecordRequest, type RecorderError } from './index.js';

const roots: string[] = [];
const image = `node@sha256:${'1'.repeat(64)}`;
const join = (...parts: readonly string[]): string => parts.join('');
const raw = String.raw;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const project = async (reproduction: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proofissue-regex-'));
  roots.push(root);
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'test', 'reproduction.mjs'), reproduction);
  await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
  return root;
};

const request = (root: string, overrides: Partial<RecordRequest> = {}): RecordRequest => ({
  arguments: ['test/reproduction.mjs'],
  environment_image: image,
  expect_stderr: [],
  expect_stdout: [],
  program: 'node',
  project_root: root,
  reproduction_paths: ['test/reproduction.mjs'],
  subject_paths: ['src/subject.mjs'],
  ...overrides,
});

const rejection = async (
  pending: Promise<unknown>,
): Promise<{ readonly code: string; readonly message: string }> => {
  try {
    await pending;
  } catch (error: unknown) {
    const failure = error as RecorderError;
    return { code: failure.code, message: failure.message };
  }
  throw new Error('The recording was accepted.');
};

const exists = async (location: string): Promise<boolean> => {
  try {
    await access(location);
    return true;
  } catch {
    return false;
  }
};

const FAILING =
  "console.log('checking calculate(2)'); console.error('Expected 4 from calculate(2) (' + 12 + 'ms)'); console.error('    at ' + import.meta.url); process.exitCode = 1;\n";

describe('regex expectations', () => {
  it('stores a normalized pattern as typed after checking it against the normalized recording', async () => {
    const root = await project(FAILING);
    const pattern = raw`Expected \d+ from calculate\(\d+\) \(<duration>\)`;
    const location = raw`^ {4}at <project>/test/reproduction\.mjs$`;

    const result = await captureRecording(
      request(root, {
        expect_stderr: [
          { mode: 'regex', normalized: true, pattern },
          { mode: 'regex', normalized: true, pattern: location },
        ],
        expect_stdout: [
          { mode: 'regex', normalized: true, pattern: raw`checking calculate\(\d\)` },
        ],
      }),
    );

    expect(result.artifact.expect.stderr).toEqual([
      { mode: 'regex', normalize: [...OUTPUT_NORMALIZATION_RULES], value: pattern },
      { mode: 'regex', normalize: [...OUTPUT_NORMALIZATION_RULES], value: location },
    ]);
    expect(result.artifact.expect.stdout).toEqual([
      {
        mode: 'regex',
        normalize: [...OUTPUT_NORMALIZATION_RULES],
        value: raw`checking calculate\(\d\)`,
      },
    ]);
    expect(validateArtifactValue(result.artifact).ok).toBe(true);
    expect(JSON.stringify(result.artifact)).not.toContain(root);
  });

  it('a raw pattern is checked against, and stored for, the raw recording', async () => {
    const root = await project(FAILING);

    const result = await captureRecording(
      request(root, {
        expect_stderr: [{ mode: 'regex', normalized: false, pattern: raw`\(12ms\)` }],
      }),
    );

    expect(result.artifact.expect.stderr).toEqual([{ mode: 'regex', value: raw`\(12ms\)` }]);
    expect(JSON.stringify(result.artifact.expect)).not.toContain('normalize');
    // The same pattern does not match the normalized recording, where the duration is a token.
    const failure = await rejection(
      captureRecording(
        request(root, {
          expect_stderr: [{ mode: 'regex', normalized: true, pattern: raw`\(12ms\)` }],
        }),
      ),
    );
    expect(failure).toEqual({
      code: 'invalid_request',
      message: 'An expected stderr pattern did not match the normalized recorded output.',
    });
  });

  it('keeps the requested order across modes', async () => {
    const root = await project(FAILING);

    const result = await captureRecording(
      request(root, {
        expect_stderr: [
          'Expected 4',
          { mode: 'regex', normalized: true, pattern: raw`from calculate\(\d+\)` },
          { mode: 'contains', normalized: true, value: '(<duration>)' },
        ],
      }),
    );

    expect(result.artifact.expect.stderr.map((item) => item.mode)).toEqual([
      'contains',
      'regex',
      'contains',
    ]);
  });

  it('rejects an unsupported or empty-matching pattern before running the command', async () => {
    const root = await project(
      "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'x'); process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    const sentinel = path.join(root, 'ran.txt');

    for (const [pattern, message] of [
      ['(?=failure)marker', 'Lookahead assertions are not supported. (offset 0)'],
      [raw`(f)\1`, 'Backreferences are not supported. (offset 3)'],
      ['failure(', 'Unterminated group: missing ")". (offset 7)'],
      ['a{101}', 'Repetition count exceeds the limit of 100. (offset 2)'],
      ['x*', 'Pattern can match without consuming output'],
      ['REDACTED:x', 'it contains redaction marker text'],
      [`(${'a'.repeat(1030)})`, 'Pattern is longer than the limit of 1024 characters.'],
    ] as const) {
      const failure = await rejection(
        captureRecording(
          request(root, { expect_stderr: [{ mode: 'regex', normalized: true, pattern }] }),
        ),
      );

      expect(failure.code).toBe('invalid_request');
      expect(failure.message).toContain('An expected output pattern is not supported: ');
      expect(failure.message).toContain(message);
      expect(failure.message).not.toContain(pattern.slice(0, 12));
      expect(await exists(sentinel)).toBe(false);
    }
  });

  it('rejects a pattern that does not match the recording', async () => {
    const root = await project(FAILING);

    for (const normalized of [true, false]) {
      expect(
        await rejection(
          captureRecording(
            request(root, {
              expect_stdout: [{ mode: 'regex', normalized, pattern: raw`checking \d{3}` }],
            }),
          ),
        ),
      ).toEqual({
        code: 'invalid_request',
        message: `An expected stdout pattern did not match the ${normalized ? 'normalized ' : ''}recorded output.`,
      });
    }
  });

  it('rejects a pattern that holds a likely secret, as it does for a literal', async () => {
    const root = await project(
      "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'x'); process.exitCode = 1;\n",
    );

    expect(
      await rejection(
        captureRecording(
          request(root, {
            expect_stderr: [
              {
                mode: 'regex',
                normalized: true,
                pattern: `password=${join('synth', 'etic-password')}`,
              },
            ],
          }),
        ),
      ),
    ).toEqual({
      code: 'redaction_failed',
      message: 'An expected output literal contains a likely secret.',
    });
  });

  it('refuses a pattern that still names the project directory', async () => {
    const root = await project("console.error('cwd=' + process.cwd()); process.exitCode = 1;\n");
    const resolved = await realpath(root);
    // Escape the characters the language treats as syntax so the pattern is valid and matches.
    const escaped = resolved.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');

    const failure = await rejection(
      captureRecording(
        request(root, {
          expect_stderr: [{ mode: 'regex', normalized: false, pattern: `cwd=${escaped}` }],
        }),
      ),
    );

    expect(failure.code).toBe('invalid_request');
    expect(failure.message).toBe(
      'An expected stderr pattern contains a local path from this computer; match the normalized path token instead.',
    );
    expect(failure.message).not.toContain(path.basename(root));
  });

  it('allows a regex beside one exact expectation on the same stream', async () => {
    const root = await project("process.stderr.write('err 5ms'); process.exitCode = 1;\n");

    const result = await captureRecording(
      request(root, {
        expect_stderr: [
          { mode: 'exact', normalized: true },
          { mode: 'regex', normalized: true, pattern: raw`err <duration>` },
        ],
      }),
    );

    expect(result.artifact.expect.stderr.map((item) => item.mode)).toEqual(['exact', 'regex']);
  });
});
