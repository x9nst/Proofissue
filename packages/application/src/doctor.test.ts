import { describe, expect, it } from 'vitest';

import { diagnoseDockerEngine, type DockerCommandResult, type DockerRun } from '@proofissue/runner';

import { APPROVED_REPLAY_IMAGE, createDoctorService } from './index.js';

const ok = (stdout: string): DockerCommandResult => ({ exit_code: 0, stdout, stderr: '' });
const failed = (): DockerCommandResult => ({ exit_code: 1, stdout: '', stderr: '' });

const docker = (image: DockerCommandResult): { calls: string[][]; run: DockerRun } => {
  const calls: string[][] = [];
  return {
    calls,
    run: (arguments_) => {
      calls.push([...arguments_]);
      switch (arguments_[0]) {
        case 'context':
          return Promise.resolve(ok('"unix:///var/run/docker.sock"'));
        case 'version':
          return Promise.resolve(ok('{"Os":"linux","Arch":"amd64","Version":"27.3.1"}'));
        case 'info':
          return Promise.resolve(ok('["name=seccomp,profile=builtin"]'));
        default:
          return Promise.resolve(image);
      }
    },
  };
};

const linux = { platform: 'linux', arch: 'x64' };

const serviceFor = (fake: { run: DockerRun }, nodeVersion: string) =>
  createDoctorService({
    host: linux,
    node_version: nodeVersion,
    diagnose: (image) => diagnoseDockerEngine(fake.run, linux, { image }),
  });

describe('doctor', () => {
  it('reports recording readiness, a Node.js major mismatch, and the missing image', async () => {
    const fake = docker(failed());
    const report = await serviceFor(fake, 'v22.4.0').doctor();

    expect(report.recording_ready).toBe(true);
    expect(report.replay_ready).toBe(false);
    expect(report.approved_image).toBe(APPROVED_REPLAY_IMAGE);
    expect(report.checks.map((check) => `${check.id}:${check.status}`)).toEqual([
      'node:warn',
      'host:ok',
      'docker_cli:ok',
      'docker_context:ok',
      'docker_engine:ok',
      'docker_seccomp:ok',
      'replay_image:fail',
    ]);
    expect(report.checks[0]?.summary).toContain('Node.js 22.4.0');
    expect(report.checks[0]?.next_step).toContain('Node.js 24');
    expect(report.checks.at(-1)?.next_step).toBe(`Run: docker pull ${APPROVED_REPLAY_IMAGE}`);
    expect(fake.calls.every((call) => call[0] !== 'pull' && call[0] !== 'run')).toBe(true);
  });

  it('is ready when every check passes on the matching Node.js major', async () => {
    const report = await serviceFor(docker(ok('[]')), 'v24.18.0').doctor();

    expect(report.replay_ready).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
      'ok',
    ]);
    expect(report.checks.every((check) => check.next_step === undefined)).toBe(true);
  });

  it('skips the Docker checks on an unsupported host and says how to replay anyway', async () => {
    const fake = docker(ok('[]'));
    const windows = { platform: 'win32', arch: 'x64' };
    const report = await createDoctorService({
      host: windows,
      node_version: 'v24.0.0',
      diagnose: (image) => diagnoseDockerEngine(fake.run, windows, { image }),
    }).doctor();

    expect(report.replay_ready).toBe(false);
    expect(report.recording_ready).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual([
      'ok',
      'fail',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
      'skipped',
    ]);
    expect(report.checks[1]?.next_step).toContain('GitHub Action');
    expect(fake.calls).toEqual([]);
  });
});
