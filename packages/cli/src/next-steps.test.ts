import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  APPROVED_REPLAY_IMAGE,
  type ProofIssueError,
  type ReplayOperationResult,
} from '@proofissue/application';
import { describe, expect, it } from 'vitest';

import { runCli, type CliIo } from './index.js';

const capture = (): { io: CliIo; output: () => string } => {
  let written = '';
  return {
    io: {
      confirm: () => Promise.resolve(false),
      write: (text) => {
        written += text;
      },
    },
    output: () => written,
  };
};

const failure = (...errors: ProofIssueError[]): ReplayOperationResult => ({
  result_schema_version: 1,
  operation: 'replay',
  status: 'execution_failed',
  mode: 'snapshot',
  warnings: [],
  errors,
  evidence: [],
  differences: [],
  substituted_paths: [],
  scope_limitations: [],
});

const replayText = async (
  arguments_: readonly string[],
  ...errors: ProofIssueError[]
): Promise<string> => {
  const { io, output } = capture();
  await runCli(['replay', ...arguments_], io, {
    replay: () => Promise.resolve(failure(...errors)),
  });
  return output();
};

describe('replay next steps', () => {
  it('prints the pull command when the image is missing', async () => {
    const text = await replayText(['a.proofissue'], {
      code: 'image_unavailable',
      message: 'The approved replay image is not available locally.',
    });

    expect(text).toContain(`Next step: docker pull ${APPROVED_REPLAY_IMAGE}\n`);
    expect(APPROVED_REPLAY_IMAGE).toMatch(/^node@sha256:[a-f0-9]{64}$/u);
  });

  it.each(['engine_unavailable', 'engine_capability_unavailable'] as const)(
    'suggests doctor for %s',
    async (code) => {
      const text = await replayText(['a.proofissue'], { code, message: 'Docker is unavailable.' });

      expect(text).toContain('Next step: run proofissue doctor');
      expect(text).toContain('GitHub Action');
    },
  );

  it('fills in the prepare command with the artifact path escaped', async () => {
    const text = await replayText(['my failure.proofissue.yaml', '--against', 'fix\u001b[31m'], {
      code: 'dependencies_not_prepared',
      message: 'Not prepared.',
    });

    expect(text).toContain(
      'Next step: proofissue replay "my failure.proofissue.yaml" --against "fix\\u{001b}[31m" --prepare --dependency-store .proofissue-store\n',
    );
    expect(text).not.toContain('\u001b');
  });

  it('keeps the store the user gave and quotes shell characters in it', async () => {
    const text = await replayText(['a.proofissue', '--dependency-store', "it's$store"], {
      code: 'dependencies_not_prepared',
      message: 'Not prepared.',
    });

    expect(text).toContain(
      "Next step: proofissue replay a.proofissue --prepare --dependency-store 'it'\\''s$store'\n",
    );
  });

  it('suggests a new empty store after a failed install', async () => {
    const text = await replayText(['a.proofissue', '--dependency-store', 'cache/'], {
      code: 'dependency_install_failed',
      message: 'The install failed.',
    });

    expect(text).toContain(
      'Next step: prepare into a new, empty store: proofissue replay a.proofissue --prepare --dependency-store cache-new\n',
    );
  });

  it.each(['timeout', 'resource_termination'] as const)(
    'calls %s a support boundary, not evidence about the failure',
    async (code) => {
      const text = await replayText(['a.proofissue'], { code, message: 'Limit reached.' });

      expect(text).toContain('Next step: none. The replay limits are fixed');
      expect(text).toContain('not evidence about the original failure');
    },
  );

  it('prints no next step for other errors, and none under --json', async () => {
    const other = await replayText(['a.proofissue'], {
      code: 'policy_rejection',
      message: 'Refused.',
    });
    const machine = await replayText(['a.proofissue', '--json'], {
      code: 'image_unavailable',
      message: 'Missing.',
    });

    expect(other).not.toContain('Next step');
    expect(machine).not.toContain('Next step');
  });

  it('prints each distinct step once', async () => {
    const text = await replayText(
      ['a.proofissue'],
      { code: 'image_unavailable', message: 'one' },
      { code: 'image_unavailable', message: 'two' },
    );

    expect(text.match(/Next step:/gu)).toHaveLength(1);
  });
});

describe('inspect summary', () => {
  it('prints a summary without file contents, argument values, or expected text', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-inspect-'));
    try {
      const original = await readFile(
        'tests/fixtures/artifacts/v1/valid/minimal.proofissue',
        'utf8',
      );
      const marked = original.replace(
        'arguments:\n    - reproduction.mjs',
        'arguments:\n    - reproduction.mjs\n    - --flag=ARGUMENT-VALUE-MARKER',
      );
      expect(marked).not.toBe(original);
      const file = path.join(root, 'marked.proofissue');
      await writeFile(file, marked);
      const { io, output } = capture();

      const result = await runCli(['inspect', file], io);

      expect(result.exit_code).toBe(0);
      expect(output()).toContain('Command: node with 2 arguments\n');
      expect(output()).not.toContain('ARGUMENT-VALUE-MARKER');
      expect(output()).not.toContain('Expected 4 from calculate(2)');
      expect(output()).not.toContain('return value + 1');
      expect(output()).not.toContain('console.error');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('shows runtime, image, files with roles and sizes, expectations, limits, and redaction', async () => {
    const { io, output } = capture();

    await runCli(['inspect', 'tests/fixtures/artifacts/v1/valid/with-dependencies.proofissue'], io);

    expect(output().split('\n')).toEqual([
      'inspected',
      'Runtime: Node.js 24 on Linux',
      'Image: node@sha256:1111111111111111111111111111111111111111111111111111111111111111 (not the approved replay image; replay refuses it)',
      'Command: node with 1 argument',
      'Files: 4 (reproduction 1, subject 1, dependency 2)',
      '  reproduction reproduction.mjs (146 bytes)',
      '  subject      calculate.mjs (56 bytes)',
      '  dependency   package-lock.json (197 bytes)',
      '  dependency   package.json (75 bytes)',
      'Expectations: exit code 1; stdout none; stderr contains',
      'Limits: 60 s, 512 MB, 1 CPU, 64 processes, 1048576 bytes per output stream',
      'Redaction: enabled, 0 likely secrets replaced',
      'Prepare: needed before replay (proofissue replay <artifact> --prepare --dependency-store <directory>)',
      '',
    ]);
  });

  it('says no preparation is needed for an artifact without dependency files', async () => {
    const { io, output } = capture();

    await runCli(['inspect', 'tests/fixtures/artifacts/v1/valid/minimal.proofissue'], io);

    expect(output()).toContain('Prepare: not needed\n');
  });

  it('prints only the machine-readable result under --json', async () => {
    const { io, output } = capture();

    await runCli(['inspect', 'tests/fixtures/artifacts/v1/valid/minimal.proofissue', '--json'], io);

    expect(output().trimEnd().split('\n')).toHaveLength(1);
    expect(output()).not.toContain('Runtime:');
  });
});
