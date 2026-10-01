import type { BoundedStreamCapture } from '@proofissue/contracts';
import { describe, expect, it } from 'vitest';

import { collectEnvironment, type EnvironmentInputs, type SystemInfo } from './environment.js';
import type { ExecOutcome, Executor } from './process.js';

const capture = (text: string): BoundedStreamCapture => ({
  decoded_text: text,
  discarded_bytes: 0,
  had_decoding_replacement: false,
  retained_bytes: text.length,
  total_bytes: text.length,
  truncated: false,
});

const outcome = (stdout: string, exitCode: number | null = 0): ExecOutcome => ({
  exitCode,
  signal: null,
  timedOut: false,
  spawnFailed: false,
  durationMs: 5,
  stdout: capture(stdout),
  stderr: capture(''),
});

const systemInfo: SystemInfo = {
  platform: 'linux',
  arch: 'x64',
  kernelRelease: '6.11.0-1018-azure',
  cpuCount: 4,
  cpuModel: 'AMD EPYC 7763 64-Core Processor',
  totalMemoryBytes: 16 * 1024 * 1024 * 1024,
  nodeVersion: '24.18.0',
};

const probes = (answers: Readonly<Record<string, ExecOutcome>>): Executor => {
  return (request) => {
    const answer = answers[request.command];
    return Promise.resolve(answer ?? { ...outcome('', null), spawnFailed: true });
  };
};

const inputs = (overrides: Partial<EnvironmentInputs> = {}): EnvironmentInputs => ({
  exec: probes({
    npm: outcome('11.16.0\n'),
    git: outcome('git version 2.53.0\n'),
    docker: outcome('28.0.4\n'),
  }),
  systemInfo,
  env: {
    PATH: '/usr/bin',
    GITHUB_SHA: 'a'.repeat(40),
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_REPOSITORY: 'example-owner/example-repository',
    GITHUB_RUN_ID: '123456789',
    ImageOS: 'ubuntu24',
    ImageVersion: '20260928.1.0',
  },
  approvedImage: `node@sha256:${'d'.repeat(64)}`,
  cwd: '/mnt/ci/work',
  ...overrides,
});

describe('collectEnvironment', () => {
  it('collects the platform, tool versions, runner image, and run link', async () => {
    expect(await collectEnvironment(inputs())).toEqual({
      harness_commit: 'a'.repeat(40),
      run_url: 'https://github.com/example-owner/example-repository/actions/runs/123456789',
      runner_image: 'ubuntu24/20260928.1.0',
      platform: 'linux',
      arch: 'x64',
      kernel_release: '6.11.0-1018-azure',
      cpu_count: 4,
      cpu_model: 'AMD EPYC 7763 64-Core Processor',
      memory_total_mb: 16384,
      host_node_version: '24.18.0',
      host_npm_version: '11.16.0',
      host_git_version: '2.53.0',
      docker_server_version: '28.0.4',
      approved_image: `node@sha256:${'d'.repeat(64)}`,
    });
  });

  it('leaves out probes that fail and values that do not match their pattern', async () => {
    const environment = await collectEnvironment(
      inputs({
        exec: probes({
          npm: outcome('11.16.0; echo injected\n'),
          git: outcome('', 1),
        }),
        env: { PATH: '/usr/bin', GITHUB_SHA: 'not-a-commit', GITHUB_RUN_ID: 'x' },
        systemInfo: { ...systemInfo, cpuModel: 'Model <script>', kernelRelease: 'bad kernel!' },
      }),
    );

    expect(environment).not.toHaveProperty('host_npm_version');
    expect(environment).not.toHaveProperty('host_git_version');
    expect(environment).not.toHaveProperty('docker_server_version');
    expect(environment).not.toHaveProperty('harness_commit');
    expect(environment).not.toHaveProperty('run_url');
    expect(environment).not.toHaveProperty('runner_image');
    expect(environment.cpu_model).toBe('unknown');
    expect(environment.kernel_release).toBe('unknown');
  });

  it('never carries a hostname, user name, or environment variable', async () => {
    const environment = await collectEnvironment(
      inputs({
        env: {
          PATH: '/usr/bin',
          HOSTNAME: 'build-host-01',
          USER: 'someone',
          GITHUB_TOKEN: 'not-for-results',
        },
      }),
    );
    const text = JSON.stringify(environment);

    expect(text).not.toContain('build-host-01');
    expect(text).not.toContain('someone');
    expect(text).not.toContain('not-for-results');
  });

  it('runs the probes with only PATH and no shell', async () => {
    const requests: Parameters<Executor>[0][] = [];
    const exec: Executor = (request) => {
      requests.push(request);
      return Promise.resolve(outcome('1.0.0\n'));
    };

    await collectEnvironment(inputs({ exec }));

    expect(requests.map((request) => request.command)).toEqual(['npm', 'git', 'docker']);
    for (const request of requests) {
      expect(Object.keys(request.env).sort()).toEqual(['PATH', 'npm_config_update_notifier']);
      expect(request.termination).toBe('immediate');
    }
  });
});
