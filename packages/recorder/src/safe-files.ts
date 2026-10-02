import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';

import { isArtifactPath } from '@proofissue/artifact-schema';

import { RecorderError } from './errors.js';

/**
 * Reading files from a project without following links. Recording and file suggestions share
 * these helpers, so a file that could not be recorded is never suggested either: every path
 * segment is checked with lstat (no symbolic links), the final file is opened with O_NOFOLLOW
 * where the platform has it, and the resolved location must still be inside the project.
 */

export const isMissing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

export const prepareProjectRoot = async (requestedRoot: string): Promise<string> => {
  const absolute = path.resolve(requestedRoot);
  let stat;
  try {
    stat = await lstat(absolute);
  } catch (error: unknown) {
    throw new RecorderError(
      'unsafe_project',
      isMissing(error)
        ? 'Selected project does not exist.'
        : 'Selected project could not be inspected.',
    );
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RecorderError(
      'unsafe_project',
      'Selected project must be a directory, not a symbolic link.',
    );
  }
  try {
    return await realpath(absolute);
  } catch {
    throw new RecorderError('unsafe_project', 'Selected project could not be resolved safely.');
  }
};

// Intermediate directories are not protected by O_NOFOLLOW, so the final location is
// resolved after the file is open and must still be inside the project root. This mirrors
// the check the runner applies to current-checkout files.
const isWithinRoot = (root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const assertSafePathComponents = async (root: string, artifactPath: string): Promise<string> => {
  let current = root;
  const segments = artifactPath.split('/');
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new RecorderError('unsafe_file', 'Selected path is invalid.');
    current = path.join(current, segment);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error: unknown) {
      throw new RecorderError(
        'unsafe_file',
        isMissing(error)
          ? `Selected file does not exist: ${artifactPath}`
          : `Selected file could not be inspected: ${artifactPath}`,
      );
    }
    if (stat.isSymbolicLink()) {
      throw new RecorderError('unsafe_file', `Symbolic links are not collected: ${artifactPath}`);
    }
    const isLast = index === segments.length - 1;
    if ((!isLast && !stat.isDirectory()) || (isLast && !stat.isFile())) {
      throw new RecorderError(
        'unsafe_file',
        `Selected path must resolve to one regular file: ${artifactPath}`,
      );
    }
  }
  return current;
};

/**
 * Reads one regular file of the project as strict UTF-8 text. It refuses a path that is not a
 * portable project-relative path, any symbolic link on the way, a file that is not regular,
 * larger than `maxBytes`, outside the project once resolved, changed while it was read, or not
 * valid UTF-8. Throws `RecorderError` with a message that names the path and never the content.
 */
export const readProjectTextFile = async (
  root: string,
  artifactPath: string,
  maxBytes: number,
): Promise<string> => {
  if (!isArtifactPath(artifactPath)) {
    throw new RecorderError(
      'unsafe_file',
      `Selected path is not a portable project-relative file path: ${artifactPath}`,
    );
  }
  const absolute = await assertSafePathComponents(root, artifactPath);
  const initialStat = await lstat(absolute);
  if (initialStat.size > maxBytes) {
    throw new RecorderError(
      'unsafe_file',
      `Selected file exceeds the ${String(maxBytes)} byte limit: ${artifactPath}`,
    );
  }

  let handle;
  try {
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(absolute, constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    const resolved = await realpath(absolute);
    if (
      !isWithinRoot(root, resolved) ||
      !openedStat.isFile() ||
      openedStat.size !== initialStat.size ||
      openedStat.dev !== initialStat.dev ||
      openedStat.ino !== initialStat.ino ||
      openedStat.size > maxBytes
    ) {
      throw new RecorderError(
        'unsafe_file',
        `Selected file changed or escaped the project while opening: ${artifactPath}`,
      );
    }
    const buffer = Buffer.alloc(openedStat.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== openedStat.size) {
      throw new RecorderError(
        'unsafe_file',
        `Selected file changed while reading: ${artifactPath}`,
      );
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new RecorderError('invalid_utf8', `Selected file is not valid UTF-8: ${artifactPath}`);
    }
  } catch (error: unknown) {
    if (error instanceof RecorderError) throw error;
    throw new RecorderError(
      'unsafe_file',
      `Selected file could not be read safely: ${artifactPath}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * Whether a portable project-relative path names one regular file reached without any
 * symbolic link. It never reads the file, and never throws.
 */
export const isSafeRegularFile = async (root: string, artifactPath: string): Promise<boolean> => {
  if (!isArtifactPath(artifactPath)) return false;
  try {
    await assertSafePathComponents(root, artifactPath);
    return true;
  } catch {
    return false;
  }
};
