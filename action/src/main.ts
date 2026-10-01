import process from 'node:process';

import { runAction } from './index.js';

const controller = new AbortController();
const interrupt = (): void => {
  controller.abort();
};

process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);

void runAction(undefined, undefined, controller.signal)
  .catch(() => {
    process.stderr.write('ProofIssue action stopped before it could publish a safe result.\n');
    process.exitCode = 1;
  })
  .finally(() => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  });
