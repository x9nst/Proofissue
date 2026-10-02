import path from 'node:path';

/**
 * Defaults for `record` that need no input from the reporter. They are pure: the caller
 * supplies the one fact that comes from the file system.
 */

/** The Node.js major version of the approved replay image. */
export const REPLAY_NODE_MAJOR = 24;

/**
 * The extension of a default artifact name. A GitHub issue accepts `.yaml` attachments but not
 * `.proofissue`, and an artifact is YAML, so the default can be attached as it is. A name given
 * explicitly is never changed, and `.proofissue` stays valid everywhere.
 */
export const DEFAULT_ARTIFACT_EXTENSION = '.proofissue.yaml';

/** The most numeric suffixes tried before the reporter is asked to choose a name. */
export const MAX_DEFAULT_ARTIFACT_SUFFIX = 99;

const MAX_STEM_LENGTH = 64;

export interface DefaultArtifactPathInput {
  /** Where the file would be created. Only used to ask `exists`. */
  readonly cwd: string;
  /** Whether something already occupies this path (a file, a link, or a directory). */
  readonly exists: (candidate: string) => boolean;
  readonly reproduction_paths: readonly string[];
}

export type DefaultArtifactPathResult =
  | {
      /** The file name, relative to `cwd`, never a path outside it. */
      readonly path: string;
      readonly status: 'chosen';
    }
  | {
      /** The first name that was tried, for the message. */
      readonly first_candidate: string;
      readonly last_candidate: string;
      readonly status: 'exhausted';
    };

/** Strips the last extension, keeps `[A-Za-z0-9._-]`, and never starts with a dot or dash. */
export const artifactStem = (reproductionPath: string | undefined): string => {
  const name = (reproductionPath ?? '').split(/[\\/]/u).pop() ?? '';
  const dot = name.lastIndexOf('.');
  const withoutExtension = dot > 0 ? name.slice(0, dot) : name;
  const safe = withoutExtension
    .replace(/[^A-Za-z0-9._-]/gu, '-')
    .replace(/^[.-]+/u, '')
    .slice(0, MAX_STEM_LENGTH);
  return safe === '' ? 'failure' : safe;
};

/**
 * Names the artifact after the first reproduction file, in the current directory. When the name
 * is taken it tries `-2` through `-99`. The exclusive write at recording time still guarantees
 * that nothing is overwritten, so a name that appears between this check and the write fails
 * instead of replacing a file.
 */
export const defaultArtifactPath = (input: DefaultArtifactPathInput): DefaultArtifactPathResult => {
  const stem = artifactStem(input.reproduction_paths[0]);
  const first = `${stem}${DEFAULT_ARTIFACT_EXTENSION}`;
  const taken = (name: string): boolean => input.exists(path.join(input.cwd, name));
  if (!taken(first)) return { status: 'chosen', path: first };
  let last = first;
  for (let suffix = 2; suffix <= MAX_DEFAULT_ARTIFACT_SUFFIX; suffix += 1) {
    last = `${stem}-${String(suffix)}${DEFAULT_ARTIFACT_EXTENSION}`;
    if (!taken(last)) return { status: 'chosen', path: last };
  }
  return { status: 'exhausted', first_candidate: first, last_candidate: last };
};
