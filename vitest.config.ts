import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const workspacePath = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@proofissue/action': workspacePath('./action/src/index.ts'),
      '@proofissue/application': workspacePath('./packages/application/src/index.ts'),
      '@proofissue/artifact-schema': workspacePath('./packages/artifact-schema/src/index.ts'),
      '@proofissue/cli': workspacePath('./packages/cli/src/index.ts'),
      '@proofissue/contracts': workspacePath('./packages/contracts/src/index.ts'),
      '@proofissue/matcher': workspacePath('./packages/matcher/src/index.ts'),
      '@proofissue/process-output': workspacePath('./packages/process-output/src/index.ts'),
      '@proofissue/recorder': workspacePath('./packages/recorder/src/index.ts'),
      '@proofissue/redactor': workspacePath('./packages/redactor/src/index.ts'),
      '@proofissue/report-ui': workspacePath('./packages/report-ui/src/index.ts'),
      '@proofissue/runner': workspacePath('./packages/runner/src/index.ts'),
    },
  },
  test: {
    include: ['action/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
