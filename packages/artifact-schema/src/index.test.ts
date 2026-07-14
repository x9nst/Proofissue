import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';

import type { ArtifactV1 } from './index.js';
import type { ArtifactFileError } from './index.js';
import {
  ARTIFACT_LIMITS,
  ARTIFACT_V1_SCHEMA,
  isArtifactPath,
  parseAndValidateArtifact,
  readArtifactFile,
  resolveArtifactPath,
  serializeArtifact,
  sha256,
  validateArtifactValue,
  writeArtifactFile,
} from './index.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const artifact = (overrides: Partial<ArtifactV1> = {}): ArtifactV1 => {
  const reproduction = 'console.error("synthetic failure");\nprocess.exitCode = 1;\n';
  const subject = 'export const value = 1;\n';
  return {
    version: 1,
    environment: {
      runtime: 'node',
      runtime_version: '24',
      operating_system: 'linux',
      image: `node@sha256:${'1'.repeat(64)}`,
    },
    capture: {
      host_operating_system: 'linux',
      host_architecture: 'x64',
      node_version: '24.15.0',
    },
    command: { program: 'node', arguments: ['test/reproduction.mjs'], working_directory: '.' },
    files: [
      {
        path: 'test/reproduction.mjs',
        role: 'reproduction',
        encoding: 'utf8',
        content: reproduction,
        sha256: sha256(reproduction),
      },
      {
        path: 'src/subject.mjs',
        role: 'subject',
        encoding: 'utf8',
        content: subject,
        sha256: sha256(subject),
      },
    ],
    expect: {
      exit_code: 1,
      stdout: [],
      stderr: [{ mode: 'contains', value: 'synthetic failure' }],
    },
    limits: {
      timeout_seconds: 60,
      memory_mb: 512,
      cpus: 1,
      processes: 64,
      output_bytes_per_stream: 1_048_576,
    },
    redaction: { enabled: true, findings: [] },
    ...overrides,
  };
};

const expectInvalid = (value: unknown, code: string): void => {
  const result = validateArtifactValue(value);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.errors.some((error) => error.code === code)).toBe(true);
};

describe('version 1 validation', () => {
  it('keeps the published JSON Schema synchronized with the executable schema', async () => {
    const published = JSON.parse(
      await readFile('packages/artifact-schema/schema/artifact-v1.schema.json', 'utf8'),
    ) as unknown;
    expect(published).toEqual(ARTIFACT_V1_SCHEMA);
  });

  it('accepts the permanent version 1 compatibility fixture', async () => {
    const result = await readArtifactFile('tests/fixtures/artifacts/v1/valid/minimal.proofissue');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.version).toBe(1);
      expect(result.artifact.validated).toBe(true);
      expect(result.artifact.files).toHaveLength(2);
    }
  });

  it('rejects schema violations, unsafe paths, collisions, hashes, and invalid limits', () => {
    expectInvalid({ ...artifact(), unexpected: true }, 'schema_violation');
    expectInvalid(
      { ...artifact(), limits: { ...artifact().limits, memory_mb: 4096 } },
      'schema_violation',
    );

    for (const unsafePath of [
      '/absolute.mjs',
      '../escape.mjs',
      'a/../b.mjs',
      'C:/drive.mjs',
      'a\\b.mjs',
    ]) {
      const base = artifact();
      expectInvalid(
        {
          ...base,
          files: [{ ...base.files[0], path: unsafePath }, base.files[1]],
        },
        unsafePath.includes('..') ? 'semantic_violation' : 'schema_violation',
      );
    }

    const duplicate = artifact();
    expectInvalid(
      {
        ...duplicate,
        files: [duplicate.files[0], { ...duplicate.files[1], path: 'TEST/REPRODUCTION.MJS' }],
      },
      'semantic_violation',
    );
    const invalidHash = artifact();
    expectInvalid(
      {
        ...invalidHash,
        files: [{ ...invalidHash.files[0], sha256: '0'.repeat(64) }, invalidHash.files[1]],
      },
      'semantic_violation',
    );
  });

  it('enforces aggregate and cross-field rules', () => {
    const base = artifact();
    expectInvalid(
      { ...base, files: base.files.filter((file) => file.role === 'subject') },
      'semantic_violation',
    );
    expectInvalid(
      { ...base, expect: { exit_code: 1, stdout: [], stderr: [] } },
      'semantic_violation',
    );
    expectInvalid(
      {
        ...base,
        redaction: {
          enabled: true,
          findings: [
            { category: 'api_key', target: 'missing.mjs', replacement: '[REDACTED:api_key]' },
          ],
        },
      },
      'semantic_violation',
    );

    const oversizedContent = 'x'.repeat(ARTIFACT_LIMITS.scalar_bytes + 1);
    expectInvalid(
      {
        ...base,
        files: [
          base.files[0],
          { ...base.files[1], content: oversizedContent, sha256: sha256(oversizedContent) },
        ],
      },
      'semantic_violation',
    );
  });
});

