import { escapePresentationText } from './presentation.js';

export type CliCommandName = 'doctor' | 'inspect' | 'prepare' | 'record' | 'replay' | 'validate';

// One line each: an error should not bury its message under the full help text.
const SYNOPSES: Readonly<Record<CliCommandName, string>> = {
  record: 'proofissue record [options] -- node <arguments...>',
  validate: 'proofissue validate <artifact> [--json]',
  inspect: 'proofissue inspect <artifact> [--json]',
  prepare: 'proofissue prepare <artifact> --dependency-store <directory> [--json]',
  replay: 'proofissue replay <artifact> [options]',
  doctor: 'proofissue doctor',
};

/**
 * The text printed after malformed arguments: the problem, a one-line synopsis, and where to
 * find the rest. The message is escaped because it may repeat an argument the user typed.
 */
export const usageError = (command: CliCommandName, message: string): string =>
  `Error: ${escapePresentationText(message)}\nUsage: ${SYNOPSES[command]}\nRun "proofissue ${command} --help" for all options.\n`;

export const unknownCommandError = (name: string): string =>
  `Error: Unknown command: ${escapePresentationText(name)}\nRun "proofissue --help" for the list of commands.\n`;

/**
 * Whether the arguments after the command name ask for help. `--help` counts anywhere before a
 * `--` separator (a value can never begin with `--`); `-h` counts only first, because a short
 * form could be the value of an option such as an expected literal.
 */
export const wantsHelp = (arguments_: readonly string[]): boolean => {
  const separator = arguments_.indexOf('--');
  const options = separator === -1 ? arguments_ : arguments_.slice(0, separator);
  return options.includes('--help') || options[0] === '-h';
};
