import {
  createStaticArtifactApplicationServices,
  type ApplicationServices,
} from '@proofissue/application';

import { parseArtifactCommand, type ParsedArtifactCommand } from './arguments.js';
import { CLI_HELP } from './help.js';
import type { CliIo, CliRunResult } from './io.js';
import { escapePresentationText } from './presentation.js';

export const runStaticCommand = async (
  arguments_: readonly string[],
  io: CliIo,
  application?: Partial<ApplicationServices>,
): Promise<CliRunResult> => {
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
};
