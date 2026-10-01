import { describe, expect, it } from 'vitest';

import { runBounded, type ExecRequest } from './process.js';

const request = (script: string, overrides: Partial<ExecRequest> = {}): ExecRequest => ({
  command: process.execPath,
  args: ['-e', script],
  cwd: process.cwd(),
  env: {},
  timeoutMs: 20_000,
  outputLimitBytes: 64 * 1024,
  termination: 'immediate',
  ...overrides,
});

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitUntilGone = async (pid: number): Promise<boolean> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!isRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

describe('runBounded', () => {
  it('captures the exit code and both streams', async () => {
    const outcome = await runBounded(
      request("process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"),
    );

    expect(outcome).toMatchObject({
      exitCode: 3,
      signal: null,
      timedOut: false,
      spawnFailed: false,
    });
    expect(outcome.stdout.decoded_text).toBe('out');
    expect(outcome.stderr.decoded_text).toBe('err');
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a timeout and stops the child', async () => {
    const outcome = await runBounded(
      request('process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)', {
        timeoutMs: 600,
      }),
    );

    expect(outcome.timedOut).toBe(true);
    expect(outcome.spawnFailed).toBe(false);
    expect(outcome.durationMs).toBeLessThan(10_000);
    const pid = Number(outcome.stdout.decoded_text);
    expect(Number.isInteger(pid)).toBe(true);
    expect(await waitUntilGone(pid)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')(
    'asks a gracefully terminated process to stop before killing it',
    async () => {
      const outcome = await runBounded(
        request(
          "process.on('SIGTERM', () => { process.stdout.write('stopping'); process.exit(0); }); process.stdout.write('ready'); setInterval(() => {}, 1000)",
          { timeoutMs: 800, termination: 'graceful' },
        ),
      );

      expect(outcome.timedOut).toBe(true);
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout.decoded_text).toContain('stopping');
    },
  );

  it('flags truncated output and keeps the head', async () => {
    const outcome = await runBounded(
      request("process.stdout.write('a'.repeat(5000))", { outputLimitBytes: 100 }),
    );

    expect(outcome.stdout).toMatchObject({
      retained_bytes: 100,
      total_bytes: 5000,
      discarded_bytes: 4900,
      truncated: true,
    });
    expect(outcome.stdout.decoded_text).toBe('a'.repeat(100));
    expect(outcome.stderr.truncated).toBe(false);
  });

  it('passes exactly the given environment', async () => {
    const previous = process.env['PROOFISSUE_TEST_SENTINEL'];
    process.env['PROOFISSUE_TEST_SENTINEL'] = 'leaked';
    try {
      const outcome = await runBounded(
        request(
          "process.stdout.write(String(process.env.PROOFISSUE_TEST_SENTINEL) + '|' + process.env.FOO)",
          { env: { FOO: 'bar' } },
        ),
      );

      expect(outcome.stdout.decoded_text).toBe('undefined|bar');
    } finally {
      if (previous === undefined) delete process.env['PROOFISSUE_TEST_SENTINEL'];
      else process.env['PROOFISSUE_TEST_SENTINEL'] = previous;
    }
  });

  it('does not interpret shell syntax in arguments', async () => {
    const outcome = await runBounded({
      ...request('process.stdout.write(process.argv[1])'),
      args: ['-e', 'process.stdout.write(process.argv[1])', 'a;b|c$(x)&&d'],
    });

    expect(outcome.stdout.decoded_text).toBe('a;b|c$(x)&&d');
  });

  it('reports a spawn failure', async () => {
    const outcome = await runBounded({
      ...request('0'),
      command: 'proofissue-trial-command-that-does-not-exist',
    });

    expect(outcome).toMatchObject({ spawnFailed: true, exitCode: null, timedOut: false });
  });
});
