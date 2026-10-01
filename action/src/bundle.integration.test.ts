import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const runBundledAction = async (
  bundlePath: string,
  outputPath: string,
  summaryPath: string,
  inputs: Readonly<Record<string, string>>,
): Promise<{ readonly code: number | null; readonly stderr: string }> =>
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd: process.cwd(),
      env: {
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        ...inputs,
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

const withCopiedBundle = async <T>(
  source: string,
  inputs: (root: string) => Readonly<Record<string, string>>,
  check: (result: {
    readonly code: number | null;
    readonly output: string;
    readonly root: string;
    readonly stderr: string;
    readonly summary: string;
  }) => Promise<T> | T,
): Promise<T> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-action-bundle-'));
  const bundlePath = path.join(root, 'proofissue-action.mjs');
  const outputPath = path.join(root, 'output.txt');
  const summaryPath = path.join(root, 'summary.md');
  await copyFile(source, bundlePath);
  await writeFile(outputPath, '');
  await writeFile(summaryPath, '');
  try {
    const execution = await runBundledAction(bundlePath, outputPath, summaryPath, inputs(root));
    return await check({
      code: execution.code,
      output: await readFile(outputPath, 'utf8'),
      root,
      stderr: execution.stderr,
      summary: await readFile(summaryPath, 'utf8'),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe('bundled GitHub Action', () => {
  it('carries no package download code', async () => {
    // The replay Action never downloads packages. Downloading is the separate prepare action,
    // which needs the network on purpose, so an accidental import into the replay bundle must
    // not add network access. The read side of the prepared store is expected here, because
    // replay checks a store before it mounts it; the code that makes requests is not.
    const bundle = await readFile('action/dist/index.js', 'utf8');

    for (const marker of ['proofissue-prepare', 'redirect_refused', 'content_encoding_refused']) {
      expect(bundle, marker).not.toContain(marker);
    }
  });

  it('runs without installed workspace modules and safely reports an invalid artifact', async () => {
    await withCopiedBundle(
      'action/dist/index.js',
      () => ({
        'INPUT_ARTIFACT-PATH': 'tests/fixtures/artifacts/v1/invalid/unknown-field.proofissue',
        'INPUT_REPLAY-MODE': 'snapshot',
      }),
      (run) => {
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(
          'ProofIssue replay did not satisfy the configured policy (invalid_artifact).',
        );
        expect(run.output).toMatch(/status<<proofissue_[0-9a-f-]+\ninvalid_artifact\n/u);
        expect(run.output).toContain('"status":"invalid_artifact"');
        expect(run.summary).toContain('- Result: `invalid_artifact`');
        expect(run.summary).not.toContain('unknown_field');
        expect(run.summary).not.toContain('additional properties');
      },
    );
  });
});

describe('bundled prepare GitHub Action', () => {
  it('carries the download code, so the replay bundle guard is not vacuous', async () => {
    const bundle = await readFile('action/prepare/dist/index.js', 'utf8');

    expect(bundle).toContain('proofissue-prepare');
  });

  it('runs without workspace modules and reports not_required without creating the store', async () => {
    await withCopiedBundle(
      'action/prepare/dist/index.js',
      (root) => ({
        'INPUT_ARTIFACT-PATH': path.resolve('tests/fixtures/action/reproduced.proofissue'),
        'INPUT_DEPENDENCY-STORE': path.join(root, 'store'),
      }),
      async (run) => {
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.output).toMatch(/status<<proofissue_[0-9a-f-]+\nnot_required\n/u);
        expect(run.output).toContain('"operation":"prepare"');
        expect(run.summary).toContain('- Result: `not_required`');
        await expect(stat(path.join(run.root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  });

  it('fails safely for an invalid artifact', async () => {
    await withCopiedBundle(
      'action/prepare/dist/index.js',
      (root) => ({
        'INPUT_ARTIFACT-PATH': path.resolve(
          'tests/fixtures/artifacts/v1/invalid/unknown-field.proofissue',
        ),
        'INPUT_DEPENDENCY-STORE': path.join(root, 'store'),
      }),
      async (run) => {
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(
          'ProofIssue dependency preparation did not complete (invalid_artifact).',
        );
        expect(run.output).toContain('"status":"invalid_artifact"');
        expect(run.summary).toContain('- Result: `invalid_artifact`');
        expect(run.summary).not.toContain('unknown_field');
        expect(run.summary).not.toContain('additional properties');
        await expect(stat(path.join(run.root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' });
      },
    );
  });
});
