import { isArtifactPath } from '@proofissue/artifact-schema';
import { containsContextPath } from '@proofissue/output-rules';
import type { OutputPathContext } from '@proofissue/output-rules';

export interface NonPortableArgumentOptions {
  /**
   * Whether a project-relative path (forward slashes) names an existing regular file in the
   * project. Only asked for arguments that contain a backslash on Windows.
   */
  readonly exists: (projectRelativePath: string) => boolean;
  /** The project and home directories of this computer, as the recorder computed them. */
  readonly host_context: OutputPathContext;
  readonly platform: 'posix' | 'win32';
}

export type NonPortableArgument =
  | {
      /** Zero-based position among the arguments after `node`. */
      readonly index: number;
      readonly reason: 'local_path';
    }
  | {
      readonly index: number;
      /** The forward-slash spelling of the project file the argument names. */
      readonly portable_path: string;
      readonly reason: 'backslash_path';
    };

const withoutLeadingCurrentDirectory = (value: string): string => {
  let result = value;
  while (result.startsWith('./')) result = result.slice(2);
  return result;
};

/**
 * Finds the first command argument that cannot be replayed on another computer: one that holds
 * the project or home directory, which would also leak the user's name into the artifact, or,
 * on Windows, one that spells a project file with backslashes, which does not exist on Linux.
 *
 * It looks only at the arguments and at what the caller says exists. It never reads a file, and
 * the result never contains the argument itself, only its position and, for a project file, the
 * portable spelling the user should write instead.
 */
export const findNonPortableArgument = (
  arguments_: readonly string[],
  options: NonPortableArgumentOptions,
): NonPortableArgument | undefined => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === undefined) continue;
    if (containsContextPath(argument, options.host_context)) return { index, reason: 'local_path' };
    if (options.platform === 'win32' && argument.includes('\\')) {
      const portable = withoutLeadingCurrentDirectory(argument.replaceAll('\\', '/'));
      if (isArtifactPath(portable) && options.exists(portable)) {
        return { index, portable_path: portable, reason: 'backslash_path' };
      }
    }
  }
  return undefined;
};

/** The message for a refused argument. It never repeats the argument. */
export const describeNonPortableArgument = (found: NonPortableArgument): string => {
  const position = `Command argument ${String(found.index + 1)} (after node)`;
  if (found.reason === 'local_path') {
    return `${position} holds a path from this computer (the project or home directory). That would put it in the artifact and it does not exist on another computer; use a path relative to the project, such as test/reproduction.mjs. No command was run.`;
  }
  return `${position} spells a project file with backslashes. Replay runs on Linux, where that is not a path; write it as ${JSON.stringify(found.portable_path)}. No command was run.`;
};
