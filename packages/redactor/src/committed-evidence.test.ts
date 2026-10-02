import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { redactText } from './index.js';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');

// Directories and files that carry fixtures, recorded evidence, examples, or documentation.
const scannedRoots = [
  'tests/fixtures',
  'tests/fuzz-corpus',
  'benchmarks/real-projects/results',
  'benchmarks/real-projects/cases.json',
  'docs',
  'examples',
  '.github',
  'action/action.yml',
  'action/prepare/action.yml',
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
];
const skippedDirectories = new Set(['dist', 'node_modules']);
const scannedExtensions = new Set(['.proofissue', '.json', '.md', '.yaml', '.yml', '.mjs', '.txt']);

// Likely-secret findings that are known and justified, by file. The security-model entry is the
// table row that describes the password rule itself. The release workflow entries are the two
// `GH_TOKEN: ${{ github.token }}` lines that give the gh CLI the run's own short-lived token
// through an expression, so no value is committed. Neither is a credential.
// Any other finding fails the test: remove the value or build it at run time instead.
const ALLOWED_FINDINGS: Readonly<Record<string, number>> = {
  '.github/workflows/release.yml': 2,
  'docs/security-model.md': 1,
};

const collect = async (entry: string, found: string[]): Promise<void> => {
  const absolute = path.join(repositoryRoot, entry);
  let info;
  try {
    info = await stat(absolute);
  } catch {
    return;
  }
  if (info.isFile()) {
    if (scannedExtensions.has(path.extname(absolute))) found.push(entry);
    return;
  }
  for (const child of await readdir(absolute, { withFileTypes: true })) {
    if (child.isDirectory() && skippedDirectories.has(child.name)) continue;
    await collect(`${entry}/${child.name}`, found);
  }
};

describe('committed evidence', () => {
  it('finds no likely secret in committed fixtures, results, examples, and documentation', async () => {
    const files: string[] = [];
    for (const entry of scannedRoots) await collect(entry, files);
    expect(files.length).toBeGreaterThan(20);

    const findings: Record<string, number> = {};
    for (const file of files) {
      // A RedactionLimitError propagates and fails the test: too many findings to describe.
      const result = redactText(await readFile(path.join(repositoryRoot, file), 'utf8'));
      if (result.findings.length > 0) findings[file] = result.findings.length;
    }

    expect(findings).toEqual(ALLOWED_FINDINGS);
  });

  it('keeps no vitest snapshot directories', async () => {
    const found: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        if (child.name === '__snapshots__') found.push(path.join(directory, child.name));
        else if (!skippedDirectories.has(child.name) && child.name !== '.git') {
          await visit(path.join(directory, child.name));
        }
      }
    };
    await visit(path.join(repositoryRoot, 'packages'));
    await visit(path.join(repositoryRoot, 'tests'));
    expect(found).toEqual([]);
  });
});
