import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import process from 'node:process';

import {
  createReplayApplicationService,
  evaluateReplayPolicy,
  type ApplicationServices,
  type ReplayOperationResult,
} from '@proofissue/application';

export type ActionApplicationServices = Pick<ApplicationServices, 'replay'>;

export interface ActionAdapter {
  readonly application: ActionApplicationServices;
}

export const createActionAdapter = (application: ActionApplicationServices): ActionAdapter =>
  Object.freeze({ application });

export type RequiredReplayStatus = 'not_reproduced' | 'reproduced';

export interface ActionInputs {
  readonly against_path?: string;
  readonly artifact_path: string;
  readonly dependency_store?: string;
  readonly mode: ReplayOperationResult['mode'];
  readonly required_status?: RequiredReplayStatus;
}

export interface ActionRuntime {
  readonly getInput: (name: string) => string;
  readonly setFailed: (message: string) => void;
  readonly setOutput: (name: string, value: string) => Promise<void>;
  readonly writeInfo: (message: string) => void;
  readonly writeSummary: (markdown: string) => Promise<void>;
}

export interface ActionRunResult {
  readonly result?: ReplayOperationResult;
  readonly success: boolean;
}

const INPUT_NAMES = {
  artifactPath: 'artifact-path',
  checkoutPath: 'checkout-path',
  dependencyStore: 'dependency-store',
  replayMode: 'replay-mode',
  requiredStatus: 'required-status',
} as const;

const requiredEnvironmentFile = (
  environment: NodeJS.ProcessEnv,
  name: 'GITHUB_OUTPUT' | 'GITHUB_STEP_SUMMARY',
): string => {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`GitHub did not provide ${name}.`);
  }
  return value;
};

const outputRecord = (name: string, value: string): string => {
  let delimiter = `proofissue_${randomUUID()}`;
  while (value.includes(delimiter)) delimiter = `proofissue_${randomUUID()}`;
  return `${name}<<${delimiter}\n${value}\n${delimiter}\n`;
};

export const createGitHubActionRuntime = (
  environment: NodeJS.ProcessEnv = process.env,
): ActionRuntime => ({
  getInput: (name) => environment[`INPUT_${name.replaceAll(' ', '_').toUpperCase()}`]?.trim() ?? '',
  setOutput: async (name, value) => {
    await appendFile(
      requiredEnvironmentFile(environment, 'GITHUB_OUTPUT'),
      outputRecord(name, value),
      'utf8',
    );
  },
  writeSummary: async (markdown) => {
    await appendFile(requiredEnvironmentFile(environment, 'GITHUB_STEP_SUMMARY'), markdown, 'utf8');
  },
  writeInfo: (message) => {
    process.stdout.write(`${message}\n`);
  },
  setFailed: (message) => {
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  },
});

export const parseActionInputs = (
  getInput: ActionRuntime['getInput'],
  workspace = process.env.GITHUB_WORKSPACE,
): ActionInputs => {
  const artifactPath = getInput(INPUT_NAMES.artifactPath);
  if (artifactPath.length === 0) throw new Error('artifact-path is required.');

  const replayMode = getInput(INPUT_NAMES.replayMode) || 'snapshot';
  if (replayMode !== 'snapshot' && replayMode !== 'current-checkout') {
    throw new Error('replay-mode must be snapshot or current-checkout.');
  }

  const requiredStatus = getInput(INPUT_NAMES.requiredStatus);
  if (
    requiredStatus.length > 0 &&
    requiredStatus !== 'reproduced' &&
    requiredStatus !== 'not_reproduced'
  ) {
    throw new Error('required-status must be reproduced or not_reproduced.');
  }

  const dependencyStore = getInput(INPUT_NAMES.dependencyStore);
  const checkoutInput = getInput(INPUT_NAMES.checkoutPath);
  const checkoutPath = checkoutInput || workspace?.trim();
  if (replayMode === 'current-checkout' && !checkoutPath) {
    throw new Error('checkout-path or GITHUB_WORKSPACE is required for current-checkout replay.');
  }
  if (replayMode === 'snapshot' && checkoutInput.length > 0) {
    throw new Error('checkout-path is only valid for current-checkout replay.');
  }

  return {
    artifact_path: artifactPath,
    mode: replayMode === 'snapshot' ? 'snapshot' : 'current_checkout',
    ...(dependencyStore.length === 0 ? {} : { dependency_store: dependencyStore }),
    ...(replayMode === 'current-checkout' && checkoutPath !== undefined
      ? { against_path: checkoutPath }
      : {}),
    ...(requiredStatus.length === 0
      ? {}
      : { required_status: requiredStatus as RequiredReplayStatus }),
  };
};

type ReplayEvidence = ReplayOperationResult['evidence'][number];
type ReplayDifference = ReplayOperationResult['differences'][number];

// Fixed text only: a label never repeats an expected value, an output excerpt, or a message.
const baseEvidenceLabel = (kind: ReplayEvidence['kind']): string => {
  switch (kind) {
    case 'exit_code':
      return 'exit code matched';
    case 'stderr_contains':
      return 'expected stderr text was present';
    case 'stderr_exact':
      return 'stderr matched the expected output exactly';
    case 'stderr_regex':
      return 'stderr matched the expected pattern';
    case 'stdout_contains':
      return 'expected stdout text was present';
    case 'stdout_exact':
      return 'stdout matched the expected output exactly';
    case 'stdout_regex':
      return 'stdout matched the expected pattern';
  }
};

