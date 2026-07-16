import { createInterface } from 'node:readline/promises';
import process, { stdin, stdout } from 'node:process';

import {
  createRecordApplicationService,
  createReplayApplicationService,
  createStaticArtifactApplicationServices,
  evaluateRequiredReplayStatus,
  type ApplicationServices,
  type OperationResult,
  type RecordApplicationRequest,
  type RecordConfirmation,
  type RecordPreview,
} from '@proofissue/application';

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
    [--yes] -- node <arguments...>

File roles:
  --reproduction  A test, fixture, or input kept exactly as recorded during fix checks.
  --subject       Implementation code that may be replaced from the current checkout.

At least one path in each role and one expected output literal are required.
The command runs directly as Node.js arguments; shell syntax is not interpreted.
Use --yes only for explicit noninteractive approval after reviewing these selections.
`;

export const CLI_HELP = `Usage:
  proofissue record [options] -- node <arguments...>
  proofissue validate <artifact.proofissue> [--json]
  proofissue inspect <artifact.proofissue> [--json]
  proofissue replay <artifact.proofissue> [--against <directory>]
    [--require-status reproduced|not_reproduced] [--json]

Replay validates before execution, accepts only the approved digest-pinned image,
uses a locked-down local Docker Engine on x86-64 Linux, and never pulls an image.
Without --against, replay uses every file embedded in the artifact. With --against,
only declared subject paths are replaced; undeclared additions, removals, and renames
are not evaluated.

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
    'Expected failure:',
    `  exit code: ${String(preview.expectations.exit_code)}`,
    ...preview.expectations.stdout.map((value) => `  stdout contains: ${quoteArgument(value)}`),
    ...preview.expectations.stderr.map((value) => `  stderr contains: ${quoteArgument(value)}`),
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

export const parseRecordArguments = (arguments_: readonly string[]): ParsedRecordCommand => {
  let projectRoot: string | undefined;
  let outputPath: string | undefined;
  let image: string | undefined;
  let noninteractive = false;
  const reproductionPaths: string[] = [];
  const subjectPaths: string[] = [];
  const expectStdout: string[] = [];
  const expectStderr: string[] = [];
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

interface ParsedArtifactCommand {
  readonly against_path?: string;
  readonly artifact_path: string;
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
    throw new Error(`Unknown option: ${argument ?? ''}`);
  }
  return {
    artifact_path: artifactPath,
    json,
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

  if (arguments_[0] === 'validate' || arguments_[0] === 'inspect') {
    let parsed: ParsedArtifactCommand;
    try {
      parsed = parseArtifactCommand(arguments_.slice(1), false);
    } catch (error: unknown) {
      io.write(`${error instanceof Error ? error.message : 'Invalid command.'}\n\n${CLI_HELP}`);
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

  if (arguments_[0] === 'replay') {
    let parsed: ParsedArtifactCommand;
    try {
      parsed = parseArtifactCommand(arguments_.slice(1), true);
    } catch (error: unknown) {
      io.write(
        `${error instanceof Error ? error.message : 'Invalid replay command.'}\n\n${CLI_HELP}`,
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
        mode: parsed.against_path === undefined ? 'snapshot' : 'current_checkout',
        signal: controller.signal,
      });
    } finally {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
    }
    io.write(parsed.json ? `${JSON.stringify(result)}\n` : renderReplayResult(result));
    const classificationCompleted =
      result.status === 'reproduced' || result.status === 'not_reproduced';
    const requiredSatisfied =
      parsed.required_status === undefined ||
      evaluateRequiredReplayStatus(result, parsed.required_status).satisfied;
    return {
      exit_code: classificationCompleted && requiredSatisfied ? 0 : 1,
      result,
    };
  }

  if (arguments_[0] !== 'record') {
    io.write(`Unknown command: ${arguments_[0] ?? ''}\n\n${CLI_HELP}`);
    return { exit_code: 2 };
  }

  let parsed: ParsedRecordCommand;
  try {
    parsed = parseRecordArguments(arguments_.slice(1));
  } catch (error: unknown) {
    io.write(
      `${error instanceof Error ? error.message : 'Invalid record command.'}\n\n${RECORD_HELP}`,
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
  else io.write(`Recording failed: ${result.errors[0]?.message ?? 'unknown error'}\n`);
  return {
    exit_code: result.status === 'created' || result.status === 'cancelled' ? 0 : 1,
    result,
  };
};
