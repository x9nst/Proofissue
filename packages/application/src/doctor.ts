import {
  APPROVED_NODE_IMAGE,
  diagnoseDockerEngine,
  type EngineCheck,
  type EngineDiagnosis,
  type EngineHost,
} from '@proofissue/runner';

import { REPLAY_NODE_MAJOR } from './record-defaults.js';

/**
 * Environment diagnosis for `proofissue doctor`. It answers two questions: can this host
 * record, and can it replay? It runs only read-only Docker CLI calls, never pulls the image,
 * never creates a container, and never uses the network. A missing image is reported with the
 * exact command that fetches it; running that command stays the user's decision.
 */
export type DoctorCheckId =
  | 'docker_cli'
  | 'docker_context'
  | 'docker_engine'
  | 'docker_seccomp'
  | 'host'
  | 'node'
  | 'replay_image';

export type DoctorCheckStatus = 'fail' | 'ok' | 'skipped' | 'warn';

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  /** A fixed command or instruction that fixes a failure or warning, when there is one. */
  readonly next_step?: string;
  readonly status: DoctorCheckStatus;
  readonly summary: string;
}

export interface DoctorReport {
  /** The image replay accepts; the only one `doctor` looks for. */
  readonly approved_image: string;
  /** In the order they are shown: Node.js first, the approved image last. */
  readonly checks: readonly DoctorCheck[];
  /** Recording runs on the host's Node.js and needs no container. */
  readonly recording_ready: boolean;
  readonly replay_ready: boolean;
}

export interface DoctorApplicationService {
  readonly doctor: () => Promise<DoctorReport>;
}

export interface DoctorPorts {
  /** Defaults to the real read-only Docker diagnosis. Tests inject a fake. */
  readonly diagnose?: (image: string) => Promise<EngineDiagnosis>;
  readonly host?: EngineHost;
  /** Defaults to `process.version`. */
  readonly node_version?: string;
}

const NEXT_STEPS: Readonly<Record<string, string>> = {
  host: 'Replay needs an x86-64 Linux host. Record here, then replay on Linux or with the GitHub Action on a hosted Linux runner.',
  docker_cli: 'Install Docker Engine 27 or newer and make the docker command available.',
  docker_context:
    'Switch to the local Docker context (docker context use default); remote contexts are not supported.',
  docker_engine:
    'Start a local rootful Docker Engine 27 or newer that runs Linux amd64 containers.',
  docker_seccomp: "Enable Docker's default seccomp profile; replay refuses to run without it.",
};

const nodeCheck = (version: string): DoctorCheck => {
  const major = Number.parseInt(/^v?(\d+)\./u.exec(version)?.[1] ?? '', 10);
  if (major === REPLAY_NODE_MAJOR) {
    return {
      id: 'node',
      status: 'ok',
      summary: `Node.js ${version.replace(/^v/u, '')}; replay uses the same major version.`,
    };
  }
  return {
    id: 'node',
    status: 'warn',
    summary: `Node.js ${version.replace(/^v/u, '')}; replay always uses Node.js ${String(REPLAY_NODE_MAJOR)}, so a recording made here can behave differently when replayed.`,
    next_step: `Record with Node.js ${String(REPLAY_NODE_MAJOR)} for the closest match to replay.`,
  };
};

const toCheck = (check: EngineCheck, host: EngineHost, image: string): DoctorCheck => {
  const nextStep =
    check.status === 'fail'
      ? check.name === 'replay_image'
        ? `Run: docker pull ${image}`
        : NEXT_STEPS[check.name]
      : undefined;
  const summary =
    check.name === 'host' && check.status === 'ok'
      ? `${host.platform} ${host.arch}.`
      : check.summary;
  return {
    id: check.name,
    status: check.status,
    summary,
    ...(nextStep === undefined ? {} : { next_step: nextStep }),
  };
};

export const createDoctorService = (ports: DoctorPorts = {}): DoctorApplicationService => ({
  doctor: async () => {
    const host = ports.host ?? { platform: process.platform, arch: process.arch };
    const image = APPROVED_NODE_IMAGE;
    const diagnose =
      ports.diagnose ??
      ((target: string) => diagnoseDockerEngine(undefined, host, { image: target }));
    const node = nodeCheck(ports.node_version ?? process.version);
    const diagnosis = await diagnose(image);
    return {
      approved_image: image,
      checks: [node, ...diagnosis.checks.map((check) => toCheck(check, host, image))],
      recording_ready: true,
      replay_ready: diagnosis.ready,
    };
  },
});
