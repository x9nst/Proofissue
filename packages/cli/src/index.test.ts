import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCliAdapter,
  parseRecordArguments,
  RECORD_HELP,
  renderReplayResult,
  renderRecordPreview,
  runCli,
  type CliIo,
} from './index.js';

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
    [['frobnicate'], 'Unknown command: frobnicate'],
  ])('%j exits 2 with a message and the usage text', async (arguments_, message) => {
    const { io, output } = capture();

    const result = await runCli(arguments_, io);

    expect(result.exit_code).toBe(2);
    expect(result.result).toBeUndefined();
    expect(output()).toContain(message);
    expect(output()).toContain('Usage:');
  });

  it.each([[[]], [['--help']], [['-h']]])('%j prints usage and exits 0', async (arguments_) => {
    const { io, output } = capture();

    const result = await runCli(arguments_, io);

    expect(result.exit_code).toBe(0);
    expect(output()).toContain('Usage:');
  });

  it('never calls an application service when arguments are rejected', async () => {
    const { io } = capture();
    const application = {
      inspect: () => Promise.reject(new Error('must not be called')),
      replay: () => Promise.reject(new Error('must not be called')),
      validate: () => Promise.reject(new Error('must not be called')),
    };

    const results = await Promise.all([
      runCli(['validate', '--json'], io, application),
      runCli(['inspect', 'a.proofissue', '--bogus'], io, application),
      runCli(['replay', 'a.proofissue', '--require-status', 'bogus'], io, application),
    ]);

    expect(results.map((result) => result.exit_code)).toEqual([2, 2, 2]);
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

  it('renders grouped roles, consequences, limits, and safe redaction metadata', () => {
    const preview = renderRecordPreview({
      command: { program: 'node', arguments: ['test/reproduction.mjs'] },
      reproduction_files: ['test/reproduction.mjs'],
      subject_files: ['src/subject.mjs'],
      expectations: { exit_code: 1, stdout: [], stderr: ['failure marker'] },
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
    command: { program: 'node' as const, arguments: ['test/reproduction.mjs'] },
    reproduction_files: ['test/reproduction.mjs'],
    subject_files: ['src/subject.mjs'],
    expectations: { exit_code: 1, stdout: [], stderr: ['failure marker'] },
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

  it('documents the flag and its limits', () => {
    expect(RECORD_HELP).toContain('--dependencies');
    expect(RECORD_HELP).toContain('lockfile version 3');
    expect(RECORD_HELP).toContain('public npm registry');
    expect(RECORD_HELP).toContain('not supported yet');
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

  it('shows the dependency files, package count, and the replay limitation', () => {
    const rendered = renderRecordPreview({ ...basePreview, dependencies: dependencies(42, 0) });

    expect(rendered).toContain('Dependency files (recorded exactly as they are');
    expect(rendered).toContain('  package.json\n  package-lock.json');
    expect(rendered).toContain('42 packages from the public npm registry');
    expect(rendered).toContain('Replaying an artifact with dependency files is not supported yet.');
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
