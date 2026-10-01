/**
 * The only place the harness starts a child process.
 *
 * Every external step goes through an {@link Executor}: no shell, an explicit environment,
 * bounded output, and a time limit. The pipeline depends on the interface, so its tests run
 * against a fake and never start a real process.
 */
import { spawn } from 'node:child_process';

import type { BoundedStreamCapture } from '@proofissue/contracts';
import { BoundedOutputCollector } from '@proofissue/process-output';

export interface ExecRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  /** The complete environment of the child. Nothing is inherited. */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  /**
   * `immediate` kills the whole process group at the deadline. `graceful` asks the process to
   * stop with SIGTERM (so a ProofIssue CLI can abort and remove its container) and kills the
   * group only after a grace period.
   */
  readonly termination: 'graceful' | 'immediate';
}

export interface ExecOutcome {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly spawnFailed: boolean;
  readonly durationMs: number;
  readonly stdout: BoundedStreamCapture;
  readonly stderr: BoundedStreamCapture;
}

export type Executor = (request: ExecRequest) => Promise<ExecOutcome>;

/** How long a gracefully terminated process may take to exit before its group is killed. */
export const GRACE_PERIOD_MS = 30_000;

const isWindows = (): boolean => process.platform === 'win32';

const childEnvironment = (env: Readonly<Record<string, string>>): Record<string, string> => {
  if (!isWindows()) return { ...env };
  const systemRoot = process.env['SystemRoot'];
  return systemRoot === undefined ? { ...env } : { ...env, SystemRoot: systemRoot };
};

const killGroup = (
  pid: number | undefined,
  child: { kill: (signal: NodeJS.Signals) => boolean },
) => {
  if (isWindows() || pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};

/** Runs one command with bounded output and a deadline. Never throws. */
export const runBounded: Executor = (request) => {
  const stdout = new BoundedOutputCollector(request.outputLimitBytes);
  const stderr = new BoundedOutputCollector(request.outputLimitBytes);
  const started = performance.now();

  return new Promise<ExecOutcome>((resolve) => {
    let settled = false;
    let timedOut = false;
    const timers: { deadline?: NodeJS.Timeout; escalation?: NodeJS.Timeout } = {};

    const finish = (exitCode: number | null, signal: string | null, spawnFailed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.deadline);
      clearTimeout(timers.escalation);
      resolve({
        exitCode,
        signal,
        timedOut,
        spawnFailed,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        stdout: stdout.finish(),
        stderr: stderr.finish(),
      });
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        detached: !isWindows(),
        env: childEnvironment(request.env),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish(null, null, true);
      return;
    }

    timers.deadline = setTimeout(() => {
      timedOut = true;
      if (request.termination === 'immediate' || isWindows()) {
        killGroup(child.pid, child);
        return;
      }
      child.kill('SIGTERM');
      timers.escalation = setTimeout(() => {
        killGroup(child.pid, child);
      }, GRACE_PERIOD_MS);
    }, request.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout.add(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.add(chunk);
    });
    child.once('error', () => {
      finish(null, null, true);
    });
    child.once('close', (exitCode, signal) => {
      // Anything the command left behind in its process group must not outlive the step.
      if (!isWindows() && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The group is already gone, which is the normal case.
        }
      }
      finish(exitCode, signal, false);
    });
  });
};