const baseDifferenceLabel = (kind: ReplayDifference['kind']): string => {
  switch (kind) {
    case 'exit_code':
      return 'exit code differed';
    case 'insufficient_output':
      return 'retained output was insufficient';
    case 'regex_step_limit':
      return 'a pattern exceeded its step limit';
    case 'stderr_differs':
      return 'stderr differed from the expected output';
    case 'stderr_missing':
      return 'expected stderr text was absent';
    case 'stderr_no_match':
      return 'stderr did not match the expected pattern';
    case 'stdout_differs':
      return 'stdout differed from the expected output';
    case 'stdout_missing':
      return 'expected stdout text was absent';
    case 'stdout_no_match':
      return 'stdout did not match the expected pattern';
  }
};

const NORMALIZED_SUFFIX = ' after normalization';

const evidenceLabel = (item: ReplayEvidence): string =>
  `${baseEvidenceLabel(item.kind)}${item.normalization === undefined ? '' : NORMALIZED_SUFFIX}`;

const differenceLabel = (item: ReplayDifference): string =>
  `${baseDifferenceLabel(item.kind)}${item.normalization === undefined ? '' : NORMALIZED_SUFFIX}`;

export const renderActionSummary = (
  result: ReplayOperationResult,
  requiredStatus: RequiredReplayStatus | undefined,
  requiredStatusSatisfied: boolean,
): string => {
  const evidence = result.evidence.map(evidenceLabel);
  const differences = result.differences.map(differenceLabel);
  const lines = [
    '## ProofIssue replay',
    '',
    `- Result: \`${result.status}\``,
    `- Mode: \`${result.mode}\``,
    `- Evidence checks passed: ${String(result.evidence.length)}`,
    `- Differences found: ${String(result.differences.length)}`,
    `- Warnings: ${String(result.warnings.length)}`,
    `- Errors: ${String(result.errors.length)}`,
    `- Subject paths substituted: ${String(result.substituted_paths.length)}`,
  ];

  if (requiredStatus !== undefined) {
    lines.push(
      `- Required result: \`${requiredStatus}\` (${requiredStatusSatisfied ? 'satisfied' : 'not satisfied'})`,
    );
  }
  if (result.cleanup !== undefined) {
    lines.push(`- Cleanup: ${result.cleanup.completed ? 'complete' : 'incomplete'}`);
  }
  if (evidence.length > 0) {
    lines.push('', 'Matched checks:', ...evidence.map((item) => `- ${item}`));
  }
  if (differences.length > 0) {
    lines.push('', 'Differences:', ...differences.map((item) => `- ${item}`));
  }
  if (
    result.status === 'invalid_artifact' ||
    result.status === 'execution_failed' ||
    !requiredStatusSatisfied
  ) {
    lines.push(
      '',
      'Review the structured `result` output for bounded diagnostic details. Raw command output is not published.',
    );
  }

  return `${lines.join('\n')}\n`;
};

const writeReplayOutputs = async (
  runtime: ActionRuntime,
  result: ReplayOperationResult,
  requiredStatusSatisfied: boolean,
): Promise<void> => {
  await runtime.setOutput('status', result.status);
  await runtime.setOutput('mode', result.mode);
  await runtime.setOutput('result', JSON.stringify(result));
  await runtime.setOutput('evidence', JSON.stringify(result.evidence));
  await runtime.setOutput('differences', JSON.stringify(result.differences));
  await runtime.setOutput('required_status_satisfied', String(requiredStatusSatisfied));
};

const defaultApplication = (): ActionApplicationServices => createReplayApplicationService();

export const runAction = async (
  application: ActionApplicationServices = defaultApplication(),
  runtime: ActionRuntime = createGitHubActionRuntime(),
  signal?: AbortSignal,
): Promise<ActionRunResult> => {
  let inputs: ActionInputs;
  try {
    inputs = parseActionInputs(runtime.getInput);
  } catch {
    runtime.setFailed('ProofIssue action input is invalid. Review the documented inputs.');
    try {
      await runtime.writeSummary(
        '## ProofIssue replay\n\nThe action input is invalid. Review the configured artifact path, replay mode, checkout path, dependency store, and required result.\n',
      );
    } catch {
      // The original input failure remains the actionable result.
    }
    return { success: false };
  }

  try {
    const result = await application.replay({
      ...(inputs.against_path === undefined ? {} : { against_path: inputs.against_path }),
      artifact_path: inputs.artifact_path,
      ...(inputs.dependency_store === undefined
        ? {}
        : { dependency_store: inputs.dependency_store }),
      mode: inputs.mode,
      ...(signal === undefined ? {} : { signal }),
    });
    const policy = evaluateReplayPolicy(result, inputs.required_status);
    const success = policy.success;

    await writeReplayOutputs(runtime, result, policy.required_status_satisfied);
    await runtime.writeSummary(
      renderActionSummary(result, inputs.required_status, policy.required_status_satisfied),
    );

    if (success) {
      runtime.writeInfo(`ProofIssue replay completed with result ${result.status}.`);
    } else {
      runtime.setFailed(
        `ProofIssue replay did not satisfy the configured policy (${result.status}).`,
      );
    }
    return { result, success };
  } catch {
    runtime.setFailed('ProofIssue action could not publish a safe replay result.');
    return { success: false };
  }
};
