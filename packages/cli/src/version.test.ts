import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from './index.js';
import { PROOFISSUE_VERSION } from './version.js';

describe('proofissue --version', () => {
  it('--version prints the package version and exits 0', async () => {
    let written = '';
    const io: CliIo = {
      confirm: () => Promise.resolve(false),
      write: (text) => {
        written += text;
      },
    };

    const outcome = await runCli(['--version'], io);

    expect(outcome.exit_code).toBe(0);
    expect(written).toBe(`${PROOFISSUE_VERSION}\n`);
  });

  it('PROOFISSUE_VERSION matches release/npm/package.json', async () => {
    const manifest = JSON.parse(await readFile('release/npm/package.json', 'utf8')) as {
      version: string;
    };
    expect(PROOFISSUE_VERSION).toBe(manifest.version);
  });
});
