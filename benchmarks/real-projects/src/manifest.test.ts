import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { APPROVED_NODE_IMAGE } from '@proofissue/runner';
import { describe, expect, it } from 'vitest';

import {
  parseManifest,
  parseManifestValue,
  selectCases,
  selectionFromInputs,
  toGithubOutputs,
  type ManifestParseResult,
  type TrialManifest,
} from './manifest.js';

const committedManifestText = readFileSync(
  fileURLToPath(new URL('../cases.json', import.meta.url)),
  'utf8',
);

const parseCommitted = (): TrialManifest => {
  const result = parseManifest(committedManifestText);
  if (!result.ok)
    throw new Error(`The committed manifest is invalid: ${JSON.stringify(result.errors)}`);
  return result.manifest;
};

type Json = Record<string, unknown>;

const validCase = (): Json => ({
  id: 'X1',
  sets: ['unit'],
  title: 'A reproducible failure',
  repository: 'https://github.com/example-owner/example-repository.git',
  links: ['https://github.com/example-owner/example-repository/issues/1'],
  pre_fix_commit: 'a'.repeat(40),
  fix_commit: 'b'.repeat(40),
  dependencies: true,
  reproduction_files: ['test/example.test.js'],
  subject_files: ['lib/example.js'],
  command: ['node', '--test', 'test/example.test.js'],
  expected_exit_code: 1,
  expectations: [{ stream: 'stdout', mode: 'contains', value: 'failing literal' }],
});

const manifestWith = (override: Json = {}, top: Json = {}): unknown => ({
  manifest_version: 1,
  image: APPROVED_NODE_IMAGE,
  cases: [{ ...validCase(), ...override }],
  ...top,
});

const errorsOf = (result: ManifestParseResult): readonly { path: string; message: string }[] =>
  result.ok ? [] : result.errors;

const rejects = (raw: unknown, path: string): void => {
  const result = parseManifestValue(raw);
  expect(result.ok).toBe(false);
  expect(errorsOf(result).map((error) => error.path)).toContain(path);
};

describe('the committed manifest', () => {
  it('parses and selects the pilot set N1, T1, M3', () => {
    const manifest = parseCommitted();
    const selected = selectCases(manifest, { kind: 'set', set: 'pilot' });

    expect(selected).toMatchObject({ ok: true });
    expect(selected.ok ? selected.cases.map((item) => item.id) : []).toEqual(['N1', 'T1', 'M3']);
  });

  it('selects the twelve primary cases as the full set, in three repositories', () => {
    const manifest = parseCommitted();
    const selected = selectCases(manifest, { kind: 'set', set: 'full' });
    const cases = selected.ok ? selected.cases : [];

    expect(cases.map((item) => item.id).sort()).toEqual(
      ['M1', 'M2', 'M3', 'M4', 'N1', 'N2', 'N4', 'N5', 'T1', 'T2', 'T3', 'T4'].sort(),
    );
    expect(new Set(cases.map((item) => item.repository)).size).toBe(3);
  });

  it('keeps the reserves out of the full set', () => {
    const manifest = parseCommitted();
    const reserve = selectCases(manifest, { kind: 'set', set: 'reserve' });

    expect(reserve.ok ? reserve.cases.map((item) => item.id) : []).toEqual(['N3', 'N6']);
    const full = selectCases(manifest, { kind: 'set', set: 'full' });
    expect(full.ok ? full.cases.map((item) => item.id) : []).not.toContain('N3');
    expect(full.ok ? full.cases.map((item) => item.id) : []).not.toContain('N6');
  });

  it('gives every case distinct commits and a failing exit code', () => {
    for (const item of parseCommitted().cases) {
      expect(item.pre_fix_commit).not.toBe(item.fix_commit);
      expect(item.expected_exit_code).toBeGreaterThan(0);
    }
  });

  it('uses the image the runner approves', () => {
    expect(parseCommitted().image).toBe(APPROVED_NODE_IMAGE);
  });

  it('keeps every pilot expectation a raw contains literal', () => {
    for (const item of parseCommitted().cases) {
      for (const expectation of item.expectations) expect(expectation.mode).toBe('contains');
    }
  });
});

