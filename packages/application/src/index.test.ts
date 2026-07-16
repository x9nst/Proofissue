import { describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseAndValidateArtifact, serializeArtifact, sha256 } from '@proofissue/artifact-schema';
import type { Runner } from '@proofissue/runner';

import type { ReplayOperationResult } from './index.js';
import {
  createRecordApplicationService,
  createReplayApplicationService,
  createStaticArtifactApplicationServices,
  evaluateRequiredReplayStatus,
  type RecordConfirmation,
  type RecordPreview,
} from './index.js';

const bearer = ['Bear', 'er'].join('');

const replayResult = (status: ReplayOperationResult['status']): ReplayOperationResult => ({
  result_schema_version: 1,
  operation: 'replay',
  status,
  mode: 'snapshot',
  warnings: [],
  errors: [],
  evidence: [],
  differences: [],
  substituted_paths: [],
  scope_limitations: [],
});

describe('evaluateRequiredReplayStatus', () => {
  it('accepts the requested classification without changing the result', () => {
    const result = replayResult('reproduced');

    expect(evaluateRequiredReplayStatus(result, 'reproduced')).toEqual({
      actual: 'reproduced',
      required: 'reproduced',
      satisfied: true,
    });
    expect(result.status).toBe('reproduced');
  });

  it('reports a policy mismatch independently from the classification', () => {
    const result = replayResult('not_reproduced');

    expect(evaluateRequiredReplayStatus(result, 'reproduced')).toEqual({
      actual: 'not_reproduced',
      required: 'reproduced',
      satisfied: false,
    });
    expect(result.status).toBe('not_reproduced');
  });
});

