import { createInterface } from 'node:readline/promises';
import process, { stdin, stdout } from 'node:process';

import {
  createPrepareApplicationService,
  createRecordApplicationService,
  createReplayApplicationService,
  createStaticArtifactApplicationServices,
  evaluateReplayPolicy,
  type ApplicationServices,
  type OperationResult,
  type OutputNormalizationRule,
  type PrepareOperationResult,
  type RecordApplicationRequest,
  type RecordConfirmation,
  type RecordOutputExpectation,
  type RecordPreview,
  type RecordPreviewExpectation,
} from '@proofissue/application';

import { PROOFISSUE_VERSION } from './version.js';

export interface CliAdapter {
  readonly application: ApplicationServices;
}

export const createCliAdapter = (application: ApplicationServices): CliAdapter =>
  Object.freeze({ application });

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

export const CLI_HELP = `Usage:
  proofissue record [options] -- node <arguments...>
  proofissue --version
  proofissue validate <artifact.proofissue> [--json]
  proofissue inspect <artifact.proofissue> [--json]
  proofissue prepare <artifact.proofissue> --dependency-store <directory> [--json]
  proofissue replay <artifact.proofissue> [--against <directory>]
    [--dependency-store <directory>]
    [--require-status reproduced|not_reproduced] [--json]

Replay validates before execution, accepts only the approved digest-pinned image,
uses a locked-down local Docker Engine on x86-64 Linux, and never pulls an image.
Without --against, replay uses every file embedded in the artifact. With --against,
only declared subject paths are replaced; undeclared additions, removals, and renames
are not evaluated.

prepare is the only ProofIssue step that makes network requests: it downloads exactly the
packages the artifact's lockfile names from the public npm registry, checks each against its
SHA-512 hash, and stores them in the given directory. It never runs the artifact or package
code. Replay never uses the network; pass the same --dependency-store to replay an artifact
with dependency files.

${RECORD_HELP}`;

export interface CliIo {
  readonly confirm: (question: string) => Promise<boolean>;
  readonly write: (text: string) => void;
}

const defaultIo = (): CliIo => ({
  write: (text) => stdout.write(text),
  confirm: async (question) => {
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await reader.question(`${question} [y/N] `);
      return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes';
    } finally {
      reader.close();
    }
  },
});

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

// The expected text is shown for review, so characters a terminal could use to hide or
// reorder text are escaped as well as control characters.
const isUnsafePresentationCode = (code: number): boolean =>
  code < 32 ||
  code === 127 ||
  (code >= 0x80 && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

const quoteExpectation = (value: string): string =>
  Array.from(JSON.stringify(value))
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return isUnsafePresentationCode(code)
        ? `\\u{${code.toString(16).padStart(4, '0')}}`
        : character;
    })
    .join('');

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

interface ParsedRecordCommand {
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

export interface CliRunResult {
  readonly exit_code: 0 | 1 | 2;
  readonly result?: OperationResult;
}

const escapePresentationText = (value: string): string =>
  Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (
        code < 32 ||
        code === 127 ||
        (code >= 0x80 && code <= 0x9f) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
      ) {
        return `\\u{${code.toString(16).padStart(4, '0')}}`;
      }
      return character;
    })
    .join('')
    .replaceAll('::', '\\:\\:');

const REPLAY_PREPARE_HINT =
  'Hint: run proofissue prepare <artifact> --dependency-store <directory>, then pass the same --dependency-store to replay.';

export const renderReplayResult = (
  result: Awaited<ReturnType<ApplicationServices['replay']>>,
): string => {
  const lines = [`Replay result: ${result.status}`, `Mode: ${result.mode}`];
  if (result.image_digest !== undefined) lines.push(`Approved image: ${result.image_digest}`);
  if (result.execution !== undefined) {
    lines.push(`Termination: ${result.execution.termination_reason}`);
    if (result.execution.exit_code !== undefined)
      lines.push(`Exit code: ${String(result.execution.exit_code)}`);
    lines.push(
      `Output retained: stdout ${String(result.execution.stdout.retained_bytes)} bytes, stderr ${String(result.execution.stderr.retained_bytes)} bytes`,
    );
  }
  for (const item of result.evidence)
    lines.push(`Matched: ${escapePresentationText(item.message)}`);
  for (const item of result.differences)
    lines.push(`Different: ${escapePresentationText(item.message)}`);
  for (const item of result.warnings)
    lines.push(`Warning: ${escapePresentationText(item.message)}`);
  for (const item of result.errors) lines.push(`Error: ${escapePresentationText(item.message)}`);
  for (const substitutedPath of result.substituted_paths)
    lines.push(`Substituted subject: ${escapePresentationText(substitutedPath)}`);
  for (const limitation of result.scope_limitations)
    lines.push(`Scope: ${escapePresentationText(limitation.message)}`);
  if (result.cleanup !== undefined)
    lines.push(`Cleanup complete: ${String(result.cleanup.completed)}`);
  return `${lines.join('\n')}\n`;
};

