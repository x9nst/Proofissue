import {
  APPROVED_REPLAY_IMAGE,
  type PrepareOperationResult,
  type ReplayOperationResult,
} from '@proofissue/application';
import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCliAdapter,
  parseRecordArguments,
  RECORD_HELP,
  renderPrepareResult,
  renderReplayResult,
  renderRecordPreview,
  runCli,
  type CliIo,
} from './index.js';
import {
  quotePathForCommand,
  renderRecordFailure,
  renderRecordSuccess,
  toPortableProjectPath,
} from './record-command.js';

describe('CLI application boundary', () => {
  it('exports the adapter factory', () => {
    expect(createCliAdapter).toBeTypeOf('function');
  });
});

const validFixture = 'tests/fixtures/artifacts/v1/valid/minimal.proofissue';
const invalidFixture = 'tests/fixtures/artifacts/v1/invalid/unknown-field.proofissue';

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

describe('validate and inspect CLI', () => {
  it.each([
    ['validate', 'valid'],
    ['inspect', 'inspected'],
  ] as const)('%s prints the status and exits 0 for a valid artifact', async (command, status) => {
    const { io, output } = capture();

    const result = await runCli([command, validFixture], io);

    expect(output()).toBe(`${status}\n`);
    expect(result.exit_code).toBe(0);
  });

  it.each([
    ['validate', 'valid'],
    ['inspect', 'inspected'],
  ] as const)('%s --json emits one parseable versioned result', async (command, status) => {
    const { io, output } = capture();

    const result = await runCli([command, validFixture, '--json'], io);

    expect(output().endsWith('\n')).toBe(true);
    expect(output().trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(output())).toMatchObject({
      result_schema_version: 1,
      operation: command,
      status,
      artifact_version: 1,
      artifact_digest: expect.stringMatching(/^[a-f0-9]{64}$/u) as string,
      errors: [],
    });
    expect(result.exit_code).toBe(0);
  });

  it('reports the same digest from validate and inspect', async () => {
    const digests: string[] = [];
    for (const command of ['validate', 'inspect']) {
      const { io, output } = capture();
      await runCli([command, validFixture, '--json'], io);
      digests.push((JSON.parse(output()) as { artifact_digest: string }).artifact_digest);
    }

    expect(digests[0]).toBe(digests[1]);
  });

  it.each([
    ['validate', invalidFixture],
    ['inspect', invalidFixture],
    ['validate', 'tests/fixtures/artifacts/v1/valid/does-not-exist.proofissue'],
  ])('%s exits 1 and names the problem for %s', async (command, artifactPath) => {
    const { io, output } = capture();

    const result = await runCli([command, artifactPath], io);

    expect(result.exit_code).toBe(1);
    expect(output()).toMatch(/^invalid_artifact\nError: /u);
  });

  it('exits 1 with a machine-readable error list under --json', async () => {
    const { io, output } = capture();

    const result = await runCli(['validate', invalidFixture, '--json'], io);

    expect(result.exit_code).toBe(1);
    const parsed = JSON.parse(output()) as { errors: unknown[]; status: string };
    expect(parsed.status).toBe('invalid_artifact');
    expect(parsed.errors.length).toBeGreaterThan(0);
  });
});

