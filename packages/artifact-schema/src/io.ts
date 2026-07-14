import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { ARTIFACT_LIMITS } from './limits.js';
import type { ArtifactV1 } from './model.js';
import { serializeArtifact } from './serialize.js';
import { parseAndValidateArtifact } from './validate.js';

export class ArtifactFileError extends Error {
  readonly code: 'atomic_write_failed' | 'input_too_large' | 'unsafe_input_file';

  constructor(code: ArtifactFileError['code'], message: string) {
    super(message);
    this.name = 'ArtifactFileError';
    this.code = code;
  }
}

const doesNotExist = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const readBoundedFile = async (
  handle: Awaited<ReturnType<typeof open>>,
  expectedBytes: number,
): Promise<Buffer | undefined> => {
  const buffer = Buffer.alloc(expectedBytes + 1);
  let offset = 0;
  while (offset < buffer.byteLength) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === expectedBytes ? buffer.subarray(0, offset) : undefined;
};

export const readArtifactFile = async (
  artifactPath: string,
): Promise<ReturnType<typeof parseAndValidateArtifact>> => {
  let initialStat;
  try {
    initialStat = await lstat(artifactPath);
  } catch (error: unknown) {
    return {
      ok: false,
      errors: [
        {
          code: 'unsafe_input_file',
          message: doesNotExist(error)
            ? 'Artifact file does not exist.'
            : 'Artifact file could not be inspected.',
        },
      ],
    };
  }
  if (!initialStat.isFile() || initialStat.isSymbolicLink()) {
    return {
      ok: false,
      errors: [
        {
          code: 'unsafe_input_file',
          message: 'Artifact input must be a regular file, not a symbolic link.',
        },
      ],
    };
  }
  if (initialStat.size > ARTIFACT_LIMITS.input_bytes) {
    return {
      ok: false,
      errors: [
        {
          code: 'input_too_large',
          message: `Artifact exceeds the ${String(ARTIFACT_LIMITS.input_bytes)} byte input limit.`,
        },
      ],
    };
  }

  let handle;
  try {
    const noFollow = 'O_NOFOLLOW' in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(artifactPath, constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      openedStat.size !== initialStat.size ||
      openedStat.dev !== initialStat.dev ||
      openedStat.ino !== initialStat.ino ||
      openedStat.size > ARTIFACT_LIMITS.input_bytes
    ) {
      return {
        ok: false,
        errors: [
          {
            code: 'unsafe_input_file',
            message: 'Artifact file changed while it was being opened.',
          },
        ],
      };
    }
    const bytes = await readBoundedFile(handle, openedStat.size);
    return bytes === undefined
      ? {
          ok: false,
          errors: [
            { code: 'unsafe_input_file', message: 'Artifact file changed while it was read.' },
          ],
        }
      : parseAndValidateArtifact(bytes);
  } catch {
    return {
      ok: false,
      errors: [{ code: 'unsafe_input_file', message: 'Artifact file could not be read safely.' }],
    };
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

export interface WriteArtifactFileResult {
  readonly bytes_written: number;
  readonly output_path: string;
}

const flushDirectoryWhenSupported = async (directory: string): Promise<void> => {
  let directoryHandle;
  try {
    directoryHandle = await open(directory, constants.O_RDONLY);
    await directoryHandle.sync();
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EISDIR')
      throw error;
  } finally {
    await directoryHandle?.close().catch(() => undefined);
  }
};

export const writeArtifactFile = async (
  outputPath: string,
  artifact: ArtifactV1,
): Promise<WriteArtifactFileResult> => {
  const serialized = serializeArtifact(artifact);
  const bytes = Buffer.from(serialized, 'utf8');
  const absoluteOutput = path.resolve(outputPath);
  const requestedParent = path.dirname(absoluteOutput);
  let parent: string;

  try {
    parent = await realpath(requestedParent);
    const outputStat = await lstat(absoluteOutput).catch((error: unknown) => {
      if (doesNotExist(error)) return undefined;
      throw error;
    });
    if (outputStat !== undefined) {
      throw new ArtifactFileError(
        'atomic_write_failed',
        'Output path already exists; artifacts are never overwritten.',
      );
    }
  } catch (error: unknown) {
    if (error instanceof ArtifactFileError) throw error;
    throw new ArtifactFileError('atomic_write_failed', 'Output path could not be prepared safely.');
  }

  const finalPath = path.join(parent, path.basename(absoluteOutput));
  const temporaryPath = path.join(parent, `.proofissue-${randomBytes(16).toString('hex')}.tmp`);
  let temporaryCreated = false;
  try {
    const handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporaryPath, finalPath);
    await flushDirectoryWhenSupported(parent);
    await unlink(temporaryPath);
    temporaryCreated = false;
    return { bytes_written: bytes.byteLength, output_path: finalPath };
  } catch (error: unknown) {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
    if (error instanceof ArtifactFileError) throw error;
    throw new ArtifactFileError(
      'atomic_write_failed',
      'Artifact could not be published atomically without replacement.',
    );
  }
};
