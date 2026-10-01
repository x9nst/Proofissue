/**
 * Describes the machine a trial ran on.
 *
 * Every value is checked against a strict pattern before it is kept, and anything that does not
 * match is replaced or dropped. Hostnames, user names, and environment variables are never read.
 */
import { arch, cpus, platform, release, totalmem } from 'node:os';

import type { Executor } from './process.js';
import type { EnvironmentRecord } from './result-model.js';

export interface SystemInfo {
  readonly platform: string;
  readonly arch: string;
  readonly kernelRelease: string;
  readonly cpuCount: number;
  readonly cpuModel: string;
  readonly totalMemoryBytes: number;
  readonly nodeVersion: string;
}

export const readSystemInfo = (): SystemInfo => {
  const processors = cpus();
  return {
    platform: platform(),
    arch: arch(),
    kernelRelease: release(),
    cpuCount: processors.length,
    cpuModel: processors[0]?.model ?? 'unknown',
    totalMemoryBytes: totalmem(),
    nodeVersion: process.versions.node,
  };
};

export interface EnvironmentInputs {
  readonly exec: Executor;
  readonly systemInfo: SystemInfo;
  /** The variables the harness may read: GITHUB_SHA, GITHUB_SERVER_URL, and the like. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly approvedImage: string;
  readonly cwd: string;
}

const WORD = /^[a-z0-9]{1,16}$/u;
const KERNEL_RELEASE = /^[0-9A-Za-z._+~-]{1,64}$/u;
const CPU_MODEL = /^[A-Za-z0-9 ()@.,+/_-]{1,128}$/u;
const VERSION = /^[0-9][0-9A-Za-z.+~_-]{0,40}$/u;
const GIT_VERSION_LINE = /^git version ([0-9][0-9A-Za-z.+~_-]{0,40})$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const SERVER_URL = /^https:\/\/[A-Za-z0-9.-]{1,64}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u;
const RUN_ID = /^[0-9]{1,20}$/u;
const RUNNER_IMAGE_PART = /^[A-Za-z0-9._-]{1,32}$/u;

const PROBE_TIMEOUT_MS = 30_000;
const PROBE_OUTPUT_BYTES = 4096;

const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').trim();

const probe = async (
  inputs: EnvironmentInputs,
  command: string,
  args: readonly string[],
): Promise<string | undefined> => {
  const path = inputs.env['PATH'];
  const outcome = await inputs.exec({
    command,
    args,
    cwd: inputs.cwd,
    env: {
      ...(path === undefined ? {} : { PATH: path }),
      npm_config_update_notifier: 'false',
    },
    timeoutMs: PROBE_TIMEOUT_MS,
    outputLimitBytes: PROBE_OUTPUT_BYTES,
    termination: 'immediate',
  });
  if (outcome.spawnFailed || outcome.timedOut || outcome.exitCode !== 0) return undefined;
  return firstLine(outcome.stdout.decoded_text);
};

const runUrl = (env: EnvironmentInputs['env']): string | undefined => {
  const server = env['GITHUB_SERVER_URL'];
  const repository = env['GITHUB_REPOSITORY'];
  const runId = env['GITHUB_RUN_ID'];
  if (
    server === undefined ||
    repository === undefined ||
    runId === undefined ||
    !SERVER_URL.test(server) ||
    !REPOSITORY.test(repository) ||
    !RUN_ID.test(runId)
  ) {
    return undefined;
  }
  return `${server}/${repository}/actions/runs/${runId}`;
};

const runnerImage = (env: EnvironmentInputs['env']): string | undefined => {
  const name = env['ImageOS'];
  const version = env['ImageVersion'];
  if (
    name === undefined ||
    version === undefined ||
    !RUNNER_IMAGE_PART.test(name) ||
    !RUNNER_IMAGE_PART.test(version)
  ) {
    return undefined;
  }
  return `${name}/${version}`;
};

const accepted = (value: string | undefined, pattern: RegExp): string | undefined =>
  value !== undefined && pattern.test(value) ? value : undefined;

/** Collects the environment record. Probes that fail or print unexpected text are left out. */
export const collectEnvironment = async (inputs: EnvironmentInputs): Promise<EnvironmentRecord> => {
  const info = inputs.systemInfo;
  const npmVersion = accepted(await probe(inputs, 'npm', ['--version']), VERSION);
  const gitLine = await probe(inputs, 'git', ['--version']);
  const gitVersion = gitLine === undefined ? undefined : GIT_VERSION_LINE.exec(gitLine)?.[1];
  const dockerVersion = accepted(
    await probe(inputs, 'docker', ['version', '--format', '{{.Server.Version}}']),
    VERSION,
  );
  const commit = accepted(inputs.env['GITHUB_SHA'], COMMIT);
  const url = runUrl(inputs.env);
  const image = runnerImage(inputs.env);
  const cpuModel = info.cpuModel.replace(/\s+/gu, ' ').trim();

  return {
    ...(commit === undefined ? {} : { harness_commit: commit }),
    ...(url === undefined ? {} : { run_url: url }),
    ...(image === undefined ? {} : { runner_image: image }),
    platform: accepted(info.platform, WORD) ?? 'unknown',
    arch: accepted(info.arch, WORD) ?? 'unknown',
    kernel_release: accepted(info.kernelRelease, KERNEL_RELEASE) ?? 'unknown',
    cpu_count: Number.isSafeInteger(info.cpuCount) && info.cpuCount >= 0 ? info.cpuCount : 0,
    cpu_model: accepted(cpuModel, CPU_MODEL) ?? 'unknown',
    memory_total_mb: Math.max(0, Math.round(info.totalMemoryBytes / (1024 * 1024))),
    host_node_version: accepted(info.nodeVersion, VERSION) ?? 'unknown',
    ...(npmVersion === undefined ? {} : { host_npm_version: npmVersion }),
    ...(gitVersion === undefined ? {} : { host_git_version: gitVersion }),
    ...(dockerVersion === undefined ? {} : { docker_server_version: dockerVersion }),
    approved_image: inputs.approvedImage,
  };
};
