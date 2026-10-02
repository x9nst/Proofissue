import {
  createDoctorService,
  type DoctorApplicationService,
  type DoctorCheckId,
  type DoctorReport,
} from '@proofissue/application';

import type { CliIo, CliRunResult } from './io.js';
import { escapePresentationText } from './presentation.js';
import { usageError } from './usage.js';

const LABELS: Readonly<Record<DoctorCheckId, string>> = {
  node: 'Node.js',
  host: 'Host',
  docker_cli: 'Docker CLI',
  docker_context: 'Docker context',
  docker_engine: 'Docker Engine',
  docker_seccomp: 'Seccomp',
  replay_image: 'Replay image',
};

/** Human output only: `doctor` has no machine-readable form, so no result contract changes. */
export const renderDoctorReport = (report: DoctorReport): string => {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(
      `${check.status.padEnd(7)} ${LABELS[check.id]}: ${escapePresentationText(check.summary)}`,
    );
    if (check.next_step !== undefined)
      lines.push(`${' '.repeat(8)}${escapePresentationText(check.next_step)}`);
  }
  lines.push(
    '',
    report.recording_ready
      ? 'Recording: ready. It runs on this host and needs no container.'
      : 'Recording: not ready.',
    report.replay_ready
      ? 'Replay: ready.'
      : 'Replay: not ready. Fix the failed checks above, then run proofissue doctor again.',
  );
  return `${lines.join('\n')}\n`;
};

export const runDoctorCommand = async (
  arguments_: readonly string[],
  io: CliIo,
  application?: Partial<DoctorApplicationService>,
): Promise<CliRunResult> => {
  const extra = arguments_[1];
  if (extra !== undefined) {
    io.write(
      usageError(
        'doctor',
        extra.startsWith('-') ? `Unknown option: ${extra}` : `Unexpected argument: ${extra}`,
      ),
    );
    return { exit_code: 2 };
  }
  const doctor = application?.doctor ?? createDoctorService().doctor;
  const report = await doctor();
  io.write(renderDoctorReport(report));
  return { exit_code: report.replay_ready ? 0 : 1 };
};
