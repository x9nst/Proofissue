import type { PrepareOperationResult, ReplayOperationResult } from '@proofissue/application';
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

const prepareResult = (status: PrepareOperationResult['status']): PrepareOperationResult => ({
  result_schema_version: 1,
  operation: 'prepare',
  status,
  warnings: [],
  errors:
    status === 'prepared'
      ? []
      : [{ code: 'dependency_download_failed', message: 'The registry could not be reached.' }],
  ...(status === 'prepared'
    ? {
        preparation: {
          packages: 3,
          downloaded_tarballs: 3,
          downloaded_bytes: 3000,
          reused_tarballs: 0,
          skipped_for_platform: 0,
          install_script_packages: 0,
        },
      }
    : {}),
});

const replayResult: ReplayOperationResult = {
  result_schema_version: 1,
  operation: 'replay',
  status: 'reproduced',
  mode: 'snapshot',
  warnings: [],
  errors: [],
  evidence: [{ kind: 'exit_code', message: 'Exit code matched: 1.' }],
  differences: [],
  substituted_paths: [],
  scope_limitations: [],
};

describe('replay --prepare', () => {
  it('runs prepare then replay with the same store', async () => {
    const { io, output } = capture();
    const calls: string[] = [];
    let preparedStore: string | undefined;
    let replayedStore: string | undefined;

    const result = await runCli(
      ['replay', 'a.proofissue', '--prepare', '--dependency-store', 'the-store'],
      io,
      {
        prepare: (request) => {
          calls.push('prepare');
          preparedStore = request.dependency_store;
          return Promise.resolve(prepareResult('prepared'));
        },
        replay: (request) => {
          calls.push('replay');
          replayedStore = request.dependency_store;
          return Promise.resolve(replayResult);
        },
      },
    );

    expect(calls).toEqual(['prepare', 'replay']);
    expect(preparedStore).toBe('the-store');
    expect(replayedStore).toBe('the-store');
    expect(result.exit_code).toBe(0);
    expect(output().indexOf('Preparation result: prepared')).toBeLessThan(
      output().indexOf('Replay result: reproduced'),
    );
  });

  it('replays an artifact that needs no preparation', async () => {
    const { io, output } = capture();

    const result = await runCli(
      ['replay', 'a.proofissue', '--prepare', '--dependency-store', 'the-store'],
      io,
      {
        prepare: () => Promise.resolve(prepareResult('not_required')),
        replay: () => Promise.resolve(replayResult),
      },
    );

    expect(result.exit_code).toBe(0);
    expect(output()).toContain('Preparation result: not_required');
    expect(output()).toContain('Replay result: reproduced');
  });

  it('requires --dependency-store', async () => {
    const { io, output } = capture();
    let called = false;

    const result = await runCli(['replay', 'a.proofissue', '--prepare'], io, {
      prepare: () => {
        called = true;
        return Promise.resolve(prepareResult('prepared'));
      },
    });

    expect(result.exit_code).toBe(2);
    expect(called).toBe(false);
    expect(output()).toContain('Error: --prepare requires --dependency-store');
    expect(output()).toContain('Run "proofissue replay --help"');
  });

  it('refuses --json', async () => {
    const { io, output } = capture();
    let called = false;

    const result = await runCli(
      ['replay', 'a.proofissue', '--prepare', '--dependency-store', 's', '--json'],
      io,
      {
        prepare: () => {
          called = true;
          return Promise.resolve(prepareResult('prepared'));
        },
      },
    );

    expect(result.exit_code).toBe(2);
    expect(called).toBe(false);
    expect(output()).toContain('--prepare cannot be combined with --json');
  });

  it('does not replay after a failed preparation', async () => {
    const { io, output } = capture();
    let replayed = false;

    const result = await runCli(
      ['replay', 'a.proofissue', '--prepare', '--dependency-store', 's'],
      io,
      {
        prepare: () => Promise.resolve(prepareResult('execution_failed')),
        replay: () => {
          replayed = true;
          return Promise.resolve(replayResult);
        },
      },
    );

    expect(replayed).toBe(false);
    expect(result.exit_code).toBe(1);
    expect(output()).toContain('Error: The registry could not be reached.');
    expect(output()).not.toContain('Replay result');
  });

  it('is not an option of validate, inspect, or prepare', async () => {
    for (const command of ['validate', 'inspect', 'prepare']) {
      const { io, output } = capture();
      const result = await runCli([command, 'a.proofissue', '--prepare'], io);
      expect(result.exit_code).toBe(2);
      expect(output()).toContain('Unknown option: --prepare');
    }
  });
});
