import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ARTIFACT_LIMITS, validateArtifactValue } from '@proofissue/artifact-schema';
import { decodeBoundedOutput } from '@proofissue/process-output';
import { redactText } from '@proofissue/redactor';

import { captureRecording, DEFAULT_RECORD_LIMITS, type RecordRequest } from './index.js';
import type { RecorderError } from './index.js';

// Passes through to the real implementation unless a test replaces it, so one test can
// simulate a path that resolves elsewhere after the recorder has opened it.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

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

const symlinkOrSkip = async (context: TestContext, target: string, link: string): Promise<void> => {
  try {
    await symlink(target, link, 'file');
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    // Report "skipped" rather than silently passing a test that checked nothing.
    if (code === 'EPERM')
      context.skip('Creating symbolic links needs a privilege this host lacks.');
    throw error;
  }
};

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

  it('rejects directories and oversized files', async () => {
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
  });

  it('rejects a symbolic-link subject file', async (context) => {
    const root = await project();
    const subject = path.join(root, 'src', 'subject.mjs');
    await writeFile(path.join(root, 'src', 'target.mjs'), 'safe');
    await rm(subject);
    await symlinkOrSkip(context, path.join(root, 'src', 'target.mjs'), subject);

    await expect(captureRecording(request(root))).rejects.toMatchObject({
      code: 'unsafe_file',
    } satisfies Partial<RecorderError>);
  });

  it('rejects a selected file that resolves outside the project once it is open', async () => {
    // Simulates the outcome of a directory being swapped for a link to elsewhere after the
    // per-segment link check and before the file is read.
    const root = await project();
    const outside = await mkdtemp(path.join(tmpdir(), 'proofissue-recorder-outside-'));
    roots.push(outside);
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises');
    vi.mocked(realpath).mockImplementation(async (target, options) =>
      path.basename(String(target)) === 'subject.mjs'
        ? path.join(outside, 'subject.mjs')
        : await actual.realpath(target, options),
    );
    try {
      await expect(captureRecording(request(root))).rejects.toMatchObject({
        code: 'unsafe_file',
      } satisfies Partial<RecorderError>);
    } finally {
      vi.mocked(realpath).mockImplementation(actual.realpath);
    }
  });

  it('still records normally when every selected file resolves inside the project', async () => {
    const root = await project();

    const capture = await captureRecording(request(root));

    expect(capture.artifact.files.map((file) => file.path).sort()).toEqual([
      'src/subject.mjs',
      'test/reproduction.mjs',
    ]);
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

  it('gives the recorded command exactly the documented environment variable names', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stdout.write(JSON.stringify(Object.keys(process.env).sort())); process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );

    const result = await captureRecording(request(root));

    // The recorder passes SystemRoot; on Windows, process creation then copies each other
    // name from the recorder's own environment when the host has it. See docs/recording.md.
    const windowsNames = [
      'HOMEDRIVE',
      'HOMEPATH',
      'LOGONSERVER',
      'PATH',
      'SYSTEMDRIVE',
      'SystemRoot',
      'TEMP',
      'USERDOMAIN',
      'USERNAME',
      'USERPROFILE',
      'WINDIR',
    ];
    const expected =
      process.platform === 'win32'
        ? windowsNames.filter((name) => process.env[name] !== undefined).sort()
        : [];
    expect(JSON.parse(result.stdout.decoded_text)).toEqual(expected);
  });

  it('keeps the environment the command prints, and other unchosen output, out of the artifact', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "if (process.argv[2] === 'print') process.stdout.write(JSON.stringify({ ...process.env, marker: 'unchosen' }));\nprocess.stderr.write('failure marker');\nprocess.exitCode = 1;\n",
    );

    const silent = await captureRecording(request(root));
    const printing = await captureRecording(
      request(root, { arguments: ['test/reproduction.mjs', 'print'] }),
    );

    expect(printing.stdout.decoded_text).toContain('"marker":"unchosen"');
    // Only the reporter's own arguments differ; nothing the command printed was kept.
    expect({ ...printing.artifact, command: silent.artifact.command }).toEqual(silent.artifact);
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

  it('terminates the whole process tree at the wall-clock limit', async () => {
    const root = await project();
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "writeFileSync('child.pid', String(child.pid));",
        'setInterval(() => {}, 1000);',
        '',
      ].join(String.fromCharCode(10)),
    );
    let pid: number | undefined;
    const alive = (candidate: number): boolean => {
      try {
        process.kill(candidate, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      await expect(
        captureRecording(
          request(root, { limits: { ...DEFAULT_RECORD_LIMITS, timeout_seconds: 1 } }),
        ),
      ).rejects.toMatchObject({ code: 'timeout' } satisfies Partial<RecorderError>);
      pid = Number.parseInt(await readFile(path.join(root, 'child.pid'), 'utf8'), 10);
      expect(Number.isInteger(pid)).toBe(true);

      const deadline = Date.now() + 10_000;
      while (alive(pid) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(alive(pid), 'the grandchild process must not outlive the recording').toBe(false);
    } finally {
      if (pid !== undefined && Number.isInteger(pid)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone, which is the expected outcome.
        }
      }
    }
  }, 30_000);

  it('never invokes a shell for argument interpretation', async () => {
    const root = await project();
    const sentinel = path.join(root, 'shell-must-not-create.txt');
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stdout.write(process.argv[3] ?? ''); process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    const metacharacters = '& echo unsafe > shell-must-not-create.txt';

    const result = await captureRecording(
      request(root, { arguments: ['test/reproduction.mjs', '--', metacharacters] }),
    );

    expect(result.stdout.decoded_text).toBe(metacharacters);
    await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('dependency capture', () => {
  const integrity = `sha512-${'A'.repeat(86)}==`;
  const tarball = (name: string): string =>
    `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`;
  const manifest = '{\n  "name": "synthetic",\n  "version": "1.0.0",\n  "private": true\n}\n';
  const lockfile = (packages: Record<string, unknown> = {}): string =>
    `${JSON.stringify({
      name: 'synthetic',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: { '': { name: 'synthetic', version: '1.0.0' }, ...packages },
    })}\n`;
  const dep = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    version: '1.0.0',
    resolved: tarball(name),
    integrity,
    ...extra,
  });
  const withDependencies = async (
    packages: Record<string, unknown> = { 'node_modules/left-pad': dep('left-pad') },
  ): Promise<string> => {
    const root = await project();
    await writeFile(path.join(root, 'package.json'), manifest);
    await writeFile(path.join(root, 'package-lock.json'), lockfile(packages));
    return root;
  };
  const asking = (root: string, overrides: Partial<RecordRequest> = {}): RecordRequest =>
    request(root, { include_dependencies: true, ...overrides });

  it('records the manifest and lockfile with the dependency role, and summarizes them', async () => {
    const root = await withDependencies({
      'node_modules/left-pad': dep('left-pad'),
      'node_modules/native': dep('native', { hasInstallScript: true }),
    });

    const capture = await captureRecording(asking(root));

    expect(capture.artifact.files.map((file) => `${file.role}:${file.path}`).sort()).toEqual([
      'dependency:package-lock.json',
      'dependency:package.json',
      'reproduction:test/reproduction.mjs',
      'subject:src/subject.mjs',
    ]);
    expect(capture.dependencies).toEqual({ install_script_packages: 1, package_count: 2 });
    expect(validateArtifactValue(capture.artifact).ok).toBe(true);
  });

  it('records the files exactly as they are on disk', async () => {
    const root = await withDependencies();

    const capture = await captureRecording(asking(root));

    const byPath = new Map(capture.artifact.files.map((file) => [file.path, file.content]));
    expect(byPath.get('package.json')).toBe(
      await readFile(path.join(root, 'package.json'), 'utf8'),
    );
    expect(byPath.get('package-lock.json')).toBe(
      await readFile(path.join(root, 'package-lock.json'), 'utf8'),
    );
  });

  it('collects nothing extra unless asked, even when the files exist', async () => {
    const root = await withDependencies();

    const capture = await captureRecording(request(root));

    expect(capture.artifact.files.map((file) => file.path).sort()).toEqual([
      'src/subject.mjs',
      'test/reproduction.mjs',
    ]);
    expect(capture.dependencies).toBeUndefined();
    expect(JSON.stringify(capture.artifact)).not.toContain('left-pad');
  });

  it('refuses when either file is missing', async () => {
    const onlyManifest = await project();
    await writeFile(path.join(onlyManifest, 'package.json'), manifest);
    const onlyLockfile = await project();
    await writeFile(path.join(onlyLockfile, 'package-lock.json'), lockfile());

    for (const root of [onlyManifest, onlyLockfile, await project()]) {
      await expect(captureRecording(asking(root))).rejects.toMatchObject({
        code: 'unsafe_file',
      } satisfies Partial<RecorderError>);
    }
  });

  it.each([
    [
      'a git source',
      { 'node_modules/a': dep('a', { resolved: 'git+ssh://git@example.test/a.git' }) },
    ],
    [
      'another registry',
      {
        'node_modules/a': dep('a', { resolved: 'https://registry.example.test/a/-/a-1.0.0.tgz' }),
      },
    ],
    [
      'a missing integrity hash',
      { 'node_modules/a': { version: '1.0.0', resolved: tarball('a') } },
    ],
    [
      'a weak integrity hash',
      { 'node_modules/a': dep('a', { integrity: `sha1-${'A'.repeat(27)}=` }) },
    ],
    ['an escaping location', { '../escape': dep('a') }],
    ['a linked package', { 'node_modules/a': dep('a', { link: true }) }],
  ])('refuses a lockfile with %s, before running the command', async (_name, packages) => {
    const root = await withDependencies(packages);
    const marker = path.join(root, 'ran.txt');
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); console.error('failure marker'); process.exitCode = 1;\n`,
    );

    await expect(captureRecording(asking(root))).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('lockfile') as string,
    });
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a lockfile that repeats a key', async () => {
    const root = await withDependencies();
    await writeFile(
      path.join(root, 'package-lock.json'),
      '{"lockfileVersion":3,"lockfileVersion":3,"packages":{}}\n',
    );

    await expect(captureRecording(asking(root))).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('duplicate_key') as string,
    });
  });

  it('reports at most three problems and escapes the location text', async () => {
    const escape = String.fromCharCode(27);
    const root = await withDependencies({
      'node_modules/a': { version: '1.0.0' },
      'node_modules/b': { version: '1.0.0' },
      'node_modules/c': { version: '1.0.0' },
      'node_modules/d': { version: '1.0.0' },
      [`../bad${escape}[31mpath`]: dep('x'),
    });

    const error = await captureRecording(asking(root)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'invalid_request' });
    const message = (error as RecorderError).message;
    expect(message).toContain('more');
    expect(message).not.toContain(escape);
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"x"'],
    ['JSON null', 'null'],
  ])('refuses a package.json that is %s', async (_name, content) => {
    const root = await withDependencies();
    await writeFile(path.join(root, 'package.json'), content);

    await expect(captureRecording(asking(root))).rejects.toMatchObject({
      code: 'invalid_request',
      message: expect.stringContaining('package.json') as string,
    });
  });

  it('refuses to alter a dependency file that contains a likely secret', async () => {
    const root = await withDependencies();
    const awsKey = ['AK', 'IA', '0123456789ABCDEF'].join('');
    await writeFile(
      path.join(root, 'package.json'),
      `{"name":"synthetic","description":"key ${awsKey}"}\n`,
    );

    const error = await captureRecording(asking(root)).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'redaction_failed' });
    expect((error as RecorderError).message).not.toContain(awsKey);
  });

  it('refuses a lockfile larger than the per-file limit', async () => {
    const root = await withDependencies();
    await writeFile(
      path.join(root, 'package-lock.json'),
      `{"lockfileVersion":3,"packages":{},"pad":"${'x'.repeat(ARTIFACT_LIMITS.scalar_bytes)}"}`,
    );

    await expect(captureRecording(asking(root))).rejects.toMatchObject({
      code: 'unsafe_file',
    } satisfies Partial<RecorderError>);
  });

  it('refuses a symbolic-link lockfile', async (context) => {
    const root = await withDependencies();
    await writeFile(path.join(root, 'real-lock.json'), lockfile());
    await rm(path.join(root, 'package-lock.json'));
    await symlinkOrSkip(
      context,
      path.join(root, 'real-lock.json'),
      path.join(root, 'package-lock.json'),
    );

    await expect(captureRecording(asking(root))).rejects.toMatchObject({
      code: 'unsafe_file',
    } satisfies Partial<RecorderError>);
  });

  it.each(['package.json', 'package-lock.json'])(
    'refuses when %s is also selected as a subject file',
    async (name) => {
      const root = await withDependencies();
      const marker = path.join(root, 'ran.txt');
      await writeFile(
        path.join(root, 'test', 'reproduction.mjs'),
        `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x'); console.error('failure marker'); process.exitCode = 1;\n`,
      );

      await expect(
        captureRecording(asking(root, { subject_paths: ['src/subject.mjs', name] })),
      ).rejects.toMatchObject({ code: 'invalid_request' } satisfies Partial<RecorderError>);
      // The conflict is caught up front, not after the command has already run.
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('still allows package.json as an ordinary subject when dependencies are not requested', async () => {
    const root = await withDependencies();

    const capture = await captureRecording(
      request(root, { subject_paths: ['src/subject.mjs', 'package.json'] }),
    );

    expect(capture.artifact.files.find((file) => file.path === 'package.json')?.role).toBe(
      'subject',
    );
  });
});
