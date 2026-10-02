import { APPROVED_REPLAY_IMAGE, type InspectOperationResult } from '@proofissue/application';

import { escapePresentationText } from './presentation.js';

type ArtifactInspectionSummary = NonNullable<InspectOperationResult['inspection']>;

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const ROLE_ORDER = ['reproduction', 'subject', 'dependency'] as const;

const modesOf = (
  expectations: ArtifactInspectionSummary['expectations']['stdout_expectations'],
): string =>
  expectations.length === 0
    ? 'none'
    : expectations
        .map((item) => (item.normalize.length === 0 ? item.mode : `${item.mode} (normalized)`))
        .join(', ');

/**
 * A readable summary of what an artifact contains, for `inspect` without `--json`. It shows
 * only metadata the machine-readable summary already carries: no file contents, no expected
 * text, and no argument values. Every echoed string is escaped for the terminal.
 */
export const renderInspectSummary = (summary: ArtifactInspectionSummary): string => {
  const counts = ROLE_ORDER.map((role) => ({
    role,
    count: summary.files.filter((file) => file.role === role).length,
  }))
    .filter((item) => item.count > 0)
    .map((item) => `${item.role} ${String(item.count)}`)
    .join(', ');
  const hasDependencies = summary.files.some((file) => file.role === 'dependency');
  const lines = [
    `Runtime: Node.js ${escapePresentationText(summary.runtime_version)} on Linux`,
    summary.image === APPROVED_REPLAY_IMAGE
      ? 'Image: the approved replay image'
      : `Image: ${escapePresentationText(summary.image)} (not the approved replay image; replay refuses it)`,
    `Command: ${summary.command.program} with ${plural(summary.command.argument_count, 'argument')}`,
    `Files: ${String(summary.files.length)} (${counts})`,
    ...ROLE_ORDER.flatMap((role) =>
      summary.files
        .filter((file) => file.role === role)
        .map(
          (file) =>
            `  ${role.padEnd(12)} ${escapePresentationText(file.path)} (${plural(file.bytes, 'byte')})`,
        ),
    ),
    `Expectations: exit code ${String(summary.expectations.exit_code)}; stdout ${modesOf(summary.expectations.stdout_expectations)}; stderr ${modesOf(summary.expectations.stderr_expectations)}`,
    `Limits: ${String(summary.limits.timeout_seconds)} s, ${String(summary.limits.memory_mb)} MB, ${plural(summary.limits.cpus, 'CPU')}, ${String(summary.limits.processes)} processes, ${plural(summary.limits.output_bytes_per_stream, 'byte')} per output stream`,
    `Redaction: enabled, ${plural(summary.redaction.finding_count, 'likely secret')} replaced`,
    hasDependencies
      ? 'Prepare: needed before replay (proofissue replay <artifact> --prepare --dependency-store <directory>)'
      : 'Prepare: not needed',
  ];
  return `${lines.join('\n')}\n`;
};