describe('static artifact application services', () => {
  it('validates the permanent version 1 fixture without executing it', async () => {
    const services = createStaticArtifactApplicationServices();
    const result = await services.validate({
      artifact_path: 'tests/fixtures/artifacts/v1/valid/minimal.proofissue',
    });

    expect(result).toMatchObject({
      operation: 'validate',
      status: 'valid',
      artifact_version: 1,
      errors: [],
    });
    expect(result.artifact_digest).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('returns bounded validation errors for an invalid artifact', async () => {
    const services = createStaticArtifactApplicationServices();
    const result = await services.validate({
      artifact_path: 'tests/fixtures/artifacts/v1/invalid/unknown-field.proofissue',
    });

    expect(result.status).toBe('invalid_artifact');
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.length).toBeLessThanOrEqual(50);
  });

  it('does not execute the artifact command or create its requested output', async () => {
    const source = await readFile('tests/fixtures/artifacts/v1/valid/minimal.proofissue');
    const parsed = parseAndValidateArtifact(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-static-validation-'));
    const sentinel = path.join(root, 'must-not-exist.txt');
    const artifactPath = path.join(root, 'inert.proofissue');
    try {
      await writeFile(
        artifactPath,
        serializeArtifact({
          ...parsed.artifact,
          command: {
            program: 'node',
            arguments: [
              '-e',
              `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'unsafe')`,
            ],
            working_directory: '.',
          },
        }),
      );
      const result = await createStaticArtifactApplicationServices().validate({
        artifact_path: artifactPath,
      });
      expect(result.status).toBe('valid');
      await expect(readFile(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('reports grouped redaction metadata without file content or removed values', async () => {
    const source = await readFile('tests/fixtures/artifacts/v1/valid/minimal.proofissue');
    const parsed = parseAndValidateArtifact(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const first = parsed.artifact.files[0];
    if (first === undefined) throw new Error('Compatibility fixture has no file.');
    const redactedContent = `${first.content}\n// [REDACTED:api_key]`;
    const candidate = {
      ...parsed.artifact,
      files: [
        { ...first, content: redactedContent, sha256: sha256(redactedContent) },
        ...parsed.artifact.files.slice(1),
      ],
      redaction: {
        enabled: true as const,
        findings: [
          {
            category: 'api_key' as const,
            target: first.path,
            replacement: '[REDACTED:api_key]',
          },
          {
            category: 'api_key' as const,
            target: first.path,
            replacement: '[REDACTED:api_key]',
          },
        ],
      },
    };
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-inspection-'));
    const artifactPath = path.join(root, 'redacted.proofissue');
    try {
      await writeFile(artifactPath, serializeArtifact(candidate));
      const result = await createStaticArtifactApplicationServices().inspect({
        artifact_path: artifactPath,
      });
      const encoded = JSON.stringify(result);

      expect(result.status).toBe('inspected');
      expect(result.inspection?.redaction).toEqual({
        enabled: true,
        finding_count: 2,
        findings: [{ category: 'api_key', target: first.path, count: 2 }],
      });
      expect(encoded).not.toContain(redactedContent);
      expect(encoded).not.toContain('SYNTHETIC_SECRET_REMOVED');
      expect(encoded).not.toContain('replacement');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});

describe('record application service', () => {
  const confirmed: RecordConfirmation = {
    reproduction_files_confirmed: true,
    subject_files_confirmed: true,
    write_confirmed: true,
  };

  const setup = async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-application-record-'));
    await mkdir(path.join(root, 'test'));
    await mkdir(path.join(root, 'src'));
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      `process.stdout.write('Authorization: ${bearer} synthetic-token'); process.stderr.write('failure marker'); process.exitCode = 1;\n`,
    );
    await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
    return {
      root,
      output: path.join(root, 'failure.proofissue'),
      request: {
        arguments: ['test/reproduction.mjs'],
        environment_image: `node@sha256:${'1'.repeat(64)}`,
        expect_stderr: ['failure marker'],
        expect_stdout: [],
        output_path: path.join(root, 'failure.proofissue'),
        program: 'node' as const,
        project_root: root,
        reproduction_paths: ['test/reproduction.mjs'],
        subject_paths: ['src/subject.mjs'],
      },
    };
  };

  it('shows a content-safe preview and writes only after all confirmations', async () => {
    const fixture = await setup();
    let preview: RecordPreview | undefined;
    try {
      const result = await createRecordApplicationService((value) => {
        preview = value;
        return Promise.resolve(confirmed);
      }).record(fixture.request);

      expect(result).toMatchObject({ status: 'created', artifact_version: 1, errors: [] });
      expect(preview?.reproduction_files).toEqual(['test/reproduction.mjs']);
      expect(preview?.subject_files).toEqual(['src/subject.mjs']);
      expect(preview?.redaction.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'authorization_header',
            target: 'stdout',
            count: 1,
          }),
        ]),
      );
      expect(JSON.stringify(preview)).not.toContain('synthetic-token');
      expect(JSON.stringify(preview)).not.toContain('decoded_text');
      expect(await readFile(fixture.output, 'utf8')).not.toContain('synthetic-token');
      expect(
        (
          await createStaticArtifactApplicationServices().validate({
            artifact_path: fixture.output,
          })
        ).status,
      ).toBe('valid');
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it.each([
    [{ ...confirmed, reproduction_files_confirmed: false }],
    [{ ...confirmed, subject_files_confirmed: false }],
    [{ ...confirmed, write_confirmed: false }],
  ])('cancels without writing when any confirmation is declined', async (confirmation) => {
    const fixture = await setup();
    try {
      const result = await createRecordApplicationService(() =>
        Promise.resolve(confirmation),
      ).record(fixture.request);
      expect(result.status).toBe('cancelled');
      await expect(readFile(fixture.output)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});

describe('replay application service', () => {
  const runner = (
    stderr = 'Expected 4 from calculate(2)',
    exitCode = 1,
    substitutedPaths: readonly string[] = [],
  ): Runner => ({
    run: () =>
      Promise.resolve({
        cleanup: {
          completed: true,
          attempted_resources: ['container', 'workspace'],
          residual_resources: [],
        },
        effective_limits: {
          cpus: 1,
          memory_mb: 512,
          output_bytes_per_stream: 1_048_576,
          processes: 64,
          timeout_seconds: 60,
          writable_workspace_mb: 64,
        },
        events: [],
        execution: {
          duration_ms: 25,
          exit_code: exitCode,
          stdout: {
            decoded_text: '',
            discarded_bytes: 0,
            had_decoding_replacement: false,
            retained_bytes: 0,
            total_bytes: 0,
            truncated: false,
          },
          stderr: {
            decoded_text: stderr,
            discarded_bytes: 0,
            had_decoding_replacement: false,
            retained_bytes: Buffer.byteLength(stderr),
            total_bytes: Buffer.byteLength(stderr),
            truncated: false,
          },
          termination_reason: 'exited',
        },
        substituted_paths: substitutedPaths,
      }),
  });

  it('returns the same explainable classification five consecutive times', async () => {
    const service = createReplayApplicationService({ runner: runner() });
    const results = await Promise.all(
      Array.from(
        { length: 5 },
        async () =>
          await service.replay({
            artifact_path: 'tests/fixtures/artifacts/v1/valid/canonical.proofissue',
            mode: 'snapshot',
          }),
      ),
    );

    expect(results.map((result) => result.status)).toEqual(Array(5).fill('reproduced'));
    expect(results.map((result) => result.evidence)).toEqual(
      Array(5).fill([
        { kind: 'exit_code', message: 'Exit code matched: 1.' },
        { kind: 'stderr_contains', message: 'Expected stderr text was present.' },
      ]),
    );
    expect(JSON.stringify(results)).not.toContain('decoded_text');
  });

  it('explains every mismatch without publishing raw command output', async () => {
    const result = await createReplayApplicationService({
      runner: runner('different failure'),
    }).replay({
      artifact_path: 'tests/fixtures/artifacts/v1/valid/canonical.proofissue',
      mode: 'snapshot',
    });

    expect(result.status).toBe('not_reproduced');
    expect(result.differences).toEqual([
      { kind: 'stderr_missing', message: 'Expected stderr text was not present.' },
    ]);
    expect(JSON.stringify(result)).not.toContain('different failure');
  });

  it('validates before invoking the runner', async () => {
    const unsafeRunner: Runner = {
      run: () => Promise.reject(new Error('Runner must not be called.')),
    };
    const spy = vi.spyOn(unsafeRunner, 'run');
    const result = await createReplayApplicationService({ runner: unsafeRunner }).replay({
      artifact_path: 'tests/fixtures/artifacts/v1/invalid/unknown-field.proofissue',
      mode: 'snapshot',
    });

    expect(result.status).toBe('invalid_artifact');
    expect(spy).not.toHaveBeenCalled();
  });

  it('redacts replay output before matching or returning a result', async () => {
    const synthetic = `Expected 4 from calculate(2)\nAuthorization: ${bearer} synthetic-replay-token`;
    const result = await createReplayApplicationService({ runner: runner(synthetic) }).replay({
      artifact_path: 'tests/fixtures/artifacts/v1/valid/canonical.proofissue',
      mode: 'snapshot',
    });

    expect(result.status).toBe('reproduced');
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'replay_output_redacted' }),
    );
    expect(JSON.stringify(result)).not.toContain('synthetic-replay-token');
  });

  it('reports corrected declared subjects and the exact current-checkout limitation', async () => {
    const service = createReplayApplicationService({ runner: runner('', 0, ['calculate.mjs']) });
    const result = await service.replay({
      artifact_path: 'tests/fixtures/artifacts/v1/valid/canonical.proofissue',
      mode: 'current_checkout',
      against_path: '.',
    });

    expect(result.status).toBe('not_reproduced');
    expect(result.substituted_paths).toEqual(['calculate.mjs']);
    expect(result.scope_limitations).toEqual([
      {
        code: 'declared_subject_paths_only',
        message:
          'Only listed subject paths were substituted; undeclared additions, removals, and renames were not evaluated.',
      },
    ]);
    expect(result.differences).toEqual([
      { kind: 'exit_code', message: 'Expected exit code 1 but received 0.' },
      { kind: 'stderr_missing', message: 'Expected stderr text was not present.' },
    ]);
  });
});
