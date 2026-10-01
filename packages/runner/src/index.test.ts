import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';

import { ARTIFACT_LIMITS, parseAndValidateArtifact, sha256 } from '@proofissue/artifact-schema';
import { openPackageStore } from '@proofissue/dependencies';

import {
  APPROVED_NODE_IMAGE,
  buildDockerCreateArguments,
  createDockerRunner,
  DEPENDENCY_INSTALL_FAILED_EXIT_CODE,
  RunnerError,
  type ContainerCreateSpec,
  type ContainerEngine,
  type ContainerState,
  type CurrentCheckoutReader,
  type ReplayWorkspace,
  type RunnerPolicy,
} from './index.js';

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

const storeRoots: string[] = [];

afterEach(async () => {
  await Promise.all(storeRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const artifact = async () => {
  const source = await readFile('tests/fixtures/artifacts/v1/valid/canonical.proofissue');
  const parsed = parseAndValidateArtifact(source);
  if (!parsed.ok) throw new Error('Canonical fixture must be valid.');
  return {
    ...parsed.artifact,
    environment: { ...parsed.artifact.environment, image: APPROVED_NODE_IMAGE },
  };
};

const policy = (timeoutSeconds = 60): RunnerPolicy => ({
  approved_images: [APPROVED_NODE_IMAGE],
  maximum_limits: {
    timeout_seconds: timeoutSeconds,
    memory_mb: 2048,
    cpus: 2,
    processes: 256,
    output_bytes_per_stream: 1024,
  },
  writable_workspace_mb: 64,
  dependency_workspace_mb: 256,
});

class FakeEngine implements ContainerEngine {
  readonly calls: string[] = [];
  readonly failures = new Set<string>();
  state: ContainerState = { exit_code: 1, oom_killed: false };
  stdout = 'details';
  stderr = 'Expected 4 from calculate(2)';
  hang = false;

  #operation(name: string): void {
    this.calls.push(name);
    if (this.failures.has(name)) throw new Error(`${name} failed`);
  }

  async assertCapabilities(): Promise<void> {
    this.#operation('capabilities');
    await Promise.resolve();
  }
  async imageExists(): Promise<boolean> {
    this.#operation('image');
    await Promise.resolve();
    return true;
  }
  readonly specs: ContainerCreateSpec[] = [];
  async create(spec: ContainerCreateSpec): Promise<void> {
    this.#operation('create');
    this.specs.push(spec);
    await Promise.resolve();
  }
  async start(
    _name: string,
    onStdout: (chunk: Uint8Array) => void,
    onStderr: (chunk: Uint8Array) => void,
  ): Promise<ContainerState> {
    this.#operation('start');
    onStdout(Buffer.from(this.stdout));
    onStderr(Buffer.from(this.stderr));
    if (this.hang) return await new Promise<ContainerState>(() => undefined);
    return this.state;
  }
  async stop(): Promise<void> {
    this.#operation('stop');
    await Promise.resolve();
  }
  async kill(): Promise<void> {
    this.#operation('kill');
    await Promise.resolve();
  }
  async remove(): Promise<void> {
    this.#operation('remove');
    await Promise.resolve();
  }
}

const workspace = (): ReplayWorkspace & { readonly calls: string[]; failRemove: boolean } => {
  const calls: string[] = [];
  return {
    calls,
    failRemove: false,
    create: () => {
      calls.push('create');
      return Promise.resolve('/tmp/proofissue-test-workspace');
    },
    remove: function () {
      calls.push('remove');
      return this.failRemove ? Promise.reject(new Error('remove failed')) : Promise.resolve();
    },
  };
};

describe('Docker isolation arguments', () => {
  it('enforces every Milestone 4 container control without untrusted shell interpolation or an engine socket', () => {
    const arguments_ = buildDockerCreateArguments({
      arguments: ['reproduction.mjs', 'argument with spaces', '&'],
      image: APPROVED_NODE_IMAGE,
      input_path: '/tmp/proofissue-input',
      limits: {
        cpus: 0.5,
        memory_mb: 64,
        output_bytes_per_stream: 1024,
        processes: 8,
        timeout_seconds: 1,
        writable_workspace_mb: 64,
      },
      name: 'proofissue-test',
    });
    const encoded = JSON.stringify(arguments_);

    expect(arguments_).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--user',
        '65532:65532',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges:true',
        '--pids-limit',
        '9',
        '--memory',
        '64m',
        '--memory-swap',
        '64m',
        '--cpus',
        '0.5',
        '--entrypoint',
        '/bin/sh',
      ]),
    );
    expect(arguments_.slice(-5)).toEqual([
      '--',
      'node',
      'reproduction.mjs',
      'argument with spaces',
      '&',
    ]);
    expect(encoded).toContain('dst=/proofissue-input,readonly');
    expect(encoded).toContain('/workspace:rw,nosuid,nodev,noexec,size=67108864,mode=1777');
    expect(encoded).not.toContain('privileged');
    expect(encoded).not.toContain('docker.sock');
  });

  const createSpec = (inputPath: string) => ({
    arguments: ['reproduction.mjs'],
    image: APPROVED_NODE_IMAGE,
    input_path: inputPath,
    limits: {
      cpus: 1,
      memory_mb: 64,
      output_bytes_per_stream: 1024,
      processes: 8,
      timeout_seconds: 1,
      writable_workspace_mb: 64,
    },
    name: 'proofissue-test',
  });

  const valuesOf = (arguments_: readonly string[], flag: string): readonly (string | undefined)[] =>
    arguments_.flatMap((argument, index) => (argument === flag ? [arguments_[index + 1]] : []));

  it('never pulls the image and discards daemon-side logs', () => {
    const arguments_ = buildDockerCreateArguments(createSpec('/tmp/proofissue-input'));

    expect(valuesOf(arguments_, '--pull')).toEqual(['never']);
    expect(valuesOf(arguments_, '--log-driver')).toEqual(['none']);
  });

  it('removes core dumps and bounds open file descriptors', () => {
    const arguments_ = buildDockerCreateArguments(createSpec('/tmp/proofissue-input'));

    expect(valuesOf(arguments_, '--ulimit')).toEqual(['core=0:0', 'nofile=1024:1024']);
  });

  it('keeps every create option ahead of the image so artifact data cannot become an option', () => {
    const arguments_ = buildDockerCreateArguments(createSpec('/tmp/proofissue-input'));
    const imageIndex = arguments_.indexOf(APPROVED_NODE_IMAGE);

    expect(imageIndex).toBeGreaterThan(0);
    for (const flag of ['--pull', '--log-driver', '--ulimit', '--network', '--read-only']) {
      expect(arguments_.indexOf(flag)).toBeLessThan(imageIndex);
    }
  });

  it.each([
    ['a comma that would add mount options', '/tmp/proofissue,readonly=false'],
    ['a comma that would redirect the mount target', '/tmp/a,dst=/etc'],
    ['a double quote', '/tmp/proofissue"input'],
    ['a newline', '/tmp/proofissue\ninput'],
    ['a carriage return', '/tmp/proofissue\rinput'],
    ['a NUL byte', '/tmp/proofissue\u0000input'],
    ['a delete character', '/tmp/proofissue\u007finput'],
    ['an empty path', ''],
    ['a relative path', 'proofissue-input'],
    ['a dot-relative path', './proofissue-input'],
  ])('rejects a mount source with %s', (_description, inputPath) => {
    expect(() => buildDockerCreateArguments(createSpec(inputPath))).toThrow(
      expect.objectContaining({ code: 'policy_rejection' }) as Error,
    );
  });

  it('does not echo a rejected mount source in the error message', () => {
    const attempted = '/tmp/secret-looking-directory,dst=/etc';
    let message = '';
    try {
      buildDockerCreateArguments(createSpec(attempted));
    } catch (error: unknown) {
      message = error instanceof Error ? error.message : '';
    }

    expect(message).not.toBe('');
    expect(message).not.toContain('secret-looking-directory');
  });

  it('accepts a typical temporary workspace path', () => {
    const arguments_ = buildDockerCreateArguments(
      createSpec('/tmp/proofissue-replay-0123456789abcdef'),
    );

    expect(arguments_).toContain(
      'type=bind,src=/tmp/proofissue-replay-0123456789abcdef,dst=/proofissue-input,readonly',
    );
  });
});

