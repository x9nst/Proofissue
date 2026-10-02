import { createInterface } from 'node:readline/promises';
import { stderr, stdin, stdout } from 'node:process';

import type { OperationResult } from '@proofissue/application';

export interface CliIo {
  readonly confirm: (question: string) => Promise<boolean>;
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

export interface CliRunResult {
  readonly exit_code: 0 | 1 | 2;
  readonly result?: OperationResult;
}
