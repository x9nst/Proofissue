import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseAndValidateArtifact, serializeArtifact } from '@proofissue/artifact-schema';
import {
  APPROVED_NODE_IMAGE,
  createDockerRunner,
  type ContainerCreateSpec,
  type ContainerEngine,
  type ContainerState,
} from '@proofissue/runner';

import { createReplayApplicationService } from './index.js';

const integration = describe.runIf(process.env.PROOFISSUE_RUN_CONTAINER_TESTS === '1');

class LocalFixtureEngine implements ContainerEngine {
  #spec: ContainerCreateSpec | undefined;

  assertCapabilities(): Promise<void> {
    return Promise.resolve();
  }

  imageExists(): Promise<boolean> {
    return Promise.resolve(true);
  }

  create(spec: ContainerCreateSpec): Promise<void> {
    this.#spec = spec;
    return Promise.resolve();
  }

  async start(
    _name: string,
    onStdout: (chunk: Uint8Array) => void,
    onStderr: (chunk: Uint8Array) => void,
  ): Promise<ContainerState> {
    const spec = this.#spec;
    if (spec === undefined) throw new Error('Fixture engine was not prepared.');
    return await new Promise<ContainerState>((resolve, reject) => {
      const child = spawn(process.execPath, [...spec.arguments], {
        cwd: spec.input_path,
        env: {},
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (chunk: Buffer) => {
        onStdout(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        onStderr(chunk);
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({
          ...(code === null ? {} : { exit_code: code }),
          ...(signal === null ? {} : { signal }),
          oom_killed: false,
        });
      });
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  kill(): Promise<void> {
    return Promise.resolve();
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }
}

const runFixVerificationFixture = async (useRealContainer: boolean): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-fix-verification-'));
  const checkout = path.join(root, 'checkout');
  const artifactPath = path.join(root, 'failure.proofissue');
  await mkdir(checkout);
  try {
    const source = await readFile('tests/fixtures/artifacts/v1/valid/canonical.proofissue');
    const parsed = parseAndValidateArtifact(source);
    if (!parsed.ok) throw new Error('Canonical fixture must be valid.');
    await writeFile(
      artifactPath,
      serializeArtifact({
        ...parsed.artifact,
        environment: { ...parsed.artifact.environment, image: APPROVED_NODE_IMAGE },
      }),
    );
    await writeFile(
      path.join(checkout, 'calculate.mjs'),
      'export function calculate(value) { return value * 2; }\n',
    );
    await writeFile(
      path.join(checkout, 'reproduction.mjs'),
      'throw new Error("checkout reproduction must be ignored");\n',
    );
    await writeFile(path.join(checkout, 'new-file.mjs'), 'throw new Error("must be ignored");\n');

    const runner = useRealContainer
      ? undefined
      : createDockerRunner({ engine: new LocalFixtureEngine() });
    const replay = createReplayApplicationService({
      ...(runner === undefined ? {} : { runner }),
    }).replay;
    const snapshot = await replay({ artifact_path: artifactPath, mode: 'snapshot' });
    const corrected = await replay({
      artifact_path: artifactPath,
      mode: 'current_checkout',
      against_path: checkout,
    });

    expect(snapshot.status).toBe('reproduced');
    expect(snapshot.evidence).toEqual([
      { kind: 'exit_code', message: 'Exit code matched: 1.' },
      { kind: 'stderr_contains', message: 'Expected stderr text was present.' },
    ]);
    expect(corrected.status).toBe('not_reproduced');
    expect(corrected.execution?.exit_code).toBe(0);
    expect(corrected.substituted_paths).toEqual(['calculate.mjs']);
    expect(corrected.scope_limitations).toContainEqual({
      code: 'declared_subject_paths_only',
      message:
        'Only listed subject paths were substituted; undeclared additions, removals, and renames were not evaluated.',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe('Milestone 5 fix verification through the shared application service', () => {
  it('reproduces the snapshot and does not reproduce with only the corrected declared subject', async () => {
    await runFixVerificationFixture(false);
  });
});

integration('Milestone 5 fix verification', () => {
  it('reproduces the snapshot and does not reproduce with only the corrected declared subject', async () => {
    await runFixVerificationFixture(true);
  }, 60_000);
});
