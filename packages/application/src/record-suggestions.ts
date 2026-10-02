import { hintForCommand, probeDependencyFiles, suggestFiles } from '@proofissue/recorder';
import type {
  CommandHint,
  DependencyProbe,
  FileSuggestions,
  SuggestedFile,
} from '@proofissue/recorder';

export { MAX_PROBE_REASONS, SUGGESTION_LIMITS } from '@proofissue/recorder';
export type {
  CommandHint,
  DependencyProbe,
  FileSuggestions,
  SuggestedFile,
  SuggestionLimit,
} from '@proofissue/recorder';

/**
 * Suggestions for a recording, as the delivery adapters use them.
 *
 * Everything here is advice that a person confirms; none of it is applied by the application on
 * its own. The functions read the project without following links and never run anything, and
 * they do not throw: a project that cannot be scanned simply has no suggestions, and the
 * recording itself reports the real problem.
 */

const NO_SUGGESTIONS: FileSuggestions = {
  files: [],
  limits_reached: [],
  manifest_sets_type: false,
  uncollected_config_files: [],
  warnings: [],
};

export interface SuggestRecordFilesRequest {
  /** The Node.js arguments after `node`. */
  readonly arguments: readonly string[];
  readonly include_dependencies?: boolean;
  readonly project_root: string;
}

/** Suggests reproduction and subject files for a command; see the recorder's `suggestFiles`. */
export const suggestRecordFiles = async (
  request: SuggestRecordFilesRequest,
): Promise<FileSuggestions> => {
  try {
    return await suggestFiles({
      arguments: request.arguments,
      ...(request.include_dependencies === undefined
        ? {}
        : { include_dependencies: request.include_dependencies }),
      project_root: request.project_root,
    });
  } catch {
    return NO_SUGGESTIONS;
  }
};

/** Looks at package.json and package-lock.json without collecting them. */
export const probeRecordDependencies = async (projectRoot: string): Promise<DependencyProbe> => {
  try {
    return await probeDependencyFiles(projectRoot);
  } catch {
    return { status: 'absent' };
  }
};

/** Explains a command that does not start with `node`; undefined when there is nothing to say. */
export const explainRecordCommand = async (
  command: readonly string[],
  projectRoot: string,
): Promise<CommandHint | undefined> => {
  try {
    return await hintForCommand({ command, project_root: projectRoot });
  } catch {
    return undefined;
  }
};

export interface RecordFileSelection {
  readonly reproduction_paths: readonly string[];
  readonly subject_paths: readonly string[];
}

/** The suggestions that may fill the roles a request left empty. */
export interface RecordFilePlan {
  /** Which roles the request did not give; only these are ever filled. */
  readonly missing: { readonly reproduction: boolean; readonly subject: boolean };
  /** Suggested for the reproduction role: empty unless that role is missing. */
  readonly reproduction: readonly SuggestedFile[];
  /** Suggested for the subject role: empty unless that role is missing. */
  readonly subject: readonly SuggestedFile[];
}

/**
 * Decides which suggestions are eligible: only roles the request left empty are filled, so a
 * role given explicitly is never changed or added to, and a file the request already names is
 * never suggested again.
 */
export const planSuggestedFiles = (
  request: RecordFileSelection,
  suggestions: FileSuggestions,
): RecordFilePlan => {
  const missing = {
    reproduction: request.reproduction_paths.length === 0,
    subject: request.subject_paths.length === 0,
  };
  const taken = new Set(
    [...request.reproduction_paths, ...request.subject_paths].map((value) => value.toLowerCase()),
  );
  const eligible = (role: 'reproduction' | 'subject'): readonly SuggestedFile[] =>
    missing[role]
      ? suggestions.files.filter(
          (file) => file.role === role && !taken.has(file.path.toLowerCase()),
        )
      : [];
  return { missing, reproduction: eligible('reproduction'), subject: eligible('subject') };
};
