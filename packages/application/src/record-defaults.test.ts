import { describe, expect, it } from 'vitest';

import {
  artifactStem,
  DEFAULT_ARTIFACT_EXTENSION,
  defaultArtifactPath,
  MAX_DEFAULT_ARTIFACT_SUFFIX,
} from './record-defaults.js';

const nothingExists = (): boolean => false;

describe('default artifact names', () => {
  it('derives the artifact name from the first reproduction file', () => {
    const chosen = defaultArtifactPath({
      cwd: 'project',
      exists: nothingExists,
      reproduction_paths: ['test/reproduction.mjs', 'test/other.mjs'],
    });

    expect(chosen).toEqual({ status: 'chosen', path: `reproduction${DEFAULT_ARTIFACT_EXTENSION}` });
    expect(DEFAULT_ARTIFACT_EXTENSION).toBe('.proofissue.yaml');
  });

  it.each([
    ['test/my test (1).spec.js', 'my-test--1-.spec'],
    ['test\\a.js', 'a'],
    ['test/.hidden.js', 'hidden'],
    ['test/--flag.mjs', 'flag'],
    ['test/archive.tar.gz', 'archive.tar'],
    ['test/noextension', 'noextension'],
    ['test/.mocharc', 'mocharc'],
    [`test/${String.fromCharCode(0xe9, 0xe8)}.js`, 'failure'],
  ])('names %j after %j', (reproduction, stem) => {
    expect(artifactStem(reproduction)).toBe(stem);
  });

  it('falls back to failure when there is no usable stem', () => {
    expect(artifactStem(undefined)).toBe('failure');
    expect(artifactStem('...')).toBe('failure');
    expect(artifactStem('test/-.js')).toBe('failure');
  });

  it('bounds the length of the stem', () => {
    expect(artifactStem(`${'a'.repeat(200)}.js`)).toHaveLength(64);
  });

  it('adds a numeric suffix when the default name exists and refuses after -99', () => {
    const taken = new Set<string>();
    const exists = (candidate: string): boolean => taken.has(candidate.replaceAll('\\', '/'));
    taken.add('work/reproduction.proofissue.yaml');

    expect(
      defaultArtifactPath({ cwd: 'work', exists, reproduction_paths: ['a/reproduction.js'] }),
    ).toEqual({
      status: 'chosen',
      path: 'reproduction-2.proofissue.yaml',
    });

    for (let suffix = 2; suffix <= MAX_DEFAULT_ARTIFACT_SUFFIX; suffix += 1) {
      taken.add(`work/reproduction-${String(suffix)}.proofissue.yaml`);
    }
    expect(
      defaultArtifactPath({ cwd: 'work', exists, reproduction_paths: ['a/reproduction.js'] }),
    ).toEqual({
      status: 'exhausted',
      first_candidate: 'reproduction.proofissue.yaml',
      last_candidate: 'reproduction-99.proofissue.yaml',
    });
  });

  it('never returns a path outside the current directory', () => {
    const chosen = defaultArtifactPath({
      cwd: 'work',
      exists: nothingExists,
      reproduction_paths: ['../../escape/../x.js'],
    });

    expect(chosen).toEqual({ status: 'chosen', path: 'x.proofissue.yaml' });
  });
});
