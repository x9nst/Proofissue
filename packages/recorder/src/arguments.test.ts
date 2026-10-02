import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createOutputPathContext } from '@proofissue/output-rules';

import {
  describeNonPortableArgument,
  findNonPortableArgument,
  type NonPortableArgumentOptions,
} from './arguments.js';
import { captureRecording, type RecordRequest, type RecorderError } from './index.js';

const roots: string[] = [];
const image = `node@sha256:${'1'.repeat(64)}`;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

// Writes a marker file when it runs, so a test can tell whether the command was started.
const project = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'proofissue-arguments-'));
  roots.push(root);
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'test', 'reproduction.mjs'),
    "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'ran'); process.stderr.write('failure marker'); process.exitCode = 1;\n",
  );
  await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
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

const rejection = async (pending: Promise<unknown>): Promise<RecorderError> => {
  try {
    await pending;
  } catch (error: unknown) {
    return error as RecorderError;
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

describe('arguments that cannot replay elsewhere', () => {
  it('refuses an argument holding the project directory before running the command', async () => {
    const root = await project();

    const failure = await rejection(
      captureRecording(request(root, { arguments: ['test/reproduction.mjs', root] })),
    );

    expect(failure.code).toBe('invalid_request');
    expect(failure.message).toContain(
      'Command argument 2 (after node) holds a path from this computer',
    );
    expect(failure.message).toContain('No command was run.');
    expect(failure.message).not.toContain(root);
    expect(await exists(path.join(root, 'ran.txt'))).toBe(false);
  });

  it('refuses a path inside the project that is part of a longer argument', async () => {
    const root = await project();
    const inside = path.join(root, 'src', 'subject.mjs');

    for (const argument of [inside, `--input=${inside}`]) {
      const failure = await rejection(
        captureRecording(request(root, { arguments: ['test/reproduction.mjs', argument] })),
      );

      expect(failure.message).toContain('holds a path from this computer');
      expect(failure.message).not.toContain(inside);
    }
    expect(await exists(path.join(root, 'ran.txt'))).toBe(false);
  });

  it('refuses an argument holding the home directory', async () => {
    const root = await project();
    const home = path.join(os.homedir(), 'documents', 'notes.txt');

    const failure = await rejection(
      captureRecording(request(root, { arguments: ['test/reproduction.mjs', home] })),
    );

    expect(failure.code).toBe('invalid_request');
    expect(failure.message).toContain('holds a path from this computer');
    expect(failure.message).not.toContain(os.homedir());
    expect(await exists(path.join(root, 'ran.txt'))).toBe(false);
  });

  it('still runs a command whose arguments are relative', async () => {
    const root = await project();

    const result = await captureRecording(
      request(root, { arguments: ['test/reproduction.mjs', 'relative/value', '--flag=1'] }),
    );

    expect(result.artifact.command.arguments).toEqual([
      'test/reproduction.mjs',
      'relative/value',
      '--flag=1',
    ]);
    expect(await exists(path.join(root, 'ran.txt'))).toBe(true);
  });
});

describe('findNonPortableArgument', () => {
  // Spelled at runtime: a literal Windows or home path would be a local path in a committed file.
  const drive = String.fromCharCode(67);
  const projectRoot = `${drive}:\\work\\project`;
  const context = createOutputPathContext({
    platform: 'win32',
    project_roots: [projectRoot],
    temporary_roots: [],
  });
  const options = (
    platform: 'posix' | 'win32',
    existing: readonly string[],
  ): NonPortableArgumentOptions => ({
    exists: (candidate) => existing.includes(candidate),
    host_context: context,
    platform,
  });

  it('refuses a backslash path to a project file on win32 and accepts it on posix', () => {
    const files = ['test/a.mjs'];

    expect(findNonPortableArgument(['test\\a.mjs'], options('win32', files))).toEqual({
      index: 0,
      portable_path: 'test/a.mjs',
      reason: 'backslash_path',
    });
    expect(findNonPortableArgument(['.\\test\\a.mjs'], options('win32', files))).toEqual({
      index: 0,
      portable_path: 'test/a.mjs',
      reason: 'backslash_path',
    });
    expect(findNonPortableArgument(['test\\a.mjs'], options('posix', files))).toBeUndefined();
  });

  it('accepts a backslash that is not a project file, and forward-slash paths', () => {
    expect(
      findNonPortableArgument(['a\\nb', 'test/a.mjs'], options('win32', ['test/a.mjs'])),
    ).toBeUndefined();
    expect(
      findNonPortableArgument(['..\\outside'], options('win32', ['..\\outside'])),
    ).toBeUndefined();
  });

  it('refuses the project directory in any spelling on win32', () => {
    for (const spelling of [
      projectRoot,
      `${projectRoot}\\test\\a.mjs`,
      projectRoot.replaceAll('\\', '/'),
      `--cwd=${projectRoot.replaceAll('\\', '\\\\')}`,
    ]) {
      expect(findNonPortableArgument(['x', spelling], options('win32', []))).toEqual({
        index: 1,
        reason: 'local_path',
      });
    }
  });

  it('describes a refusal without repeating the argument', () => {
    const local = describeNonPortableArgument({ index: 0, reason: 'local_path' });
    const backslash = describeNonPortableArgument({
      index: 2,
      portable_path: 'test/a.mjs',
      reason: 'backslash_path',
    });

    expect(local).toContain('Command argument 1 (after node)');
    expect(backslash).toContain('Command argument 3 (after node)');
    expect(backslash).toContain('write it as "test/a.mjs"');
  });
});
