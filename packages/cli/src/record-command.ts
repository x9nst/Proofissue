import {
  createRecordApplicationService,
  type OutputNormalizationRule,
  type RecordApplicationRequest,
  type RecordConfirmation,
  type RecordOutputExpectation,
  type RecordPreview,
  type RecordPreviewExpectation,
} from '@proofissue/application';

import type { CliIo, CliRunResult } from './io.js';
import { escapePresentationText, quoteExpectation } from './presentation.js';
import { usageError } from './usage.js';

export const RECORD_HELP = `Usage:
  proofissue record --project <directory> --output <file.proofissue>
    --image <repository@sha256:digest>
    --reproduction <path> --subject <path>
    [--expect-stdout <literal>] [--expect-stderr <literal>]
    [--expect-stdout-normalized <text>] [--expect-stderr-normalized <text>]
    [--expect-stdout-regex <pattern>] [--expect-stderr-regex <pattern>]
    [--expect-stdout-exact] [--expect-stderr-exact]
    [--expect-stdout-exact-normalized] [--expect-stderr-exact-normalized]
    [--dependencies] [--yes] -- node <arguments...>

File roles:
  --reproduction  A test, fixture, or input kept exactly as recorded during fix checks.
  --subject       Implementation code that may be replaced from the current checkout.

Expected output (give at least one; the value options may be repeated):
  --expect-stdout, --expect-stderr
      Text that must appear, byte for byte, in the stream.
  --expect-stdout-normalized, --expect-stderr-normalized
      Text as it was printed here. Replay compares after ignoring line endings, terminal
      escape sequences, trailing whitespace, the project and temporary directories,
      durations, process IDs, the Node.js version, and Node.js internal line numbers.
  --expect-stdout-regex, --expect-stderr-regex
      A pattern that must match somewhere in the stream after the same normalization.
      The pattern language is a bounded subset of JavaScript regular expressions (no
      lookaround or backreferences, at most 1024 characters, no case-insensitive or
      Unicode-property forms) that always runs in linear time; a pattern that cannot match
      without consuming output, such as a*, is refused. It is checked before the command runs.
      Write a pattern against normalized output, for example "took <duration>" and
      "<project>/test/a\\.mjs:\\d+:\\d+".
  --expect-stdout-exact, --expect-stderr-exact
      The whole stream must match exactly. Take no value, at most once per stream.
  --expect-stdout-exact-normalized, --expect-stderr-exact-normalized
      The whole stream must match exactly after the same normalization. Take no value;
      an exact option of either kind is allowed at most once per stream.

At least one path in each role and one expected output are required.
--dependencies also records package.json and package-lock.json from the project root so the
locked npm packages can be installed later. The lockfile must use lockfile version 3 and the
public npm registry. Before replaying such an artifact, run proofissue prepare to download and
verify the locked packages.
The command runs directly as Node.js arguments; shell syntax is not interpreted.
Use --yes only for explicit noninteractive approval after reviewing these selections.
`;

const quoteArgument = (value: string): string => JSON.stringify(value);

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const renderDependencySection = (preview: RecordPreview): readonly string[] => {
  const dependencies = preview.dependencies;
  if (dependencies === undefined) return [];
  return [
    'Dependency files (recorded exactly as they are and never replaced during a fix check):',
    ...dependencies.files.map((file) => `  ${file}`),
    `  ${plural(dependencies.package_count, 'package')} from the public npm registry, each pinned by an integrity hash.`,
    ...(dependencies.install_script_packages > 0
      ? [
          `  ${plural(dependencies.install_script_packages, 'package')} ${dependencies.install_script_packages === 1 ? 'declares' : 'declare'} install scripts, which are never run.`,
        ]
      : []),
    '  Run proofissue prepare before replay to download and verify these packages.',
    '',
  ];
};

// Wording for the preview: what each rule treats as noise, in canonical order.
const RULE_PREVIEW_LABELS: Readonly<Record<OutputNormalizationRule, string>> = {
  line_endings: 'line endings',
  ansi_escapes: 'terminal escape sequences',
  trailing_whitespace: 'trailing whitespace',
  paths: 'paths (<project>, <tmp>)',
  node_version: 'Node.js version',
  node_internal_locations: 'Node.js internal locations',
  process_ids: 'process IDs',
  durations: 'durations',
};