describe('parseManifest', () => {
  it('accepts a minimal valid manifest', () => {
    expect(parseManifestValue(manifestWith())).toMatchObject({ ok: true });
  });

  it('reports invalid JSON as a typed error', () => {
    expect(parseManifest('{')).toEqual({
      ok: false,
      errors: [{ path: '', message: 'The manifest is not valid JSON.' }],
    });
  });

  it('rejects duplicate case IDs', () => {
    const raw = { ...(manifestWith() as Json), cases: [validCase(), validCase()] };
    rejects(raw, '/cases/1/id');
  });

  it('rejects commits that are not 40-character lowercase hex', () => {
    rejects(manifestWith({ pre_fix_commit: 'a'.repeat(39) }), '/cases/0/pre_fix_commit');
    rejects(manifestWith({ pre_fix_commit: 'A'.repeat(40) }), '/cases/0/pre_fix_commit');
    rejects(manifestWith({ fix_commit: 'main' }), '/cases/0/fix_commit');
  });

  it('rejects identical pre-fix and fix commits', () => {
    rejects(manifestWith({ fix_commit: 'a'.repeat(40) }), '/cases/0/fix_commit');
  });

  it('rejects repositories outside https://github.com', () => {
    const rejected = [
      'git@github.com:example-owner/example-repository.git',
      'http://github.com/example-owner/example-repository.git',
      'file:///srv/example-repository.git',
      'ext::sh -c touch% /tmp/x',
      'https://example.com/example-owner/example-repository.git',
      'https://github.com/example-owner/example-repository',
    ];
    for (const repository of rejected) rejects(manifestWith({ repository }), '/cases/0/repository');
  });

  it('rejects non-portable file paths', () => {
    const backslash = String.fromCharCode(92);
    const rejected = [
      '../escape.js',
      'lib/../escape.js',
      '/absolute.js',
      `lib${backslash}windows.js`,
      'lib//empty.js',
      'lib/./dot.js',
      '',
    ];
    for (const file of rejected) {
      rejects(manifestWith({ subject_files: [file] }), '/cases/0/subject_files/0');
    }
  });

  it('rejects package.json and package-lock.json as selected files', () => {
    rejects(manifestWith({ subject_files: ['package.json'] }), '/cases/0/subject_files/0');
    rejects(
      manifestWith({ reproduction_files: ['package-lock.json'] }),
      '/cases/0/reproduction_files/0',
    );
  });

  it('rejects a path selected twice across roles, ignoring case', () => {
    rejects(
      manifestWith({ reproduction_files: ['lib/Example.js'], subject_files: ['lib/example.js'] }),
      '/cases/0',
    );
  });

  it('rejects commands that do not start with node', () => {
    rejects(manifestWith({ command: ['npm', 'test'] }), '/cases/0/command/0');
    rejects(manifestWith({ command: ['node'] }), '/cases/0/command');
  });

  it('rejects empty and control-character command arguments', () => {
    rejects(manifestWith({ command: ['node', ''] }), '/cases/0/command/1');
    rejects(manifestWith({ command: ['node', 'a\nb'] }), '/cases/0/command/1');
    rejects(manifestWith({ command: ['node', 'a\u0000b'] }), '/cases/0/command/1');
    rejects(manifestWith({ command: ['node', 'a\u007fb'] }), '/cases/0/command/1');
    expect(parseManifestValue(manifestWith({ command: ['node', 'a\tb'] })).ok).toBe(true);
  });

  it('rejects expectation values that start with --, are empty, or are too long', () => {
    const contains = (value: string): Json => ({ stream: 'stdout', mode: 'contains', value });
    rejects(manifestWith({ expectations: [contains('--flag')] }), '/cases/0/expectations/0/value');
    rejects(manifestWith({ expectations: [contains('')] }), '/cases/0/expectations/0/value');
    rejects(
      manifestWith({ expectations: [contains('x'.repeat(8193))] }),
      '/cases/0/expectations/0/value',
    );
    expect(
      parseManifestValue(manifestWith({ expectations: [contains('x'.repeat(8192))] })).ok,
    ).toBe(true);
  });

  it('requires a value for contains modes and forbids one for exact modes', () => {
    rejects(
      manifestWith({ expectations: [{ stream: 'stdout', mode: 'contains' }] }),
      '/cases/0/expectations/0/value',
    );
    rejects(
      manifestWith({ expectations: [{ stream: 'stderr', mode: 'contains_normalized' }] }),
      '/cases/0/expectations/0/value',
    );
    rejects(
      manifestWith({ expectations: [{ stream: 'stdout', mode: 'exact', value: 'text' }] }),
      '/cases/0/expectations/0/value',
    );
    expect(
      parseManifestValue(manifestWith({ expectations: [{ stream: 'stdout', mode: 'exact' }] })).ok,
    ).toBe(true);
  });

  it('allows at most one exact expectation per stream', () => {
    rejects(
      manifestWith({
        expectations: [
          { stream: 'stdout', mode: 'exact' },
          { stream: 'stdout', mode: 'exact_normalized' },
        ],
      }),
      '/cases/0/expectations/1',
    );
    expect(
      parseManifestValue(
        manifestWith({
          expectations: [
            { stream: 'stdout', mode: 'exact' },
            { stream: 'stderr', mode: 'exact_normalized' },
          ],
        }),
      ).ok,
    ).toBe(true);
  });

  it('rejects unknown keys at every level', () => {
    rejects(manifestWith({}, { extra: true }), '/extra');
    rejects(manifestWith({ extra: true }), '/cases/0/extra');
    rejects(
      manifestWith({
        expectations: [{ stream: 'stdout', mode: 'contains', value: 'x', extra: 1 }],
      }),
      '/cases/0/expectations/0/extra',
    );
  });

  it('enforces the file-count limit with and without dependencies', () => {
    const files = (count: number): string[] =>
      Array.from({ length: count }, (_, index) => `src/file-${String(index)}.js`);

    expect(
      parseManifestValue(manifestWith({ subject_files: files(97), dependencies: true })).ok,
    ).toBe(true);
    rejects(manifestWith({ subject_files: files(98), dependencies: true }), '/cases/0');
    expect(
      parseManifestValue(manifestWith({ subject_files: files(99), dependencies: false })).ok,
    ).toBe(true);
    rejects(manifestWith({ subject_files: files(100), dependencies: false }), '/cases/0');
  });

  it('requires an expected exit code from 1 to 255', () => {
    for (const code of [0, 256, -1, 1.5, '1']) {
      rejects(manifestWith({ expected_exit_code: code }), '/cases/0/expected_exit_code');
    }
    expect(parseManifestValue(manifestWith({ expected_exit_code: 255 })).ok).toBe(true);
  });

  it('rejects an image that is not a digest-pinned node image', () => {
    rejects(manifestWith({}, { image: 'node:24' }), '/image');
  });

  it('rejects non-https links and unsupported manifest versions', () => {
    rejects(manifestWith({ links: ['http://example.com/x'] }), '/cases/0/links/0');
    rejects(manifestWith({}, { manifest_version: 2 }), '/manifest_version');
  });
});

