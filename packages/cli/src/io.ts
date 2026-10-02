import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import type { OperationResult } from '@proofissue/application';

export interface CliIo {
  readonly confirm: (question: string) => Promise<boolean>;
  readonly write: (text: string) => void;
}

export const defaultIo = (): CliIo => ({
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

export interface CliRunResult {
  readonly exit_code: 0 | 1 | 2;
  readonly result?: OperationResult;
}
