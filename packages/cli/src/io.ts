import { createInterface } from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';

import type {
  ApplicationServices,
  DoctorApplicationService,
  OperationResult,
} from '@proofissue/application';

export interface CliIo {
  /**
   * Reads one typed line for guided recording. Resolves to undefined when input ended (end of
   * file or Ctrl+C). Optional, and used only when `interactive` is true.
   */
  readonly ask?: (question: string) => Promise<string | undefined>;
  readonly confirm: (question: string) => Promise<boolean>;
  /**
   * Whether a person is at a terminal: standard input and output are both terminals. Guided
   * recording needs this and `ask`; without them no suggestion is ever shown or applied.
   */
  readonly interactive?: boolean;
  readonly write: (text: string) => void;
  /**
   * Where text goes that must not mix with machine-readable output on stdout, such as the
   * recording preview under `record --json`. Optional: without it that text is not shown.
   */
  readonly writeError?: (text: string) => void;
}

export const defaultIo = (): CliIo => ({
  write: (text) => stdout.write(text),
  writeError: (text) => stderr.write(text),
  interactive: stdin.isTTY && stdout.isTTY,
  ask: async (question) => {
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      // Closing the input (Ctrl+D, Ctrl+C) never settles the question, so it is raced.
      return await new Promise<string | undefined>((resolve) => {
        reader.once('close', () => {
          resolve(undefined);
        });
        reader.question(question).then(resolve, () => {
          resolve(undefined);
        });
      });
    } finally {
      reader.close();
    }
  },
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

/** The application services a command may be given in place of the real ones, for tests. */
export type CliServices = Partial<ApplicationServices> & Partial<DoctorApplicationService>;

export interface CliRunResult {
  readonly exit_code: 0 | 1 | 2;
  readonly result?: OperationResult;
}