describe('CLI argument errors', () => {
  it.each([
    [['validate'], 'An artifact path is required.'],
    [['inspect'], 'An artifact path is required.'],
    [['replay'], 'An artifact path is required.'],
    [['validate', '--json', 'a.proofissue'], 'An artifact path is required.'],
    [['validate', 'a.proofissue', '--bogus'], 'Unknown option: --bogus'],
    [
      ['inspect', 'a.proofissue', '--require-status', 'reproduced'],
      'Unknown option: --require-status',
    ],
    [
      ['replay', 'a.proofissue', '--require-status', 'bogus'],
      '--require-status must be reproduced or not_reproduced.',
    ],
    [['replay', 'a.proofissue', '--against'], '--against requires a checkout directory.'],
    [['replay', 'a.proofissue', '--against', '--json'], '--against requires a checkout directory.'],
    [['prepare'], 'An artifact path is required.'],
    [['prepare', '--json'], 'An artifact path is required.'],
    [['prepare', 'a.proofissue'], '--dependency-store is required.'],
    [['prepare', 'a.proofissue', '--json'], '--dependency-store is required.'],
    [['prepare', 'a.proofissue', '--dependency-store'], '--dependency-store requires a directory.'],
    [
      ['prepare', 'a.proofissue', '--dependency-store', '--json'],
      '--dependency-store requires a directory.',
    ],
    [
      ['prepare', 'a.proofissue', '--dependency-store', 'store', '--against', 'x'],
      'Unknown option: --against',
    ],
    [
      ['prepare', 'a.proofissue', '--dependency-store', 'store', '--require-status', 'reproduced'],
      'Unknown option: --require-status',
    ],
    [['replay', 'a.proofissue', '--dependency-store'], '--dependency-store requires a directory.'],
    [
      ['validate', 'a.proofissue', '--dependency-store', 'store'],
      'Unknown option: --dependency-store',
    ],
    [['frobnicate'], 'Unknown command: frobnicate'],
  ])('%j exits 2 with a message and the usage text', async (arguments_, message) => {
    const { io, output } = capture();

    const result = await runCli(arguments_, io);

    expect(result.exit_code).toBe(2);
    expect(result.result).toBeUndefined();
    expect(output()).toContain(message);
    expect(output()).toMatch(/^Error: /u);
    expect(output()).toContain('--help');
    expect(output()).not.toContain('File roles:');
  });

  it.each([[[]], [['--help']], [['-h']]])('%j prints usage and exits 0', async (arguments_) => {
    const { io, output } = capture();

    const result = await runCli(arguments_, io);

    expect(result.exit_code).toBe(0);
    expect(output()).toContain('Usage:');
  });

  it('prints record help and exits 0 for record --help', async () => {
    const { io, output } = capture();

    const result = await runCli(['record', '--help'], io);

    expect(result.exit_code).toBe(0);
    expect(output()).toBe(RECORD_HELP);
  });

  it('prints replay help for replay -h', async () => {
    const { io, output } = capture();

    const result = await runCli(['replay', '-h'], io);

    expect(result.exit_code).toBe(0);
    expect(output()).toContain('proofissue replay <artifact>');
    expect(output()).toContain('--require-status');
    expect(output()).not.toContain('--expect-stdout');
  });

  it.each(['validate', 'inspect', 'prepare'])('prints %s help for --help', async (command) => {
    const { io, output } = capture();

    const result = await runCli([command, 'a.proofissue', '--help'], io);

    expect(result.exit_code).toBe(0);
    expect(output()).toContain(`proofissue ${command} <artifact>`);
  });

  it('does not treat --help after -- as a request for help', async () => {
    const { io, output } = capture();

    const result = await runCli(['record', '--', 'node', '--help'], io);

    expect(result.exit_code).toBe(1);
    expect(output()).not.toContain('File roles:');
  });

  it('prints the error and a help pointer, not the full help, for a malformed command', async () => {
    const { io, output } = capture();

    const result = await runCli(['replay', 'a.proofissue', '--bogus'], io);

    expect(result.exit_code).toBe(2);
    expect(output().trimEnd().split('\n')).toEqual([
      'Error: Unknown option: --bogus',
      'Usage: proofissue replay <artifact> [options]',
      'Run "proofissue replay --help" for all options.',
    ]);
  });

  it('explains that the command goes after -- when a positional argument comes first', async () => {
    const { io, output } = capture();

    const result = await runCli(['record', 'node', 'test/a.mjs'], io);

    expect(result.exit_code).toBe(2);
    expect(output()).toContain('put the command after --');
    expect(output()).not.toContain('Unknown record option');
  });

  it('escapes terminal controls in an echoed argument', async () => {
    const { io, output } = capture();

    await runCli(['record', 'node\u001b[31m'], io);

    expect(output()).not.toContain('\u001b');
  });

  it('never calls an application service when arguments are rejected', async () => {
    const { io } = capture();
    const application = {
      inspect: () => Promise.reject(new Error('must not be called')),
      prepare: () => Promise.reject(new Error('must not be called')),
      replay: () => Promise.reject(new Error('must not be called')),
      validate: () => Promise.reject(new Error('must not be called')),
    };

    const results = await Promise.all([
      runCli(['validate', '--json'], io, application),
      runCli(['inspect', 'a.proofissue', '--bogus'], io, application),
      runCli(['replay', 'a.proofissue', '--require-status', 'bogus'], io, application),
      runCli(['prepare', 'a.proofissue'], io, application),
    ]);

    expect(results.map((result) => result.exit_code)).toEqual([2, 2, 2, 2]);
  });
});

describe('replay CLI', () => {
  const replayResult = {
    result_schema_version: 1 as const,
    operation: 'replay' as const,
    status: 'reproduced' as const,
    mode: 'snapshot' as const,
    warnings: [],
    errors: [],
    evidence: [
      { kind: 'exit_code' as const, message: 'Exit code matched: 1.' },
      { kind: 'stderr_contains' as const, message: 'Expected stderr text was present.' },
    ],
    differences: [],
    substituted_paths: [],
    scope_limitations: [],
    cleanup: {
      completed: true,
      attempted_resources: ['container', 'workspace'],
      residual_resources: [],
    },
  };

  it('uses the shared replay result and separates classification from required-status policy', async () => {
    let written = '';
    const io: CliIo = {
      confirm: () => Promise.resolve(false),
      write: (text) => {
        written += text;
      },
    };
    const application = {
      replay: () => Promise.resolve(replayResult),
    };

    const accepted = await runCli(
      ['replay', 'failure.proofissue', '--require-status', 'reproduced'],
      io,
      application,
    );
    const rejected = await runCli(
      ['replay', 'failure.proofissue', '--require-status', 'not_reproduced'],
      io,
      application,
    );

    expect(accepted.exit_code).toBe(0);
    expect(rejected.exit_code).toBe(1);
    expect(accepted.result?.status).toBe('reproduced');
    expect(written).toContain('Replay result: reproduced');
    expect(written).not.toContain('decoded_text');
  });

  it('emits the versioned result as valid JSON for automation', async () => {
    let written = '';
    const result = await runCli(
      ['replay', 'failure.proofissue', '--json'],
      {
        confirm: () => Promise.resolve(false),
        write: (text) => {
          written += text;
        },
      },
      { replay: () => Promise.resolve(replayResult) },
    );

    expect(result.exit_code).toBe(0);
    expect(JSON.parse(written)).toMatchObject({
      result_schema_version: 1,
      operation: 'replay',
      status: 'reproduced',
    });
  });

  it('selects current-checkout mode and visibly reports every substitution and limitation', async () => {
    let written = '';
    let received: { readonly against_path?: string; readonly mode: string } | undefined;
    const currentResult = {
      ...replayResult,
      status: 'not_reproduced' as const,
      mode: 'current_checkout' as const,
      substituted_paths: ['calculate.mjs'],
      scope_limitations: [
        {
          code: 'declared_subject_paths_only' as const,
          message:
            'Only listed subject paths were substituted; undeclared additions, removals, and renames were not evaluated.',
        },
      ],
    };
    const result = await runCli(
      ['replay', 'failure.proofissue', '--against', 'corrected-checkout'],
      {
        confirm: () => Promise.resolve(false),
        write: (text) => {
          written += text;
        },
      },
      {
        replay: (request) => {
          received = request;
          return Promise.resolve(currentResult);
        },
      },
    );

    expect(result.exit_code).toBe(0);
    expect(received).toMatchObject({
      against_path: 'corrected-checkout',
      mode: 'current_checkout',
    });
    expect(written).toContain('Mode: current_checkout');
    expect(written).toContain('Substituted subject: calculate.mjs');
    expect(written).toContain('undeclared additions, removals, and renames were not evaluated');
  });

  it('neutralizes terminal controls, bidirectional controls, and workflow commands', () => {
    const rendered = renderReplayResult({
      ...replayResult,
      warnings: [
        {
          code: 'hostile',
          message: '\u001b]0;title\u0007\r::error::spoof\u202e',
        },
      ],
    });

    expect(rendered).not.toContain('\u001b');
    expect(rendered).not.toContain('\r');
    expect(rendered).not.toContain('\u202e');
    expect(rendered).not.toContain('::error::');
    expect(rendered).toContain('\\u{001b}');
    expect(rendered).toContain('\\:\\:error\\:\\:spoof');
  });
});

