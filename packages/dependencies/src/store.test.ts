import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, type TestContext } from 'vitest';

import {
  openExistingPackageStore,
  openPackageStore,
  StoreError,
  type StoreErrorCode,
} from './store.js';
import { entryPathFor, everythingStored, storedEntries, temporaryFiles } from './test-support.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const workspace = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-store-'));
  roots.push(root);
  return root;
};

const integrityOf = (content: Uint8Array): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

async function* chunked(content: Uint8Array, size = 7): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < content.byteLength; offset += size) {
    yield content.subarray(offset, offset + size);
    await Promise.resolve();
  }
}

const codeOf = async (run: () => Promise<unknown>): Promise<StoreErrorCode | undefined> => {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof StoreError) return error.code;
    throw error;
  }
  return undefined;
};

const symlinkOrSkip = async (context: TestContext, target: string, link: string): Promise<void> => {
  try {
    await symlink(target, link);
  } catch (error: unknown) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
    if (code === 'EPERM')
      context.skip('Creating symbolic links needs a privilege this host lacks.');
    throw error;
  }
};

const tarball = Buffer.from('synthetic tarball bytes '.repeat(100));

describe('openPackageStore', () => {
  it('creates a missing directory, including parents', async () => {
    const root = await workspace();

    const store = await openPackageStore(path.join(root, 'a', 'b', 'store'));

    expect((await stat(store.directory)).isDirectory()).toBe(true);
  });

  it('reopens an existing store and keeps its entries', async () => {
    const root = await workspace();
    const first = await openPackageStore(path.join(root, 'store'));
    await first.add(integrityOf(tarball), chunked(tarball));

    const second = await openPackageStore(path.join(root, 'store'));

    expect((await second.lookup(integrityOf(tarball)))?.bytes).toBe(tarball.byteLength);
  });

  it('refuses a path that is a file', async () => {
    const root = await workspace();
    await writeFile(path.join(root, 'file'), 'x');

    expect(await codeOf(async () => await openPackageStore(path.join(root, 'file')))).toBe(
      'store_unsafe',
    );
  });

  it('refuses a store directory that is a symbolic link', async (context) => {
    const root = await workspace();
    await mkdir(path.join(root, 'real'));
    await symlinkOrSkip(context, path.join(root, 'real'), path.join(root, 'link'));

    expect(await codeOf(async () => await openPackageStore(path.join(root, 'link')))).toBe(
      'store_unsafe',
    );
  });

  it('refuses a store whose cache directory is a file', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'store'));
    await writeFile(path.join(root, 'store', '_cacache'), 'x');

    expect(await codeOf(async () => await openPackageStore(path.join(root, 'store')))).toBe(
      'store_unsafe',
    );
  });
});

describe('openExistingPackageStore', () => {
  it('reads entries written by a writable store', async () => {
    const root = await workspace();
    const writable = await openPackageStore(path.join(root, 'store'));
    await writable.add(integrityOf(tarball), chunked(tarball));

    const readable = await openExistingPackageStore(path.join(root, 'store'));

    expect((await readable.lookup(integrityOf(tarball)))?.bytes).toBe(tarball.byteLength);
    expect(readable.directory).toBe(writable.directory);
    expect(readable).not.toHaveProperty('add');
  });

  it('refuses a directory that does not exist, and creates nothing', async () => {
    const root = await workspace();

    expect(
      await codeOf(async () => await openExistingPackageStore(path.join(root, 'nothing'))),
    ).toBe('store_unsafe');
    expect(await readdir(root)).toEqual([]);
  });

  it('refuses a directory that is not a store, and adds nothing to it', async () => {
    const root = await workspace();
    await mkdir(path.join(root, 'plain'));
    await writeFile(path.join(root, 'plain', 'file.txt'), 'x');

    expect(await codeOf(async () => await openExistingPackageStore(path.join(root, 'plain')))).toBe(
      'store_unsafe',
    );
    expect(await readdir(path.join(root, 'plain'))).toEqual(['file.txt']);
  });

  it('does not change anything on disk when it is only used for lookups', async () => {
    const root = await workspace();
    const writable = await openPackageStore(path.join(root, 'store'));
    await writable.add(integrityOf(tarball), chunked(tarball));
    const before = await everythingStored(writable.directory);

    const readable = await openExistingPackageStore(path.join(root, 'store'));
    await readable.lookup(integrityOf(tarball));
    await readable.lookup(integrityOf(Buffer.from('not stored')));

    expect(await everythingStored(writable.directory)).toEqual(before);
    expect((await readdir(path.join(writable.directory, '_cacache'))).sort()).toEqual([
      'content-v2',
      'tmp',
    ]);
  });
});

