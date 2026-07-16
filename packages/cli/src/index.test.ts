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