const describeExpectation = (
  stream: 'stderr' | 'stdout',
  item: RecordPreviewExpectation,
): string => {
  const normalized = item.normalize.length > 0;
  const value = quoteExpectation(item.value);
  if (item.mode === 'exact') {
    return `  ${stream} ${normalized ? 'after normalization is' : 'is'} exactly: ${value}`;
  }
  if (item.mode === 'regex') {
    return `  ${stream} matches pattern${normalized ? ' after normalization' : ''}: ${value}`;
  }
  return `  ${stream} contains${normalized ? ' after normalization' : ''}: ${value}`;
};

const describeNormalizations = (preview: RecordPreview): readonly string[] => {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of [...preview.expectations.stdout, ...preview.expectations.stderr]) {
    if (item.normalize.length === 0) continue;
    const description = item.normalize.map((rule) => RULE_PREVIEW_LABELS[rule]).join(', ');
    if (seen.has(description)) continue;
    seen.add(description);
    lines.push(`  normalization: ${description}`);
  }
  return lines;
};

export const renderRecordPreview = (preview: RecordPreview): string => {
  const lines = [
    'ProofIssue recording preview',
    '',
    'Authorized command (no shell):',
    `  node ${preview.command.arguments.map(quoteArgument).join(' ')}`,
    '',
    'Files kept exactly as recorded during fix checks (reproduction):',
    ...preview.reproduction_files.map((file) => `  ${file}`),
    '  A test or fixture placed in the other group may be replaced during a fix check.',
    '',
    'Files that may be replaced from the current checkout (subject):',
    ...preview.subject_files.map((file) => `  ${file}`),
    '  Implementation code placed in the first group stays frozen and may hide a real fix.',
    '',
    ...renderDependencySection(preview),
    'Expected failure:',
    `  exit code: ${String(preview.expectations.exit_code)}`,
    ...preview.expectations.stdout.map((item) => describeExpectation('stdout', item)),
    ...preview.expectations.stderr.map((item) => describeExpectation('stderr', item)),
    ...describeNormalizations(preview),
    '',
    'Limits:',
    `  timeout: ${String(preview.limits.timeout_seconds)} seconds`,
    `  output retained per stream: ${String(preview.limits.output_bytes_per_stream)} bytes`,
    `  stdout truncated: ${String(preview.output.stdout.truncated)}`,
    `  stderr truncated: ${String(preview.output.stderr.truncated)}`,
    '',
    `Redaction findings: ${String(preview.redaction.finding_count)}`,
    ...preview.redaction.findings.map(
      (finding) =>
        `  ${finding.target}: ${finding.category} × ${String(finding.count)} -> ${finding.replacement}`,
    ),
    '  Removed values are never shown. Redaction reduces risk but does not replace review.',
    '',
  ];
  return `${lines.join('\n')}\n`;
};

export interface ParsedRecordCommand {
  readonly noninteractive_confirmation: boolean;
  readonly request: RecordApplicationRequest;
}

const takeValue = (arguments_: readonly string[], index: number, option: string): string => {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return value;
};

// Flags that take no value: the whole stream is the expectation.
const EXACT_OPTIONS: ReadonlyMap<
  string,
  { readonly normalized: boolean; readonly stream: 'stderr' | 'stdout' }
> = new Map([
  ['--expect-stdout-exact', { normalized: false, stream: 'stdout' }],
  ['--expect-stderr-exact', { normalized: false, stream: 'stderr' }],
  ['--expect-stdout-exact-normalized', { normalized: true, stream: 'stdout' }],
  ['--expect-stderr-exact-normalized', { normalized: true, stream: 'stderr' }],
]);

const isExactExpectation = (item: RecordOutputExpectation): boolean =>
  typeof item !== 'string' && item.mode === 'exact';

