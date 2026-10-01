/**
 * A local, content-addressed store of verified package tarballs, laid out as an npm cache.
 *
 * Tarballs live at `_cacache/content-v2/sha512/<aa>/<bb>/<rest>`, where the name is the
 * SHA-512 digest in hex. That is exactly where npm looks for a package it already has, so
 * the store directory can be handed to `npm ci --offline --cache <store>` unchanged and no
 * copy is needed. File names are derived only from the digest, so nothing a lockfile says can
 * influence a path.
 *
 * A download is written under a temporary name, hashed as it arrives, and moved into place
 * only if the digest matches, so a partial or mismatched download never becomes a valid
 * entry. Existing entries are hashed again before they are trusted. Tarballs are stored as
 * received and are never extracted here.
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

  constructor(reason: unknown) {
    super('A package download failed.');
    this.name = 'SourceFailure';
    this.reason = reason;
  }
}

export interface StoredPackage {
  readonly bytes: number;
  /** Absolute path of the verified tarball. */
  readonly file: string;
  /** The integrity string that addresses it. */
  readonly integrity: string;
}

/** What a consumer that only reads the store needs. */
export interface ReadablePackageStore {
  /** The resolved directory to hand to npm as its cache. */
  readonly directory: string;
  /** The entry for `integrity` if one exists and still hashes correctly, else undefined. */
  lookup(integrity: string): Promise<StoredPackage | undefined>;
}

export interface PackageStore extends ReadablePackageStore {
  /**
   * Stream a download into the store. Resolves only if the bytes hash to `integrity`;
   * otherwise nothing is left behind.
   */
  add(integrity: string, chunks: AsyncIterable<Uint8Array>): Promise<StoredPackage>;
}

const INTEGRITY = /^sha512-([A-Za-z0-9+/]{86}==)$/u;
const SWAP_ATTEMPTS = 8;
const CONTENT_SEGMENTS = ['_cacache', 'content-v2', 'sha512'] as const;
const TEMPORARY_SEGMENTS = ['_cacache', 'tmp'] as const;

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

/**
 * Makes sure `directory` is a real directory and not a link, creating it when allowed.
 * Returns false only when it is missing and creation was not allowed.
 */
const ensureDirectory = async (directory: string, create: boolean): Promise<boolean> => {
  const existing = await lstat(directory).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw new StoreError('store_write_failed', 'The store directory could not be inspected.');
  });
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new StoreError('store_unsafe', 'The store contains an unexpected entry.');
    }
    return true;
  }
  if (!create) return false;
  try {
    await mkdir(directory, { mode: 0o755 });
  } catch {
    // Another preparation may have created it a moment ago; that is fine if it is a directory.
    if (!(await ensureDirectory(directory, false))) {
      throw new StoreError('store_write_failed', 'The store directory could not be prepared.');
    }
  }
  return true;
};

const resolveRoot = async (requestedDirectory: string, create: boolean): Promise<string> => {
  const requested = path.resolve(requestedDirectory);
  const existing = await lstat(requested).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw new StoreError('store_write_failed', 'The store directory could not be inspected.');
  });
  if (existing !== undefined && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new StoreError('store_unsafe', 'The store location must be a directory, not a link.');
  }
  if (existing === undefined) {
    if (!create) throw new StoreError('store_unsafe', 'The store directory does not exist.');
    try {
      await mkdir(requested, { recursive: true, mode: 0o755 });
    } catch {
      throw new StoreError('store_write_failed', 'The store directory could not be prepared.');
    }
  }
  try {
    return await realpath(requested);
  } catch {
    throw new StoreError('store_write_failed', 'The store directory could not be resolved.');
  }
};

const openStore = async (
  requestedDirectory: string,
  create: boolean,
): Promise<{ directory: string; lookup: ReadablePackageStore['lookup']; write: boolean }> => {
  const root = await resolveRoot(requestedDirectory, create);
  const contentDirectory = path.join(root, ...CONTENT_SEGMENTS);
  const temporaryDirectory = path.join(root, ...TEMPORARY_SEGMENTS);

  // Create or check each level from the top, never following a link.
  let walked = root;
  for (const segment of [...CONTENT_SEGMENTS]) {
    walked = path.join(walked, segment);
    if (!(await ensureDirectory(walked, create))) {
      throw new StoreError('store_unsafe', 'The directory is not a package store.');
    }
  }
  if (create) await ensureDirectory(temporaryDirectory, true);

  const finalPath = (hex: string): string =>
    path.join(contentDirectory, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));

  const lookup = async (integrity: string): Promise<StoredPackage | undefined> => {
    const hex = digestOf(integrity);
    const file = finalPath(hex);
    try {
      // A link anywhere on the way, or anything but a plain file, is never trusted.
      const real = await realpath(file);
      const sameLocation =
        process.platform === 'win32' ? real.toLowerCase() === file.toLowerCase() : real === file;
      if (!sameLocation) return undefined;
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      const actual = await hashFile(file);
      return actual.digest === hex ? { bytes: actual.bytes, file, integrity } : undefined;
    } catch {
      return undefined;
    }
  };

  return { directory: root, lookup, write: create };
};

/** Opens a store for reading only. Nothing is created, so a missing store is an error. */
export const openExistingPackageStore = async (
  requestedDirectory: string,
): Promise<ReadablePackageStore> => {
  const { directory, lookup } = await openStore(requestedDirectory, false);
  return { directory, lookup };
};

/** Opens a store for reading and writing, creating it if it does not exist. */
export const openPackageStore = async (requestedDirectory: string): Promise<PackageStore> => {
  const { directory, lookup } = await openStore(requestedDirectory, true);
  const contentDirectory = path.join(directory, ...CONTENT_SEGMENTS);
  const temporaryDirectory = path.join(directory, ...TEMPORARY_SEGMENTS);

  const add = async (
    integrity: string,
    chunks: AsyncIterable<Uint8Array>,
  ): Promise<StoredPackage> => {
    const hex = digestOf(integrity);
    const first = path.join(contentDirectory, hex.slice(0, 2));
    const second = path.join(first, hex.slice(2, 4));
    const file = path.join(second, hex.slice(4));
    const temporary = path.join(
      temporaryDirectory,
      `proofissue-${randomBytes(12).toString('hex')}`,
    );
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
      await ensureDirectory(first, true);
      await ensureDirectory(second, true);

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

  return { add, directory, lookup };
};
