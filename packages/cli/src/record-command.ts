import { lstatSync } from 'node:fs';
import process from 'node:process';

import {
  APPROVED_REPLAY_IMAGE,
  createRecordApplicationService,
  defaultArtifactPath,
  REPLAY_NODE_MAJOR,
  type OutputNormalizationRule,
  type RecordApplicationRequest,
  type RecordConfirmation,
  type RecordOutputExpectation,
  type RecordPreview,
  type RecordPreviewExpectation,
} from '@proofissue/application';

import { createLineSelector } from './guided-record.js';
import type { CliIo, CliRunResult } from './io.js';
import { escapePresentationText, quoteExpectation } from './presentation.js';
import { usageError } from './usage.js';

export const RECORD_HELP = `Usage:
  proofissue record --reproduction <path> --subject <path>
    [--project <directory>] [--output <file>]
    [--image <repository@sha256:digest>]
    [--expect-stdout <literal>] [--expect-stderr <literal>]
    [--expect-stdout-normalized <text>] [--expect-stderr-normalized <text>]
    [--expect-stdout-regex <pattern>] [--expect-stderr-regex <pattern>]
    [--expect-stdout-exact] [--expect-stderr-exact]
    [--expect-stdout-exact-normalized] [--expect-stderr-exact-normalized]
    [--dependencies] [--yes] [--json] -- node <arguments...>

Defaults:
  --project  The current directory.
  --output   <name of the first --reproduction file>.proofissue.yaml in the current directory,
             or -2 to -99 before the extension when that name is taken. A name you give is
             used exactly as written; .proofissue and .proofissue.yaml are both valid. GitHub
             issues accept the .yaml name as an attachment.
  --image    The approved replay image (Node.js 24). Replay refuses any other image.

File roles:
  --reproduction  A test, fixture, or input kept exactly as recorded during fix checks.
  --subject       Implementation code that may be replaced from the current checkout.
  Paths are relative to the project. A leading ./ is removed, and on Windows backslashes are
  converted to forward slashes. The command after -- must not contain the project or home
  directory, or, on Windows, a backslash path to a project file: write test/a.mjs instead.

Expected output (the value options may be repeated):
  Without any of these options, in a terminal and without --yes or --json, the command runs
  once and you choose the expected lines from a numbered listing of what it printed; pressing
  Enter takes the suggested line. Under --yes, with --json, or without a terminal, give at
  least one:
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

At least one path in each role is required, and one expected output, given or chosen.
--dependencies also records package.json and package-lock.json from the project root so the
locked npm packages can be installed later. The lockfile must use lockfile version 3 and the
public npm registry. Before replaying such an artifact, run proofissue prepare to download and
verify the locked packages.
The command runs directly as Node.js arguments; shell syntax is not interpreted.
Use --yes only for explicit noninteractive approval after reviewing these selections.
--json (which needs --yes) prints one result line on stdout and the preview on stderr.
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

const renderImageSection = (preview: RecordPreview): readonly string[] => [
  preview.replay_image === APPROVED_REPLAY_IMAGE
    ? `Replay image: approved Node.js ${String(REPLAY_NODE_MAJOR)} image`
    : `Replay image: ${escapePresentationText(preview.replay_image)}`,
  ...(preview.replay_image === APPROVED_REPLAY_IMAGE
    ? []
    : ['  Warning: this is not the approved replay image, so replay will refuse this artifact.']),
  ...(preview.host_node_major === REPLAY_NODE_MAJOR
    ? []
    : [
        `  Warning: recorded with Node.js ${String(preview.host_node_major)}, but replay always uses Node.js ${String(REPLAY_NODE_MAJOR)}; the failure may not reproduce there.`,
      ]),
];

export const renderRecordPreview = (preview: RecordPreview): string => {
  const lines = [
    'ProofIssue recording preview',
    '',
    `Artifact file: ${escapePresentationText(preview.output_path)}`,
    ...renderImageSection(preview),
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
  readonly json: boolean;
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

/** What parsing needs from the machine: the current directory and what already exists there. */
export interface RecordEnvironment {
  readonly cwd: string;
  readonly exists: (candidate: string) => boolean;
  /** Which separators a path typed here may use. Defaults to this process's platform. */
  readonly platform?: 'posix' | 'win32';
}

/**
 * Spells a selected file the way the artifact stores it: with forward slashes and without a
 * leading `./`. Backslashes are separators only on Windows; on other systems they are part of a
 * name, so the path is left for the recorder to refuse. Nothing else is rewritten, so a path
 * that is not portable still fails with its own message.
 */
export const toPortableProjectPath = (value: string, platform: 'posix' | 'win32'): string => {
  let result = platform === 'win32' ? value.replaceAll('\\', '/') : value;
  while (result.startsWith('./')) result = result.slice(2);
  return result;
};

const nodeRecordEnvironment = (): RecordEnvironment => ({
  cwd: process.cwd(),
  exists: (candidate) => {
    try {
      lstatSync(candidate);
      return true;
    } catch {
      return false;
    }
  },
});

const chooseOutputPath = (
  reproductionPaths: readonly string[],
  environment: RecordEnvironment,
): string => {
  const chosen = defaultArtifactPath({
    cwd: environment.cwd,
    exists: environment.exists,
    reproduction_paths: reproductionPaths,
  });
  if (chosen.status === 'chosen') return chosen.path;
  throw new Error(
    `Every default artifact name from ${chosen.first_candidate} to ${chosen.last_candidate} is taken; pass --output <file>.`,
  );
};

export const parseRecordArguments = (
  arguments_: readonly string[],
  environment: RecordEnvironment = nodeRecordEnvironment(),
): ParsedRecordCommand => {
  const platform = environment.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  let projectRoot: string | undefined;
  let outputPath: string | undefined;
  let image: string | undefined;
  let noninteractive = false;
  let json = false;
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
    if (argument === '--json') {
      json = true;
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
        reproductionPaths.push(toPortableProjectPath(value, platform));
        break;
      case '--subject':
        subjectPaths.push(toPortableProjectPath(value, platform));
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

  if (command?.[0] !== 'node' || command.length < 2) {
    throw new Error('The command after -- must start with node and include at least one argument.');
  }
  return {
    json,
    noninteractive_confirmation: noninteractive,
    request: {
      arguments: command.slice(1),
      environment_image: image ?? APPROVED_REPLAY_IMAGE,
      expect_stderr: expectStderr,
      expect_stdout: expectStdout,
      ...(includeDependencies ? { include_dependencies: true } : {}),
      output_path: outputPath ?? chooseOutputPath(reproductionPaths, environment),
      program: 'node',
      project_root: projectRoot ?? '.',
      reproduction_paths: reproductionPaths,
      subject_paths: subjectPaths,
    },
  };
};

/** Where a prepared dependency store goes in the suggested commands. */
const SUGGESTED_DEPENDENCY_STORE = '.proofissue-store';

/**
 * Quotes a path for the suggested commands. Plain paths stay plain; others are double-quoted,
 * or single-quoted when they hold a character a shell would still interpret inside double
 * quotes. The text is escaped first, so a control character never reaches the terminal.
 */
export const quotePathForCommand = (value: string): string => {
  const escaped = escapePresentationText(value);
  if (/^[A-Za-z0-9_./:@%+=\\-]+$/u.test(escaped)) return escaped;
  if (!/["$`!]/u.test(escaped)) return `"${escaped}"`;
  return `'${escaped.replaceAll("'", "'\\''")}'`;
};

