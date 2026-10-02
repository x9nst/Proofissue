import { RECORD_HELP } from './record-command.js';

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
