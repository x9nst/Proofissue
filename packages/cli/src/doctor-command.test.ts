import { APPROVED_REPLAY_IMAGE, type DoctorReport } from '@proofissue/application';
import { describe, expect, it } from 'vitest';

import { DOCTOR_HELP, renderDoctorReport, runCli, type CliIo } from './index.js';

const capture = (): { io: CliIo; output: () => string } => {
  let written = '';
  return {
    io: {
      confirm: () => Promise.resolve(false),
      write: (text) => {
        written += text;
      },
    },
    output: () => written,
  };
};

const READY: DoctorReport = {
  approved_image: APPROVED_REPLAY_IMAGE,
  recording_ready: true,
  replay_ready: true,
  checks: [
    { id: 'node', status: 'ok', summary: 'Node.js 24.18.0; replay uses the same major version.' },
    { id: 'host', status: 'ok', summary: 'linux x64.' },
    { id: 'docker_cli', status: 'ok', summary: 'The docker command runs.' },
    { id: 'docker_context', status: 'ok', summary: 'The Docker context is a local unix socket.' },
    { id: 'docker_engine', status: 'ok', summary: 'Docker Engine 27.3.1, linux/amd64.' },
    { id: 'docker_seccomp', status: 'ok', summary: 'The default seccomp profile is available.' },
    { id: 'replay_image', status: 'ok', summary: 'The approved replay image is present locally.' },
  ],
};

const MISSING_IMAGE: DoctorReport = {
  ...READY,
  replay_ready: false,
  checks: [
    {
      id: 'node',
      status: 'warn',
      summary:
        'Node.js 22.4.0; replay always uses Node.js 24, so a recording made here can behave differently when replayed.',
      next_step: 'Record with Node.js 24 for the closest match to replay.',
    },
    ...READY.checks.slice(1, 6),
    {
      id: 'replay_image',
      status: 'fail',
      summary:
        'The approved replay image is not available locally; replay never pulls images automatically.',
      next_step: `Run: docker pull ${APPROVED_REPLAY_IMAGE}`,
    },
  ],
};

describe('doctor CLI', () => {
  it('prints ok and missing lines with the exact pull command', async () => {
    const { io, output } = capture();

    await runCli(['doctor'], io, { doctor: () => Promise.resolve(MISSING_IMAGE) });

    expect(output()).toContain('warn    Node.js: Node.js 22.4.0;');
    expect(output()).toContain('ok      Host: linux x64.');
    expect(output()).toContain('fail    Replay image: The approved replay image is not available');
    expect(output()).toContain(`\n        Run: docker pull ${APPROVED_REPLAY_IMAGE}\n`);
    expect(output()).toContain('Recording: ready.');
    expect(output()).toContain('Replay: not ready.');
  });

  it('exits 1 when replay is not ready and 0 when it is', async () => {
    const ready = capture();
    const notReady = capture();

    const readyResult = await runCli(['doctor'], ready.io, {
      doctor: () => Promise.resolve(READY),
    });
    const notReadyResult = await runCli(['doctor'], notReady.io, {
      doctor: () => Promise.resolve(MISSING_IMAGE),
    });

    expect(readyResult.exit_code).toBe(0);
    expect(ready.output()).toContain('Replay: ready.');
    expect(notReadyResult.exit_code).toBe(1);
  });

  it('exits 2 with a short usage error for any argument, without diagnosing', async () => {
    for (const arguments_ of [['--json'], ['extra']]) {
      const { io, output } = capture();
      let called = false;
      const result = await runCli(['doctor', ...arguments_], io, {
        doctor: () => {
          called = true;
          return Promise.resolve(READY);
        },
      });

      expect(result.exit_code).toBe(2);
      expect(called).toBe(false);
      expect(output()).toContain('Usage: proofissue doctor');
      expect(output()).toContain('Run "proofissue doctor --help"');
    }
  });

  it('prints its own help and exits 0 for doctor --help', async () => {
    const { io, output } = capture();

    const result = await runCli(['doctor', '--help'], io);

    expect(result.exit_code).toBe(0);
    expect(output()).toBe(DOCTOR_HELP);
  });

  it('escapes terminal controls in every shown line', () => {
    const text = renderDoctorReport({
      ...READY,
      checks: [
        {
          id: 'docker_engine',
          status: 'fail',
          summary: 'bad\u001b[31m',
          next_step: 'step‮',
        },
      ],
    });

    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('‮');
  });
});
