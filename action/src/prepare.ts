import {
  createPrepareApplicationService,
  type ApplicationServices,
  type PrepareOperationResult,
} from '@proofissue/application';

import { createGitHubActionRuntime, type ActionRuntime } from './index.js';

/**
 * The prepare entry point of the GitHub Action. It is bundled separately from the replay
 * entry point, which must never import this module: the replay bundle carries no download code.
 */
export type PrepareActionApplicationServices = Pick<ApplicationServices, 'prepare'>;

export interface PrepareActionInputs {
  readonly artifact_path: string;
  readonly dependency_store: string;
}

export interface PrepareActionRunResult {
  readonly result?: PrepareOperationResult;
  readonly success: boolean;
}

const INPUT_NAMES = {
  artifactPath: 'artifact-path',
  dependencyStore: 'dependency-store',
} as const;

export const parsePrepareActionInputs = (
  getInput: ActionRuntime['getInput'],
): PrepareActionInputs => {
  const artifactPath = getInput(INPUT_NAMES.artifactPath);
  if (artifactPath.length === 0) throw new Error('artifact-path is required.');
  const dependencyStore = getInput(INPUT_NAMES.dependencyStore);
  if (dependencyStore.length === 0) throw new Error('dependency-store is required.');
  return { artifact_path: artifactPath, dependency_store: dependencyStore };
};

/**
 * Counts and fixed labels only: never messages, package locations, or directories.
 */
export const renderPrepareActionSummary = (result: PrepareOperationResult): string => {
  const lines = ['## ProofIssue dependency preparation', '', `- Result: \`${result.status}\``];
  const preparation = result.preparation;
  if (preparation !== undefined) {
    lines.push(
      `- Packages for the replay platform: ${String(preparation.packages)}`,
      `- Tarballs downloaded: ${String(preparation.downloaded_tarballs)}`,
      `- Tarballs already in the store: ${String(preparation.reused_tarballs)}`,
      `- Skipped for another platform: ${String(preparation.skipped_for_platform)}`,
    );
  }
  if (result.status === 'not_required') {
    lines.push('- The artifact has no dependency files, so nothing was downloaded.');
  }
  lines.push(
    `- Warnings: ${String(result.warnings.length)}`,
    `- Errors: ${String(result.errors.length)}`,
  );
  if (result.status !== 'prepared' && result.status !== 'not_required') {
    lines.push('', 'Review the structured `result` output for bounded diagnostic details.');
  }
  return `${lines.join('\n')}\n`;
};

export const runPrepareAction = async (
  application: PrepareActionApplicationServices = createPrepareApplicationService(),
  runtime: ActionRuntime = createGitHubActionRuntime(),
  signal?: AbortSignal,
): Promise<PrepareActionRunResult> => {
  let inputs: PrepareActionInputs;
  try {
    inputs = parsePrepareActionInputs(runtime.getInput);
  } catch {
    runtime.setFailed('ProofIssue prepare action input is invalid. Review the documented inputs.');
    try {
      await runtime.writeSummary(
        '## ProofIssue dependency preparation\n\nThe action input is invalid. Review the configured artifact path and dependency store.\n',
      );
    } catch {
      // The original input failure remains the actionable result.
    }
    return { success: false };
  }

  try {
    const result = await application.prepare({
      artifact_path: inputs.artifact_path,
      dependency_store: inputs.dependency_store,
      ...(signal === undefined ? {} : { signal }),
    });
    const success = result.status === 'prepared' || result.status === 'not_required';

    await runtime.setOutput('status', result.status);
    await runtime.setOutput('result', JSON.stringify(result));
    await runtime.writeSummary(renderPrepareActionSummary(result));

    if (success) {
      runtime.writeInfo(`ProofIssue dependency preparation completed (${result.status}).`);
    } else {
      runtime.setFailed(`ProofIssue dependency preparation did not complete (${result.status}).`);
    }
    return { result, success };
  } catch {
    runtime.setFailed('ProofIssue prepare action could not publish a safe result.');
    return { success: false };
  }
};
