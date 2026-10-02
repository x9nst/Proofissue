/**
 * Builds the `proofissue record` argument list for a trial case.
 *
 * The harness drives the CLI exactly as a maintainer would. These functions are pure: they only
 * put manifest values in the documented order, and the CLI itself validates them again.
 */
import type { TrialCase, TrialExpectation } from './manifest.js';

export interface RecordArgumentContext {
  /** The project checkout (PRE plus the overlaid reproduction files). */
  readonly projectDirectory: string;
  readonly outputPath: string;
  readonly image: string;
}

/** The literal the install-only baseline artifact prints, and expects. */
export const BASELINE_STDOUT = 'proofissue-install-baseline';

/** The baseline command: it loads nothing from the project, so its replay time is setup plus install. */
export const BASELINE_COMMAND: readonly string[] = [
  'node',
  '-e',
  `process.stdout.write('${BASELINE_STDOUT}')`,
];

const optionFor = (expectation: TrialExpectation): string => {
  switch (expectation.mode) {
    case 'contains':
      return `--expect-${expectation.stream}`;
    case 'contains_normalized':
      return `--expect-${expectation.stream}-normalized`;
    case 'exact':
      return `--expect-${expectation.stream}-exact`;
    case 'exact_normalized':
      return `--expect-${expectation.stream}-exact-normalized`;
  }
};

/** Maps each expectation mode to its CLI flag. The exact modes take no value. */
export const expectationArguments = (
  expectations: readonly TrialExpectation[],
): readonly string[] =>
  expectations.flatMap((expectation) =>
    expectation.value === undefined
      ? [optionFor(expectation)]
      : [optionFor(expectation), expectation.value],
  );

const buildArguments = (
  item: Pick<TrialCase, 'dependencies' | 'reproduction_files' | 'subject_files'>,
  context: RecordArgumentContext,
  expectations: readonly string[],
  command: readonly string[],
): readonly string[] => [
  'record',
  '--project',
  context.projectDirectory,
  '--output',
  context.outputPath,
  '--image',
  context.image,
  ...(item.dependencies ? ['--dependencies'] : []),
  ...item.reproduction_files.flatMap((file) => ['--reproduction', file]),
  ...item.subject_files.flatMap((file) => ['--subject', file]),
  ...expectations,
  '--yes',
  '--json',
  '--',
  ...command,
];

/** The argument list after the CLI path for recording the case's own reproduction. */
export const buildRecordArguments = (
  item: TrialCase,
  context: RecordArgumentContext,
): readonly string[] =>
  buildArguments(item, context, expectationArguments(item.expectations), item.command);

/**
 * The install-only baseline: the same files and dependencies, but a command that prints one
 * literal and exits 0. Its replay duration approximates setup plus the offline install.
 */
export const buildBaselineRecordArguments = (
  item: TrialCase,
  context: RecordArgumentContext,
): readonly string[] =>
  buildArguments(
    item,
    context,
    expectationArguments([{ stream: 'stdout', mode: 'contains', value: BASELINE_STDOUT }]),
    BASELINE_COMMAND,
  );
