import process from 'node:process';

import {
  createPrepareApplicationService,
  type ApplicationServices,
  type PrepareOperationResult,
} from '@proofissue/application';

import { takeStoreValue } from './arguments.js';
import { CLI_HELP } from './help.js';
import type { CliIo, CliRunResult } from './io.js';
import { escapePresentationText } from './presentation.js';

export interface ParsedPrepareCommand {
  readonly artifact_path: string;
  readonly dependency_store: string;
  readonly json: boolean;
}

export const parsePrepareArguments = (arguments_: readonly string[]): ParsedPrepareCommand => {
  const artifactPath = arguments_[0];
  if (artifactPath === undefined || artifactPath.startsWith('--'))
    throw new Error('An artifact path is required.');
  let json = false;
  let store: string | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
    } else if (argument === '--dependency-store') {
      store = takeStoreValue(arguments_, index);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument ?? ''}`);
    }
  }
  if (store === undefined) throw new Error('--dependency-store is required.');
  return { artifact_path: artifactPath, dependency_store: store, json };
};

export const renderPrepareResult = (result: PrepareOperationResult): string => {
  const lines = [`Preparation result: ${result.status}`];
  if (result.status === 'not_required') {
    lines.push('The artifact has no dependency files; replay needs no prepared store.');
  }
  const preparation = result.preparation;
  if (preparation !== undefined) {
    lines.push(
      `Packages for the replay platform: ${String(preparation.packages)}`,
      `Tarballs downloaded: ${String(preparation.downloaded_tarballs)} (${String(preparation.downloaded_bytes)} bytes)`,
      `Tarballs already in the store: ${String(preparation.reused_tarballs)}`,
      `Skipped for another platform: ${String(preparation.skipped_for_platform)}`,
    );
  }
  for (const item of result.warnings)
    lines.push(`Warning: ${escapePresentationText(item.message)}`);
  for (const item of result.errors) {
    const location = item.details?.['package_path'];
    lines.push(
      `Error: ${escapePresentationText(item.message)}${
        typeof location === 'string' ? ` (${escapePresentationText(location)})` : ''
      }`,
    );
  }
  if (result.status === 'prepared') lines.push('Replay offline with the same --dependency-store.');
  return `${lines.join('\n')}\n`;
};

export const runPrepareCommand = async (
  arguments_: readonly string[],
  io: CliIo,
  application?: Partial<ApplicationServices>,
): Promise<CliRunResult> => {
  let parsed: ParsedPrepareCommand;
  try {
    parsed = parsePrepareArguments(arguments_.slice(1));
  } catch (error: unknown) {
    io.write(
      `${escapePresentationText(error instanceof Error ? error.message : 'Invalid prepare command.')}\n\n${CLI_HELP}`,
    );
    return { exit_code: 2 };
  }
  const prepare = application?.prepare ?? createPrepareApplicationService().prepare;
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let result: PrepareOperationResult;
  try {
    result = await prepare({
      artifact_path: parsed.artifact_path,
      dependency_store: parsed.dependency_store,
      signal: controller.signal,
    });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
  io.write(parsed.json ? `${JSON.stringify(result)}\n` : renderPrepareResult(result));
  return {
    exit_code: result.status === 'prepared' || result.status === 'not_required' ? 0 : 1,
    result,
  };
};
