import { APPROVED_REPLAY_IMAGE, type ProofIssueErrorCode } from '@proofissue/application';

import { quotePathForCommand } from './record-command.js';

export interface NextStepContext {
  /** The artifact path exactly as the command received it. */
  readonly artifact_path: string;
  readonly against_path?: string;
  readonly dependency_store?: string;
}

const DEFAULT_STORE = '.proofissue-store';

const prepareCommand = (context: NextStepContext, store: string): string =>
  [
    'proofissue replay',
    quotePathForCommand(context.artifact_path),
    ...(context.against_path === undefined
      ? []
      : ['--against', quotePathForCommand(context.against_path)]),
    '--prepare --dependency-store',
    quotePathForCommand(store),
  ].join(' ');

/**
 * The deterministic next step for a replay error code, or undefined when the message already
 * says what to do. Commands are built from fixed text plus the user's own paths, escaped and
 * quoted; nothing comes from the artifact or from Docker output.
 */
export const nextStepFor = (
  code: ProofIssueErrorCode,
  context: NextStepContext,
): string | undefined => {
  switch (code) {
    case 'image_unavailable':
      return `docker pull ${APPROVED_REPLAY_IMAGE}`;
    case 'engine_unavailable':
    case 'engine_capability_unavailable':
      return 'run proofissue doctor to see which prerequisite is missing, or replay with the GitHub Action on a hosted Linux runner.';
    case 'dependencies_not_prepared':
      return prepareCommand(context, context.dependency_store ?? DEFAULT_STORE);
    case 'dependency_install_failed':
      return `prepare into a new, empty store: ${prepareCommand(
        context,
        `${(context.dependency_store ?? DEFAULT_STORE).replace(/[\\/]+$/u, '')}-new`,
      )}`;
    case 'timeout':
    case 'resource_termination':
      return 'none. The replay limits are fixed in this release; reaching one is a support boundary of ProofIssue, not evidence about the original failure.';
    default:
      return undefined;
  }
};

/** One line per distinct code with a next step, in the order the errors appeared. */
export const renderNextSteps = (
  codes: readonly ProofIssueErrorCode[],
  context: NextStepContext,
): string => {
  const lines: string[] = [];
  for (const code of new Set(codes)) {
    const step = nextStepFor(code, context);
    if (step !== undefined) lines.push(`Next step: ${step}`);
  }
  return lines.map((line) => `${line}\n`).join('');
};