describe('runner lifecycle', () => {
  it('captures bounded streams and removes the container before the workspace', async () => {
    const engine = new FakeEngine();
    engine.stdout = 'x'.repeat(2048);
    const files = workspace();
    const result = await createDockerRunner({ engine, policy: policy(), workspace: files }).run({
      artifact: await artifact(),
      mode: 'snapshot',
    });

    expect(result.execution).toMatchObject({
      exit_code: 1,
      termination_reason: 'exited',
      stdout: { retained_bytes: 1024, truncated: true },
    });
    expect(engine.calls).toEqual(['capabilities', 'image', 'create', 'start', 'remove']);
    expect(files.calls).toEqual(['create', 'remove']);
    expect(result.cleanup).toEqual({
      completed: true,
      attempted_resources: ['container', 'workspace'],
      residual_resources: [],
    });
    expect(result.events.map((event) => event.type)).toEqual([
      'policy_checked',
      'workspace_created',
      'container_created',
      'container_started',
      'container_exited',
      'cleanup_completed',
    ]);
  });

  it('rejects an unapproved image before checking Docker or creating a workspace', async () => {
    const engine = new FakeEngine();
    const files = workspace();
    const unapproved = {
      ...(await artifact()),
      environment: { ...(await artifact()).environment, image: `node@sha256:${'a'.repeat(64)}` },
    };

    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: unapproved,
        mode: 'snapshot',
      }),
    ).rejects.toMatchObject({ code: 'policy_rejection' });
    expect(engine.calls).toEqual([]);
    expect(files.calls).toEqual([]);
  });

  it('terminates a timed-out container and cleans every allocated resource', async () => {
    vi.useFakeTimers();
    const engine = new FakeEngine();
    engine.hang = true;
    const files = workspace();
    const pending = createDockerRunner({ engine, policy: policy(0.01), workspace: files }).run({
      artifact: await artifact(),
      mode: 'snapshot',
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'timeout',
      execution: { termination_reason: 'timeout' },
      cleanup: { completed: true, residual_resources: [] },
    });
    await vi.runAllTimersAsync();
    await assertion;
    expect(engine.calls).toEqual(['capabilities', 'image', 'create', 'start', 'stop', 'remove']);
    expect(files.calls).toEqual(['create', 'remove']);
    vi.useRealTimers();
  });

  it('classifies memory enforcement as resource termination', async () => {
    const engine = new FakeEngine();
    engine.state = { exit_code: 137, oom_killed: true };
    const files = workspace();
    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: await artifact(),
        mode: 'snapshot',
      }),
    ).rejects.toMatchObject({
      code: 'resource_termination',
      execution: { termination_reason: 'resource_limit' },
      cleanup: { completed: true },
    });
  });

  it('treats a SIGKILL exit as resource termination even when the engine misses the OOM flag', async () => {
    // The engine can report the exit before it records the kernel's OOM kill, so a process
    // killed for memory may arrive here as exit status 137 with oom_killed false.
    const engine = new FakeEngine();
    engine.state = { exit_code: 137, oom_killed: false };
    const files = workspace();
    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: await artifact(),
        mode: 'snapshot',
      }),
    ).rejects.toMatchObject({
      code: 'resource_termination',
      execution: { exit_code: 137, termination_reason: 'resource_limit' },
      cleanup: { completed: true },
    });
  });

  it.each([0, 1, 2, 126, 127, 130, 134, 139, 143])(
    'still reports exit status %i as an ordinary exit',
    async (exitCode) => {
      const engine = new FakeEngine();
      engine.state = { exit_code: exitCode, oom_killed: false };
      const result = await createDockerRunner({
        engine,
        policy: policy(),
        workspace: workspace(),
      }).run({ artifact: await artifact(), mode: 'snapshot' });

      expect(result.execution).toMatchObject({
        exit_code: exitCode,
        termination_reason: 'exited',
      });
    },
  );

  it('terminates and cleans an interrupted run', async () => {
    const engine = new FakeEngine();
    engine.hang = true;
    const files = workspace();
    const controller = new AbortController();
    const pending = createDockerRunner({ engine, policy: policy(), workspace: files }).run({
      artifact: await artifact(),
      mode: 'snapshot',
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'timeout',
      cleanup: { completed: true, residual_resources: [] },
    });
    await vi.waitFor(() => {
      expect(engine.calls).toContain('start');
    });
    controller.abort();

    await assertion;
    expect(engine.calls).toEqual(expect.arrayContaining(['stop', 'remove']));
    expect(files.calls).toEqual(['create', 'remove']);
  });

  it.each([
    ['create', ['remove']],
    ['start', ['stop', 'remove']],
    ['remove', []],
  ] as const)(
    'reports a fault during %s and still attempts later cleanup',
    async (failure, expected) => {
      const engine = new FakeEngine();
      engine.failures.add(failure);
      const files = workspace();
      let caught: unknown;
      try {
        await createDockerRunner({ engine, policy: policy(), workspace: files }).run({
          artifact: await artifact(),
          mode: 'snapshot',
        });
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RunnerError);
      expect(engine.calls).toEqual(expect.arrayContaining([...expected]));
      expect(files.calls).toContain('remove');
    },
  );

  it('fails safely when workspace creation is fault-injected before a container exists', async () => {
    const engine = new FakeEngine();
    const files: ReplayWorkspace = {
      create: () => Promise.reject(new Error('workspace creation failed')),
      remove: () => Promise.reject(new Error('no workspace should be exposed')),
    };

    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: await artifact(),
        mode: 'snapshot',
      }),
    ).rejects.toMatchObject({
      code: 'internal_error',
      cleanup: { completed: true, attempted_resources: [] },
    });
    expect(engine.calls).toEqual(['capabilities', 'image']);
  });

  it('falls back to kill when stop fails and reports both stop and kill faults', async () => {
    const engine = new FakeEngine();
    engine.failures.add('start');
    engine.failures.add('stop');
    engine.failures.add('kill');
    const files = workspace();

    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: await artifact(),
        mode: 'snapshot',
      }),
    ).rejects.toMatchObject({ cleanup: { completed: false } });
    expect(engine.calls).toEqual(expect.arrayContaining(['start', 'stop', 'kill', 'remove']));
    expect(files.calls).toContain('remove');
  });

  it('reports workspace-removal failure as residual cleanup', async () => {
    const engine = new FakeEngine();
    const files = workspace();
    files.failRemove = true;

    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: await artifact(),
        mode: 'snapshot',
      }),
    ).rejects.toMatchObject({
      code: 'cleanup_failed',
      cleanup: { completed: false, residual_resources: ['workspace'] },
    });
  });

  it('substitutes only declared subject files and keeps reproduction files byte-identical', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'proofissue-current-checkout-'));
    const input = await artifact();
    const originalReproduction = input.files.find((file) => file.role === 'reproduction');
    if (originalReproduction === undefined) throw new Error('Fixture has no reproduction file.');
    await writeFile(path.join(checkout, 'calculate.mjs'), 'export const fixed = true;\n');
    await writeFile(
      path.join(checkout, 'reproduction.mjs'),
      'throw new Error("must be ignored");\n',
    );
    await writeFile(path.join(checkout, 'new-file.mjs'), 'export const added = true;\n');

    const captured = new Map<string, string>();
    const files: ReplayWorkspace = {
      create: (artifactValue, replacements = new Map()) => {
        for (const file of artifactValue.files) {
          captured.set(file.path, replacements.get(file.path) ?? file.content);
        }
        return Promise.resolve('/tmp/proofissue-test-workspace');
      },
      remove: () => Promise.resolve(),
    };
    try {
      const result = await createDockerRunner({
        engine: new FakeEngine(),
        policy: policy(),
        workspace: files,
      }).run({ artifact: input, mode: 'current_checkout', against_path: checkout });

      expect(result.substituted_paths).toEqual(['calculate.mjs']);
      expect(captured.get('calculate.mjs')).toBe('export const fixed = true;\n');
      expect(captured.get('reproduction.mjs')).toBe(originalReproduction.content);
      expect(captured.has('new-file.mjs')).toBe(false);
    } finally {
      await rm(checkout, { force: true, recursive: true });
    }
  });

  it('gives the checkout reader only manifest entries declared as subjects', async () => {
    let receivedRoles: readonly string[] = [];
    let receivedPaths: readonly string[] = [];
    const checkout: CurrentCheckoutReader = {
      read: (_root, subjectFiles) => {
        receivedRoles = subjectFiles.map((file) => file.role);
        receivedPaths = subjectFiles.map((file) => file.path);
        return Promise.resolve(
          subjectFiles.map((file) => ({
            content: file.content,
            path: file.path,
            sha256: file.sha256,
          })),
        );
      },
    };

    await createDockerRunner({
      checkout,
      engine: new FakeEngine(),
      policy: policy(),
      workspace: workspace(),
    }).run({
      artifact: await artifact(),
      mode: 'current_checkout',
      against_path: 'unused-by-injected-reader',
    });

    expect(receivedRoles).toEqual(['subject']);
    expect(receivedPaths).toEqual(['calculate.mjs']);
  });

  it.each([
    [
      'removed or renamed',
      async (root: string) => {
        await rm(path.join(root, 'calculate.mjs'), { force: true });
      },
    ],
    [
      'changed to a directory',
      async (root: string) => {
        await mkdir(path.join(root, 'calculate.mjs'));
      },
    ],
    [
      'changed to invalid UTF-8',
      async (root: string) => {
        await writeFile(path.join(root, 'calculate.mjs'), Buffer.from([0xff]));
      },
    ],
    [
      'changed to an oversized file',
      async (root: string) => {
        await writeFile(
          path.join(root, 'calculate.mjs'),
          Buffer.alloc(ARTIFACT_LIMITS.scalar_bytes + 1),
        );
      },
    ],
  ] as const)(
    'rejects a declared subject that was %s before creating a workspace',
    async (_case, prepare) => {
      const checkout = await mkdtemp(path.join(tmpdir(), 'proofissue-unsafe-checkout-'));
      const engine = new FakeEngine();
      const files = workspace();
      try {
        await prepare(checkout);
        await expect(
          createDockerRunner({ engine, policy: policy(), workspace: files }).run({
            artifact: await artifact(),
            mode: 'current_checkout',
            against_path: checkout,
          }),
        ).rejects.toMatchObject({ code: 'unsafe_checkout_file' });
        expect(engine.calls).toEqual(['capabilities', 'image']);
        expect(files.calls).toEqual([]);
      } finally {
        await rm(checkout, { force: true, recursive: true });
      }
    },
  );

  it('rejects a symbolic-link subject that escapes the selected checkout', async (context) => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'proofissue-symlink-checkout-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'proofissue-symlink-outside-'));
    const outsideFile = path.join(outside, 'calculate.mjs');
    await writeFile(outsideFile, 'export const escaped = true;\n');
    try {
      await symlinkOrSkip(context, outsideFile, path.join(checkout, 'calculate.mjs'));
      const engine = new FakeEngine();
      const files = workspace();
      await expect(
        createDockerRunner({ engine, policy: policy(), workspace: files }).run({
          artifact: await artifact(),
          mode: 'current_checkout',
          against_path: checkout,
        }),
      ).rejects.toMatchObject({ code: 'unsafe_checkout_file' });
      expect(engine.calls).toEqual(['capabilities', 'image']);
      expect(files.calls).toEqual([]);
    } finally {
      await rm(checkout, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it('requires an explicit checkout only for current-checkout mode', async () => {
    const engine = new FakeEngine();
    const files = workspace();
    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: await artifact(),
        mode: 'current_checkout',
      }),
    ).rejects.toMatchObject({ code: 'policy_rejection' });
    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: files }).run({
        artifact: await artifact(),
        mode: 'snapshot',
        against_path: '.',
      }),
    ).rejects.toMatchObject({ code: 'policy_rejection' });
    expect(engine.calls).toEqual([]);
    expect(files.calls).toEqual([]);
  });
});

