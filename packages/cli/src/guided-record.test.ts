import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ObservedLine, RecordObservationView, StreamListing } from '@proofissue/application';

import { displayLine, renderObservationListing } from './guided-record.js';
import { runCli, type CliIo } from './index.js';

const ESC = String.fromCharCode(27);
const RLO = String.fromCharCode(0x202e);
const C1_CSI = String.fromCharCode(0x9b);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const exists = async (location: string): Promise<boolean> => {
  try {
    await access(location);
    return true;
  } catch {
    return false;
  }
};

const MARKER = 'ran.marker';

const project = async (exitCode = 1): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-guided-cli-'));
  roots.push(root);
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'test', 'reproduction.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(new URL('../${MARKER}', import.meta.url), 'ran');`,
      "console.log('checking 3 inputs');",
      "console.error('Expected 4 from calculate(2)');",
      "console.error('  at test/reproduction.mjs');",
      `process.exitCode = ${String(exitCode)};`,
      '',
    ].join('\n'),
  );
  await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
  return root;
};

interface Session {
  readonly asked: string[];
  readonly confirmations: string[];
  readonly io: CliIo;
  readonly output: () => string;
}

const session = (
  answers: readonly (string | undefined)[],
  options: { readonly confirm?: boolean; readonly interactive?: boolean } = {},
): Session => {
  let written = '';
  const asked: string[] = [];
  const confirmations: string[] = [];
  const queue = [...answers];
  return {
    asked,
    confirmations,
    io: {
      ask: (question) => {
        asked.push(question);
        return Promise.resolve(queue.shift());
      },
      confirm: (question) => {
        confirmations.push(question);
        return Promise.resolve(options.confirm ?? true);
      },
      interactive: options.interactive ?? true,
      write: (text) => {
        written += text;
      },
    },
    output: () => written,
  };
};

const recordArguments = (root: string, ...extra: readonly string[]): readonly string[] => [
  'record',
  '--project',
  root,
  '--output',
  path.join(root, 'failure.proofissue.yaml'),
  '--reproduction',
  'test/reproduction.mjs',
  '--subject',
  'src/subject.mjs',
  ...extra,
  '--',
  'node',
  'test/reproduction.mjs',
];

const stream = (
  name: 'stderr' | 'stdout',
  lines: readonly (Partial<ObservedLine> & { readonly text: string })[],
  overrides: Partial<StreamListing> = {},
): StreamListing => ({
  lines: lines.map((line, index) => ({
    id: `${name === 'stdout' ? 'o' : 'e'}${String(index + 1)}`,
    number: index + 1,
    selectable: true,
    stream: name,
    ...line,
  })),
  omitted_lines: 0,
  stream: name,
  total_lines: lines.length,
  truncated: false,
  ...overrides,
});