export const parseRecordArguments = (arguments_: readonly string[]): ParsedRecordCommand => {
  let projectRoot: string | undefined;
  let outputPath: string | undefined;
  let image: string | undefined;
  let noninteractive = false;
  let includeDependencies = false;
  const reproductionPaths: string[] = [];
  const subjectPaths: string[] = [];
  const expectStdout: RecordOutputExpectation[] = [];
  const expectStderr: RecordOutputExpectation[] = [];
  let command: readonly string[] | undefined;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--') {
      command = arguments_.slice(index + 1);
      break;
    }
    if (argument === '--yes') {
      noninteractive = true;
      continue;
    }
    if (argument === '--dependencies') {
      includeDependencies = true;
      continue;
    }
    const exact = EXACT_OPTIONS.get(argument ?? '');
    if (exact !== undefined) {
      const target = exact.stream === 'stdout' ? expectStdout : expectStderr;
      if (target.some(isExactExpectation)) {
        throw new Error(
          `At most one exact expectation is allowed for ${exact.stream}; ${argument ?? ''} was repeated or combined with another exact option.`,
        );
      }
      target.push({ mode: 'exact', normalized: exact.normalized });
      continue;
    }
    if (argument === undefined) continue;
    if (!argument.startsWith('-')) {
      throw new Error(
        `Unexpected argument "${argument}": put the command after --, for example: -- node test/reproduction.mjs`,
      );
    }
    const value = takeValue(arguments_, index, argument);
    index += 1;
    switch (argument) {
      case '--project':
        projectRoot = value;
        break;
      case '--output':
        outputPath = value;
        break;
      case '--image':
        image = value;
        break;
      case '--reproduction':
        reproductionPaths.push(value);
        break;
      case '--subject':
        subjectPaths.push(value);
        break;
      case '--expect-stdout':
        expectStdout.push(value);
        break;
      case '--expect-stderr':
        expectStderr.push(value);
        break;
      case '--expect-stdout-normalized':
        expectStdout.push({ mode: 'contains', normalized: true, value });
        break;
      case '--expect-stderr-normalized':
        expectStderr.push({ mode: 'contains', normalized: true, value });
        break;
      case '--expect-stdout-regex':
        expectStdout.push({ mode: 'regex', normalized: true, pattern: value });
        break;
      case '--expect-stderr-regex':
        expectStderr.push({ mode: 'regex', normalized: true, pattern: value });
        break;
      default:
        throw new Error(`Unknown record option: ${argument}`);
    }
  }

  if (projectRoot === undefined || outputPath === undefined || image === undefined) {
    throw new Error('--project, --output, and --image are required.');
  }
  if (command?.[0] !== 'node' || command.length < 2) {
    throw new Error('The command after -- must start with node and include at least one argument.');
  }
  return {
    noninteractive_confirmation: noninteractive,
    request: {
      arguments: command.slice(1),
      environment_image: image,
      expect_stderr: expectStderr,
      expect_stdout: expectStdout,
      ...(includeDependencies ? { include_dependencies: true } : {}),
      output_path: outputPath,
      program: 'node',
      project_root: projectRoot,
      reproduction_paths: reproductionPaths,
      subject_paths: subjectPaths,
    },
  };
};

export const runRecordCommand = async (
  arguments_: readonly string[],
  io: CliIo,
): Promise<CliRunResult> => {
  let parsed: ParsedRecordCommand;
  try {
    parsed = parseRecordArguments(arguments_.slice(1));
  } catch (error: unknown) {
    io.write(
      usageError('record', error instanceof Error ? error.message : 'Invalid record command.'),
    );
    return { exit_code: 2 };
  }

  const confirm = async (preview: RecordPreview): Promise<RecordConfirmation> => {
    io.write(renderRecordPreview(preview));
    if (parsed.noninteractive_confirmation) {
      return {
        reproduction_files_confirmed: true,
        subject_files_confirmed: true,
        write_confirmed: true,
      };
    }
    const reproductionFilesConfirmed = await io.confirm(
      'Are the files kept exactly as recorded classified correctly?',
    );
    if (!reproductionFilesConfirmed) {
      return {
        reproduction_files_confirmed: false,
        subject_files_confirmed: false,
        write_confirmed: false,
      };
    }
    const subjectFilesConfirmed = await io.confirm(
      'Are the files replaceable from the current checkout classified correctly?',
    );
    const writeConfirmed =
      subjectFilesConfirmed && (await io.confirm('Create the new .proofissue artifact?'));
    return {
      reproduction_files_confirmed: reproductionFilesConfirmed,
      subject_files_confirmed: subjectFilesConfirmed,
      write_confirmed: writeConfirmed,
    };
  };

  const result = await createRecordApplicationService(confirm).record(parsed.request);
  if (result.status === 'created') io.write('Artifact created.\n');
  else if (result.status === 'cancelled')
    io.write('Recording cancelled; no artifact was written.\n');
  else
    io.write(
      `Recording failed: ${escapePresentationText(result.errors[0]?.message ?? 'unknown error')}\n`,
    );
  return {
    exit_code: result.status === 'created' || result.status === 'cancelled' ? 0 : 1,
    result,
  };
};
