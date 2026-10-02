import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  explainRecordCommand,
  planSuggestedFiles,
  probeRecordDependencies,
  suggestRecordFiles,
  type FileSuggestions,
} from './index.js';

const suggestions: FileSuggestions = {
  files: [
    { path: 'test/a.mjs', reason: 'named in the command', role: 'reproduction' },
    { path: 'package.json', reason: 'sets "type"', role: 'reproduction' },
    { path: 'src/a.mjs', reason: 'imported by test/a.mjs', role: 'subject' },
    { path: 'src/b.mjs', reason: 'imported by src/a.mjs', role: 'subject' },
  ],
  limits_reached: [],
  manifest_sets_type: true,
  uncollected_config_files: [],
  warnings: [],
};

describe('planSuggestedFiles', () => {
  it('fills both roles when the request names neither', () => {
    const plan = planSuggestedFiles({ reproduction_paths: [], subject_paths: [] }, suggestions);
    expect(plan.missing).toEqual({ reproduction: true, subject: true });
    expect(plan.reproduction.map((file) => file.path)).toEqual(['test/a.mjs', 'package.json']);
    expect(plan.subject.map((file) => file.path)).toEqual(['src/a.mjs', 'src/b.mjs']);
  });

  it('keeps a role given on the command line unchanged and fills only the other', () => {
    const plan = planSuggestedFiles(
      { reproduction_paths: ['test/other.mjs'], subject_paths: [] },
      suggestions,
    );
    expect(plan.missing).toEqual({ reproduction: false, subject: true });
    expect(plan.reproduction).toEqual([]);
    expect(plan.subject.map((file) => file.path)).toEqual(['src/a.mjs', 'src/b.mjs']);

    const given = planSuggestedFiles(
      { reproduction_paths: ['test/a.mjs'], subject_paths: ['src/a.mjs'] },
      suggestions,
    );
    expect(given.reproduction).toEqual([]);
    expect(given.subject).toEqual([]);
  });

  it('never suggests a file the request already names, in either role', () => {
    const plan = planSuggestedFiles(
      { reproduction_paths: [], subject_paths: ['SRC/A.mjs'] },
      suggestions,
    );
    expect(plan.reproduction.map((file) => file.path)).toEqual(['test/a.mjs', 'package.json']);
    expect(plan.subject).toEqual([]);
  });
});

describe('suggestions never throw', () => {
  const missing = path.join(tmpdir(), 'proofissue-suggestions-none');

  it('returns no suggestions for a project that cannot be scanned', async () => {
    expect(await suggestRecordFiles({ arguments: ['a.mjs'], project_root: missing })).toMatchObject(
      {
        files: [],
        warnings: [],
      },
    );
    expect(await probeRecordDependencies(missing)).toEqual({ status: 'absent' });
    expect(await explainRecordCommand(['mocha'], missing)).toBeUndefined();
  });

  it('suggests the files of the example', async () => {
    const result = await suggestRecordFiles({
      arguments: ['test/reproduction.mjs'],
      project_root: 'examples/failing-node-test',
    });
    expect(result.files.map((file) => `${file.role}:${file.path}`)).toEqual([
      'reproduction:test/reproduction.mjs',
      'subject:src/calculate.mjs',
    ]);
  });
});