export interface ParsedPrepareCommand {
  readonly artifact_path: string;
  readonly dependency_store: string;
  readonly json: boolean;
}

const takeStoreValue = (arguments_: readonly string[], index: number): string => {
  const value = arguments_[index + 1];
  if (value === undefined || value.startsWith('--'))
    throw new Error('--dependency-store requires a directory.');
  return value;
};

export const parsePrepareArguments = (arguments_: readonly string[]): ParsedPrepareCommand => {
  const artifactPath = arguments_[0];
  if (artifactPath === undefined || artifactPath.startsWith('--'))
    throw new Error('An artifact path is required.');
  let json = false;
  let store: string | undefined;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
    } else if (argument === '--dependency-store') {
      store = takeStoreValue(arguments_, index);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument ?? ''}`);
    }
  }
  if (store === undefined) throw new Error('--dependency-store is required.');
  return { artifact_path: artifactPath, dependency_store: store, json };
};

export const renderPrepareResult = (result: PrepareOperationResult): string => {
  const lines = [`Preparation result: ${result.status}`];
  if (result.status === 'not_required') {
    lines.push('The artifact has no dependency files; replay needs no prepared store.');
  }
  const preparation = result.preparation;
  if (preparation !== undefined) {
    lines.push(
      `Packages for the replay platform: ${String(preparation.packages)}`,
      `Tarballs downloaded: ${String(preparation.downloaded_tarballs)} (${String(preparation.downloaded_bytes)} bytes)`,
      `Tarballs already in the store: ${String(preparation.reused_tarballs)}`,
      `Skipped for another platform: ${String(preparation.skipped_for_platform)}`,
    );
  }
  for (const item of result.warnings)
    lines.push(`Warning: ${escapePresentationText(item.message)}`);
  for (const item of result.errors) {
    const location = item.details?.['package_path'];
    lines.push(
      `Error: ${escapePresentationText(item.message)}${
        typeof location === 'string' ? ` (${escapePresentationText(location)})` : ''
      }`,
    );
  }
  if (result.status === 'prepared') lines.push('Replay offline with the same --dependency-store.');
  return `${lines.join('\n')}\n`;
};

interface ParsedArtifactCommand {
  readonly against_path?: string;
  readonly artifact_path: string;
  readonly dependency_store?: string;
  readonly json: boolean;
  readonly required_status?: 'not_reproduced' | 'reproduced';
}

const parseArtifactCommand = (
  arguments_: readonly string[],
  allowRequiredStatus: boolean,
): ParsedArtifactCommand => {
  const artifactPath = arguments_[0];
  if (artifactPath === undefined || artifactPath.startsWith('--'))
    throw new Error('An artifact path is required.');
  let json = false;
  let againstPath: string | undefined;
  let dependencyStore: string | undefined;
  let requiredStatus: ParsedArtifactCommand['required_status'];
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--json') {
      json = true;
      continue;
    }
    if (argument === '--require-status' && allowRequiredStatus) {
      const value = arguments_[index + 1];
      if (value !== 'reproduced' && value !== 'not_reproduced')
        throw new Error('--require-status must be reproduced or not_reproduced.');
      requiredStatus = value;
      index += 1;
      continue;
    }
    if (argument === '--against' && allowRequiredStatus) {
      const value = arguments_[index + 1];
      if (value === undefined || value.startsWith('--'))
        throw new Error('--against requires a checkout directory.');
      againstPath = value;
      index += 1;
      continue;
    }
    if (argument === '--dependency-store' && allowRequiredStatus) {
      dependencyStore = takeStoreValue(arguments_, index);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument ?? ''}`);
  }
  return {
    artifact_path: artifactPath,
    json,
    ...(dependencyStore === undefined ? {} : { dependency_store: dependencyStore }),
    ...(againstPath === undefined ? {} : { against_path: againstPath }),
    ...(requiredStatus === undefined ? {} : { required_status: requiredStatus }),
  };
};