describe('restricted YAML parsing', () => {
  it.each([
    ['malformed YAML', 'version: ['],
    ['duplicate keys', 'version: 1\nversion: 1\n'],
    ['anchors and aliases', 'value: &shared text\nother: *shared\n'],
    ['custom tags', 'version: !unsafe 1\n'],
    ['multiple documents', 'version: 1\n---\nversion: 1\n'],
  ])('rejects %s', (_name, source) => {
    const result = parseAndValidateArtifact(source);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid UTF-8 and oversized input before parsing', () => {
    expect(parseAndValidateArtifact(Uint8Array.of(0xff)).ok).toBe(false);
    expect(parseAndValidateArtifact(new Uint8Array(ARTIFACT_LIMITS.input_bytes + 1)).ok).toBe(
      false,
    );
  });

  it('bounds depth, node count, and returned errors', () => {
    const deep = `${Array.from(
      { length: ARTIFACT_LIMITS.yaml_depth + 2 },
      (_, index) => `${'  '.repeat(index)}level:`,
    ).join('\n')}\n${'  '.repeat(ARTIFACT_LIMITS.yaml_depth + 2)}value`;
    const deepResult = parseAndValidateArtifact(deep);
    expect(deepResult.ok).toBe(false);
    if (!deepResult.ok) expect(deepResult.errors[0]?.message).toContain('depth limit');

    const nodes = Array.from(
      { length: ARTIFACT_LIMITS.yaml_nodes + 1 },
      (_, index) => `- ${String(index)}`,
    ).join('\n');
    const nodeResult = parseAndValidateArtifact(nodes);
    expect(nodeResult.ok).toBe(false);
    if (!nodeResult.ok) {
      expect(nodeResult.errors[0]?.message).toContain('node limit');
      expect(nodeResult.errors.length).toBeLessThanOrEqual(ARTIFACT_LIMITS.validation_errors);
    }

    const largeScalar = `value: "${'x'.repeat(ARTIFACT_LIMITS.scalar_bytes + 1)}"`;
    const scalarResult = parseAndValidateArtifact(largeScalar);
    expect(scalarResult.ok).toBe(false);
    if (!scalarResult.ok) expect(scalarResult.errors[0]?.message).toContain('scalar exceeds');
  });

  it('fails safely for a reusable generated fuzz sample', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 2048 }), (bytes) => {
        const result = parseAndValidateArtifact(bytes);
        if (!result.ok) {
          expect(result.errors.length).toBeLessThanOrEqual(ARTIFACT_LIMITS.validation_errors);
          expect(
            result.errors.reduce((total, error) => total + error.message.length, 0),
          ).toBeLessThanOrEqual(ARTIFACT_LIMITS.aggregate_error_message_characters);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('retains a reusable restricted-YAML regression corpus', async () => {
    const directory = 'tests/fuzz-corpus/yaml';
    const seeds = (await readdir(directory)).filter((name) => name.endsWith('.yaml'));
    expect(seeds.length).toBeGreaterThanOrEqual(5);
    for (const seed of seeds) {
      const result = parseAndValidateArtifact(await readFile(path.join(directory, seed)));
      expect(result.ok, seed).toBe(false);
      if (!result.ok) expect(result.errors.length).toBeLessThanOrEqual(50);
    }
  });
});

describe('canonical serialization', () => {
  it('matches the permanent canonical byte fixture', async () => {
    const fixture = await readArtifactFile(
      'tests/fixtures/artifacts/v1/valid/canonical.proofissue',
    );
    expect(fixture.ok).toBe(true);
    if (!fixture.ok) return;
    expect(serializeArtifact(fixture.artifact)).toBe(
      await readFile('tests/fixtures/artifacts/v1/valid/canonical.proofissue', 'utf8'),
    );
  });

  it('is byte-for-byte stable and round-trips exact file content', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 256 }),
          fc.constantFrom(
            '',
            'no trailing newline',
            'one trailing newline\n',
            'multiple trailing newlines\n\n\n',
            'tabs\tand unicode \u2603\n',
            'windows\r\nline endings\r\n',
          ),
        ),
        (content) => {
          const base = artifact();
          const subjectFile = base.files[1];
          if (subjectFile === undefined) throw new Error('Fixture setup failed.');
          const candidate = {
            ...base,
            files: [base.files[0], { ...subjectFile, content, sha256: sha256(content) }].filter(
              (file): file is NonNullable<typeof file> => file !== undefined,
            ),
          };
          const first = serializeArtifact(candidate);
          const second = serializeArtifact(candidate);
          expect(second).toBe(first);
          expect(first.endsWith('\n')).toBe(true);
          expect(first.endsWith('\n\n')).toBe(false);
          expect(first.includes('\r')).toBe(false);

          const parsed = parseAndValidateArtifact(first);
          expect(parsed.ok).toBe(true);
          if (parsed.ok) {
            expect(
              parsed.artifact.files.find((file) => file.path === 'src/subject.mjs')?.content,
            ).toBe(content);
          }
        },
      ),
    );
  });

  it('sorts canonical files and redaction findings', () => {
    const base = artifact();
    const first = base.files[0];
    const second = base.files[1];
    if (first === undefined || second === undefined) throw new Error('Fixture setup failed.');
    const serialized = serializeArtifact({
      ...base,
      files: [first, second],
      redaction: {
        enabled: true,
        findings: [
          { category: 'password', target: first.path, replacement: '[REDACTED:password]' },
          { category: 'api_key', target: first.path, replacement: '[REDACTED:api_key]' },
        ],
      },
    });
    expect(serialized.indexOf('- path: "src/subject.mjs"')).toBeLessThan(
      serialized.indexOf('- path: "test/reproduction.mjs"'),
    );
    expect(serialized.indexOf('category: api_key')).toBeLessThan(
      serialized.indexOf('category: password'),
    );
  });
});

