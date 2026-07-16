import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { ARTIFACT_LIMITS, parseAndValidateArtifact } from '@proofissue/artifact-schema';

import {
  APPROVED_NODE_IMAGE,
  buildDockerCreateArguments,
  createDockerRunner,
  RunnerError,
  type ContainerEngine,
  type ContainerState,
  type CurrentCheckoutReader,
  type ReplayWorkspace,
  type RunnerPolicy,
} from './index.js';

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
  async create(): Promise<void> {
    this.#operation('create');
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

  it('rejects a symbolic-link subject that escapes the selected checkout', async () => {
    const checkout = await mkdtemp(path.join(tmpdir(), 'proofissue-symlink-checkout-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'proofissue-symlink-outside-'));
    const outsideFile = path.join(outside, 'calculate.mjs');
    await writeFile(outsideFile, 'export const escaped = true;\n');
    try {
      try {
        await symlink(outsideFile, path.join(checkout, 'calculate.mjs'), 'file');
      } catch (error: unknown) {
        const code =
          typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
        if (code === 'EPERM') return;
        throw error;
      }
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
