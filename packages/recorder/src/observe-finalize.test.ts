import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureRecording, finalizeRecording, observeRecording } from './index.js';
import type { ObserveRequest, RecordRequest } from './index.js';

const roots: string[] = [];
const image = `node@sha256:${'1'.repeat(64)}`;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

// The script overwrites the subject file, so a file read after the command would differ.
const project = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-observe-'));
  roots.push(root);
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'test', 'reproduction.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(new URL('../src/subject.mjs', import.meta.url), 'export const value = 99;\\n');",
      "process.stdout.write('ordinary stdout\\n');",
      "process.stderr.write('failure marker\\n');",
      'process.exitCode = 7;',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
  return root;
};

const observeRequest = (root: string): ObserveRequest => ({
  arguments: ['test/reproduction.mjs'],
  environment_image: image,
  program: 'node',
  project_root: root,
  reproduction_paths: ['test/reproduction.mjs'],
  subject_paths: ['src/subject.mjs'],
});

describe('observe and finalize', () => {
  it('observe reads selected files before the command runs', async () => {
    const root = await project();

    const observation = await observeRecording(observeRequest(root));

    const subject = observation.files.find((file) => file.path === 'src/subject.mjs');
    expect(subject?.content).toBe('export const value = 3;\n');
    expect(observation.exit_code).toBe(7);
    expect(observation.stderr.decoded_text).toBe('failure marker\n');
  });

  it('capture produces byte-identical artifacts to observe plus finalize', async () => {
    const rootForCapture = await project();
    const rootForSplit = await project();
    const expectations = {
      expect_stderr: ['failure marker', { mode: 'contains', normalized: true, value: 'marker' }],
      expect_stdout: [{ mode: 'exact', normalized: true }],
    } as const;
    const withRoot = (root: string): RecordRequest => ({
      ...observeRequest(root),
      expect_stderr: expectations.expect_stderr,
      expect_stdout: expectations.expect_stdout,
    });

    const whole = await captureRecording(withRoot(rootForCapture));
    const split = finalizeRecording(
      await observeRecording(observeRequest(rootForSplit)),
      expectations,
    );

    expect(JSON.stringify(split.artifact)).toBe(JSON.stringify(whole.artifact));
    expect(split.stdout.decoded_text).toBe(whole.stdout.decoded_text);
    expect(split.stderr.decoded_text).toBe(whole.stderr.decoded_text);
  });

  it('still checks expectation patterns before the command runs when capturing', async () => {
    const root = await project();

    await expect(
      captureRecording({
        ...observeRequest(root),
        expect_stderr: [{ mode: 'regex', normalized: true, pattern: '(?=a)' }],
        expect_stdout: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    // The command did not run, so it did not overwrite the subject file.
    const observation = await observeRecording(observeRequest(root));
    expect(observation.files.find((file) => file.path === 'src/subject.mjs')?.content).toBe(
      'export const value = 3;\n',
    );
  });
});