export interface RecordSuccess {
  /** Whether the artifact records package.json and package-lock.json. */
  readonly has_dependencies: boolean;
  /** The artifact's SHA-256, as the result reports it. */
  readonly digest: string;
  /** The path as the reporter gave it or the default chose it. */
  readonly output_path: string;
}

/**
 * What to do with a new artifact: where it is, how to attach it to a GitHub issue, and the
 * exact commands to replay it. The first line stays `Artifact created.`.
 */
export const renderRecordSuccess = (success: RecordSuccess): string => {
  const file = quotePathForCommand(success.output_path);
  const attachable = /\.ya?ml$/iu.test(success.output_path);
  const store = SUGGESTED_DEPENDENCY_STORE;
  const replay = success.has_dependencies
    ? [
        `  proofissue prepare ${file} --dependency-store ${store}`,
        `  proofissue replay ${file} --dependency-store ${store}`,
      ]
    : [`  proofissue replay ${file}`];
  const check = success.has_dependencies
    ? [
        `  proofissue prepare ${file} --dependency-store ${store}`,
        `  proofissue replay ${file} --dependency-store ${store} --require-status reproduced`,
      ]
    : [`  proofissue replay ${file} --require-status reproduced`];
  return [
    'Artifact created.',
    `Saved: ${escapePresentationText(success.output_path)} (sha256 ${success.digest.slice(0, 12)})`,
    attachable
      ? 'To share it, drag the file into a GitHub issue comment: GitHub accepts the .yaml extension.'
      : 'GitHub does not accept the .proofissue extension as an attachment. Copy the file to a name ending in .yaml before attaching it; the contents are the same.',
    'A maintainer replays it on x86-64 Linux with Docker:',
    ...replay,
    'On x86-64 Linux with Docker you can check it yourself first:',
    ...check,
    '',
  ].join('\n');
};

