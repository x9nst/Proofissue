import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { parseAndValidateArtifact, serializeArtifact, sha256 } from '@proofissue/artifact-schema';

import type { ReplayOperationResult } from './index.js';
import { createStaticArtifactApplicationServices, evaluateRequiredReplayStatus } from './index.js';

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