describe('artifacts with dependency files', () => {
  const lockfileWith = (names: readonly string[]): string =>
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'synthetic' },
        ...Object.fromEntries(
          names.map((name) => [
            `node_modules/${name}`,
            {
              version: '1.0.0',
              resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`,
              integrity: `sha512-${createHash('sha512').update(tarballOf(name)).digest('base64')}`,
            },
          ]),
        ),
      },
    });
  const tarballOf = (name: string): Buffer => Buffer.from(`synthetic tarball for ${name}`);

  const dependencyArtifact = async (names: readonly string[] = []) => {
    const parsed = parseAndValidateArtifact(
      await readFile('tests/fixtures/artifacts/v1/valid/with-dependencies.proofissue'),
    );
    if (!parsed.ok) throw new Error('Dependency fixture must be valid.');
    const lockfile = lockfileWith(names);
    return {
      ...parsed.artifact,
      environment: { ...parsed.artifact.environment, image: APPROVED_NODE_IMAGE },
      files: parsed.artifact.files.map((file) =>
        file.path === 'package-lock.json'
          ? { ...file, content: lockfile, sha256: sha256(lockfile) }
          : file,
      ),
    };
  };

  const preparedStore = async (names: readonly string[]): Promise<string> => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-runner-deps-'));
    storeRoots.push(root);
    const store = await openPackageStore(path.join(root, 'store'));
    for (const name of names) {
      const bytes = tarballOf(name);
      await store.add(
        `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
        (async function* () {
          yield await Promise.resolve(bytes);
        })(),
      );
    }
    return store.directory;
  };

  const run = async (
    engine: FakeEngine,
    files: ReturnType<typeof workspace>,
    names: readonly string[],
    store?: string,
  ) =>
    await createDockerRunner({ engine, policy: policy(), workspace: files }).run({
      artifact: await dependencyArtifact(names),
      ...(store === undefined ? {} : { dependency_store: store }),
      mode: 'snapshot',
    });

  it('refuses before any engine or workspace work when no prepared store is given', async () => {
    const engine = new FakeEngine();
    const files = workspace();

    await expect(run(engine, files, [])).rejects.toMatchObject({
      code: 'dependencies_not_prepared',
      message: expect.stringContaining('no prepared store was given') as string,
    });
    expect(engine.calls).toEqual([]);
    expect(files.calls).toEqual([]);
  });

  it('refuses before any engine work when packages are missing, and says how many', async () => {
    const engine = new FakeEngine();
    const files = workspace();
    const store = await preparedStore(['a']);

    const error = await run(engine, files, ['a', 'b', 'c'], store).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({ code: 'dependencies_not_prepared' });
    expect((error as RunnerError).message).toContain('2 locked packages are missing');
    expect(engine.calls).toEqual([]);
    expect(files.calls).toEqual([]);
  });

  it('uses the singular for one missing package', async () => {
    const error = await run(new FakeEngine(), workspace(), ['a'], await preparedStore([])).catch(
      (caught: unknown) => caught,
    );

    expect((error as RunnerError).message).toContain('1 locked package is missing');
  });

  it('refuses a prepared store that does not exist, and creates nothing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-runner-deps-'));
    storeRoots.push(root);

    await expect(
      run(new FakeEngine(), workspace(), [], path.join(root, 'nothing')),
    ).rejects.toMatchObject({ code: 'dependencies_not_prepared' });
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a store whose entry no longer matches its hash', async () => {
    const store = await preparedStore(['a']);
    const hex = createHash('sha512').update(tarballOf('a')).digest('hex');
    const entry = path.join(
      store,
      '_cacache',
      'content-v2',
      'sha512',
      hex.slice(0, 2),
      hex.slice(2, 4),
      hex.slice(4),
    );
    await rm(entry);
    await writeFile(entry, 'tampered');

    await expect(run(new FakeEngine(), workspace(), ['a'], store)).rejects.toMatchObject({
      code: 'dependencies_not_prepared',
    });
  });

  it('rejects an artifact whose lockfile cannot be used', async () => {
    const parsed = await dependencyArtifact([]);
    const broken = '{"lockfileVersion":2,"packages":{}}';
    const artifact = {
      ...parsed,
      files: parsed.files.map((file) =>
        file.path === 'package-lock.json'
          ? { ...file, content: broken, sha256: sha256(broken) }
          : file,
      ),
    };
    const engine = new FakeEngine();

    await expect(
      createDockerRunner({ engine, policy: policy(), workspace: workspace() }).run({
        artifact,
        dependency_store: await preparedStore([]),
        mode: 'snapshot',
      }),
    ).rejects.toMatchObject({ code: 'policy_rejection' });
    expect(engine.calls).toEqual([]);
  });

  it('creates the container with the verified store when it is complete', async () => {
    const engine = new FakeEngine();
    const store = await preparedStore(['a', 'b']);

    const result = await run(engine, workspace(), ['a', 'b'], store);

    expect(engine.calls).toEqual(['capabilities', 'image', 'create', 'start', 'remove']);
    expect(engine.specs).toHaveLength(1);
    expect(engine.specs[0]?.dependency_cache).toBe(store);
    expect(result.effective_limits.writable_workspace_mb).toBe(256);
  });

  it('uses the larger workspace only for artifacts with dependencies', async () => {
    const engine = new FakeEngine();
    const withDependencies = await run(engine, workspace(), [], await preparedStore([]));
    const without = await createDockerRunner({
      engine: new FakeEngine(),
      policy: policy(),
      workspace: workspace(),
    }).run({ artifact: await artifact(), mode: 'snapshot' });

    expect(withDependencies.effective_limits.writable_workspace_mb).toBe(256);
    expect(without.effective_limits.writable_workspace_mb).toBe(64);
  });

  it('ignores a store given for an artifact that has no dependency files', async () => {
    const engine = new FakeEngine();

    await createDockerRunner({ engine, policy: policy(), workspace: workspace() }).run({
      artifact: await artifact(),
      dependency_store: '/does/not/matter',
      mode: 'snapshot',
    });

    expect(engine.specs[0]).not.toHaveProperty('dependency_cache');
  });

  it('reports a failed install, with only the npm error code, when the bootstrap exits 199', async () => {
    const engine = new FakeEngine();
    engine.state = { exit_code: DEPENDENCY_INSTALL_FAILED_EXIT_CODE, oom_killed: false };
    engine.stderr = [
      'npm error code ENOSPC',
      'npm error syscall write',
      'npm error path /workspace/node_modules/some-secret-looking-package/file.js',
    ].join('\n');

    const error = await run(engine, workspace(), [], await preparedStore([])).catch(
      (caught: unknown) => caught,
    );

    expect(error).toMatchObject({
      code: 'dependency_install_failed',
      cleanup: { completed: true },
    });
    expect((error as RunnerError).message).toBe(
      'The locked packages could not be installed offline (npm error ENOSPC).',
    );
    expect((error as RunnerError).message).not.toContain('some-secret-looking-package');
  });

  it.each([
    ['no npm code at all', 'something went wrong'],
    ['a code that is not an npm error line', 'the package is called npm error code EFAKE'],
    ['a code in the middle of a line', 'x npm error code EFAKE'],
    ['a lower-case code', 'npm error code enospc'],
    ['an over-long code', `npm error code E${'A'.repeat(40)}`],
  ])('does not echo anything from the output when it holds %s', async (_name, stderr) => {
    const engine = new FakeEngine();
    engine.state = { exit_code: DEPENDENCY_INSTALL_FAILED_EXIT_CODE, oom_killed: false };
    engine.stderr = stderr;

    const error = await run(engine, workspace(), [], await preparedStore([])).catch(
      (caught: unknown) => caught,
    );

    expect((error as RunnerError).message).toBe(
      'The locked packages could not be installed offline.',
    );
  });

  it('keeps resource termination ahead of a failed install', async () => {
    const engine = new FakeEngine();
    engine.state = { exit_code: 137, oom_killed: true };

    await expect(run(engine, workspace(), [], await preparedStore([]))).rejects.toMatchObject({
      code: 'resource_termination',
    });
  });

  it('does not treat exit status 199 as an install failure when there are no dependencies', async () => {
    const engine = new FakeEngine();
    engine.state = { exit_code: DEPENDENCY_INSTALL_FAILED_EXIT_CODE, oom_killed: false };

    const result = await createDockerRunner({
      engine,
      policy: policy(),
      workspace: workspace(),
    }).run({ artifact: await artifact(), mode: 'snapshot' });

    expect(result.execution).toMatchObject({ exit_code: 199, termination_reason: 'exited' });
  });

  it('treats an ordinary failing command as the command failing, not the install', async () => {
    const engine = new FakeEngine();
    engine.state = { exit_code: 1, oom_killed: false };

    const result = await run(engine, workspace(), [], await preparedStore([]));

    expect(result.execution).toMatchObject({ exit_code: 1, termination_reason: 'exited' });
  });
});