describe('selectionFromInputs and selectCases', () => {
  const manifest = parseCommitted();

  it('lets a case list win over a set', () => {
    const selection = selectionFromInputs({ cases: 'T1, N1', set: 'pilot', ref: 'trials/other/x' });

    expect(selection).toEqual({ ok: true, selection: { kind: 'cases', ids: ['T1', 'N1'] } });
    const cases = selection.ok ? selectCases(manifest, selection.selection) : undefined;
    expect(cases?.ok ? cases.cases.map((item) => item.id) : []).toEqual(['T1', 'N1']);
  });

  it('uses the set when no cases are given, treating empty strings as not given', () => {
    expect(selectionFromInputs({ cases: '', set: 'pilot' })).toEqual({
      ok: true,
      selection: { kind: 'set', set: 'pilot' },
    });
  });

  it('takes the set from a trials/<set>/<label> ref', () => {
    expect(selectionFromInputs({ cases: '', set: '', ref: 'trials/pilot/run-1' })).toEqual({
      ok: true,
      selection: { kind: 'set', set: 'pilot' },
    });
    expect(selectionFromInputs({ ref: 'trials/pilot' })).toEqual({
      ok: true,
      selection: { kind: 'set', set: 'pilot' },
    });
  });

  it('rejects when nothing selects a set or case', () => {
    expect(selectionFromInputs({ cases: '', set: '', ref: 'main' }).ok).toBe(false);
    expect(selectionFromInputs({}).ok).toBe(false);
  });

  it('rejects unknown sets and unknown IDs', () => {
    const unknownSet = selectionFromInputs({ set: 'missing' });
    expect(unknownSet.ok && selectCases(manifest, unknownSet.selection).ok).toBe(false);
    const unknownId = selectionFromInputs({ cases: 'N1,Z9' });
    expect(unknownId.ok && selectCases(manifest, unknownId.selection).ok).toBe(false);
  });

  it('rejects malformed IDs, duplicate IDs, and malformed set names', () => {
    expect(selectionFromInputs({ cases: 'n1' }).ok).toBe(false);
    expect(selectionFromInputs({ cases: 'N1,N1' }).ok).toBe(false);
    expect(selectionFromInputs({ cases: ',' }).ok).toBe(false);
    expect(selectionFromInputs({ set: 'Pilot' }).ok).toBe(false);
    expect(selectionFromInputs({ ref: 'trials/BAD/run-1' }).ok).toBe(false);
  });
});

describe('toGithubOutputs', () => {
  it('prints compact case and image lines', () => {
    const manifest = parseCommitted();
    const selected = selectCases(manifest, { kind: 'set', set: 'pilot' });
    const output = selected.ok ? toGithubOutputs(manifest, selected.cases) : '';

    expect(output).toBe(`cases=["N1","T1","M3"]\nimage=${APPROVED_NODE_IMAGE}\n`);
  });
});