describe('guided line selection', () => {
  it('renders ids and escapes terminal and bidirectional controls', () => {
    const view: RecordObservationView = {
      exit_code: 1,
      stdout: stream('stdout', [{ text: `red ${ESC}[31mtext${C1_CSI}2J ${RLO}evil` }]),
      stderr: stream('stderr', [
        { text: 'x'.repeat(250) },
        { text: '', selectable: false, reason: 'empty' },
        { text: 'a path /srv/x', selectable: false, reason: 'local_path' },
        { text: 'token [REDACTED:token]', selectable: false, reason: 'redaction_marker' },
      ]),
    };

    const text = renderObservationListing(view);

    expect(text).not.toContain(ESC);
    expect(text).not.toContain(RLO);
    expect(text).not.toContain(C1_CSI);
    expect(text).toContain('  o1  red \\u{001b}[31mtext\\u{009b}2J \\u{202e}evil');
    expect(text).toContain(`  e1  ${'x'.repeat(200)} ... (50 more characters)`);
    expect(text).toContain('  e2  [not selectable: empty]');
    expect(text).toContain('  e3  [not selectable: holds a path from this computer]');
    expect(text).not.toContain('/srv/x');
    expect(text).toContain(
      '  e4  [not selectable: contains a redaction marker] token [REDACTED:token]',
    );
    expect(text).toContain('stderr (4 lines):');
    expect(text.indexOf('stdout (1 line):')).toBeLessThan(text.indexOf('stderr (4 lines):'));
  });

  it('cuts a long line by characters, not in the middle of an escape', () => {
    expect(displayLine(ESC.repeat(300))).toBe(
      `${'\\u{001b}'.repeat(200)} ... (100 more characters)`,
    );
  });

  it('says how many lines are not shown', () => {
    const view: RecordObservationView = {
      exit_code: 1,
      stdout: {
        ...stream('stdout', [{ text: 'first' }]),
        lines: [
          { id: 'o1', number: 1, selectable: true, stream: 'stdout', text: 'first' },
          { id: 'o900', number: 900, selectable: true, stream: 'stdout', text: 'last' },
        ],
        omitted_lines: 898,
        total_lines: 900,
      },
      stderr: stream('stderr', []),
    };

    const text = renderObservationListing(view);

    expect(text).toContain('stdout (900 lines):');
    expect(text).toContain('  o1  first\n  ... 898 lines not shown ...\n  o900  last');
    expect(text).toContain('stderr (0 lines):\n  (nothing printed)');
  });

  it('accepts the suggestion on Enter', async () => {
    const root = await project();
    const terminal = session(['']);

    const result = await runCli(recordArguments(root), terminal.io);

    expect(result.exit_code).toBe(0);
    const text = terminal.output();
    expect(text).toContain('The command exited with code 1.');
    expect(text).toContain('  e1  Expected 4 from calculate(2)');
    expect(text).toContain('Suggested: e1, a line that starts with "Expected".');
    expect(terminal.asked).toEqual([
      'Enter line ids separated by spaces (e.g. e3 o12), or press Enter to use the suggested line e1: ',
    ]);
    expect(text).toContain('stderr contains after normalization: "Expected 4 from calculate(2)"');
    expect(text).toContain('Artifact created.');
    // The three confirmations of every recording still apply.
    expect(terminal.confirmations).toHaveLength(3);
    const artifact = await readFile(path.join(root, 'failure.proofissue.yaml'), 'utf8');
    expect(artifact).toContain('Expected 4 from calculate(2)');
  });

  it('accepts several ids', async () => {
    const root = await project();
    const terminal = session(['o1  e2 o1']);

    const result = await runCli(recordArguments(root), terminal.io);

    expect(result.exit_code).toBe(0);
    const text = terminal.output();
    expect(text).toContain('stdout contains after normalization: "checking 3 inputs"');
    expect(text).toContain('stderr contains after normalization: "at test/reproduction.mjs"');
    expect(text).not.toContain('stderr contains after normalization: "Expected 4');
  });

  it('re-prompts on an unknown id and cancels after three attempts', async () => {
    const root = await project();
    const terminal = session(['e99', `${ESC}[2J`, 'o0']);

    const result = await runCli(recordArguments(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.asked).toHaveLength(3);
    const text = terminal.output();
    expect(text).toContain('"e99" is not a listed line id that can be chosen.');
    expect(text).toContain('"\\u{001b}[2J" is not a listed line id');
    expect(text).not.toContain(ESC);
    expect(text).toContain('No valid line was chosen after 3 attempts.');
    expect(text).toContain('Recording cancelled; no artifact was written.');
    expect(await exists(path.join(root, 'failure.proofissue.yaml'))).toBe(false);
  });

  it('recovers when a later attempt is valid', async () => {
    const root = await project();
    const terminal = session(['zzz', 'e1']);

    const result = await runCli(recordArguments(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).toContain('Artifact created.');
  });

  it('cancels without writing when input ends', async () => {
    const root = await project();
    const terminal = session([undefined]);

    const result = await runCli(recordArguments(root), terminal.io);

    expect(result.exit_code).toBe(0);
    expect(terminal.output()).toContain('Recording cancelled; no artifact was written.');
    expect(await exists(path.join(root, 'failure.proofissue.yaml'))).toBe(false);
  });

  it('asks before recording a command that exited 0', async () => {
    const root = await project(0);
    const declined = session([''], { confirm: false });

    const result = await runCli(recordArguments(root), declined.io);

    expect(result.exit_code).toBe(0);
    expect(declined.confirmations).toEqual([
      'The command exited 0; it did not fail. Record it anyway?',
    ]);
    expect(declined.asked).toHaveLength(0);
    expect(await exists(path.join(root, 'failure.proofissue.yaml'))).toBe(false);

    const accepted = session(['']);
    const second = await runCli(recordArguments(root), accepted.io);

    expect(second.exit_code).toBe(0);
    expect(accepted.confirmations[0]).toBe(
      'The command exited 0; it did not fail. Record it anyway?',
    );
    expect(accepted.output()).toContain('Artifact created.');
  });

  const explanation =
    'Recording failed: A failing recording needs an expected stdout or stderr literal. Run record in a terminal without --expect options to choose a line from the command\'s output, or pass --expect-stderr-normalized "<text>" (or another --expect option).\n';

  it.each([
    ['--yes', ['--yes'], true],
    ['--json', ['--yes', '--json'], true],
    ['without a terminal', [], false],
  ] as const)(
    'does not enter guided mode with %s, and explains the options',
    async (_name, extra, interactive) => {
      const root = await project();
      const terminal = session(['e1'], { interactive });
      let errors = '';
      const io: CliIo = {
        ...terminal.io,
        writeError: (text) => {
          errors += text;
        },
      };

      const result = await runCli(recordArguments(root, ...extra), io);

      expect(result.exit_code).toBe(1);
      expect(terminal.asked).toHaveLength(0);
      expect(terminal.confirmations).toHaveLength(0);
      const text = (extra as readonly string[]).includes('--json')
        ? (JSON.parse(terminal.output()) as { errors: { message: string }[] }).errors
            .map((error) => `Recording failed: ${error.message}\n`)
            .join('')
        : terminal.output();
      expect(text).toBe(explanation);
      expect(errors).toBe('');
      // The command did not run: the explanation comes before anything is executed.
      expect(await exists(path.join(root, MARKER))).toBe(false);
      expect(await exists(path.join(root, 'failure.proofissue.yaml'))).toBe(false);
    },
  );

  it('does not enter guided mode when an io has no ask function', async () => {
    const root = await project();
    let written = '';

    const result = await runCli(recordArguments(root), {
      confirm: () => Promise.resolve(true),
      interactive: true,
      write: (text) => {
        written += text;
      },
    });

    expect(result.exit_code).toBe(1);
    expect(written).toContain('A failing recording needs an expected stdout or stderr literal.');
  });

  it('keeps the explicit options unchanged in a terminal', async () => {
    const root = await project();
    const terminal = session(['e1']);

    const result = await runCli(
      recordArguments(root, '--expect-stderr', 'Expected 4 from calculate(2)'),
      terminal.io,
    );

    expect(result.exit_code).toBe(0);
    expect(terminal.asked).toHaveLength(0);
    expect(terminal.output()).not.toContain('What it printed');
  });
});
