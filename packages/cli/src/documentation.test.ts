import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import { CLI_HELP, RECORD_HELP } from './index.js';

// Guards against documentation drift: a command, option, or Action that the code gains must be
// documented before the checks pass. Paths are relative to the repository root, where the
// tests run.
const REQUIRED_SUBSECTIONS = [
  '### Purpose',
  '### Syntax',
  '### Options',
  '### Example',
  '### Failure behavior',
  '### Security notes',
] as const;

const sectionOf = (document: string, heading: string): string => {
  const start = document.indexOf(`\n${heading}\n`);
  if (start === -1) return '';
  const next = document.indexOf('\n## ', start + heading.length + 2);
  return document.slice(start, next === -1 ? undefined : next);
};

describe('docs/cli.md', () => {
  const read = async (): Promise<string> => await readFile('docs/cli.md', 'utf8');

  it.each(['record', 'validate', 'inspect', 'prepare', 'replay'])(
    'documents %s completely',
    async (command) => {
      const section = sectionOf(await read(), `## \`${command}\``);
      expect(section, `the section for ${command} is missing`).not.toBe('');
      for (const subsection of REQUIRED_SUBSECTIONS) {
        expect(section, `${command} lacks ${subsection}`).toContain(`\n${subsection}\n`);
      }
    },
  );

  it('documents every option the CLI help names', async () => {
    const document = await read();
    const options = new Set(`${CLI_HELP}\n${RECORD_HELP}`.match(/--[a-z][a-z-]*/gu) ?? []);
    expect(options.size).toBeGreaterThan(10);
    for (const option of options) {
      expect(document, `${option} is not documented in docs/cli.md`).toContain(option);
    }
  });

  it('documents the usage exit behavior', async () => {
    const document = await read();
    expect(document).toContain('`--help`');
    expect(document).toContain('`-h`');
  });
});

describe('docs/github-action.md', () => {
  const ACTION_SUBSECTIONS = [
    '### Purpose',
    '### Example',
    '### Inputs',
    '### Outputs',
    '### Failure behavior',
    '### Workflow summary',
    '### Security notes',
  ] as const;

  it.each(['Replay Action', 'Prepare Action'])('documents the %s completely', async (title) => {
    const section = sectionOf(await readFile('docs/github-action.md', 'utf8'), `## ${title}`);
    expect(section, `the section for ${title} is missing`).not.toBe('');
    for (const subsection of ACTION_SUBSECTIONS) {
      expect(section, `${title} lacks ${subsection}`).toContain(`\n${subsection}\n`);
    }
  });
});
