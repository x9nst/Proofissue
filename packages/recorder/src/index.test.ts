import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ARTIFACT_LIMITS, validateArtifactValue } from '@proofissue/artifact-schema';
import { decodeBoundedOutput } from '@proofissue/process-output';
import { redactText } from '@proofissue/redactor';

import { captureRecording, DEFAULT_RECORD_LIMITS, type RecordRequest } from './index.js';
import type { RecorderError } from './index.js';

const roots: string[] = [];
const image = `node@sha256:${'1'.repeat(64)}`;
const bearer = ['Bear', 'er'].join('');

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const project = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-recorder-'));
  roots.push(root);
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'test', 'reproduction.mjs'),
    "process.stdout.write('ordinary stdout');\nprocess.stderr.write('failure marker');\nprocess.exitCode = 7;\n",
  );
  await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
  await writeFile(path.join(root, 'unselected.txt'), 'must not be collected');
  return root;
};

const request = (root: string, overrides: Partial<RecordRequest> = {}): RecordRequest => ({
  arguments: ['test/reproduction.mjs'],
  environment_image: image,
  expect_stderr: ['failure marker'],
  expect_stdout: [],
  program: 'node',
  project_root: root,
  reproduction_paths: ['test/reproduction.mjs'],
  subject_paths: ['src/subject.mjs'],
  ...overrides,
});