describe('package store', () => {
  const open = async () => await openPackageStore(path.join(await workspace(), 'store'));

  it('stores a verified download and returns it from lookup', async () => {
    const store = await open();
    const integrity = integrityOf(tarball);

    const added = await store.add(integrity, chunked(tarball));
    const found = await store.lookup(integrity);

    expect(added).toEqual({
      bytes: tarball.byteLength,
      file: expect.any(String) as string,
      integrity,
    });
    expect(found).toEqual(added);
    expect((await readFile(added.file)).equals(tarball)).toBe(true);
  });

  it('puts the file exactly where npm looks for content with that digest', async () => {
    const store = await open();
    const hex = createHash('sha512').update(tarball).digest('hex');

    const added = await store.add(integrityOf(tarball), chunked(tarball));

    expect(added.file).toBe(
      path.join(
        store.directory,
        '_cacache',
        'content-v2',
        'sha512',
        hex.slice(0, 2),
        hex.slice(2, 4),
        hex.slice(4),
      ),
    );
    expect(added.file).toBe(entryPathFor(store.directory, tarball));
  });

  it('leaves no temporary file after a successful add', async () => {
    const store = await open();

    await store.add(integrityOf(tarball), chunked(tarball));

    expect(await temporaryFiles(store.directory)).toEqual([]);
  });

  it('makes entries readable by an unprivileged container user', async (context) => {
    if (process.platform === 'win32') context.skip('POSIX permissions do not apply on Windows.');
    const store = await open();

    const added = await store.add(integrityOf(tarball), chunked(tarball));

    expect((await stat(added.file)).mode & 0o777).toBe(0o444);
  });

  it('stores an empty-bytes-per-chunk download and a large one', async () => {
    const store = await open();
    const large = Buffer.alloc(3 * 1024 * 1024, 5);

    const added = await store.add(integrityOf(large), chunked(large, 65_536));

    expect(added.bytes).toBe(large.byteLength);
    expect((await store.lookup(integrityOf(large)))?.bytes).toBe(large.byteLength);
  });

  it('returns nothing for a package that is not stored', async () => {
    const store = await open();

    expect(await store.lookup(integrityOf(tarball))).toBeUndefined();
  });

  it('rejects bytes that do not match the integrity hash and leaves nothing behind', async () => {
    const store = await open();
    const other = Buffer.from('different bytes');

    expect(await codeOf(async () => await store.add(integrityOf(tarball), chunked(other)))).toBe(
      'integrity_mismatch',
    );

    expect(await store.lookup(integrityOf(tarball))).toBeUndefined();
    expect(await everythingStored(store.directory)).toEqual([]);
  });

  it('rejects a download that is a prefix of the expected bytes', async () => {
    const store = await open();

    expect(
      await codeOf(
        async () => await store.add(integrityOf(tarball), chunked(tarball.subarray(0, 100))),
      ),
    ).toBe('integrity_mismatch');
    expect(await everythingStored(store.directory)).toEqual([]);
  });

  it('rejects a download with extra bytes appended', async () => {
    const store = await open();
    const extended = Buffer.concat([tarball, Buffer.from('x')]);

    expect(await codeOf(async () => await store.add(integrityOf(tarball), chunked(extended)))).toBe(
      'integrity_mismatch',
    );
  });

  it('leaves no partial file when the download fails midway, and passes the error on', async () => {
    const store = await open();
    async function* failing(): AsyncGenerator<Uint8Array> {
      yield tarball.subarray(0, 50);
      await Promise.resolve();
      throw new Error('connection reset');
    }

    await expect(store.add(integrityOf(tarball), failing())).rejects.toThrow('connection reset');

    expect(await everythingStored(store.directory)).toEqual([]);
  });

  it('does not trust an entry whose content changed on disk, and repairs it', async () => {
    const store = await open();
    const integrity = integrityOf(tarball);
    const added = await store.add(integrity, chunked(tarball));
    await rm(added.file);
    await writeFile(added.file, 'corrupted');

    expect(await store.lookup(integrity)).toBeUndefined();

    await store.add(integrity, chunked(tarball));
    expect((await store.lookup(integrity))?.bytes).toBe(tarball.byteLength);
    expect((await readFile(added.file)).equals(tarball)).toBe(true);
  });

  it('does not trust a symbolic link planted as an entry, and replaces only the link', async (context) => {
    const store = await open();
    const integrity = integrityOf(tarball);
    const outside = path.join(path.dirname(store.directory), 'outside.tgz');
    await writeFile(outside, tarball);
    const entry = entryPathFor(store.directory, tarball);
    await mkdir(path.dirname(entry), { recursive: true });
    await symlinkOrSkip(context, outside, entry);

    expect(await store.lookup(integrity)).toBeUndefined();

    const added = await store.add(integrity, chunked(tarball));
    expect(added.file).toBe(entry);
    expect((await readFile(outside)).equals(tarball)).toBe(true);
    expect((await store.lookup(integrity))?.bytes).toBe(tarball.byteLength);
  });

  it('never deletes a directory planted as an entry', async () => {
    const store = await open();
    const integrity = integrityOf(tarball);
    const entry = entryPathFor(store.directory, tarball);
    await mkdir(entry, { recursive: true });
    await writeFile(path.join(entry, 'keep.txt'), 'important');

    expect(await store.lookup(integrity)).toBeUndefined();
    expect(await codeOf(async () => await store.add(integrity, chunked(tarball)))).toBe(
      'store_write_failed',
    );

    expect(await readFile(path.join(entry, 'keep.txt'), 'utf8')).toBe('important');
    expect(await temporaryFiles(store.directory)).toEqual([]);
  });

  it('does not trust or write through a symbolic link in place of a shard directory', async (context) => {
    const store = await open();
    const integrity = integrityOf(tarball);
    const target = entryPathFor(store.directory, tarball);
    const shard = path.dirname(path.dirname(target));
    const elsewhere = path.join(path.dirname(store.directory), 'elsewhere');
    await mkdir(path.join(elsewhere, path.basename(path.dirname(target))), { recursive: true });
    await writeFile(
      path.join(elsewhere, path.basename(path.dirname(target)), path.basename(target)),
      tarball,
    );
    await symlinkOrSkip(context, elsewhere, shard);

    expect(await store.lookup(integrity)).toBeUndefined();
    expect(await codeOf(async () => await store.add(integrity, chunked(tarball)))).toBe(
      'store_unsafe',
    );
  });

  it('leaves a valid existing entry untouched when the same package is added again', async () => {
    const store = await open();
    const integrity = integrityOf(tarball);
    const first = await store.add(integrity, chunked(tarball));
    const before = await stat(first.file);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });

    const second = await store.add(integrity, chunked(tarball));
    const after = await stat(second.file);

    expect(second.file).toBe(first.file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.ino).toBe(before.ino);
    expect(await storedEntries(store.directory)).toHaveLength(1);
  });

  it('survives several writers adding the same package at once', async () => {
    const store = await open();
    const integrity = integrityOf(tarball);

    const results = await Promise.all(
      Array.from({ length: 6 }, async () => await store.add(integrity, chunked(tarball, 13))),
    );

    expect(new Set(results.map((item) => item.file)).size).toBe(1);
    expect(await storedEntries(store.directory)).toHaveLength(1);
    expect((await store.lookup(integrity))?.bytes).toBe(tarball.byteLength);
  });

  it('treats two spellings of one digest as the same entry', async () => {
    const store = await open();
    const canonical = integrityOf(tarball);
    // The last base64 character carries four bits plus two ignored padding bits, so a
    // neighbouring character with the same top bits decodes to identical bytes.
    const last = canonical.charAt(canonical.length - 3);
    const alias = `${canonical.slice(0, -3)}${last === 'A' ? 'B' : 'A'}==`;
    fc: {
      const aliasBytes = Buffer.from(alias.slice('sha512-'.length), 'base64');
      const canonicalBytes = Buffer.from(canonical.slice('sha512-'.length), 'base64');
      if (!aliasBytes.equals(canonicalBytes)) break fc;
      await store.add(canonical, chunked(tarball));
      expect((await store.lookup(alias))?.bytes).toBe(tarball.byteLength);
    }
  });

  it.each([
    ['a missing algorithm', 'A'.repeat(88)],
    ['sha1', `sha1-${'A'.repeat(27)}=`],
    ['sha256', `sha256-${'A'.repeat(43)}=`],
    ['a short sha512', `sha512-${'A'.repeat(85)}==`],
    ['a path traversal', 'sha512-../../../../etc/passwd'],
    ['a slash in the digest', `sha512-${'A'.repeat(40)}/${'A'.repeat(45)}==`.replace('/', '\\')],
    ['an empty string', ''],
    ['two hashes', `sha512-${'A'.repeat(86)}== sha512-${'B'.repeat(86)}==`],
  ])('refuses %s for both add and lookup', async (_name, integrity) => {
    const store = await open();

    expect(await codeOf(async () => await store.lookup(integrity))).toBe('store_unsafe');
    expect(await codeOf(async () => await store.add(integrity, chunked(tarball)))).toBe(
      'store_unsafe',
    );
    expect(await everythingStored(store.directory)).toEqual([]);
  });
});