describe('prepare CLI', () => {
  const preparedResult: PrepareOperationResult = {
    result_schema_version: 1,
    operation: 'prepare',
    status: 'prepared',
    artifact_version: 1,
    artifact_digest: '0'.repeat(64),
    warnings: [
      {
        code: 'install_scripts_not_run',
        message: '1 package declares install scripts, which are never run.',
      },
    ],
    errors: [],
    preparation: {
      packages: 3,
      downloaded_tarballs: 2,
      downloaded_bytes: 2048,
      reused_tarballs: 1,
      skipped_for_platform: 1,
      install_script_packages: 1,
    },
  };

  const withStatus = (status: PrepareOperationResult['status']): PrepareOperationResult => ({
    result_schema_version: 1,
    operation: 'prepare',
    status,
    warnings: [],
    errors: [],
  });

  it('passes the artifact and store to the shared prepare service and exits 0 when prepared', async () => {
    const { io, output } = capture();
    let received: { artifact_path: string; dependency_store: string } | undefined;

    const result = await runCli(
      ['prepare', 'failure.proofissue', '--dependency-store', 'the-store'],
      io,
      {
        prepare: (request) => {
          received = request;
          return Promise.resolve(preparedResult);
        },
      },
    );

    expect(result.exit_code).toBe(0);
    expect(received).toMatchObject({
      artifact_path: 'failure.proofissue',
      dependency_store: 'the-store',
    });
    expect(output()).toContain('Preparation result: prepared');
  });

  it('treats not_required as success', async () => {
    const { io, output } = capture();

    const result = await runCli(['prepare', 'a.proofissue', '--dependency-store', 's'], io, {
      prepare: () => Promise.resolve(withStatus('not_required')),
    });

    expect(result.exit_code).toBe(0);
    expect(output()).toBe(
      'Preparation result: not_required\nThe artifact has no dependency files; replay needs no prepared store.\n',
    );
  });

  it.each(['invalid_input', 'invalid_artifact', 'execution_failed'] as const)(
    'exits 1 for %s',
    async (status) => {
      const { io, output } = capture();

      const result = await runCli(['prepare', 'a.proofissue', '--dependency-store', 's'], io, {
        prepare: () => Promise.resolve(withStatus(status)),
      });

      expect(result.exit_code).toBe(1);
      expect(output()).toContain(`Preparation result: ${status}`);
    },
  );

  it('--json emits one parseable versioned prepare result', async () => {
    const { io, output } = capture();

    const result = await runCli(
      ['prepare', 'a.proofissue', '--dependency-store', 's', '--json'],
      io,
      { prepare: () => Promise.resolve(preparedResult) },
    );

    expect(result.exit_code).toBe(0);
    expect(output().trimEnd().split('\n')).toHaveLength(1);
    expect(JSON.parse(output())).toMatchObject({
      result_schema_version: 1,
      operation: 'prepare',
      status: 'prepared',
      preparation: { packages: 3 },
    });
  });

  it('renders counts and the install-script warning without package names', () => {
    const rendered = renderPrepareResult(preparedResult);

    expect(rendered).toBe(
      [
        'Preparation result: prepared',
        'Packages for the replay platform: 3',
        'Tarballs downloaded: 2 (2048 bytes)',
        'Tarballs already in the store: 1',
        'Skipped for another platform: 1',
        'Warning: 1 package declares install scripts, which are never run.',
        'Replay offline with the same --dependency-store.',
        '',
      ].join('\n'),
    );
  });

  it('shows the failing package location after an error and neutralizes terminal controls', () => {
    const escape = String.fromCharCode(27);
    const rendered = renderPrepareResult({
      ...withStatus('execution_failed'),
      errors: [
        {
          code: 'dependency_download_failed',
          message: `${escape}]0;title::error::spoof`,
          details: { reason: 'http_status', package_path: 'node_modules/synthetic-left-pad' },
        },
      ],
    });

    expect(rendered).not.toContain(escape);
    expect(rendered).not.toContain('::error::');
    expect(rendered).toContain('\\:\\:error\\:\\:spoof (node_modules/synthetic-left-pad)');
  });

  it('prepares a dependency-free artifact end to end without creating the store', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-prepare-'));
    const store = path.join(root, 'store');
    try {
      const { io, output } = capture();

      const result = await runCli(['prepare', validFixture, '--dependency-store', store], io);

      expect(result.exit_code).toBe(0);
      expect(output()).toContain('Preparation result: not_required');
      await expect(stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('prepares the zero-package dependency fixture end to end', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-prepare-'));
    const store = path.join(root, 'store');
    try {
      const { io, output } = capture();

      const result = await runCli(
        [
          'prepare',
          'tests/fixtures/artifacts/v1/valid/with-dependencies.proofissue',
          '--dependency-store',
          store,
        ],
        io,
      );

      expect(result.exit_code).toBe(0);
      expect(output()).toContain('Packages for the replay platform: 0');
      expect((await stat(path.join(store, '_cacache', 'content-v2', 'sha512'))).isDirectory()).toBe(
        true,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('replay CLI dependency store', () => {
  const replayResult = (errors: ReplayOperationResult['errors'] = []): ReplayOperationResult => ({
    result_schema_version: 1,
    operation: 'replay',
    status: errors.length === 0 ? 'reproduced' : 'execution_failed',
    mode: 'snapshot',
    warnings: [],
    errors,
    evidence: [],
    differences: [],
    substituted_paths: [],
    scope_limitations: [],
  });

  it('passes --dependency-store to the shared replay service', async () => {
    const { io } = capture();
    let received: { dependency_store?: string } | undefined;

    await runCli(['replay', 'a.proofissue', '--dependency-store', 'the-store'], io, {
      replay: (request) => {
        received = request;
        return Promise.resolve(replayResult());
      },
    });

    expect(received?.dependency_store).toBe('the-store');
  });

  it('sends no dependency store without the option', async () => {
    const { io } = capture();
    let received: object | undefined;

    await runCli(['replay', 'a.proofissue'], io, {
      replay: (request) => {
        received = request;
        return Promise.resolve(replayResult());
      },
    });

    expect(received).not.toHaveProperty('dependency_store');
  });

  it('suggests prepare when the store is missing', async () => {
    const failing = replayResult([
      { code: 'dependencies_not_prepared', message: 'The dependencies are not prepared.' },
    ]);
    const human = capture();
    const machine = capture();

    await runCli(['replay', 'a.proofissue'], human.io, { replay: () => Promise.resolve(failing) });
    await runCli(['replay', 'a.proofissue', '--json'], machine.io, {
      replay: () => Promise.resolve(failing),
    });

    expect(human.output()).toContain('Hint: run proofissue prepare');
    expect(machine.output()).not.toContain('Hint:');
  });
});

describe('record CLI', () => {
  it('documents file roles, direct execution, and explicit automation approval', () => {
    expect(RECORD_HELP).toContain('--reproduction');
    expect(RECORD_HELP).toContain('--subject');
    expect(RECORD_HELP).toContain('File roles:');
    expect(RECORD_HELP).toContain('shell syntax is not interpreted');
    expect(RECORD_HELP).toContain('--yes');
  });

  it('parses repeated file roles and preserves command argument boundaries', () => {
    const parsed = parseRecordArguments([
      '--project',
      '.',
      '--output',
      'failure.proofissue',
      '--image',
      `node@sha256:${'1'.repeat(64)}`,
      '--reproduction',
      'test/a.mjs',
      '--reproduction',
      'test/b.mjs',
      '--subject',
      'src/a.mjs',
      '--expect-stderr',
      'failure marker',
      '--yes',
      '--',
      'node',
      'test/a.mjs',
      'argument with spaces',
      '&',
    ]);

    expect(parsed.noninteractive_confirmation).toBe(true);
    expect(parsed.request.reproduction_paths).toEqual(['test/a.mjs', 'test/b.mjs']);
    expect(parsed.request.arguments).toEqual(['test/a.mjs', 'argument with spaces', '&']);
  });

  const minimalRecordArguments = [
    '--reproduction',
    'test/reproduction.mjs',
    '--subject',
    'src/calculate.mjs',
    '--expect-stderr',
    'Expected 4',
    '--',
    'node',
    'test/reproduction.mjs',
  ];
  const nothingExists = { cwd: 'work', exists: () => false };

  it('accepts a record command with only files, an expectation, and the command', () => {
    const parsed = parseRecordArguments(minimalRecordArguments, nothingExists);

    expect(parsed.request).toMatchObject({
      environment_image: APPROVED_REPLAY_IMAGE,
      output_path: 'reproduction.proofissue.yaml',
      project_root: '.',
      reproduction_paths: ['test/reproduction.mjs'],
      subject_paths: ['src/calculate.mjs'],
    });
  });

  it('derives the artifact name from the first reproduction file', () => {
    const parsed = parseRecordArguments(
      [
        '--reproduction',
        'test/second.mjs',
        '--reproduction',
        'test/other.mjs',
        '--subject',
        'src/a.mjs',
        '--expect-stderr',
        'x',
        '--',
        'node',
        'test/second.mjs',
      ],
      nothingExists,
    );

    expect(parsed.request.output_path).toBe('second.proofissue.yaml');
  });

  it('keeps an explicit --output, image, and project exactly as given', () => {
    const image = `node@sha256:${'1'.repeat(64)}`;
    const parsed = parseRecordArguments(
      [
        '--output',
        'mine.proofissue',
        '--image',
        image,
        '--project',
        'sub',
        ...minimalRecordArguments,
      ],
      nothingExists,
    );

    expect(parsed.request).toMatchObject({
      environment_image: image,
      output_path: 'mine.proofissue',
      project_root: 'sub',
    });
  });

  it('adds a numeric suffix when the default name exists and refuses after -99', () => {
    const taken = new Set(['reproduction.proofissue.yaml', 'reproduction-2.proofissue.yaml']);
    const exists = (candidate: string): boolean =>
      taken.has(path.basename(candidate)) && path.dirname(candidate) === 'work';

    expect(
      parseRecordArguments(minimalRecordArguments, { cwd: 'work', exists }).request.output_path,
    ).toBe('reproduction-3.proofissue.yaml');

    expect(() =>
      parseRecordArguments(minimalRecordArguments, { cwd: 'work', exists: () => true }),
    ).toThrow('pass --output <file>');
  });

  it('renders grouped roles, consequences, limits, and safe redaction metadata', () => {
    const preview = renderRecordPreview({
      host_node_major: 24,
      output_path: 'failure.proofissue.yaml',
      replay_image: APPROVED_REPLAY_IMAGE,
      command: { program: 'node', arguments: ['test/reproduction.mjs'] },
      reproduction_files: ['test/reproduction.mjs'],
      subject_files: ['src/subject.mjs'],
      expectations: {
        exit_code: 1,
        stdout: [],
        stderr: [{ mode: 'contains' as const, normalize: [], value: 'failure marker' }],
      },
      limits: {
        timeout_seconds: 60,
        memory_mb: 512,
        cpus: 1,
        processes: 64,
        output_bytes_per_stream: 1024,
      },
      output: {
        stdout: {
          discarded_bytes: 0,
          had_decoding_replacement: false,
          retained_bytes: 0,
          total_bytes: 0,
          truncated: false,
        },
        stderr: {
          discarded_bytes: 0,
          had_decoding_replacement: false,
          retained_bytes: 14,
          total_bytes: 14,
          truncated: false,
        },
      },
      redaction: {
        finding_count: 1,
        findings: [
          {
            category: 'api_key',
            target: 'stdout',
            count: 1,
            replacement: '[REDACTED:api_key]',
          },
        ],
      },
    });

    expect(preview).toContain('Files kept exactly as recorded');
    expect(preview).toContain('Files that may be replaced');
    expect(preview).toContain('may hide a real fix');
    expect(preview).toContain('stdout: api_key × 1');
    expect(preview).not.toContain('synthetic-secret');
  });

  it('renders each expectation mode with its normalization', () => {
    const stream = {
      discarded_bytes: 0,
      had_decoding_replacement: false,
      retained_bytes: 0,
      total_bytes: 0,
      truncated: false,
    };
    const all = [
      'line_endings',
      'ansi_escapes',
      'trailing_whitespace',
      'paths',
      'node_version',
      'node_internal_locations',
      'process_ids',
      'durations',
    ] as const;
    const preview = renderRecordPreview({
      host_node_major: 24,
      output_path: 'failure.proofissue.yaml',
      replay_image: APPROVED_REPLAY_IMAGE,
      command: { program: 'node', arguments: ['test/reproduction.mjs'] },
      reproduction_files: ['test/reproduction.mjs'],
      subject_files: ['src/subject.mjs'],
      expectations: {
        exit_code: 1,
        stdout: [{ mode: 'exact', normalize: [], value: 'checking\n' }],
        stderr: [
          { mode: 'contains', normalize: [], value: 'raw' },
          { mode: 'contains', normalize: all, value: 'took <duration>' },
          { mode: 'exact', normalize: all, value: 'whole <tmp>\n' },
          { mode: 'exact', normalize: ['line_endings', 'paths'], value: 'other\n' },
        ],
      },
      limits: {
        timeout_seconds: 60,
        memory_mb: 512,
        cpus: 1,
        processes: 64,
        output_bytes_per_stream: 1024,
      },
      output: { stdout: stream, stderr: stream },
      redaction: { finding_count: 0, findings: [] },
    });

    expect(preview).toContain(
      [
        'Expected failure:',
        '  exit code: 1',
        '  stdout is exactly: "checking\\n"',
        '  stderr contains: "raw"',
        '  stderr contains after normalization: "took <duration>"',
        '  stderr after normalization is exactly: "whole <tmp>\\n"',
        '  stderr after normalization is exactly: "other\\n"',
        '  normalization: line endings, terminal escape sequences, trailing whitespace, paths (<project>, <tmp>), Node.js version, Node.js internal locations, process IDs, durations',
        '  normalization: line endings, paths (<project>, <tmp>)',
        '',
      ].join('\n'),
    );
  });

  it('escapes characters that could hide or reorder an expected value in the preview', () => {
    const stream = {
      discarded_bytes: 0,
      had_decoding_replacement: false,
      retained_bytes: 0,
      total_bytes: 0,
      truncated: false,
    };
    const hidden = `a${String.fromCharCode(0x202e)}b${String.fromCharCode(0x85)}c${String.fromCharCode(127)}`;
    const preview = renderRecordPreview({
      host_node_major: 24,
      output_path: 'failure.proofissue.yaml',
      replay_image: APPROVED_REPLAY_IMAGE,
      command: { program: 'node', arguments: ['x.mjs'] },
      reproduction_files: ['x.mjs'],
      subject_files: ['y.mjs'],
      expectations: {
        exit_code: 1,
        stdout: [],
        stderr: [{ mode: 'exact', normalize: [], value: hidden }],
      },
      limits: {
        timeout_seconds: 60,
        memory_mb: 512,
        cpus: 1,
        processes: 64,
        output_bytes_per_stream: 1024,
      },
      output: { stdout: stream, stderr: stream },
      redaction: { finding_count: 0, findings: [] },
    });

    expect(preview).toContain('  stderr is exactly: "a\\u{202e}b\\u{0085}c\\u{007f}"');
    expect(preview).not.toContain(String.fromCharCode(0x202e));
    expect(preview).not.toContain(String.fromCharCode(0x85));
  });

  it('creates a validated artifact with explicit noninteractive confirmation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-'));
    await mkdir(path.join(root, 'test'));
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
    const output = path.join(root, 'failure.proofissue');
    let written = '';
    const io: CliIo = {
      write: (text) => {
        written += text;
      },
      confirm: () => Promise.reject(new Error('Noninteractive mode must not prompt.')),
    };
    try {
      const result = await runCli(
        [
          'record',
          '--project',
          root,
          '--output',
          output,
          '--image',
          `node@sha256:${'1'.repeat(64)}`,
          '--reproduction',
          'test/reproduction.mjs',
          '--subject',
          'src/subject.mjs',
          '--expect-stderr',
          'failure marker',
          '--yes',
          '--',
          'node',
          'test/reproduction.mjs',
        ],
        io,
      );

      expect(result).toMatchObject({ exit_code: 0, result: { status: 'created' } });
      expect(written).toContain('ProofIssue recording preview');
      expect(written).toContain('Artifact created.');
      expect(await readFile(output, 'utf8')).toContain('version: 1');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('does not repeat a likely secret given as an expected value', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-secret-'));
    await mkdir(path.join(root, 'test'));
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
    const output = path.join(root, 'failure.proofissue');
    // Built at run time so no secret-shaped literal is committed.
    const secret = 'sk-' + 'proj-' + 'SYNTHETICTESTONLYvalue';
    const { io, output: text } = capture();
    try {
      const result = await runCli(
        [
          'record',
          '--project',
          root,
          '--output',
          output,
          '--image',
          `node@sha256:${'1'.repeat(64)}`,
          '--reproduction',
          'test/reproduction.mjs',
          '--subject',
          'src/subject.mjs',
          '--expect-stderr',
          secret,
          '--yes',
          '--',
          'node',
          'test/reproduction.mjs',
        ],
        io,
      );

      expect(result.exit_code).toBe(1);
      expect(text()).toContain('Recording failed:');
      expect(text()).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('escapes control characters in an unknown command name', async () => {
    const escape = String.fromCharCode(27);
    const { io, output } = capture();

    const result = await runCli([`${escape}]0;spoofed title`], io);

    expect(result.exit_code).toBe(2);
    expect(output()).toContain('Unknown command: ');
    expect(output()).not.toContain(escape);
  });

  it('escapes control characters in an unknown option name', async () => {
    const escape = String.fromCharCode(27);
    const { io, output } = capture();

    const result = await runCli(['validate', validFixture, `--${escape}[31mred`], io);

    expect(result.exit_code).toBe(2);
    expect(output()).toContain('Unknown option: ');
    expect(output()).not.toContain(escape);
  });
});

describe('record CLI dependency capture', () => {
  const stream = {
    discarded_bytes: 0,
    had_decoding_replacement: false,
    retained_bytes: 0,
    total_bytes: 0,
    truncated: false,
  };
  const basePreview = {
    host_node_major: 24,
    output_path: 'failure.proofissue.yaml',
    replay_image: APPROVED_REPLAY_IMAGE,
    command: { program: 'node' as const, arguments: ['test/reproduction.mjs'] },
    reproduction_files: ['test/reproduction.mjs'],
    subject_files: ['src/subject.mjs'],
    expectations: {
      exit_code: 1,
      stdout: [],
      stderr: [{ mode: 'contains' as const, normalize: [], value: 'failure marker' }],
    },
    limits: {
      timeout_seconds: 60,
      memory_mb: 512,
      cpus: 1,
      processes: 64,
      output_bytes_per_stream: 1024,
    },
    output: { stdout: stream, stderr: stream },
    redaction: { finding_count: 0, findings: [] },
  };
  const dependencies = (packageCount: number, installScripts: number) => ({
    files: ['package.json', 'package-lock.json'],
    install_script_packages: installScripts,
    package_count: packageCount,
  });
  const requiredArguments = [
    '--project',
    '.',
    '--output',
    'failure.proofissue',
    '--image',
    `node@sha256:${'1'.repeat(64)}`,
    '--reproduction',
    'test/a.mjs',
    '--subject',
    'src/a.mjs',
    '--expect-stderr',
    'failure marker',
  ];

  it('warns in the preview when --image is not the approved image', () => {
    const approved = renderRecordPreview(basePreview);
    const other = renderRecordPreview({
      ...basePreview,
      replay_image: `node@sha256:${'1'.repeat(64)}`,
    });

    expect(approved).toContain('Replay image: approved Node.js 24 image');
    expect(approved).not.toContain('Warning');
    expect(other).toContain('Warning: this is not the approved replay image');
    expect(other).toContain(`node@sha256:${'1'.repeat(64)}`);
  });

  it('warns when recording with a Node.js major other than 24', () => {
    const rendered = renderRecordPreview({ ...basePreview, host_node_major: 22 });

    expect(rendered).toContain('recorded with Node.js 22, but replay always uses Node.js 24');
    expect(renderRecordPreview(basePreview)).not.toContain('recorded with Node.js');
  });

  it('shows where the artifact will be written, escaped', () => {
    const rendered = renderRecordPreview({
      ...basePreview,
      output_path: 'a\u001b[31mb.proofissue',
    });

    expect(rendered).toContain('Artifact file: a\\u{001b}[31mb.proofissue');
    expect(rendered).not.toContain('\u001b');
  });

  it('normalizes ./ and backslash selections before recording', () => {
    const select = (platform: 'posix' | 'win32', reproduction: string, subject: string) =>
      parseRecordArguments(
        [
          '--reproduction',
          reproduction,
          '--subject',
          subject,
          '--expect-stderr',
          'x',
          '--',
          'node',
          'test/a.mjs',
        ],
        { cwd: 'work', exists: () => false, platform },
      ).request;

    const windows = select('win32', '.\\test\\a.mjs', './src\\a.mjs');
    expect(windows.reproduction_paths).toEqual(['test/a.mjs']);
    expect(windows.subject_paths).toEqual(['src/a.mjs']);

    const posix = select('posix', './test/a.mjs', '././src/a.mjs');
    expect(posix.reproduction_paths).toEqual(['test/a.mjs']);
    expect(posix.subject_paths).toEqual(['src/a.mjs']);
    // A backslash is part of a name on posix, so it is left for the recorder to refuse.
    expect(select('posix', 'test\\a.mjs', 'src/a.mjs').reproduction_paths).toEqual(['test\\a.mjs']);
    expect(toPortableProjectPath('..\\x', 'win32')).toBe('../x');
  });

  it('refuses an argument holding the project path before running the command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-arguments-'));
    try {
      await mkdir(path.join(root, 'test'));
      await mkdir(path.join(root, 'src'));
      await writeFile(
        path.join(root, 'test', 'a.mjs'),
        "import { writeFileSync } from 'node:fs'; writeFileSync('ran.txt', 'x'); console.error('failure'); process.exitCode = 1;\n",
      );
      await writeFile(path.join(root, 'src', 'a.mjs'), 'export {};\n');
      const { io, output } = capture();

      const result = await runCli(
        [
          'record',
          '--project',
          root,
          '--output',
          path.join(root, 'out.proofissue'),
          '--reproduction',
          './test/a.mjs',
          '--subject',
          'src/a.mjs',
          '--expect-stderr',
          'failure',
          '--yes',
          '--',
          'node',
          'test/a.mjs',
          path.join(root, 'src', 'a.mjs'),
        ],
        io,
      );

      expect(result.exit_code).toBe(1);
      expect(output()).toContain('Recording failed: Command argument 2 (after node) holds a path');
      expect(output()).not.toContain('ProofIssue recording preview');
      expect(output().replaceAll(root, '')).toBe(output());
      await expect(stat(path.join(root, 'ran.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(stat(path.join(root, 'out.proofissue'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('prints the path, digest prefix, attach guidance, and the replay command after creation', () => {
    const rendered = renderRecordSuccess({
      digest: 'abcdef0123456789'.repeat(4),
      has_dependencies: false,
      output_path: 'reproduction.proofissue.yaml',
    });

    expect(rendered.split('\n')).toEqual([
      'Artifact created.',
      'Saved: reproduction.proofissue.yaml (sha256 abcdef012345)',
      'To share it, drag the file into a GitHub issue comment: GitHub accepts the .yaml extension.',
      'A maintainer replays it on x86-64 Linux with Docker:',
      '  proofissue replay reproduction.proofissue.yaml',
      'On x86-64 Linux with Docker you can check it yourself first:',
      '  proofissue replay reproduction.proofissue.yaml --require-status reproduced',
      '',
    ]);
  });

  it('prints the prepare and replay commands for an artifact with dependencies', () => {
    const rendered = renderRecordSuccess({
      digest: 'f'.repeat(64),
      has_dependencies: true,
      output_path: 'failure.proofissue.yaml',
    });

    expect(rendered).toContain(
      '  proofissue prepare failure.proofissue.yaml --dependency-store .proofissue-store\n',
    );
    expect(rendered).toContain(
      '  proofissue replay failure.proofissue.yaml --dependency-store .proofissue-store\n',
    );
    expect(rendered).toContain('--dependency-store .proofissue-store --require-status reproduced');
  });

  it('says how to attach a .proofissue file, which GitHub refuses', () => {
    const rendered = renderRecordSuccess({
      digest: '0'.repeat(64),
      has_dependencies: false,
      output_path: 'failure.proofissue',
    });

    expect(rendered).toContain('GitHub does not accept the .proofissue extension');
    expect(rendered).toContain('ending in .yaml');
  });

  it.each([
    ['plain/name.proofissue.yaml', 'plain/name.proofissue.yaml'],
    ['my file.proofissue.yaml', '"my file.proofissue.yaml"'],
    ["it's $HOME.yaml", "'it'\\''s $HOME.yaml'"],
    ['a\u001bb.yaml', '"a\\u{001b}b.yaml"'],
  ])('quotes %j for the suggested commands', (value, expected) => {
    expect(quotePathForCommand(value)).toBe(expected);
  });

  it('prints every error, escaped, and not only the first', () => {
    const rendered = renderRecordFailure([
      { message: 'first problem' },
      { message: 'second\u001b[31m problem' },
    ]);

    expect(rendered).toBe(
      'Recording failed: first problem\nRecording failed: second\\u{001b}[31m problem\n',
    );
    expect(renderRecordFailure([])).toBe('Recording failed: unknown error\n');
  });

  it('documents the flag and its limits', () => {
    expect(RECORD_HELP).toContain('--dependencies');
    expect(RECORD_HELP).toContain('lockfile version 3');
    expect(RECORD_HELP).toContain('public npm registry');
    expect(RECORD_HELP).toContain('run proofissue prepare');
  });

  it('asks for dependency files only when --dependencies is given', () => {
    const without = parseRecordArguments([...requiredArguments, '--', 'node', 'test/a.mjs']);
    const withFlag = parseRecordArguments([
      ...requiredArguments,
      '--dependencies',
      '--',
      'node',
      'test/a.mjs',
    ]);

    expect(without.request).not.toHaveProperty('include_dependencies');
    expect(withFlag.request.include_dependencies).toBe(true);
    expect(withFlag.request.arguments).toEqual(['test/a.mjs']);
  });

  it('accepts the flag anywhere before the command', () => {
    const parsed = parseRecordArguments([
      '--dependencies',
      ...requiredArguments,
      '--yes',
      '--',
      'node',
      'test/a.mjs',
    ]);

    expect(parsed.request.include_dependencies).toBe(true);
    expect(parsed.noninteractive_confirmation).toBe(true);
  });

  it('does not take the next argument as the flag value', () => {
    const parsed = parseRecordArguments([
      ...requiredArguments,
      '--dependencies',
      '--yes',
      '--',
      'node',
      'test/a.mjs',
    ]);

    expect(parsed.noninteractive_confirmation).toBe(true);
  });

  it('shows the dependency files, package count, and the prepare step', () => {
    const rendered = renderRecordPreview({ ...basePreview, dependencies: dependencies(42, 0) });

    expect(rendered).toContain('Dependency files (recorded exactly as they are');
    expect(rendered).toContain('  package.json\n  package-lock.json');
    expect(rendered).toContain('42 packages from the public npm registry');
    expect(rendered).toContain('Run proofissue prepare before replay');
    expect(rendered).not.toContain('install scripts');
  });

  it('uses the singular for one package and names install scripts when present', () => {
    const rendered = renderRecordPreview({ ...basePreview, dependencies: dependencies(1, 1) });

    expect(rendered).toContain('1 package from the public npm registry');
    expect(rendered).toContain('1 package declares install scripts, which are never run.');
    expect(renderRecordPreview({ ...basePreview, dependencies: dependencies(5, 3) })).toContain(
      '3 packages declare install scripts, which are never run.',
    );
  });

  it('places the dependency section between the file groups and the expectations', () => {
    const rendered = renderRecordPreview({ ...basePreview, dependencies: dependencies(2, 0) });

    const subjectAt = rendered.indexOf('Files that may be replaced');
    const dependencyAt = rendered.indexOf('Dependency files');
    const expectedAt = rendered.indexOf('Expected failure:');
    expect(subjectAt).toBeLessThan(dependencyAt);
    expect(dependencyAt).toBeLessThan(expectedAt);
  });

  it('adds no dependency section to a preview without dependencies', () => {
    expect(renderRecordPreview(basePreview)).not.toContain('Dependency files');
  });

  it('records dependency files end to end and shows them before writing', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-deps-'));
    await mkdir(path.join(root, 'test'));
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
    await writeFile(path.join(root, 'package.json'), '{"name":"synthetic"}\n');
    await writeFile(
      path.join(root, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { name: 'synthetic' },
          'node_modules/synthetic-dep': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/synthetic-dep/-/synthetic-dep-1.0.0.tgz',
            integrity: `sha512-${'A'.repeat(86)}==`,
          },
        },
      }),
    );
    const output = path.join(root, 'failure.proofissue');
    let written = '';
    const io: CliIo = {
      write: (text) => {
        written += text;
      },
      confirm: () => Promise.reject(new Error('Noninteractive mode must not prompt.')),
    };
    try {
      const result = await runCli(
        [
          'record',
          '--project',
          root,
          '--output',
          output,
          '--image',
          `node@sha256:${'1'.repeat(64)}`,
          '--reproduction',
          'test/reproduction.mjs',
          '--subject',
          'src/subject.mjs',
          '--expect-stderr',
          'failure marker',
          '--dependencies',
          '--yes',
          '--',
          'node',
          'test/reproduction.mjs',
        ],
        io,
      );

      expect(result.exit_code).toBe(0);
      expect(written).toContain('1 package from the public npm registry');
      expect(written).not.toContain('synthetic-dep');
      expect(written).toContain('Artifact created.');
      const artifactText = await readFile(output, 'utf8');
      expect(artifactText).toContain('role: dependency');
      const validated = await runCli(['validate', output], capture().io);
      expect(validated.exit_code).toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('fails with a clear message and writes nothing when the lockfile is unusable', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-cli-deps-bad-'));
    await mkdir(path.join(root, 'test'));
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      "process.stderr.write('failure marker'); process.exitCode = 1;\n",
    );
    await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
    await writeFile(path.join(root, 'package.json'), '{"name":"synthetic"}\n');
    await writeFile(path.join(root, 'package-lock.json'), '{"lockfileVersion":2,"packages":{}}');
    const output = path.join(root, 'failure.proofissue');
    const { io, output: text } = capture();
    try {
      const result = await runCli(
        [
          'record',
          '--project',
          root,
          '--output',
          output,
          '--image',
          `node@sha256:${'1'.repeat(64)}`,
          '--reproduction',
          'test/reproduction.mjs',
          '--subject',
          'src/subject.mjs',
          '--expect-stderr',
          'failure marker',
          '--dependencies',
          '--yes',
          '--',
          'node',
          'test/reproduction.mjs',
        ],
        io,
      );

      expect(result.exit_code).toBe(1);
      expect(text()).toContain('Recording failed:');
      expect(text()).toContain('unsupported_lockfile_version');
      await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