describe('path safety properties', () => {
  it('keeps every accepted generated path under the assigned root', () => {
    const segment = fc
      .stringMatching(/^[A-Za-z0-9_-]{1,12}$/u)
      .filter((value) => value !== '.' && value !== '..');
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 6 }), (segments) => {
        const artifactPath = segments.join('/');
        expect(isArtifactPath(artifactPath)).toBe(true);
        expect(resolveArtifactPath('/safe/root', artifactPath).startsWith('/safe/root/')).toBe(
          true,
        );
      }),
    );
  });

  it('rejects generated traversal paths', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('../x', 'a/../x', './x', '/x', 'C:/x', '\\\\host\\share', 'a\\b'),
        (candidate) => {
          expect(isArtifactPath(candidate)).toBe(false);
        },
      ),
    );
  });

  it('rejects generated duplicate and ASCII case-colliding paths in either order', () => {
    const safePath = fc
      .array(fc.stringMatching(/^[A-Za-z0-9_-]{1,10}$/u), { minLength: 1, maxLength: 4 })
      .map((segments) => segments.join('/'));
    fc.assert(
      fc.property(safePath, fc.boolean(), (generatedPath, reverse) => {
        const base = artifact();
        const first = base.files[0];
        const second = base.files[1];
        if (first === undefined || second === undefined) throw new Error('Fixture setup failed.');
        const colliding = [
          { ...first, path: generatedPath },
          { ...second, path: generatedPath.toUpperCase() },
        ];
        const result = validateArtifactValue({
          ...base,
          files: reverse ? colliding.reverse() : colliding,
        });
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.errors.some((error) => error.code === 'semantic_violation')).toBe(true);
      }),
    );
  });
});

describe('artifact file input and publication', () => {
  it('writes a validated artifact atomically and never overwrites', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-artifact-'));
    roots.push(root);
    const output = path.join(root, 'failure.proofissue');

    const written = await writeArtifactFile(output, artifact());
    expect(written.bytes_written).toBe(Buffer.byteLength(await readFile(output)));
    await expect(writeArtifactFile(output, artifact())).rejects.toMatchObject({
      code: 'atomic_write_failed',
    } satisfies Partial<ArtifactFileError>);
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects non-regular and oversized input files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-input-'));
    roots.push(root);
    const directory = path.join(root, 'artifact.proofissue');
    await mkdir(directory);
    expect((await readArtifactFile(directory)).ok).toBe(false);

    const oversized = path.join(root, 'oversized.proofissue');
    await writeFile(oversized, Buffer.alloc(ARTIFACT_LIMITS.input_bytes + 1));
    expect((await readArtifactFile(oversized)).ok).toBe(false);
  });

  it('rejects symbolic-link artifact input where the platform permits the fixture', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-link-'));
    roots.push(root);
    const target = path.join(root, 'target.proofissue');
    const link = path.join(root, 'link.proofissue');
    await writeFile(target, serializeArtifact(artifact()));
    try {
      await symlink(target, link, 'file');
    } catch (error: unknown) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
      if (code === 'EPERM') return;
      throw error;
    }
    expect((await readArtifactFile(link)).ok).toBe(false);
  });
});
