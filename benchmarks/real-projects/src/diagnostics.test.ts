import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DIAGNOSTICS_README,
  DIAGNOSTIC_FILE_LIMIT_BYTES,
  createDiagnosticSink,
} from './diagnostics.js';
import { createScrubber } from './scrub.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { force: true, recursive: true });
});

const directory = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'trial-diagnostics-'));
  roots.push(root);
  return path.join(root, 'diag', 'X1');
};

describe('createDiagnosticSink', () => {
  it('redacts likely secrets, scrubs local paths, and writes a README', async () => {
    const target = await directory();
    const home = ['', 'home', 'runner', 'x'].join('/');
    const sink = createDiagnosticSink(target, createScrubber([]));

    sink.add('step.txt', 'before\n');
    sink.add('step.txt', `API_TOKEN=SYNTHETIC_TEST_ONLY_value_789\nat ${home}\n`);
    await sink.flush();

    const text = await readFile(path.join(target, 'step.txt'), 'utf8');
    expect(text).toContain('before');
    expect(text).toContain('[REDACTED:sensitive_environment]');
    expect(text).not.toContain('SYNTHETIC_TEST_ONLY_value_789');
    expect(text).toContain('<home>');
    expect(await readFile(path.join(target, 'README.txt'), 'utf8')).toBe(DIAGNOSTICS_README);
  });

  it('bounds each file', async () => {
    const target = await directory();
    const sink = createDiagnosticSink(target, createScrubber([]));

    sink.add('big.txt', 'a'.repeat(DIAGNOSTIC_FILE_LIMIT_BYTES * 2));
    await sink.flush();

    const text = await readFile(path.join(target, 'big.txt'), 'utf8');
    expect(Buffer.byteLength(text)).toBeLessThan(DIAGNOSTIC_FILE_LIMIT_BYTES + 100);
    expect(text).toContain('[truncated at');
  });

  it('withholds a file with too many likely secrets instead of writing it', async () => {
    const target = await directory();
    const sink = createDiagnosticSink(target, createScrubber([]));
    const lines = Array.from(
      { length: 200 },
      (_, index) => `API_TOKEN=SYNTHETIC_TEST_ONLY_${String(index)}`,
    );

    sink.add('many.txt', lines.join('\n'));
    await sink.flush();

    const text = await readFile(path.join(target, 'many.txt'), 'utf8');
    expect(text).toContain('withheld');
    expect(text).not.toContain('SYNTHETIC_TEST_ONLY_');
  });

  it('rejects a file name that is not a plain name', async () => {
    const sink = createDiagnosticSink(await directory(), createScrubber([]));
    const escape = ['..', 'escape.txt'].join('/');

    expect(() => {
      sink.add(escape, 'x');
    }).toThrow('not valid');
    expect(() => {
      sink.add('.hidden', 'x');
    }).toThrow('not valid');
  });

  it('never throws from flush, even when the directory cannot be created', async () => {
    const target = await directory();
    const sink = createDiagnosticSink(
      path.join(target, 'NUL', 'x'.repeat(5000)),
      createScrubber([]),
    );

    sink.add('a.txt', 'x');
    await expect(sink.flush()).resolves.toBeUndefined();
  });
});
