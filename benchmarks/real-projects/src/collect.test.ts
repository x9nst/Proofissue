import { copyFile, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { collectResults, verifyDigests } from './collect.js';
import { runTrialCase } from './pipeline.js';
import {
  cleanupTrialHarnesses,
  createTrialHarness,
  sampleCase,
  temporaryDirectory,
  type TrialHarness,
} from './test-support.js';
import { parseTrialResult } from './summary.js';

afterEach(cleanupTrialHarnesses);

const finishedTrial = async (): Promise<{ harness: TrialHarness; directory: string }> => {
  const harness = await createTrialHarness();
  await runTrialCase(sampleCase, harness.context);
  return { harness, directory: path.join(harness.roots.output, 'X1') };
};

describe('collectResults', () => {
  it('reads valid results and verifies the uploaded artifact digests', async () => {
    const { harness } = await finishedTrial();
    const collected = await collectResults(harness.roots.output);

    expect(collected.invalid).toEqual([]);
    expect(collected.results.map((item) => item.result.case.id)).toEqual(['X1']);
    expect(collected.results[0]?.digest_verified).toBe(true);
  });

  it('reads the layout that artifact download produces', async () => {
    const { directory } = await finishedTrial();
    const input = await temporaryDirectory('trial-collect-');
    const layout = path.join(input, 'trial-result-X1', 'X1');
    await mkdir(layout, { recursive: true });
    for (const name of ['X1.result.json', 'X1.proofissue', 'X1-install-baseline.proofissue']) {
      await copyFile(path.join(directory, name), path.join(layout, name));
    }

    const collected = await collectResults(input);

    expect(collected.results).toHaveLength(1);
    expect(collected.results[0]?.digest_verified).toBe(true);
  });

  it('flags a digest mismatch with the uploaded artifact', async () => {
    const { harness, directory } = await finishedTrial();
    await writeFile(path.join(directory, 'X1.proofissue'), 'tampered after the run\n');

    const collected = await collectResults(harness.roots.output);

    expect(collected.results[0]?.digest_verified).toBe(false);
  });

  it('flags a mismatching install-baseline artifact too', async () => {
    const { harness, directory } = await finishedTrial();
    await writeFile(path.join(directory, 'X1-install-baseline.proofissue'), 'tampered\n');

    expect((await collectResults(harness.roots.output)).results[0]?.digest_verified).toBe(false);
  });

  it('reports no verification when the artifact file is absent', async () => {
    const { directory } = await finishedTrial();
    const text = await readFile(path.join(directory, 'X1.result.json'), 'utf8');
    const parsed = parseTrialResult(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const empty = await temporaryDirectory('trial-collect-');

    expect(await verifyDigests(parsed.result, empty)).toBeNull();
  });

  it('rejects malformed, oversized, misnamed, and duplicate results', async () => {
    const { directory } = await finishedTrial();
    const input = await temporaryDirectory('trial-collect-');
    const good = await readFile(path.join(directory, 'X1.result.json'), 'utf8');
    await mkdir(path.join(input, 'a'), { recursive: true });
    await mkdir(path.join(input, 'b'), { recursive: true });
    await mkdir(path.join(input, 'c'), { recursive: true });
    await mkdir(path.join(input, 'd'), { recursive: true });
    await mkdir(path.join(input, 'e'), { recursive: true });
    await writeFile(path.join(input, 'a', 'X1.result.json'), good);
    await writeFile(path.join(input, 'b', 'X1.result.json'), good);
    await writeFile(path.join(input, 'c', 'B1.result.json'), '{ not json');
    await writeFile(path.join(input, 'd', 'X9.result.json'), good);
    await writeFile(path.join(input, 'e', 'Z1.result.json'), ' '.repeat(1024 * 1024 + 1));

    const collected = await collectResults(input);
    const reasons = new Map(collected.invalid.map((item) => [item.file, item.reason]));

    expect(collected.results.map((item) => item.result.case.id)).toEqual(['X1']);
    expect(reasons.get('b/X1.result.json')).toContain('already read');
    expect(reasons.get('c/B1.result.json')).toContain('not valid JSON');
    expect(reasons.get('d/X9.result.json')).toContain('different case');
    expect(reasons.get('e/Z1.result.json')).toContain('larger than 1 MiB');
  });

  it('ignores files deeper than four directories and anything not named like a result', async () => {
    const { directory } = await finishedTrial();
    const input = await temporaryDirectory('trial-collect-');
    const deep = path.join(input, 'a', 'b', 'c', 'd', 'e');
    await mkdir(deep, { recursive: true });
    await copyFile(path.join(directory, 'X1.result.json'), path.join(deep, 'X1.result.json'));
    await copyFile(path.join(directory, 'X1.result.json'), path.join(input, 'x1.result.json'));
    await copyFile(path.join(directory, 'X1.result.json'), path.join(input, 'X1.result.json.bak'));

    const collected = await collectResults(input);

    expect(collected.results).toEqual([]);
    expect(collected.invalid).toEqual([]);
  });

  it('shows only sanitized path characters for rejected files', async () => {
    const input = await temporaryDirectory('trial-collect-');
    const odd = path.join(input, 'we ird;name$x');
    await mkdir(odd, { recursive: true });
    await writeFile(path.join(odd, 'B1.result.json'), '{');

    const collected = await collectResults(input);

    expect(collected.invalid[0]?.file).toBe('we_ird_name_x/B1.result.json');
  });

  it('does not follow a symbolic link to a result', async () => {
    const { directory } = await finishedTrial();
    const input = await temporaryDirectory('trial-collect-');
    try {
      await symlink(path.join(directory, 'X1.result.json'), path.join(input, 'X1.result.json'));
    } catch {
      return; // Creating links needs a privilege some hosts do not grant.
    }

    const collected = await collectResults(input);

    expect(collected.results).toEqual([]);
  });
});
