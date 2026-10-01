/**
 * A local, content-addressed store of verified package tarballs.
 *
 * File names are derived only from the SHA-512 digest, so nothing a lockfile says can
 * influence a path. A download is written under a temporary name, hashed as it arrives,
 * and renamed into place only if the digest matches, so a partial or mismatched download
 * never becomes a valid entry. Existing entries are hashed again before they are trusted.
 * Tarballs are stored as received and are never extracted here.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export type StoreErrorCode = 'integrity_mismatch' | 'store_unsafe' | 'store_write_failed';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

class SourceFailure extends Error {
  readonly reason: unknown;

  constructor(cause: unknown) {
    super('A package download failed.');
    this.name = 'SourceFailure';
    this.reason = cause;
  }
}

export interface StoredPackage {
  readonly bytes: number;
  /** Absolute path of the verified tarball. */
  readonly file: string;
  /** The integrity string that addresses it. */
  readonly integrity: string;
}

export interface PackageStore {
  /** The resolved directory holding the entries. */
  readonly directory: string;
  /**
   * Stream a download into the store. Resolves only if the bytes hash to `integrity`;
   * otherwise nothing is left behind.
   */
  add(integrity: string, chunks: AsyncIterable<Uint8Array>): Promise<StoredPackage>;
  /** The entry for `integrity` if one exists and still hashes correctly, else undefined. */
  lookup(integrity: string): Promise<StoredPackage | undefined>;
}

const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/u;
const ENTRY_DIRECTORY = 'v1';
const SWAP_ATTEMPTS = 8;

const digestOf = (integrity: string): string => {
  const match = INTEGRITY.exec(integrity);
  const encoded = match?.[1];
  if (encoded === undefined) {
    throw new StoreError('store_unsafe', 'An integrity hash is not a well-formed SHA-512 hash.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength !== 64) {
    throw new StoreError('store_unsafe', 'An integrity hash is not a well-formed SHA-512 hash.');
  }
  return bytes.toString('hex');
};

const missing = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const hashFile = async (file: string): Promise<{ bytes: number; digest: string }> => {
  const hash = createHash('sha512');
  let bytes = 0;
  for await (const chunk of createReadStream(file) as AsyncIterable<Buffer>) {
    hash.update(chunk);
    bytes += chunk.byteLength;
  }
  return { bytes, digest: hash.digest('hex') };
};

export const openPackageStore = async (requestedDirectory: string): Promise<PackageStore> => {
  const requested = path.resolve(requestedDirectory);
  try {
    const existing = await lstat(requested).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink())) {
      throw new StoreError('store_unsafe', 'The store location must be a directory, not a link.');
    }
    await mkdir(requested, { recursive: true, mode: 0o755 });
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError('store_write_failed', 'The store directory could not be prepared.');
  }

  let root: string;
  try {
    root = await realpath(requested);
    const entries = path.join(root, ENTRY_DIRECTORY);
    const inner = await lstat(entries).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw error;
    });
    if (inner !== undefined && (!inner.isDirectory() || inner.isSymbolicLink())) {
      throw new StoreError('store_unsafe', 'The store contains an unexpected entry.');
    }
    await mkdir(entries, { mode: 0o755, recursive: true });
  } catch (error: unknown) {
    if (error instanceof StoreError) throw error;
    throw new StoreError('store_write_failed', 'The store directory could not be prepared.');
  }

  const entriesDirectory = path.join(root, ENTRY_DIRECTORY);
  const finalPath = (hex: string): string => path.join(entriesDirectory, `sha512-${hex}.tgz`);

  const lookup = async (integrity: string): Promise<StoredPackage | undefined> => {
    const hex = digestOf(integrity);
    const file = finalPath(hex);
    const stat = await lstat(file).catch((error: unknown) => {
      if (missing(error)) return undefined;
      throw new StoreError('store_write_failed', 'A store entry could not be inspected.');
    });
    if (stat === undefined) return undefined;
    // A link or anything but a plain file is never trusted; the caller replaces it.
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    try {
      const actual = await hashFile(file);
      return actual.digest === hex ? { bytes: actual.bytes, file, integrity } : undefined;
    } catch {
      return undefined;
    }
  };

  const add = async (
    integrity: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<StoredPackage> => {
    const hex = digestOf(integrity);
    const file = finalPath(hex);
    const temporary = path.join(entriesDirectory, `.tmp-${randomBytes(12).toString('hex')}`);
    const hash = createHash('sha512');
    const iterator = chunks[Symbol.asyncIterator]();
    let bytes = 0;
    let created = false;
    try {
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      created = true;
      try {
        for (;;) {
          let step: IteratorResult<Uint8Array>;
          try {
            step = await iterator.next();
          } catch (error: unknown) {
            // A failing download is the caller's to classify, not a storage fault.
            throw new SourceFailure(error);
          }
          if (step.done === true) break;
          hash.update(step.value);
          bytes += step.value.byteLength;
          await handle.write(step.value);
        }
        if (hash.digest('hex') !== hex) {
          throw new StoreError(
            'integrity_mismatch',
            'A downloaded package does not match its integrity hash.',
          );
        }
        await handle.sync();
      } finally {
        await handle.close();
        await iterator.return?.().catch(() => undefined);
      }
      // Readable by the unprivileged user the replay container runs as; the contents are
      // public tarballs.
      await chmod(temporary, 0o444);

      // Another writer may have finished the same entry, and may be reading it right now.
      // A valid entry is kept as it is. Only an invalid one (corrupt, or a link someone
      // planted) is removed, and a swap that fails because the file is briefly busy, which
      // happens on Windows while another writer hashes it, is checked again and retried.
      for (let attempt = 1; ; attempt += 1) {
        const existing = await lookup(integrity);
        if (existing !== undefined) return existing;
        try {
          const present = await lstat(file).catch((error: unknown) => {
            if (missing(error)) return undefined;
            throw error;
          });
          if (present !== undefined) await unlink(file);
          await rename(temporary, file);
          break;
        } catch (error: unknown) {
          if (attempt >= SWAP_ATTEMPTS) throw error;
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 15 * attempt);
          });
        }
      }
      created = false;
      return { bytes, file, integrity };
    } catch (error: unknown) {
      if (error instanceof SourceFailure) throw error.reason;
      if (error instanceof StoreError) throw error;
      throw new StoreError('store_write_failed', 'A package could not be written to the store.');
    } finally {
      if (created) await unlink(temporary).catch(() => undefined);
    }
  };

  return { add, directory: root, lookup };
};
