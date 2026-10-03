import { access, cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { afterEach, describe, expect, it } from 'vitest';

import { runCli, type CliIo } from './index.js';

// The README's five-minute walkthrough is the first thing a reporter copies. These tests run the
// commands it shows, and fail if the README or the example drifts from what the CLI does.
const originalDirectory = process.cwd();
const roots: string[] = [];

afterEach(async () => {
  process.chdir(originalDirectory);
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const readme = async (): Promise<string> => await readFile('README.md', 'utf8');

/** The contents of every fenced code block, in order. */
const fencedBlocks = (document: string): string[] =>
  [...document.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)].map((match) => match[1] ?? '');

/** Splits a documented command into arguments: backslash continuations, double quotes. */
const tokenize = (block: string): string[] => {
  const line = block.replace(/\\\r?\n/gu, ' ').trim();
  return [...line.matchAll(/"([^"]*)"|(\S+)/gu)].map((match) => match[1] ?? match[2] ?? '');
};

const GUIDED_COMMAND = 'npx proofissue record -- node test/reproduction.mjs';

const exampleCopy = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-readme-'));
  roots.push(root);
  await cp(path.join(originalDirectory, 'examples', 'failing-node-test'), root, {
    recursive: true,
  });
  return root;
};

const terminal = (): { readonly io: CliIo; readonly output: () => string } => {
  let written = '';
  return {
    io: {
      ask: () => Promise.resolve(''),
      confirm: () => Promise.resolve(true),
      interactive: true,
      write: (text) => {
        written += text;
      },
      writeError: (text) => {
        written += text;
      },
    },
    output: () => written,
  };
};

const exists = async (location: string): Promise<boolean> => {
  try {
    await access(location);
    return true;
  } catch {
    return false;
  }
};

describe('README.md five-minute walkthrough', () => {
  it('creates the same two example files that the repository ships', async () => {
    const blocks = fencedBlocks(await readme()).map((block) => block.trim());
    for (const file of ['src/calculate.mjs', 'test/reproduction.mjs']) {
      const shipped = (
        await readFile(path.join('examples', 'failing-node-test', ...file.split('/')), 'utf8')
      ).trim();
      expect(blocks, `README.md does not show ${file} as shipped`).toContain(shipped);
    }
  });

  it('records the README five-minute example with the documented non-interactive command', async () => {
    const document = await readme();
    const block = fencedBlocks(document).find((candidate) =>
      candidate.startsWith('npx proofissue record --yes'),
    );
    expect(block, 'README.md has no non-interactive record command').toBeDefined();
    const [npx, program, ...argumentsList] = tokenize(block ?? '');
    expect([npx, program]).toEqual(['npx', 'proofissue']);
    expect(argumentsList).toEqual([
      'record',
      '--yes',
      '--reproduction',
      'test/reproduction.mjs',
      '--subject',
      'src/calculate.mjs',
      '--expect-stderr',
      'Expected 4 from calculate(2)',
      '--',
      'node',
      'test/reproduction.mjs',
    ]);

    const root = await exampleCopy();
    process.chdir(root);
    const session = terminal();
    const outcome = await runCli(argumentsList, session.io);

    expect(outcome.exit_code).toBe(0);
    expect(session.output()).toContain('Saved: reproduction.proofissue.yaml (sha256 ');
    expect(await exists(path.join(root, 'reproduction.proofissue.yaml'))).toBe(true);

    // The sharing step: these are the commands the README shows next.
    for (const command of ['validate', 'inspect']) {
      const shown = `npx proofissue ${command} reproduction.proofissue.yaml`;
      expect(document, `README.md does not show: ${shown}`).toContain(shown);
      const checked = terminal();
      const result = await runCli([command, 'reproduction.proofissue.yaml'], checked.io);
      expect(result.exit_code).toBe(0);
    }
  });

  it('records the README guided command by pressing Enter on the suggestions', async () => {
    expect(await readme()).toContain(`${GUIDED_COMMAND}\n`);
    const root = await exampleCopy();
    process.chdir(root);
    const session = terminal();

    const outcome = await runCli(GUIDED_COMMAND.split(' ').slice(2), session.io);

    expect(outcome.exit_code).toBe(0);
    expect(session.output()).toContain('e1  Expected 4 from calculate(2)');
    expect(await exists(path.join(root, 'reproduction.proofissue.yaml'))).toBe(true);
  });

  it('shows the replay, fix-check, and preparation commands and keeps their options real', async () => {
    const document = await readme();
    for (const command of [
      'npx proofissue doctor',
      'npx proofissue replay reproduction.proofissue.yaml',
      'npx proofissue replay reproduction.proofissue.yaml --against . --require-status not_reproduced',
      'npx proofissue replay reproduction.proofissue.yaml --prepare --dependency-store .proofissue-store',
    ]) {
      expect(document, `README.md does not show: ${command}`).toContain(`${command}\n`);
    }
    const cliReference = await readFile('docs/cli.md', 'utf8');
    for (const option of ['--against', '--require-status', '--prepare', '--dependency-store']) {
      expect(cliReference).toContain(option);
    }
  });

  it('keeps the documented version tags consistent', async () => {
    const manifest = JSON.parse(await readFile('release/npm/package.json', 'utf8')) as {
      version: string;
    };
    const [major = '0', minor = '0'] = manifest.version.split('.');
    const release = `v${major}.${minor}.0`;
    // The README and the Action reference name the release these docs describe.
    expect(await readme()).toContain(`x9nst/Proofissue/action@${release}`);
    expect(await readme()).toContain(`x9nst/Proofissue/action/prepare@${release}`);
    expect(await readFile('docs/github-action.md', 'utf8')).toContain(
      `x9nst/Proofissue/action@${release}`,
    );
  });
});
