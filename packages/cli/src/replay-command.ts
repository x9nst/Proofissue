import process from 'node:process';

import {
  createReplayApplicationService,
  evaluateReplayPolicy,
  type ApplicationServices,
} from '@proofissue/application';

import { parseArtifactCommand, type ParsedArtifactCommand } from './arguments.js';
import type { CliIo, CliRunResult } from './io.js';
import { escapePresentationText } from './presentation.js';
import { usageError } from './usage.js';

const REPLAY_PREPARE_HINT =
  'Hint: run proofissue prepare <artifact> --dependency-store <directory>, then pass the same --dependency-store to replay.';

export const renderReplayResult = (
  result: Awaited<ReturnType<ApplicationServices['replay']>>,
): string => {
  const lines = [`Replay result: ${result.status}`, `Mode: ${result.mode}`];
  if (result.image_digest !== undefined) lines.push(`Approved image: ${result.image_digest}`);
  if (result.execution !== undefined) {
    lines.push(`Termination: ${result.execution.termination_reason}`);
    if (result.execution.exit_code !== undefined)
      lines.push(`Exit code: ${String(result.execution.exit_code)}`);
    lines.push(
      `Output retained: stdout ${String(result.execution.stdout.retained_bytes)} bytes, stderr ${String(result.execution.stderr.retained_bytes)} bytes`,
    );
  }
  for (const item of result.evidence)
    lines.push(`Matched: ${escapePresentationText(item.message)}`);
  for (const item of result.differences)
    lines.push(`Different: ${escapePresentationText(item.message)}`);
  for (const item of result.warnings)
    lines.push(`Warning: ${escapePresentationText(item.message)}`);
  for (const item of result.errors) lines.push(`Error: ${escapePresentationText(item.message)}`);
  for (const substitutedPath of result.substituted_paths)
    lines.push(`Substituted subject: ${escapePresentationText(substitutedPath)}`);
  for (const limitation of result.scope_limitations)
    lines.push(`Scope: ${escapePresentationText(limitation.message)}`);
  if (result.cleanup !== undefined)
    lines.push(`Cleanup complete: ${String(result.cleanup.completed)}`);
  return `${lines.join('\n')}\n`;
};

export const runReplayCommand = async (
  arguments_: readonly string[],
  io: CliIo,
  application?: Partial<ApplicationServices>,
): Promise<CliRunResult> => {
  let parsed: ParsedArtifactCommand;
  try {
    parsed = parseArtifactCommand(arguments_.slice(1), true);
  } catch (error: unknown) {
    io.write(
      usageError('replay', error instanceof Error ? error.message : 'Invalid replay command.'),
    );
    return { exit_code: 2 };
  }
  const replay = application?.replay ?? createReplayApplicationService().replay;
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let result: Awaited<ReturnType<ApplicationServices['replay']>>;
  try {
    result = await replay({
      ...(parsed.against_path === undefined ? {} : { against_path: parsed.against_path }),
      artifact_path: parsed.artifact_path,
      ...(parsed.dependency_store === undefined
        ? {}
        : { dependency_store: parsed.dependency_store }),
      mode: parsed.against_path === undefined ? 'snapshot' : 'current_checkout',
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  io.write(
    parsed.json
      ? `${JSON.stringify(result)}\n`
      : `${renderReplayResult(result)}${
          result.errors.some((error) => error.code === 'dependencies_not_prepared')
            ? `${REPLAY_PREPARE_HINT}\n`
            : ''
        }`,
  );
  return {
    exit_code: evaluateReplayPolicy(result, parsed.required_status).success ? 0 : 1,
    result,
  };
};
