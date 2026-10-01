import process from 'node:process';

import { runPrepareAction } from './prepare.js';

const controller = new AbortController();
const interrupt = (): void => {
  controller.abort();
};

process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

void runPrepareAction(undefined, undefined, controller.signal)
  .catch(() => {
    process.stderr.write(
      'ProofIssue prepare action stopped before it could publish a safe result.\n',
    );
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  });