describe('Docker arguments for dependencies', () => {
  const base = {
    arguments: ['reproduction.mjs'],
    image: APPROVED_NODE_IMAGE,
    input_path: '/tmp/proofissue-input',
    limits: {
      cpus: 1,
      memory_mb: 512,
      output_bytes_per_stream: 1024,
      processes: 64,
      timeout_seconds: 60,
      writable_workspace_mb: 256,
    },
    name: 'proofissue-test',
  };
  const bootstrapOf = (arguments_: readonly string[]): string => {
    const index = arguments_.indexOf('-c');
    return arguments_[index + 1] ?? '';
  };

  it('adds a second, read-only mount for the prepared store and nothing else', () => {
    const without = buildDockerCreateArguments(base);
    const withCache = buildDockerCreateArguments({
      ...base,
      dependency_cache: '/prepared/dependency-store',
    });

    expect(without.join(' ')).not.toContain('proofissue-cache');
    expect(withCache).toContain(
      'type=bind,src=/prepared/dependency-store,dst=/proofissue-cache,readonly',
    );
    expect(withCache.filter((item) => item === '--mount')).toHaveLength(2);
    expect(
      withCache
        .filter((item) => item.includes('dst='))
        .every((item) => item.endsWith('readonly') || item.includes('tmpfs')),
    ).toBe(true);
  });

  it('keeps the container locked down exactly as before', () => {
    const withCache = buildDockerCreateArguments({ ...base, dependency_cache: '/store' });

    for (const control of [
      ['--network', 'none'],
      ['--read-only'],
      ['--cap-drop', 'ALL'],
      ['--security-opt', 'no-new-privileges:true'],
      ['--user', '65532:65532'],
      ['--pull', 'never'],
    ]) {
      expect(withCache.join(' ')).toContain(control.join(' '));
    }
    expect(withCache.join(' ')).not.toContain('privileged');
    expect(withCache.join(' ')).not.toContain('docker.sock');
  });

  it('sizes the workspace from the effective limit', () => {
    const withCache = buildDockerCreateArguments({ ...base, dependency_cache: '/store' });

    expect(withCache.join(' ')).toContain(
      `/workspace:rw,nosuid,nodev,noexec,size=${String(256 * 1_048_576)}`,
    );
  });

  it('uses the dependency bootstrap only when there is a store', () => {
    const plain = bootstrapOf(buildDockerCreateArguments(base));
    const dependent = bootstrapOf(
      buildDockerCreateArguments({ ...base, dependency_cache: '/store' }),
    );

    expect(plain).not.toContain('npm');
    expect(dependent).toContain('npm ci --offline --ignore-scripts');
    expect(dependent).toContain('--cache /proofissue-cache');
  });

  it('installs offline, without scripts, before it starts the command, and fails closed', () => {
    const script = bootstrapOf(buildDockerCreateArguments({ ...base, dependency_cache: '/store' }));
    const lines = script.split('\n');

    expect(lines[0]).toContain('exit 199');
    expect(lines.at(-1)).toBe('exec env -i PATH=/usr/local/bin:/usr/bin:/bin "$@"');
    const install = lines.findIndex((line) => line.includes('npm ci'));
    expect(install).toBeGreaterThan(0);
    expect(install).toBeLessThan(lines.length - 1);
    expect(lines[install]).toMatch(/\|\| fail$/u);
    for (const line of lines.slice(1, -1)) expect(line).toMatch(/\|\| fail$/u);
    expect(script).not.toContain('--registry');
    expect(script).not.toMatch(/npm (install|i|add)\b/u);
  });

  it('puts no artifact data into the script', () => {
    const script = bootstrapOf(
      buildDockerCreateArguments({
        ...base,
        arguments: ['; touch /pwned', '$(id)'],
        dependency_cache: '/store',
      }),
    );

    expect(script).not.toContain('pwned');
    expect(script).not.toContain('$(id)');
  });

  it('runs npm with an empty, controlled environment', () => {
    const script = bootstrapOf(buildDockerCreateArguments({ ...base, dependency_cache: '/store' }));
    const install = script.split('\n').find((line) => line.includes('npm ci')) ?? '';

    expect(install.startsWith('env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp npm ci')).toBe(
      true,
    );
  });

  it.each([
    ['a comma', '/store,readonly=false'],
    ['a double quote', '/store"x'],
    ['a newline', '/store\nx'],
    ['a relative path', 'store'],
    ['an empty path', ''],
  ])('rejects a prepared store path with %s', (_name, cache) => {
    expect(() => buildDockerCreateArguments({ ...base, dependency_cache: cache })).toThrow(
      expect.objectContaining({ code: 'policy_rejection' }) as Error,
    );
  });
});
