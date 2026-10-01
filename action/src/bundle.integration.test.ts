import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const runBundledAction = async (
  bundlePath: string,
  outputPath: string,
  summaryPath: string,
): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd: process.cwd(),
      env: {
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        'INPUT_ARTIFACT-PATH': 'tests/fixtures/artifacts/v1/invalid/unknown-field.proofissue',
        'INPUT_REPLAY-MODE': 'snapshot',
      },
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      resolve({ code, stderr });
    });
  });

describe('bundled GitHub Action', () => {
  it('carries no package download or store code', async () => {
    // The Action only replays. Downloading packages is a separate, explicit step, and until
    // the Action intentionally offers it, an accidental import must not add network access.
    // Remove or update this test in the change that adds that step to the Action.
    const bundle = await readFile('action/dist/index.js', 'utf8');

    for (const marker of ['proofissue-prepare', 'redirect_refused', 'integrity_mismatch']) {
      expect(bundle, marker).not.toContain(marker);
    }
  });

  it('runs without installed workspace modules and safely reports an invalid artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-action-bundle-'));
    const bundlePath = path.join(root, 'proofissue-action.mjs');
    const outputPath = path.join(root, 'output.txt');
    const summaryPath = path.join(root, 'summary.md');
    await copyFile('action/dist/index.js', bundlePath);
    await writeFile(outputPath, '');
    await writeFile(summaryPath, '');
    try {
      const execution = await runBundledAction(bundlePath, outputPath, summaryPath);
      const output = await readFile(outputPath, 'utf8');
      const summary = await readFile(summaryPath, 'utf8');

      expect(execution.code).toBe(1);
      expect(execution.stderr).toContain(
        'ProofIssue replay did not satisfy the configured policy (invalid_artifact).',
      );
      expect(output).toMatch(/status<<proofissue_[0-9a-f-]+\ninvalid_artifact\n/u);
      expect(output).toContain('"status":"invalid_artifact"');
      expect(summary).toContain('- Result: `invalid_artifact`');
      expect(summary).not.toContain('unknown_field');
      expect(summary).not.toContain('additional properties');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
