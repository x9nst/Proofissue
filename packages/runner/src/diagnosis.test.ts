import { describe, expect, it } from 'vitest';

import {
  APPROVED_NODE_IMAGE,
  createDockerEngine,
  diagnoseDockerEngine,
  RunnerError,
  type DockerCommandResult,
  type DockerRun,
  type EngineHost,
} from './index.js';

const LINUX: EngineHost = { platform: 'linux', arch: 'x64' };

const ok = (stdout: string): DockerCommandResult => ({ exit_code: 0, stdout, stderr: '' });
const failed = (): DockerCommandResult => ({ exit_code: 1, stdout: '', stderr: 'denied' });

interface FakeDocker {
  readonly calls: string[][];
  readonly run: DockerRun;
}

/** A Docker CLI whose answers are keyed by the first one or two arguments. */
const fakeDocker = (
  answers: Readonly<Record<string, DockerCommandResult | 'missing'>>,
): FakeDocker => {
  const calls: string[][] = [];
  return {
    calls,
    run: (arguments_) => {
      calls.push([...arguments_]);
      const key = arguments_[0] === 'image' ? 'image' : (arguments_[0] ?? '');
      const answer = answers[key];
      if (answer === 'missing')
        return Promise.reject(new RunnerError('engine_unavailable', 'Docker is unavailable.'));
      return Promise.resolve(answer ?? failed());
    },
  };
};

const READY = {
  context: ok('"unix:///var/run/docker.sock"'),
  version: ok('{"Os":"linux","Arch":"amd64","Version":"27.3.1"}'),
  info: ok('["name=seccomp,profile=builtin","name=cgroupns"]'),
  image: ok('["node@sha256:abc"]'),
} as const;

const statuses = async (
  docker: FakeDocker,
  host = LINUX,
  image: string = APPROVED_NODE_IMAGE,
): Promise<readonly string[]> => {
  const diagnosis = await diagnoseDockerEngine(docker.run, host, { image });
  return diagnosis.checks.map((check) => `${check.name}:${check.status}`);
};

describe('diagnoseDockerEngine', () => {
  it('diagnoses each prerequisite in order and skips the rest after a failure', async () => {
    expect(await statuses(fakeDocker(READY))).toEqual([
      'host:ok',
      'docker_cli:ok',
      'docker_context:ok',
      'docker_engine:ok',
      'docker_seccomp:ok',
      'replay_image:ok',
    ]);
    expect(await statuses(fakeDocker({ ...READY, version: failed() }))).toEqual([
      'host:ok',
      'docker_cli:ok',
      'docker_context:ok',
      'docker_engine:fail',
      'docker_seccomp:skipped',
      'replay_image:skipped',
    ]);
    const docker = fakeDocker(READY);
    expect(await statuses(docker, { platform: 'win32', arch: 'x64' })).toEqual([
      'host:fail',
      'docker_cli:skipped',
      'docker_context:skipped',
      'docker_engine:skipped',
      'docker_seccomp:skipped',
      'replay_image:skipped',
    ]);
    expect(docker.calls).toEqual([]);
    expect(await statuses(fakeDocker({ context: 'missing' }))).toEqual([
      'host:ok',
      'docker_cli:fail',
      'docker_context:skipped',
      'docker_engine:skipped',
      'docker_seccomp:skipped',
      'replay_image:skipped',
    ]);
  });

  it('reports a missing image with the exact pull command and no further effect', async () => {
    const docker = fakeDocker({ ...READY, image: failed() });
    const diagnosis = await diagnoseDockerEngine(docker.run, LINUX, { image: APPROVED_NODE_IMAGE });

    expect(diagnosis.ready).toBe(false);
    const image = diagnosis.checks.at(-1);
    expect(image).toMatchObject({
      name: 'replay_image',
      status: 'fail',
      code: 'image_unavailable',
      remedy: `docker pull ${APPROVED_NODE_IMAGE}`,
    });
    expect(docker.calls.map((call) => call.slice(0, 2).join(' '))).toEqual([
      'context inspect',
      'version --format',
      'info --format',
      'image inspect',
    ]);
  });

  it('runs only read-only Docker subcommands', async () => {
    const docker = fakeDocker(READY);
    await diagnoseDockerEngine(docker.run, LINUX, { image: APPROVED_NODE_IMAGE });
    for (const call of docker.calls) {
      expect(['context', 'version', 'info', 'image']).toContain(call[0]);
      expect(call).not.toContain('pull');
    }
  });

  it('shows the engine version only when it looks like a version', async () => {
    const odd = fakeDocker({
      ...READY,
      version: ok('{"Os":"linux","Arch":"amd64","Version":"27.1 \\u001b[31mred"}'),
    });
    const diagnosis = await diagnoseDockerEngine(odd.run, LINUX);
    const engine = diagnosis.checks.find((check) => check.name === 'docker_engine');
    expect(engine?.summary).toBe('Docker Engine 27 or newer, linux/amd64.');
  });
});

describe('assertCapabilities', () => {
  const raised = async (
    docker: FakeDocker,
    host = LINUX,
  ): Promise<[string, string] | undefined> => {
    try {
      await createDockerEngine({ run: docker.run, host }).assertCapabilities();
    } catch (error: unknown) {
      if (error instanceof RunnerError) return [error.code, error.message];
      throw error;
    }
    return undefined;
  };

  it('raises the same codes and messages as before', async () => {
    expect(await raised(fakeDocker(READY))).toBeUndefined();
    expect(await raised(fakeDocker(READY), { platform: 'darwin', arch: 'arm64' })).toEqual([
      'engine_capability_unavailable',
      'Replay currently requires a local x86-64 Linux host with Docker Engine.',
    ]);
    expect(await raised(fakeDocker({ context: 'missing' }))).toEqual([
      'engine_unavailable',
      'Docker is unavailable.',
    ]);
    expect(await raised(fakeDocker({ ...READY, context: failed() }))).toEqual([
      'engine_unavailable',
      'The local Docker context could not be inspected.',
    ]);
    expect(await raised(fakeDocker({ ...READY, context: ok('"ssh://remote"') }))).toEqual([
      'engine_capability_unavailable',
      'Remote Docker contexts are not supported for replay.',
    ]);
    expect(await raised(fakeDocker({ ...READY, context: ok('not json') }))).toEqual([
      'engine_capability_unavailable',
      'Docker returned an invalid context.',
    ]);
    expect(await raised(fakeDocker({ ...READY, version: ok('null') }))).toEqual([
      'engine_unavailable',
      'The Docker Engine is not running.',
    ]);
    expect(await raised(fakeDocker({ ...READY, version: ok('{') }))).toEqual([
      'engine_capability_unavailable',
      'Docker returned invalid server information.',
    ]);
    expect(
      await raised(
        fakeDocker({ ...READY, version: ok('{"Os":"linux","Arch":"amd64","Version":"26.1"}') }),
      ),
    ).toEqual([
      'engine_capability_unavailable',
      'Replay requires Docker Engine 27 or newer running Linux amd64 containers.',
    ]);
    expect(await raised(fakeDocker({ ...READY, info: ok('["name=apparmor"]') }))).toEqual([
      'engine_capability_unavailable',
      'Docker must provide its default seccomp security profile.',
    ]);
  });

  it('does not check the image, which replay checks separately', async () => {
    const docker = fakeDocker({ ...READY, image: failed() });
    expect(await raised(docker)).toBeUndefined();
    expect(docker.calls.some((call) => call[0] === 'image')).toBe(false);
  });
});
