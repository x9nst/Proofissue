import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseRecordArguments } from '@proofissue/cli';
import { describe, expect, it } from 'vitest';

import { parseManifest, type TrialCase } from './manifest.js';
import {
  BASELINE_COMMAND,
  BASELINE_STDOUT,
  buildBaselineRecordArguments,
  buildRecordArguments,
  expectationArguments,
} from './record-arguments.js';

const context = {
  projectDirectory: '/mnt/ci/work/X1/repo',
  outputPath: '/mnt/ci/results/X1/X1.proofissue',
  image: `node@sha256:${'c'.repeat(64)}`,
};

const sampleCase: TrialCase = {
  id: 'X1',
  sets: ['unit'],
  title: 'Sample',
  repository: 'https://github.com/example-owner/example-repository.git',
  links: [],
  pre_fix_commit: 'a'.repeat(40),
  fix_commit: 'b'.repeat(40),
  dependencies: true,
  reproduction_files: ['test/one.test.js', 'test/fixture.json'],
  subject_files: ['lib/a.js', 'lib/b.js'],
  command: ['node', '--test', '--test-name-pattern=a name', 'test/one.test.js'],
  expected_exit_code: 1,
  expectations: [
    { stream: 'stdout', mode: 'contains', value: 'first literal' },
    { stream: 'stderr', mode: 'contains_normalized', value: 'second literal' },
    { stream: 'stdout', mode: 'exact_normalized' },
  ],
};

describe('buildRecordArguments', () => {
  it('builds the argument list in the documented order, with --yes and -- node', () => {
    expect(buildRecordArguments(sampleCase, context)).toEqual([
      'record',
      '--project',
      context.projectDirectory,
      '--output',
      context.outputPath,
      '--image',
      context.image,
      '--dependencies',
      '--reproduction',
      'test/one.test.js',
      '--reproduction',
      'test/fixture.json',
      '--subject',
      'lib/a.js',
      '--subject',
      'lib/b.js',
      '--expect-stdout',
      'first literal',
      '--expect-stderr-normalized',
      'second literal',
      '--expect-stdout-exact-normalized',
      '--yes',
      '--json',
      '--',
      'node',
      '--test',
      '--test-name-pattern=a name',
      'test/one.test.js',
    ]);
  });

  it('omits --dependencies when the case records none', () => {
    expect(buildRecordArguments({ ...sampleCase, dependencies: false }, context)).not.toContain(
      '--dependencies',
    );
  });

  it('maps each expectation mode to its CLI flag', () => {
    const modes = (stream: 'stderr' | 'stdout'): readonly string[] =>
      expectationArguments([
        { stream, mode: 'contains', value: 'v1' },
        { stream, mode: 'contains_normalized', value: 'v2' },
        { stream, mode: 'exact' },
      ]);

    expect(modes('stdout')).toEqual([
      '--expect-stdout',
      'v1',
      '--expect-stdout-normalized',
      'v2',
      '--expect-stdout-exact',
    ]);
    expect(modes('stderr')).toEqual([
      '--expect-stderr',
      'v1',
      '--expect-stderr-normalized',
      'v2',
      '--expect-stderr-exact',
    ]);
    expect(expectationArguments([{ stream: 'stderr', mode: 'exact_normalized' }])).toEqual([
      '--expect-stderr-exact-normalized',
    ]);
  });

  it('is accepted by the CLI argument parser', () => {
    const parsed = parseRecordArguments(buildRecordArguments(sampleCase, context).slice(1));

    expect(parsed.noninteractive_confirmation).toBe(true);
    expect(parsed.request).toMatchObject({
      arguments: sampleCase.command.slice(1),
      environment_image: context.image,
      include_dependencies: true,
      output_path: context.outputPath,
      program: 'node',
      project_root: context.projectDirectory,
      reproduction_paths: sampleCase.reproduction_files,
      subject_paths: sampleCase.subject_files,
    });
    expect(parsed.request.expect_stdout).toEqual([
      'first literal',
      { mode: 'exact', normalized: true },
    ]);
    expect(parsed.request.expect_stderr).toEqual([
      { mode: 'contains', normalized: true, value: 'second literal' },
    ]);
  });

  it('is accepted by the CLI argument parser for every committed case', () => {
    const manifest = parseManifest(
      readFileSync(fileURLToPath(new URL('../cases.json', import.meta.url)), 'utf8'),
    );
    if (!manifest.ok) throw new Error('The committed manifest is invalid.');

    for (const item of manifest.manifest.cases) {
      const parsed = parseRecordArguments(
        buildRecordArguments(item, { ...context, image: manifest.manifest.image }).slice(1),
      );
      expect(parsed.request.arguments).toEqual(item.command.slice(1));
      expect(parsed.request.include_dependencies).toBe(true);
    }
  });
});

describe('buildBaselineRecordArguments', () => {
  it('records the same files and dependencies with a command that only prints one literal', () => {
    const baseline = buildBaselineRecordArguments(sampleCase, context);
    const parsed = parseRecordArguments(baseline.slice(1));

    expect(parsed.request).toMatchObject({
      arguments: BASELINE_COMMAND.slice(1),
      include_dependencies: true,
      reproduction_paths: sampleCase.reproduction_files,
      subject_paths: sampleCase.subject_files,
    });
    expect(parsed.request.expect_stdout).toEqual([BASELINE_STDOUT]);
    expect(parsed.request.expect_stderr).toEqual([]);
    expect(baseline.slice(baseline.indexOf('--') + 1)).toEqual(BASELINE_COMMAND);
  });

  it('does not carry the case expectations or command', () => {
    const baseline = buildBaselineRecordArguments(sampleCase, context);

    expect(baseline).not.toContain('first literal');
    expect(baseline).not.toContain('--test');
  });
});
