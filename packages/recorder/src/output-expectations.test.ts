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
const ESC = String.fromCharCode(27);

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const project = async (reproduction: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proofissue-expectations-'));
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

// Prints every place a program commonly shows where it runs: its directory, its module URL,
// an inspected object (escaped on Windows), the temporary directory, and a stack frame.
const LOCATIONS = [
  "import os from 'node:os';",
  "import { inspect } from 'node:util';",
  "console.error('cwd=' + process.cwd());",
  "console.error('url=' + import.meta.url);",
  'console.error(inspect({ p: process.cwd() }, { breakLength: Infinity }));',
  "console.error('tmp=' + os.tmpdir());",
  "console.error(new Error('boom').stack.split('\\n')[1]);",
  'process.exitCode = 1;',
].join('\n');

describe('output expectation modes', () => {
  it('stores normalized text with <project> and <tmp> and no host path', async () => {
    const root = await project(LOCATIONS);
    const result = await captureRecording(
      request(root, { expect_stderr: [{ mode: 'exact', normalized: true }] }),
    );

    const lines = result.artifact.expect.stderr[0]?.value.split('\n') ?? [];
    expect(lines.slice(0, 5)).toEqual([
      'cwd=<project>',
      'url=<project>/test/reproduction.mjs',
      "{ p: '<project>' }",
      'tmp=<tmp>',
      expect.stringMatching(/^ {4}at <project>\/test\/reproduction\.mjs:\d+:\d+$/u) as string,
    ]);
    expect(result.artifact.expect.stderr[0]).toMatchObject({
      mode: 'exact',
      normalize: [...OUTPUT_NORMALIZATION_RULES],
    });

    const stored = JSON.stringify(result.artifact);
    for (const hostPath of [root, await realpath(root), os.tmpdir(), os.homedir()]) {
      expect(stored).not.toContain(hostPath);
      expect(stored).not.toContain(hostPath.replaceAll('\\', '\\\\'));
    }
    expect(validateArtifactValue(result.artifact).ok).toBe(true);
  });

  it('stores a normalized literal the way it appears in the normalized recording', async () => {
    const root = await project(LOCATIONS);
    const result = await captureRecording(
      request(root, {
        expect_stderr: [
          { mode: 'contains', normalized: true, value: 'cwd=' + (await realpath(root)) },
          { mode: 'contains', normalized: true, value: 'tmp=' + os.tmpdir() },
        ],
      }),
    );

    expect(result.artifact.expect.stderr).toEqual([
      { mode: 'contains', normalize: [...OUTPUT_NORMALIZATION_RULES], value: 'cwd=<project>' },
      { mode: 'contains', normalize: [...OUTPUT_NORMALIZATION_RULES], value: 'tmp=<tmp>' },
    ]);
  });

  it('keeps plain literal expectations exactly as before', async () => {
    const root = await project(
      "process.stdout.write('ordinary stdout'); process.stderr.write('failure marker'); process.exitCode = 7;\n",
    );

    const result = await captureRecording(
      request(root, {
        expect_stderr: ['failure marker', { mode: 'contains', normalized: false, value: 'marker' }],
        expect_stdout: ['ordinary'],
      }),
    );

    expect(result.artifact.expect).toEqual({
      exit_code: 7,
      stdout: [{ mode: 'contains', value: 'ordinary' }],
      stderr: [
        { mode: 'contains', value: 'failure marker' },
        { mode: 'contains', value: 'marker' },
      ],
    });
    expect(JSON.stringify(result.artifact.expect)).not.toContain('normalize');
  });

  it('records a raw exact expectation as the whole redacted stream', async () => {
    const root = await project(
      "process.stdout.write('checking\\n'); process.stderr.write('failure marker\\n'); process.exitCode = 1;\n",
    );

    const result = await captureRecording(
      request(root, {
        expect_stderr: [{ mode: 'exact', normalized: false }],
        expect_stdout: [{ mode: 'exact', normalized: false }],
      }),
    );

    expect(result.artifact.expect.stdout).toEqual([{ mode: 'exact', value: 'checking\n' }]);
    expect(result.artifact.expect.stderr).toEqual([{ mode: 'exact', value: 'failure marker\n' }]);
  });

  it('keeps the requested order across modes and streams', async () => {
    const root = await project(
      "console.log('one 5ms'); console.error('two 7ms'); process.exitCode = 1;\n",
    );

    const result = await captureRecording(
      request(root, {
        expect_stderr: [
          { mode: 'contains', normalized: true, value: 'two <duration>' },
          'two',
          { mode: 'exact', normalized: true },
        ],
        expect_stdout: ['one', { mode: 'contains', normalized: true, value: 'one 5ms' }],
      }),
    );

    expect(
      result.artifact.expect.stdout.map((item) => [item.mode, item.normalize !== undefined]),
    ).toEqual([
      ['contains', false],
      ['contains', true],
    ]);
    expect(
      result.artifact.expect.stderr.map((item) => [item.mode, item.normalize !== undefined]),
    ).toEqual([
      ['contains', true],
      ['contains', false],
      ['exact', true],
    ]);
    expect(result.artifact.expect.stdout[1]?.value).toBe('one <duration>');
  });

  it('rejects an invalid expectation request before running the command', async () => {
    const root = await project(
      "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'x'); process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    const sentinel = path.join(root, 'ran.txt');

    for (const overrides of [
      {
        expect_stderr: [
          { mode: 'exact', normalized: true },
          { mode: 'exact', normalized: false },
        ],
      },
      {
        expect_stdout: [
          { mode: 'exact', normalized: false },
          { mode: 'exact', normalized: true },
        ],
      },
      { expect_stderr: [{ mode: 'contains', normalized: true, value: '' }] },
      { expect_stderr: [{ mode: 'contains', normalized: true, value: 'x'.repeat(8193) }] },
      { expect_stderr: [] },
    ] as const) {
      const failure = await rejection(captureRecording(request(root, overrides)));

      expect(failure.code).toBe('invalid_request');
      expect(await exists(sentinel)).toBe(false);
    }
  });

  it('allows one exact expectation on each stream', async () => {
    const root = await project(
      "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 1;\n",
    );

    const result = await captureRecording(
      request(root, {
        expect_stderr: [{ mode: 'exact', normalized: false }, 'err'],
        expect_stdout: [{ mode: 'exact', normalized: true }],
      }),
    );

    expect(result.artifact.expect.stderr).toHaveLength(2);
    expect(result.artifact.expect.stdout).toHaveLength(1);
  });

  it('rejects normalized text that was not printed', async () => {
    const root = await project("process.stderr.write('took 5ms'); process.exitCode = 1;\n");

    expect(
      await rejection(
        captureRecording(
          request(root, {
            expect_stderr: [{ mode: 'contains', normalized: true, value: 'never printed' }],
          }),
        ),
      ),
    ).toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining(
        'An expected stderr literal was not observed in the normalized output.',
      ) as string,
    });
    // The raw text is not a substitute: the stored value is normalized, so this one passes
    // only because normalizing the literal reproduces what the stream normalizes to.
    const accepted = await captureRecording(
      request(root, {
        expect_stderr: [{ mode: 'contains', normalized: true, value: 'took 5ms' }],
      }),
    );
    expect(accepted.artifact.expect.stderr[0]?.value).toBe('took <duration>');
  });

  describe('hints for a literal that was not observed', () => {
    const missing = async (
      reproduction: string,
      expectation: Partial<RecordRequest>,
    ): Promise<string> => {
      const root = await project(reproduction);
      return (await rejection(captureRecording(request(root, expectation)))).message;
    };

    it('points to the other stream when the literal was printed there', async () => {
      const message = await missing(
        "process.stdout.write('visible marker'); process.stderr.write('other'); process.exitCode = 1;\n",
        { expect_stderr: ['visible marker'] },
      );

      expect(message).toContain('was not observed in retained output.');
      expect(message).toContain('It was printed on stdout instead; use --expect-stdout.');
      const reverse = await missing(
        "process.stderr.write('visible marker'); process.stdout.write('other'); process.exitCode = 1;\n",
        { expect_stdout: ['visible marker'] },
      );
      expect(reverse).toContain('It was printed on stderr instead; use --expect-stderr.');
    });

    it('points to a normalized expectation when only normalization makes it match', async () => {
      const message = await missing(
        "process.stderr.write('took 5ms\\n'); process.exitCode = 1;\n",
        { expect_stderr: ['took <duration>'] },
      );

      expect(message).toContain(
        'It matches the stderr only after normalization; use --expect-stderr-normalized.',
      );
      const other = await missing(
        "process.stdout.write('took 5ms'); process.stderr.write('x'); process.exitCode = 1;\n",
        { expect_stderr: [{ mode: 'contains', normalized: true, value: 'took 5ms' }] },
      );
      expect(other).toContain('was not observed in the normalized output.');
      expect(other).toContain(
        'It appears in the normalized stdout; use --expect-stdout-normalized.',
      );
    });

    it('mentions truncation when the stream was truncated', async () => {
      const root = await project("process.stderr.write('x'.repeat(4096)); process.exitCode = 1;\n");

      const failure = await rejection(
        captureRecording({
          ...request(root, { expect_stderr: ['never printed'] }),
          limits: {
            timeout_seconds: 60,
            memory_mb: 512,
            cpus: 1,
            processes: 64,
            output_bytes_per_stream: 1024,
          },
        }),
      );

      expect(failure.message).toContain(
        'The stderr was truncated at its retained byte limit, so the text may have been cut off.',
      );
    });

    it('counts lines when nothing else explains it', async () => {
      const message = await missing(
        "process.stdout.write('a\\nb\\n'); process.stderr.write('c'); process.exitCode = 1;\n",
        { expect_stderr: ['never printed'] },
      );

      expect(message).toContain('The command printed 2 stdout lines and 1 stderr line;');
    });

    it('never repeats the literal or output text in the hint', async () => {
      const literal = 'distinctive-literal-9f3a';
      const printed = 'distinctive-output-71c2';
      const messages = await Promise.all([
        missing(`process.stdout.write('${printed}'); process.exitCode = 1;\n`, {
          expect_stderr: [literal],
        }),
        missing(`process.stdout.write('${printed}'); process.exitCode = 1;\n`, {
          expect_stderr: [{ mode: 'contains', normalized: true, value: literal }],
        }),
        missing(
          `process.stdout.write('${literal}'); process.stderr.write('${printed}'); process.exitCode = 1;\n`,
          { expect_stderr: [literal] },
        ),
      ]);

      for (const message of messages) {
        expect(message).not.toContain(literal);
        expect(message).not.toContain(printed);
      }
    });
  });

  it('keeps the original messages for raw literals that were not printed or hold a secret', async () => {
    const root = await project("process.stderr.write('failure marker'); process.exitCode = 1;\n");

    expect(
      await rejection(captureRecording(request(root, { expect_stderr: ['never printed'] }))),
    ).toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining(
        'An expected stderr literal was not observed in retained output.',
      ) as string,
    });
    expect(
      await rejection(
        captureRecording(
          request(root, {
            expect_stderr: [
              {
                mode: 'contains',
                normalized: true,
                value: `password=${join('synth', 'etic-password')}`,
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

  it.each([
    [
      'truncated',
      "process.stderr.write('x'.repeat(4096)); process.exitCode = 1;\n",
      'The recorded stderr was truncated, so an exact expectation cannot describe it.',
      true,
    ],
    [
      'oversized',
      "process.stderr.write('x'.repeat(9000)); process.exitCode = 1;\n",
      'The recorded stderr is larger than 8192 bytes, so an exact expectation cannot store it.',
      true,
    ],
    [
      'empty',
      "process.stdout.write('only stdout'); process.exitCode = 1;\n",
      'The recorded stderr is empty, so an exact expectation cannot describe it.',
      false,
    ],
    [
      'redacted',
      `process.stderr.write('${join('pass', 'word=synthetic-', 'password')}'); process.exitCode = 1;\n`,
      'The recorded stderr contains redaction markers, so an exact expectation cannot be used.',
      true,
    ],
  ])('refuses an exact expectation for a %s stream', async (kind, source, message, advises) => {
    const root = await project(source);
    for (const normalized of [false, true]) {
      const failure = await rejection(
        captureRecording(
          request(root, {
            expect_stderr: [{ mode: 'exact', normalized }],
            expect_stdout: kind === 'empty' ? ['only stdout'] : [],
            ...(kind === 'truncated'
              ? {
                  limits: {
                    cpus: 1,
                    memory_mb: 512,
                    output_bytes_per_stream: 1024,
                    processes: 64,
                    timeout_seconds: 60,
                  },
                }
              : {}),
          }),
        ),
      );

      expect(failure.code).toBe('invalid_request');
      expect(failure.message).toContain(message);
      expect(failure.message.includes('normalized literal')).toBe(advises);
    }
  });

  it('refuses a raw exact value that still contains the project directory', async () => {
    const root = await project('console.error(process.cwd()); process.exitCode = 1;\n');

    const failure = await rejection(
      captureRecording(request(root, { expect_stderr: [{ mode: 'exact', normalized: false }] })),
    );

    expect(failure.code).toBe('invalid_request');
    expect(failure.message).toContain('contains a local path from this computer');
    expect(failure.message).not.toContain(await realpath(root));
  });

  it('refuses a value that still contains the home directory', async (context) => {
    const home = os.homedir();
    if (path.dirname(home) === home) context.skip('The home directory is a filesystem root.');
    // The script prints this process's home directory, so the test does not depend on how the
    // child process would find its own.
    const root = await project(
      `console.error('home=' + ${JSON.stringify(home)}); process.exitCode = 1;\n`,
    );
    const printed = `home=${home}`;

    for (const expectation of [
      { mode: 'exact', normalized: true },
      { mode: 'exact', normalized: false },
      { mode: 'contains', normalized: true, value: printed },
    ] as const) {
      const failure = await rejection(
        captureRecording(request(root, { expect_stderr: [expectation] })),
      );

      expect(failure.code).toBe('invalid_request');
      expect(failure.message).toContain('contains a local path from this computer');
      expect(failure.message).not.toContain(home);
    }
  });

  it('refuses a value that forms a likely secret after normalization', async () => {
    const token = join('sk', '-proj-', 'abcdefghijklmnopqrstuv');
    const split = `${token.slice(0, 18)}${ESC}[0m${token.slice(18)}`;
    const root = await project(
      `process.stderr.write(${JSON.stringify(split)}); process.exitCode = 1;\n`,
    );

    // As printed, the token is split by the escape sequence, so redaction does not see it.
    const raw = await captureRecording(request(root, { expect_stderr: [split.slice(0, 10)] }));
    expect(raw.artifact.redaction.findings).toEqual([]);

    for (const expectation of [
      { mode: 'exact', normalized: true },
      { mode: 'contains', normalized: true, value: split },
    ] as const) {
      const failure = await rejection(
        captureRecording(request(root, { expect_stderr: [expectation] })),
      );

      expect(failure).toEqual({
        code: 'redaction_failed',
        message: 'An expected stderr value contains a likely secret after normalization.',
      });
    }
  });

  it('returns the path context that normalized the output and never puts it in the artifact', async () => {
    const root = await project(LOCATIONS);
    const result = await captureRecording(
      request(root, {
        expect_stderr: [
          { mode: 'contains', normalized: true, value: 'cwd=' + (await realpath(root)) },
        ],
      }),
    );

    expect(result.path_context.forms.some((form) => form.token === '<project>')).toBe(true);
    expect(result.path_context.forms.some((form) => form.token === '<tmp>')).toBe(true);
    expect(JSON.stringify(result.artifact)).not.toContain('path_context');
  });
});
