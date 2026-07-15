import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createCliAdapter,
  parseRecordArguments,
  RECORD_HELP,
  renderRecordPreview,
  runCli,
  type CliIo,
} from './index.js';

describe('CLI application boundary', () => {
  it('exports the adapter factory', () => {
    expect(createCliAdapter).toBeTypeOf('function');
  });
});

describe('record CLI', () => {
  it('documents provisional file roles, direct execution, and explicit automation approval', () => {
    expect(RECORD_HELP).toContain('--reproduction');
    expect(RECORD_HELP).toContain('--subject');
    expect(RECORD_HELP).toContain('provisional wording');
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
