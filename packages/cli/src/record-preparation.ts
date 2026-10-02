import {
  planSuggestedFiles,
  probeRecordDependencies,
  suggestRecordFiles,
  type RecordApplicationRequest,
} from '@proofissue/application';

import type { GuidedIo } from './guided-record.js';
import {
  askAboutDependencyFiles,
  confirmSuggestedFiles,
  renderSuggestedFlags,
  renderSuggestionNotes,
} from './record-suggestions.js';

/** What the command line decided before suggestions are considered. */
export interface RecordPreparationInput {
  /** `--no-dependencies`. */
  readonly no_dependencies: boolean;
  readonly platform: 'posix' | 'win32';
  readonly request: RecordApplicationRequest;
  /**
   * Present only when a person is at a terminal and neither --yes nor --json was given. Without
   * it nothing is ever asked, suggested, or applied.
   */
  readonly terminal?: GuidedIo;
}

export type RecordPreparation =
  | {
      /** Printed after a failed recording (never before), for the person to copy. */
      readonly copyable_suggestions?: string;
      /** A lockfile exists but is not recorded and nobody decided that. */
      readonly dependency_warning: boolean;
      readonly request: RecordApplicationRequest;
      readonly status: 'ready';
    }
  | { readonly status: 'cancelled' };

/**
 * Everything that may change a record request before the command runs, and all of it with the
 * reporter's say-so:
 *
 * 1. Dependency files: when package.json and package-lock.json both exist and the request did
 *    not decide, a person at a terminal is asked (after seeing the package count and whether the
 *    lockfile is valid). Otherwise nothing is recorded and a warning is kept for the preview.
 * 2. Files: for the roles the request left empty, the files the command names and their relative
 *    imports are suggested with reasons. A person at a terminal confirms or edits them; without
 *    one they are never applied, only offered as flags to copy.
 *
 * It reads project files to find suggestions and never runs the command.
 */
export const prepareRecordRequest = async (
  input: RecordPreparationInput,
): Promise<RecordPreparation> => {
  let request = input.request;
  const terminal = input.terminal;
  let dependencyWarning = false;

  if (request.include_dependencies !== true && !input.no_dependencies) {
    const probe = await probeRecordDependencies(request.project_root);
    if (probe.status !== 'absent') {
      if (terminal === undefined) {
        dependencyWarning = true;
      } else {
        const answer = await askAboutDependencyFiles(terminal, probe);
        if (answer === 'cancelled') return { status: 'cancelled' };
        if (answer === 'yes') request = { ...request, include_dependencies: true };
      }
    }
  }

  const rolesMissing =
    request.reproduction_paths.length === 0 || request.subject_paths.length === 0;
  if (!rolesMissing && terminal === undefined) {
    return { dependency_warning: dependencyWarning, request, status: 'ready' };
  }

  const suggestions = await suggestRecordFiles({
    arguments: request.arguments,
    ...(request.include_dependencies === true ? { include_dependencies: true } : {}),
    project_root: request.project_root,
  });
  const plan = planSuggestedFiles(request, suggestions);
  const notes = renderSuggestionNotes(suggestions, {
    include_dependencies: request.include_dependencies === true,
    reproduction_suggested: plan.reproduction.some((file) => file.path === 'package.json'),
    selected_paths: [
      ...request.reproduction_paths,
      ...request.subject_paths,
      ...plan.reproduction.map((file) => file.path),
      ...plan.subject.map((file) => file.path),
    ],
  });

  if (terminal === undefined) {
    return {
      copyable_suggestions: `${renderSuggestedFlags(plan)}${notes.length > 0 ? `${notes.join('\n')}\n` : ''}`,
      dependency_warning: dependencyWarning,
      request,
      status: 'ready',
    };
  }

  if (!rolesMissing) {
    if (notes.length > 0) terminal.write(`${notes.join('\n')}\n`);
    return { dependency_warning: dependencyWarning, request, status: 'ready' };
  }

  const result = await confirmSuggestedFiles(terminal, plan, notes, input.platform);
  if (result.status === 'cancelled') return { status: 'cancelled' };
  request = {
    ...request,
    reproduction_paths: plan.missing.reproduction
      ? result.choice.reproduction_paths
      : request.reproduction_paths,
    subject_paths: plan.missing.subject ? result.choice.subject_paths : request.subject_paths,
  };
  return { dependency_warning: dependencyWarning, request, status: 'ready' };
};
