import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

/**
 * Test helpers for building hostile package tarballs and inspecting a package store on disk.
 * Exposed only as `@proofissue/dependencies/testing`, for tests; it is not part of the API.
 */

const walk = async (directory: string): Promise<string[]> => {
  const found: string[] = [];
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return found;
  }
  for (const name of names) {
    const full = path.join(directory, name);
    const children = await readdir(full).catch(() => undefined);
    if (children === undefined) found.push(full);
    else found.push(...(await walk(full)));
  }
  return found;
};

/** Every finished entry in the store, as paths relative to the store directory. */
export const storedEntries = async (storeDirectory: string): Promise<string[]> =>
  (await walk(path.join(storeDirectory, '_cacache', 'content-v2')))
    .map((file) => path.relative(storeDirectory, file).replaceAll('\\', '/'))
    .sort();

/** Every temporary file left in the store. After any operation this should be empty. */
export const temporaryFiles = async (storeDirectory: string): Promise<string[]> =>
  (await walk(path.join(storeDirectory, '_cacache', 'tmp')))
    .map((file) => path.relative(storeDirectory, file).replaceAll('\\', '/'))
    .sort();

/** Anything at all in the store's content or temporary areas. */
export const everythingStored = async (storeDirectory: string): Promise<string[]> => [
  ...(await storedEntries(storeDirectory)),
  ...(await temporaryFiles(storeDirectory)),
];

/** Where npm expects the content with this SHA-512 digest to be. */
export const entryPathFor = (storeDirectory: string, content: Uint8Array): string => {
  const hex = createHash('sha512').update(content).digest('hex');
  return path.join(
    storeDirectory,
    '_cacache',
    'content-v2',
    'sha512',
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
};

/** Builds a gzipped tar archive by hand, so tests can create hostile ones. */
export type TarEntryType = 'file' | 'hardlink' | 'symlink';

export interface TarEntry {
  readonly content?: Buffer | string;
  readonly link?: string;
  readonly name: string;
  readonly type?: TarEntryType;
}

const header = (name: string, size: number, type: string, link: string): Buffer => {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.write('        ', 148);
  block.write(type, 156);
  block.write(link, 157, 100, 'utf8');
  block.write('ustar\0' + '00', 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
};

const TYPE_FLAGS: Readonly<Record<TarEntryType, string>> = {
  file: '0',
  hardlink: '1',
  symlink: '2',
};

export const buildTarball = (entries: readonly TarEntry[]): Buffer => {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.content ?? '');
    const padding = (512 - (data.length % 512)) % 512;
    parts.push(
      header(entry.name, data.length, TYPE_FLAGS[entry.type ?? 'file'], entry.link ?? ''),
      data,
      Buffer.alloc(padding),
    );
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
};
