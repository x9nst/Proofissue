import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  parseAndValidateArtifact,
  serializeArtifact,
  sha256,
  type ArtifactOutputExpectationV1,
  type ArtifactV1,
} from '@proofissue/artifact-schema';
import { DEFAULT_OUTPUT_NORMALIZATION } from '@proofissue/output-rules';
import {
  APPROVED_NODE_IMAGE,
  createDockerRunner,
  type ContainerCreateSpec,
  type ContainerEngine,
  type ContainerState,
} from '@proofissue/runner';

import { createRecordApplicationService, createReplayApplicationService } from './index.js';

const integration = describe.runIf(process.env.PROOFISSUE_RUN_CONTAINER_TESTS === '1');

class LocalFixtureEngine implements ContainerEngine {
  #spec: ContainerCreateSpec | undefined;

  assertCapabilities(): Promise<void> {
    return Promise.resolve();
  }

  imageExists(): Promise<boolean> {
    return Promise.resolve(true);
  }

  create(spec: ContainerCreateSpec): Promise<void> {
    this.#spec = spec;
    return Promise.resolve();
  }

  async start(
    _name: string,
    onStdout: (chunk: Uint8Array) => void,
    onStderr: (chunk: Uint8Array) => void,
  ): Promise<ContainerState> {
    const spec = this.#spec;
    if (spec === undefined) throw new Error('Fixture engine was not prepared.');
    return await new Promise<ContainerState>((resolve, reject) => {
      const child = spawn(process.execPath, [...spec.arguments], {
        cwd: spec.input_path,
        env: {},
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stdout.on('data', (chunk: Buffer) => {
        onStdout(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        onStderr(chunk);
      });
      child.once('error', reject);
      child.once('close', (code, signal) => {
        resolve({
          ...(code === null ? {} : { exit_code: code }),
          ...(signal === null ? {} : { signal }),
          oom_killed: false,
        });
      });
    });
  }

  stop(): Promise<void> {
    return Promise.resolve();
  }

  kill(): Promise<void> {
    return Promise.resolve();
  }

  remove(): Promise<void> {
    return Promise.resolve();
  }
}

const runFixVerificationFixture = async (useRealContainer: boolean): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-fix-verification-'));
  const checkout = path.join(root, 'checkout');
  const artifactPath = path.join(root, 'failure.proofissue');
  await mkdir(checkout);
  try {
    const source = await readFile('tests/fixtures/artifacts/v1/valid/canonical.proofissue');
    const parsed = parseAndValidateArtifact(source);
    if (!parsed.ok) throw new Error('Canonical fixture must be valid.');
    await writeFile(
      artifactPath,
      serializeArtifact({
        ...parsed.artifact,
        environment: { ...parsed.artifact.environment, image: APPROVED_NODE_IMAGE },
      }),
    );
    await writeFile(
      path.join(checkout, 'calculate.mjs'),
      'export function calculate(value) { return value * 2; }\n',
    );
    await writeFile(
      path.join(checkout, 'reproduction.mjs'),
      'throw new Error("checkout reproduction must be ignored");\n',
    );
    await writeFile(path.join(checkout, 'new-file.mjs'), 'throw new Error("must be ignored");\n');

    const runner = useRealContainer
      ? undefined
      : createDockerRunner({ engine: new LocalFixtureEngine() });
    const replay = createReplayApplicationService({
      ...(runner === undefined ? {} : { runner }),
    }).replay;
    const snapshot = await replay({ artifact_path: artifactPath, mode: 'snapshot' });
    const corrected = await replay({
      artifact_path: artifactPath,
      mode: 'current_checkout',
      against_path: checkout,
    });

    expect(snapshot.status).toBe('reproduced');
    expect(snapshot.evidence).toEqual([
      { kind: 'exit_code', message: 'Exit code matched: 1.' },
      { kind: 'stderr_contains', message: 'Expected stderr text was present.' },
    ]);
    expect(corrected.status).toBe('not_reproduced');
    expect(corrected.execution?.exit_code).toBe(0);
    expect(corrected.substituted_paths).toEqual(['calculate.mjs']);
    expect(corrected.scope_limitations).toContainEqual({
      code: 'declared_subject_paths_only',
      message:
        'Only listed subject paths were substituted; undeclared additions, removals, and renames were not evaluated.',
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe('Milestone 5 fix verification through the shared application service', () => {
  it('reproduces the snapshot and does not reproduce with only the corrected declared subject', async () => {
    await runFixVerificationFixture(false);
  });
});

integration('Milestone 5 fix verification', () => {
  it('reproduces the snapshot and does not reproduce with only the corrected declared subject', async () => {
    await runFixVerificationFixture(true);
  }, 60_000);
});

// A reproduction whose output differs on every run and between machines: a color escape, a
// carriage return, a duration that changes, and (optionally) the module URL and the temporary
// directory. It is written without backslash escapes so it survives any tooling.
const outputMatchingReproduction = (withLocations: boolean): string =>
  [
    "import { calculate } from './calculate.mjs';",
    ...(withLocations ? ["import os from 'node:os';"] : []),
    '',
    'const started = Date.now();',
    'if (calculate(2) !== 4) {',
    '  const elapsed = Date.now() - started + 1;',
    '  const esc = String.fromCharCode(27);',
    "  process.stderr.write(esc + '[31mExpected 4 from calculate(2) (' + elapsed + 'ms)' + esc + '[0m' + String.fromCharCode(13, 10));",
    ...(withLocations
      ? [
          "  process.stderr.write('    at ' + import.meta.url + String.fromCharCode(10));",
          "  process.stderr.write('tmp=' + os.tmpdir() + String.fromCharCode(10));",
        ]
      : []),
    '  process.exitCode = 1;',
    '}',
    '',
  ].join(String.fromCharCode(10));

const SUBJECT_SOURCE = 'export function calculate(value) { return value + 1; }\n';
const FIXED_SUBJECT_SOURCE = 'export function calculate(value) { return value * 2; }\n';

const all = [...DEFAULT_OUTPUT_NORMALIZATION];

// Expectations written the way they are stored: already normalized.
const outputMatchingExpectations = (
  withLocations: boolean,
): readonly ArtifactOutputExpectationV1[] => [
  {
    mode: 'contains',
    normalize: all,
    value: 'Expected 4 from calculate(2) (<duration>)',
  },
  ...(withLocations
    ? ([
        { mode: 'contains', normalize: all, value: 'at <project>/reproduction.mjs' },
        { mode: 'contains', normalize: all, value: 'tmp=<tmp>' },
      ] as const)
    : []),
  {
    mode: 'exact',
    normalize: all,
    value: withLocations
      ? 'Expected 4 from calculate(2) (<duration>)\n    at <project>/reproduction.mjs\ntmp=<tmp>\n'
      : 'Expected 4 from calculate(2) (<duration>)\n',
  },
];

// Patterns are stored as typed and matched against the normalized output, so they name the same
// tokens a normalized literal does.
const regexExpectations = (withLocations: boolean): readonly ArtifactOutputExpectationV1[] => [
  {
    mode: 'regex',
    normalize: all,
    value: String.raw`Expected \d+ from calculate\(\d+\) \(<duration>\)`,
  },
  ...(withLocations
    ? ([
        { mode: 'regex', normalize: all, value: String.raw`^ {4}at <project>/reproduction\.mjs$` },
        { mode: 'regex', normalize: all, value: String.raw`^tmp=<tmp>$` },
      ] as const)
    : []),
];

const outputMatchingArtifact = (
  withLocations: boolean,
  stderr: readonly ArtifactOutputExpectationV1[],
): ArtifactV1 => {
  const reproduction = outputMatchingReproduction(withLocations);
  return {
    version: 1,
    environment: {
      runtime: 'node',
      runtime_version: '24',
      operating_system: 'linux',
      image: APPROVED_NODE_IMAGE,
    },
    capture: { host_operating_system: 'linux', host_architecture: 'x64', node_version: '24.15.0' },
    command: { program: 'node', arguments: ['reproduction.mjs'], working_directory: '.' },
    files: [
      {
        path: 'calculate.mjs',
        role: 'subject',
        encoding: 'utf8',
        content: SUBJECT_SOURCE,
        sha256: sha256(SUBJECT_SOURCE),
      },
      {
        path: 'reproduction.mjs',
        role: 'reproduction',
        encoding: 'utf8',
        content: reproduction,
        sha256: sha256(reproduction),
      },
    ],
    expect: { exit_code: 1, stdout: [], stderr },
    limits: {
      timeout_seconds: 30,
      memory_mb: 512,
      cpus: 1,
      processes: 64,
      output_bytes_per_stream: 1_048_576,
    },
    redaction: { enabled: true, findings: [] },
  };
};

const DIFFERENCE_KIND = {
  contains: 'stderr_missing',
  exact: 'stderr_differs',
  regex: 'stderr_no_match',
} as const;

const expectedKinds = (stderr: readonly ArtifactOutputExpectationV1[]) => ({
  evidence: ['exit_code', ...stderr.map((item) => `stderr_${item.mode}`)],
  differences: ['exit_code', ...stderr.map((item) => DIFFERENCE_KIND[item.mode])],
});

const runOutputMatchingFixture = async (
  useRealContainer: boolean,
  withLocations: boolean,
  expectations: (
    withLocations: boolean,
  ) => readonly ArtifactOutputExpectationV1[] = outputMatchingExpectations,
): Promise<void> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-output-matching-'));
  const checkout = path.join(root, 'checkout');
  const artifactPath = path.join(root, 'failure.proofissue');
  await mkdir(checkout);
  try {
    const stderr = expectations(withLocations);
    await writeFile(artifactPath, serializeArtifact(outputMatchingArtifact(withLocations, stderr)));
    await writeFile(path.join(checkout, 'calculate.mjs'), FIXED_SUBJECT_SOURCE);
    await writeFile(
      path.join(checkout, 'reproduction.mjs'),
      'throw new Error("checkout reproduction must be ignored");\n',
    );

    const runner = useRealContainer
      ? undefined
      : createDockerRunner({ engine: new LocalFixtureEngine() });
    const replay = createReplayApplicationService({
      ...(runner === undefined ? {} : { runner }),
    }).replay;
    const snapshot = await replay({ artifact_path: artifactPath, mode: 'snapshot' });
    const corrected = await replay({
      artifact_path: artifactPath,
      mode: 'current_checkout',
      against_path: checkout,
    });
    const kinds = expectedKinds(stderr);

    expect(snapshot.status).toBe('reproduced');
    expect(snapshot.evidence.map((item) => item.kind)).toEqual(kinds.evidence);
    expect(snapshot.differences).toEqual([]);
    for (const item of snapshot.evidence.slice(1)) {
      expect(item.normalization?.rules).toEqual(all);
      expect(item.normalization?.changes.map((change) => change.rule)).toEqual(
        expect.arrayContaining(['line_endings', 'ansi_escapes', 'durations']),
      );
    }
    expect(corrected.status).toBe('not_reproduced');
    expect(corrected.execution?.exit_code).toBe(0);
    expect(corrected.differences.map((item) => item.kind)).toEqual(kinds.differences);
    expect(corrected.substituted_paths).toEqual(['calculate.mjs']);

    const encoded = JSON.stringify([snapshot, corrected]);
    expect(encoded).not.toContain('decoded_text');
    expect(encoded).not.toContain(root);
    expect(encoded).not.toContain('Expected 4 from calculate(2)');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe('Output matching fix verification through the shared application service', () => {
  it('reproduces normalized expectations and does not reproduce after the declared fix', async () => {
    await runOutputMatchingFixture(false, false);
  });

  it('reproduces normalized regex expectations and does not reproduce after the declared fix', async () => {
    await runOutputMatchingFixture(false, false, regexExpectations);
  });
});

integration('Output matching fix verification in the locked-down container', () => {
  it('reproduces normalized path and temporary-directory expectations and then the fix', async () => {
    await runOutputMatchingFixture(true, true);
  }, 90_000);

  it('reproduces normalized regex expectations with paths and then the fix', async () => {
    await runOutputMatchingFixture(true, true, regexExpectations);
  }, 90_000);

  it('records on the host and reproduces in the container, then verifies the fix', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-record-then-replay-'));
    const checkout = path.join(root, 'checkout');
    const project = path.join(root, 'project');
    const artifactPath = path.join(root, 'recorded.proofissue');
    await mkdir(checkout);
    await mkdir(project);
    try {
      await writeFile(path.join(project, 'calculate.mjs'), SUBJECT_SOURCE);
      await writeFile(path.join(project, 'reproduction.mjs'), outputMatchingReproduction(true));
      await writeFile(path.join(checkout, 'calculate.mjs'), FIXED_SUBJECT_SOURCE);
      const moduleUrl = pathToFileURL(path.join(await realpath(project), 'reproduction.mjs')).href;

      const recorded = await createRecordApplicationService(() =>
        Promise.resolve({
          reproduction_files_confirmed: true,
          subject_files_confirmed: true,
          write_confirmed: true,
        }),
      ).record({
        arguments: ['reproduction.mjs'],
        environment_image: APPROVED_NODE_IMAGE,
        expect_stderr: [
          { mode: 'contains', normalized: true, value: 'Expected 4 from calculate(2) (' },
          { mode: 'contains', normalized: true, value: `at ${moduleUrl}` },
          { mode: 'contains', normalized: true, value: 'tmp=/tmp' },
          { mode: 'exact', normalized: true },
          {
            mode: 'regex',
            normalized: true,
            pattern: String.raw`Expected \d+ from calculate\(\d+\) \(<duration>\)`,
          },
          {
            mode: 'regex',
            normalized: true,
            pattern: String.raw`^ {4}at <project>/reproduction\.mjs$`,
          },
        ],
        expect_stdout: [],
        output_path: artifactPath,
        program: 'node',
        project_root: project,
        reproduction_paths: ['reproduction.mjs'],
        subject_paths: ['calculate.mjs'],
      });
      expect(recorded).toMatchObject({ status: 'created', errors: [] });
      expect(await readFile(artifactPath, 'utf8')).not.toContain(await realpath(project));

      const replay = createReplayApplicationService().replay;
      const snapshot = await replay({ artifact_path: artifactPath, mode: 'snapshot' });
      const corrected = await replay({
        artifact_path: artifactPath,
        mode: 'current_checkout',
        against_path: checkout,
      });

      expect(snapshot.status).toBe('reproduced');
      expect(snapshot.evidence.map((item) => item.kind)).toEqual([
        'exit_code',
        'stderr_contains',
        'stderr_contains',
        'stderr_contains',
        'stderr_exact',
        'stderr_regex',
        'stderr_regex',
      ]);
      expect(corrected.status).toBe('not_reproduced');
      expect(corrected.differences.map((item) => item.kind)).toEqual([
        'exit_code',
        'stderr_missing',
        'stderr_missing',
        'stderr_missing',
        'stderr_differs',
        'stderr_no_match',
        'stderr_no_match',
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 120_000);
});
