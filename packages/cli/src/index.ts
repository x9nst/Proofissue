import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  createRecordApplicationService,
  type ApplicationServices,
  type RecordApplicationRequest,
  type RecordConfirmation,
  type RecordOperationResult,
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

File roles (provisional wording):
  --reproduction  A test, fixture, or input kept exactly as recorded during fix checks.
  --subject       Implementation code that may be replaced from the current checkout.

At least one path in each role and one expected output literal are required.
The command runs directly as Node.js arguments; shell syntax is not interpreted.
Use --yes only for explicit noninteractive approval after reviewing these selections.
`;

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
  readonly result?: RecordOperationResult;
}

export const runCli = async (
  arguments_: readonly string[],
  io: CliIo = defaultIo(),
): Promise<CliRunResult> => {
  if (arguments_.length === 0 || arguments_[0] === '--help' || arguments_[0] === '-h') {
    io.write(RECORD_HELP);
    return { exit_code: 0 };
  }
  if (arguments_[0] !== 'record') {
    io.write(`Unknown command: ${arguments_[0] ?? ''}\n\n${RECORD_HELP}`);
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