export const runCli = async (
  arguments_: readonly string[],
  io: CliIo = defaultIo(),
  application?: Partial<ApplicationServices>,
): Promise<CliRunResult> => {
  if (arguments_.length === 0 || arguments_[0] === '--help' || arguments_[0] === '-h') {
    io.write(CLI_HELP);
    return { exit_code: 0 };
  }

  if (arguments_[0] === '--version' && arguments_.length === 1) {
    io.write(`${PROOFISSUE_VERSION}\n`);
    return { exit_code: 0 };
  }

  if (arguments_[0] === 'validate' || arguments_[0] === 'inspect') {
    let parsed: ParsedArtifactCommand;
    try {
      parsed = parseArtifactCommand(arguments_.slice(1), false);
    } catch (error: unknown) {
      io.write(
        `${escapePresentationText(error instanceof Error ? error.message : 'Invalid command.')}\n\n${CLI_HELP}`,
      );
      return { exit_code: 2 };
    }
    const staticServices = createStaticArtifactApplicationServices();
    const result =
      arguments_[0] === 'validate'
        ? await (application?.validate ?? staticServices.validate)({
            artifact_path: parsed.artifact_path,
          })
        : await (application?.inspect ?? staticServices.inspect)({
            artifact_path: parsed.artifact_path,
          });
    io.write(
      parsed.json
        ? `${JSON.stringify(result)}\n`
        : `${result.status}\n${result.errors.map((error) => `Error: ${escapePresentationText(error.message)}\n`).join('')}`,
    );
    return {
      exit_code: result.status === 'valid' || result.status === 'inspected' ? 0 : 1,
      result,
    };
  }

  if (arguments_[0] === 'prepare') {
    let parsed: ParsedPrepareCommand;
    try {
      parsed = parsePrepareArguments(arguments_.slice(1));
    } catch (error: unknown) {
      io.write(
        `${escapePresentationText(error instanceof Error ? error.message : 'Invalid prepare command.')}\n\n${CLI_HELP}`,
      );
      return { exit_code: 2 };
    }
    const prepare = application?.prepare ?? createPrepareApplicationService().prepare;
    const controller = new AbortController();
    const interrupt = (): void => {
      controller.abort();
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    let result: PrepareOperationResult;
    try {
      result = await prepare({
        artifact_path: parsed.artifact_path,
        dependency_store: parsed.dependency_store,
        signal: controller.signal,
      });
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
    io.write(parsed.json ? `${JSON.stringify(result)}\n` : renderPrepareResult(result));
    return {
      exit_code: result.status === 'prepared' || result.status === 'not_required' ? 0 : 1,
      result,
    };
  }

  if (arguments_[0] === 'replay') {
    let parsed: ParsedArtifactCommand;
    try {
      parsed = parseArtifactCommand(arguments_.slice(1), true);
    } catch (error: unknown) {
      io.write(
        `${escapePresentationText(error instanceof Error ? error.message : 'Invalid replay command.')}\n\n${CLI_HELP}`,
      );
      return { exit_code: 2 };
    }
    const replay = application?.replay ?? createReplayApplicationService().replay;
    const controller = new AbortController();
    const interrupt = (): void => {
      controller.abort();
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    let result: Awaited<ReturnType<ApplicationServices['replay']>>;
    try {
      result = await replay({
        ...(parsed.against_path === undefined ? {} : { against_path: parsed.against_path }),
        artifact_path: parsed.artifact_path,
        ...(parsed.dependency_store === undefined
          ? {}
          : { dependency_store: parsed.dependency_store }),
        mode: parsed.against_path === undefined ? 'snapshot' : 'current_checkout',
        signal: controller.signal,
      });
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
    io.write(
      parsed.json
        ? `${JSON.stringify(result)}\n`
        : `${renderReplayResult(result)}${
            result.errors.some((error) => error.code === 'dependencies_not_prepared')
              ? `${REPLAY_PREPARE_HINT}\n`
              : ''
          }`,
    );
    return {
      exit_code: evaluateReplayPolicy(result, parsed.required_status).success ? 0 : 1,
      result,
    };
  }

  if (arguments_[0] !== 'record') {
    io.write(`Unknown command: ${escapePresentationText(arguments_[0] ?? '')}\n\n${CLI_HELP}`);
    return { exit_code: 2 };
  }

  let parsed: ParsedRecordCommand;
  try {
    parsed = parseRecordArguments(arguments_.slice(1));
  } catch (error: unknown) {
    io.write(
      `${escapePresentationText(error instanceof Error ? error.message : 'Invalid record command.')}\n\n${RECORD_HELP}`,
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