describe('captureRecording', () => {
  it('cannot miss a split secret at any captured chunk boundary', () => {
    const secret = `Authorization: ${bearer} synthetic-token-value`;
    for (let split = 1; split < secret.length; split += 1) {
      const capture = decodeBoundedOutput(
        [Buffer.from(secret.slice(0, split)), Buffer.from(secret.slice(split))],
        1024,
      );
      const result = redactText(capture.decoded_text);
      expect(result.text, `split ${String(split)}`).toBe(
        'Authorization: Bearer [REDACTED:authorization_header]',
      );
      expect(result.text).not.toContain('synthetic-token-value');
    }
  });

  it('captures separate streams, exit code, metadata, and only explicit files', async () => {
    const root = await project();
    const result = await captureRecording(request(root));

    expect(result.stdout.decoded_text).toBe('ordinary stdout');
    expect(result.stderr.decoded_text).toBe('failure marker');
    expect(result.artifact.expect.exit_code).toBe(7);
    expect(result.artifact.capture.node_version).toBe(process.versions.node);
    expect(result.artifact.command.arguments).toEqual(['test/reproduction.mjs']);
    expect(result.artifact.files.map((file) => file.path).sort()).toEqual([
      'src/subject.mjs',
      'test/reproduction.mjs',
    ]);
    expect(JSON.stringify(result.artifact)).not.toContain('must not be collected');
    expect(validateArtifactValue(result.artifact).ok).toBe(true);
  });

  it('redacts secrets after complete stream and file collection regardless of write boundaries', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      `process.stdout.write('Authorization: ${bearer} synthetic-');\n` +
        "process.stdout.write('token-value');\n" +
        "process.stderr.write('failure marker');\n" +
        'process.exitCode = 1;\n',
    );
    await writeFile(
      path.join(root, 'src', 'subject.mjs'),
      'export const password = "password=synthetic-password";\n',
    );

    const result = await captureRecording(request(root));
    const encoded = JSON.stringify(result);

    expect(result.stdout.decoded_text).toContain('[REDACTED:authorization_header]');
    expect(encoded).not.toContain('synthetic-token-value');
    expect(encoded).not.toContain('synthetic-password');
    expect(result.artifact.redaction.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ category: 'authorization_header', target: 'stdout' }),
        expect.objectContaining({ category: 'password', target: 'src/subject.mjs' }),
      ]),
    );
    expect(validateArtifactValue(result.artifact).ok).toBe(true);
  });

  it('applies the output limit while draining excess bytes', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stdout.write('x'.repeat(2048)); process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );

    const result = await captureRecording(
      request(root, {
        limits: { ...DEFAULT_RECORD_LIMITS, output_bytes_per_stream: 1024 },
      }),
    );

    expect(result.stdout).toMatchObject({
      retained_bytes: 1024,
      total_bytes: 2048,
      discarded_bytes: 1024,
      truncated: true,
    });
  });

  it.each([['../outside.mjs'], ['test/../outside.mjs'], ['/absolute.mjs'], ['C:/drive.mjs']])(
    'rejects unsafe selected path %s before command execution',
    async (unsafePath) => {
      const root = await project();
      await expect(
        captureRecording(request(root, { reproduction_paths: [unsafePath] })),
      ).rejects.toMatchObject({ code: 'unsafe_file' } satisfies Partial<RecorderError>);
    },
  );

  it('rejects directories, oversized files, and symbolic links', async () => {
    const root = await project();
    await expect(captureRecording(request(root, { subject_paths: ['src'] }))).rejects.toMatchObject(
      { code: 'unsafe_file' } satisfies Partial<RecorderError>,
    );

    await writeFile(
      path.join(root, 'src', 'subject.mjs'),
      Buffer.alloc(ARTIFACT_LIMITS.scalar_bytes + 1),
    );
    await expect(captureRecording(request(root))).rejects.toMatchObject({
      code: 'unsafe_file',
    } satisfies Partial<RecorderError>);

    await writeFile(path.join(root, 'src', 'target.mjs'), 'safe');
    try {
      await symlink(
        path.join(root, 'src', 'target.mjs'),
        path.join(root, 'src', 'subject.mjs'),
        'file',
      );
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'EEXIST') {
        await rm(path.join(root, 'src', 'subject.mjs'));
        try {
          await symlink(
            path.join(root, 'src', 'target.mjs'),
            path.join(root, 'src', 'subject.mjs'),
            'file',
          );
        } catch (retryError: unknown) {
          const retryCode =
            typeof retryError === 'object' && retryError !== null && 'code' in retryError
              ? retryError.code
              : undefined;
          if (retryCode === 'EPERM') return;
          throw retryError;
        }
      } else if (code === 'EPERM') return;
      else throw error;
    }
    await expect(captureRecording(request(root))).rejects.toMatchObject({
      code: 'unsafe_file',
    } satisfies Partial<RecorderError>);
  });

  it('does not expose host environment values to the recorded command', async () => {
    const root = await project();
    const previous = process.env.PROOFISSUE_SYNTHETIC_SECRET;
    process.env.PROOFISSUE_SYNTHETIC_SECRET = 'must-not-leak';
    try {
      await writeFile(
        path.join(root, 'test', 'reproduction.mjs'),
        "process.stdout.write(process.env.PROOFISSUE_SYNTHETIC_SECRET ?? 'absent'); process.stderr.write('failure marker'); process.exitCode = 1;\n",
      );
      const result = await captureRecording(request(root));
      expect(result.stdout.decoded_text).toBe('absent');
      expect(JSON.stringify(result.artifact)).not.toContain('must-not-leak');
    } finally {
      if (previous === undefined) delete process.env.PROOFISSUE_SYNTHETIC_SECRET;
      else process.env.PROOFISSUE_SYNTHETIC_SECRET = previous;
    }
  });

  it('rejects expectations that were not observed or contain likely secrets', async () => {
    const root = await project();
    await expect(
      captureRecording(request(root, { expect_stderr: ['different failure'] })),
    ).rejects.toMatchObject({ code: 'invalid_request' } satisfies Partial<RecorderError>);
    await expect(
      captureRecording(request(root, { expect_stderr: ['sk-proj-abcdefghijklmnopqrstuv'] })),
    ).rejects.toMatchObject({ code: 'redaction_failed' } satisfies Partial<RecorderError>);
  });

  it('terminates a command that exceeds the wall-clock limit and emits no artifact draft', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "setTimeout(() => process.stderr.write('failure marker'), 10_000);\n",
    );
    await expect(
      captureRecording(
        request(root, {
          limits: { ...DEFAULT_RECORD_LIMITS, timeout_seconds: 1 },
        }),
      ),
    ).rejects.toMatchObject({ code: 'timeout' } satisfies Partial<RecorderError>);
  });

  it('never invokes a shell for argument interpretation', async () => {
    const root = await project();
    const sentinel = path.join(root, 'shell-must-not-create.txt');
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stdout.write(process.argv[3] ?? ''); process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    const metacharacters = `& echo unsafe > ${sentinel}`;

    const result = await captureRecording(
      request(root, { arguments: ['test/reproduction.mjs', '--', metacharacters] }),
    );

    expect(result.stdout.decoded_text).toBe(metacharacters);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
