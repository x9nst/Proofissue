import process from 'node:process';

import {
  createPrepareApplicationService,
  createReplayApplicationService,
  evaluateReplayPolicy,
  type ApplicationServices,
} from '@proofissue/application';

import { parseArtifactCommand, type ParsedArtifactCommand } from './arguments.js';
import type { CliIo, CliRunResult } from './io.js';
import { renderNextSteps } from './next-steps.js';
import { renderPrepareResult } from './prepare-command.js';
import { escapePresentationText } from './presentation.js';
import { usageError } from './usage.js';

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
    if (parsed.prepare && parsed.dependency_store !== undefined) {
      // The one explicit network step, run first and shown in full. A failed preparation ends
      // the command: replaying without the packages would only report a second, misleading error.
      const prepare = application?.prepare ?? createPrepareApplicationService().prepare;
      const prepared = await prepare({
        artifact_path: parsed.artifact_path,
        dependency_store: parsed.dependency_store,
        signal: controller.signal,
      });
      const ready = prepared.status === 'prepared' || prepared.status === 'not_required';
      io.write(renderPrepareResult(prepared));
      if (!ready) return { exit_code: 1, result: prepared };
      io.write('\n');
    }
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
      : `${renderReplayResult(result)}${renderNextSteps(
          result.errors.map((error) => error.code),
          {
            artifact_path: parsed.artifact_path,
            ...(parsed.against_path === undefined ? {} : { against_path: parsed.against_path }),
            ...(parsed.dependency_store === undefined
              ? {}
              : { dependency_store: parsed.dependency_store }),
          },
        )}`,
  );
  return {
    exit_code: evaluateReplayPolicy(result, parsed.required_status).success ? 0 : 1,
    result,
  };
};
