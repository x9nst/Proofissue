import type { ApplicationServices } from '@proofissue/application';

import {
  CLI_HELP,
  helpFor,
  RECORD_HELP,
  REPLAY_HELP,
  PREPARE_HELP,
  VALIDATE_HELP,
  INSPECT_HELP,
} from './help.js';
import { defaultIo, type CliIo, type CliRunResult } from './io.js';
import { runPrepareCommand } from './prepare-command.js';
import { runRecordCommand } from './record-command.js';
import { runReplayCommand } from './replay-command.js';
import { runStaticCommand } from './static-commands.js';
import { unknownCommandError, wantsHelp, type CliCommandName } from './usage.js';
import { PROOFISSUE_VERSION } from './version.js';

export interface CliAdapter {
  readonly application: ApplicationServices;
}

export const createCliAdapter = (application: ApplicationServices): CliAdapter =>
  Object.freeze({ application });

export { CLI_HELP, INSPECT_HELP, PREPARE_HELP, RECORD_HELP, REPLAY_HELP, VALIDATE_HELP };
export { type CliIo, type CliRunResult };
export { parseRecordArguments, renderRecordPreview } from './record-command.js';
export { renderReplayResult } from './replay-command.js';
export {
  parsePrepareArguments,
  renderPrepareResult,
  type ParsedPrepareCommand,
} from './prepare-command.js';

const COMMAND_NAMES: readonly string[] = ['inspect', 'prepare', 'record', 'replay', 'validate'];

const isCommandName = (value: string | undefined): value is CliCommandName =>
  value !== undefined && COMMAND_NAMES.includes(value);

export const runCli = async (
  arguments_: readonly string[],
  io: CliIo = defaultIo(),
  application?: Partial<ApplicationServices>,
): Promise<CliRunResult> => {
  if (arguments_.length === 0 || arguments_[0] === '--help' || arguments_[0] === '-h') {
    io.write(CLI_HELP);
    return { exit_code: 0 };
  }

  const command = arguments_[0];
  if (isCommandName(command) && wantsHelp(arguments_.slice(1))) {
    io.write(helpFor(command));
    return { exit_code: 0 };
  }

  if (arguments_[0] === '--version' && arguments_.length === 1) {
    io.write(`${PROOFISSUE_VERSION}\n`);
    return { exit_code: 0 };
  }

  if (arguments_[0] === 'validate' || arguments_[0] === 'inspect')
    return runStaticCommand(arguments_, io, application);
  if (arguments_[0] === 'prepare') return runPrepareCommand(arguments_, io, application);
  if (arguments_[0] === 'replay') return runReplayCommand(arguments_, io, application);

  if (arguments_[0] !== 'record') {
    io.write(unknownCommandError(arguments_[0] ?? ''));
    return { exit_code: 2 };
  }

  return runRecordCommand(arguments_, io);
};
