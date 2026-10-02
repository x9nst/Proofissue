import { RECORD_HELP } from './record-command.js';
import type { CliCommandName } from './usage.js';

export const VALIDATE_HELP = `Usage:
  proofissue validate <artifact> [--json]

Checks an artifact against the version 1 schema and its limits without executing anything.
Prints valid or invalid_artifact, with each problem; --json prints one result line.
`;

export const INSPECT_HELP = `Usage:
  proofissue inspect <artifact> [--json]

Validates an artifact and prints its status. --json prints one line with a summary of the
runtime, command, files, expectations, limits, and redaction counts; it never includes file
contents or expected text.
`;

export const PREPARE_HELP = `Usage:
  proofissue prepare <artifact> --dependency-store <directory> [--json]

prepare is the only ProofIssue step that makes network requests: it downloads exactly the
packages the artifact's lockfile names from the public npm registry, checks each against its
SHA-512 hash, and stores them in the given directory. It never runs the artifact or package
code. Replay never uses the network; pass the same --dependency-store to replay an artifact
with dependency files.
`;

export const REPLAY_HELP = `Usage:
  proofissue replay <artifact> [--against <directory>]
    [--dependency-store <directory>]
    [--require-status reproduced|not_reproduced] [--json]

Replay validates before execution, accepts only the approved digest-pinned image,
uses a locked-down local Docker Engine on x86-64 Linux, and never pulls an image.
Without --against, replay uses every file embedded in the artifact. With --against,
only declared subject paths are replaced; undeclared additions, removals, and renames
are not evaluated.
`;

export const DOCTOR_HELP = `Usage:
  proofissue doctor

Checks whether this machine can replay artifacts: Node.js, host platform, Docker CLI, a local
Docker context, Docker Engine 27 or newer, the default seccomp profile, and the approved replay
image. It runs only read-only Docker commands, never pulls the image (a missing image is
reported with the exact docker pull command), starts no container, and uses no network.
Exits 0 when replay is ready and 1 when it is not.
`;

export { RECORD_HELP };

const COMMAND_HELP: Readonly<Record<CliCommandName, string>> = {
  record: RECORD_HELP,
  validate: VALIDATE_HELP,
  inspect: INSPECT_HELP,
  prepare: PREPARE_HELP,
  replay: REPLAY_HELP,
  doctor: DOCTOR_HELP,
};

/** The help for one command, as printed by `proofissue <command> --help`. */
export const helpFor = (command: CliCommandName): string => COMMAND_HELP[command];

// Every command's help is part of this text, so the documentation check sees every option.
export const CLI_HELP = `ProofIssue records a failing Node.js command as a portable artifact and replays it.

Commands:
  record    Record a failing command as an artifact
  validate  Check an artifact without running it
  inspect   Summarize an artifact without running it
  prepare   Download an artifact's locked npm packages (the only network step)
  replay    Replay an artifact in a locked-down container
  doctor    Check whether this machine can replay artifacts

Run "proofissue <command> --help" for one command's options.

${RECORD_HELP}
${VALIDATE_HELP}
${INSPECT_HELP}
${PREPARE_HELP}
${REPLAY_HELP}
${DOCTOR_HELP}`;
