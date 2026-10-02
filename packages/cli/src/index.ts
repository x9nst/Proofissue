import type { ApplicationServices } from '@proofissue/application';

import { CLI_HELP } from './help.js';
import { defaultIo, type CliIo, type CliRunResult } from './io.js';
import { runPrepareCommand } from './prepare-command.js';
import { escapePresentationText } from './presentation.js';
import { RECORD_HELP, runRecordCommand } from './record-command.js';
import { runReplayCommand } from './replay-command.js';
import { runStaticCommand } from './static-commands.js';

export interface CliAdapter {
  readonly application: ApplicationServices;
}

export const createCliAdapter = (application: ApplicationServices): CliAdapter =>
  Object.freeze({ application });

export { CLI_HELP, RECORD_HELP };
export { type CliIo, type CliRunResult };
export { parseRecordArguments, renderRecordPreview } from './record-command.js';
export { renderReplayResult } from './replay-command.js';
export {
  parsePrepareArguments,
  renderPrepareResult,
  type ParsedPrepareCommand,
} from './prepare-command.js';

export const runCli = async (
  arguments_: readonly string[],
  io: CliIo = defaultIo(),
  application?: Partial<ApplicationServices>,
): Promise<CliRunResult> => {
  if (arguments_.length === 0 || arguments_[0] === '--help' || arguments_[0] === '-h') {
    io.write(CLI_HELP);
    return { exit_code: 0 };
  }

  if (arguments_[0] === 'validate' || arguments_[0] === 'inspect')
    return runStaticCommand(arguments_, io, application);
  if (arguments_[0] === 'prepare') return runPrepareCommand(arguments_, io, application);
  if (arguments_[0] === 'replay') return runReplayCommand(arguments_, io, application);

  if (arguments_[0] !== 'record') {
    io.write(`Unknown command: ${escapePresentationText(arguments_[0] ?? '')}\n\n${CLI_HELP}`);
    return { exit_code: 2 };
  }

  return runRecordCommand(arguments_, io);
};
