import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseAndValidateArtifact, serializeArtifact, sha256 } from '@proofissue/artifact-schema';

import type { ReplayOperationResult } from './index.js';
import {
  createRecordApplicationService,
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