/** Every error, one per line, each starting with the same prefix. */
export const renderRecordFailure = (errors: readonly { readonly message: string }[]): string =>
  (errors.length === 0 ? [{ message: 'unknown error' }] : errors)
    .map((error) => `Recording failed: ${escapePresentationText(error.message)}\n`)
    .join('');

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
  if (parsed.json && !parsed.noninteractive_confirmation) {
    io.write(
      usageError(
        'record',
        '--json needs --yes: a prompt cannot be answered while the result is machine-readable.',
      ),
    );
    return { exit_code: 2 };
  }

  let hasDependencies = false;
  const confirm = async (preview: RecordPreview): Promise<RecordConfirmation> => {
    hasDependencies = preview.dependencies !== undefined;
    // Under --json the single result line owns stdout, so the preview goes to stderr.
    (parsed.json ? io.writeError : io.write)?.(renderRecordPreview(preview));
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

  // Guided selection needs a person at a terminal and no request for machine-readable or
  // unattended behavior. Under --yes, --json, or without a terminal nothing is ever suggested
  // or applied: the recorder then asks for an expectation option.
  const ask = io.ask;
  const select =
    parsed.request.expect_stdout.length + parsed.request.expect_stderr.length === 0 &&
    !parsed.noninteractive_confirmation &&
    !parsed.json &&
    io.interactive === true &&
    ask !== undefined
      ? createLineSelector({ ask, confirm: io.confirm, write: io.write })
      : undefined;
  if (select !== undefined) {
    io.write(
      'No expected output was given, so the command will run now (no shell) and you can choose the expected lines from what it prints.\n',
    );
  }

  const result = await createRecordApplicationService(
    confirm,
    undefined,
    undefined,
    select === undefined ? {} : { select_expectations: select },
  ).record(parsed.request);
  if (parsed.json) io.write(`${JSON.stringify(result)}\n`);
  else if (result.status === 'created')
    io.write(
      renderRecordSuccess({
        digest: result.artifact_digest ?? '',
        has_dependencies: hasDependencies,
        output_path: parsed.request.output_path,
      }),
    );
  else if (result.status === 'cancelled')
    io.write('Recording cancelled; no artifact was written.\n');
  else io.write(renderRecordFailure(result.errors));
  return {
    exit_code: result.status === 'created' || result.status === 'cancelled' ? 0 : 1,
    result,
  };
};
