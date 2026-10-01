import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { InspectOperationResult } from '@proofissue/contracts';
import { describe, expect, it } from 'vitest';

import {
  classifyLimit,
  parseInspect,
  parsePrepare,
  parseRecordOutput,
  parseReplay,
  toReplayRun,
} from './cli-results.js';

const fixture = (...segments: readonly string[]): string => {
  const text = readFileSync(
    fileURLToPath(
      new URL(`../../../tests/fixtures/results/v1/${segments.join('/')}`, import.meta.url),
    ),
    'utf8',
  );
  // The CLI prints one line of JSON.
  return JSON.stringify(JSON.parse(text));
};

const withChange = (name: string, change: (value: Record<string, unknown>) => void): string => {
  const value = JSON.parse(fixture(name)) as Record<string, unknown>;
  change(value);
  return JSON.stringify(value);
};

describe('parseReplay', () => {
  it('reads the reproduced fixture', () => {
    const run = parseReplay(fixture('reproduced.json'));

    expect(run).toMatchObject({
      status: 'reproduced',
      mode: 'snapshot',
      evidence_kinds: ['exit_code', 'stderr_contains'],
      difference_kinds: [],
      errors: [],
      cleanup_completed: true,
    });
    expect(run.execution).toMatchObject({
      duration_ms: 125,
      exit_code: 1,
      termination_reason: 'exited',
      stdout: { retained_bytes: 0, total_bytes: 0, truncated: false },
      stderr: { retained_bytes: 36, total_bytes: 36, truncated: false },
    });
    expect(run.effective_limits).toMatchObject({
      cpus: 1,
      memory_mb: 512,
      processes: 64,
      timeout_seconds: 60,
      writable_workspace_mb: 64,
    });
  });

  it('reads the not-reproduced fixtures with their difference kinds', () => {
    expect(parseReplay(fixture('not-reproduced.json'))).toMatchObject({
      status: 'not_reproduced',
    });
    const outputModes = parseReplay(fixture('not-reproduced-output-modes.json'));

    expect(outputModes.status).toBe('not_reproduced');
    expect(outputModes.mode).toBe('current_checkout');
    expect(outputModes.evidence_kinds).toEqual(['stdout_exact']);
    expect(outputModes.difference_kinds).toContain('exit_code');
    expect(outputModes.difference_kinds).toContain('stderr_missing');
    expect([...outputModes.difference_kinds]).toEqual([...outputModes.difference_kinds].sort());
  });

  it('reads the normalized-output fixture', () => {
    const run = parseReplay(fixture('reproduced-normalized.json'));

    expect(run.status).toBe('reproduced');
    expect(run.evidence_kinds.length).toBeGreaterThan(0);
  });

  it('reads the execution-failed and invalid-artifact fixtures', () => {
    const failed = parseReplay(fixture('execution-failed.json'));
    const invalid = parseReplay(fixture('invalid-artifact.json'));

    expect(failed).toMatchObject({
      status: 'execution_failed',
      errors: [{ code: 'engine_unavailable' }],
    });
    expect(failed.execution).toBeUndefined();
    expect(invalid).toMatchObject({
      status: 'invalid_artifact',
      errors: [{ code: 'schema_violation' }],
    });
  });

  it('keeps unknown evidence and difference kinds as opaque strings', () => {
    const run = parseReplay(
      withChange('reproduced.json', (value) => {
        value['evidence'] = [
          { kind: 'exception_type', message: 'a future kind' },
          { kind: 'exit_code', message: 'm' },
        ];
        value['differences'] = [{ kind: 'stack_location_differs', message: 'm' }];
      }),
    );

    expect(run.evidence_kinds).toEqual(['exception_type', 'exit_code']);
    expect(run.difference_kinds).toEqual(['stack_location_differs']);
  });

  it('never keeps evidence or error message text beyond the bounds, or program output', () => {
    const run = parseReplay(
      withChange('execution-failed.json', (value) => {
        value['errors'] = [{ code: 'internal_error', message: 'x'.repeat(5000) }];
      }),
    );

    expect(run.errors[0]?.message.length).toBe(1024);
    expect(JSON.stringify(run)).not.toContain('Expected stderr text was present');
  });

  it('reports unparseable for non-JSON, the wrong operation, or a missing status', () => {
    const unparseable = { status: 'unparseable', evidence_kinds: [], errors: [] };

    expect(parseReplay('not json at all')).toMatchObject(unparseable);
    expect(parseReplay('')).toMatchObject(unparseable);
    expect(parseReplay('[]')).toMatchObject(unparseable);
    expect(parseReplay(fixture('prepare', 'prepared.json'))).toMatchObject(unparseable);
    expect(
      parseReplay(
        withChange('reproduced.json', (value) => {
          delete value['status'];
        }),
      ),
    ).toMatchObject(unparseable);
    expect(
      parseReplay(
        withChange('reproduced.json', (value) => {
          value['status'] = 'confirmed';
        }),
      ),
    ).toMatchObject(unparseable);
    expect(
      parseReplay(
        withChange('reproduced.json', (value) => {
          value['result_schema_version'] = 2;
        }),
      ),
    ).toMatchObject(unparseable);
  });

  it('ignores malformed optional sections instead of failing', () => {
    const run = parseReplay(
      withChange('reproduced.json', (value) => {
        value['execution'] = { duration_ms: 'fast' };
        value['effective_limits'] = [];
        value['artifact_digest'] = 'not a digest';
      }),
    );

    expect(run.status).toBe('reproduced');
    expect(run.execution).toBeUndefined();
    expect(run.effective_limits).toBeUndefined();
    expect(run.artifact_digest).toBeUndefined();
  });
});

describe('parsePrepare', () => {
  it('reads the prepared fixture', () => {
    expect(parsePrepare(fixture('prepare', 'prepared.json'))).toEqual({
      status: 'prepared',
      artifact_digest: '0'.repeat(64),
      preparation: {
        packages: 3,
        downloaded_tarballs: 2,
        downloaded_bytes: 2048,
        reused_tarballs: 1,
        skipped_for_platform: 1,
        install_script_packages: 1,
      },
      errors: [],
      warning_codes: ['install_scripts_not_run'],
    });
  });

  it('reads the not-required, invalid-artifact, and execution-failed fixtures', () => {
    expect(parsePrepare(fixture('prepare', 'not-required.json')).status).toBe('not_required');
    expect(parsePrepare(fixture('prepare', 'invalid-artifact.json'))).toMatchObject({
      status: 'invalid_artifact',
      errors: [{ code: 'lockfile_rejected', reason: 'unsupported_lockfile_version' }],
    });
    expect(parsePrepare(fixture('prepare', 'execution-failed.json'))).toMatchObject({
      status: 'execution_failed',
      errors: [{ code: 'dependency_download_failed', reason: 'http_status', http_status: 404 }],
    });
  });

  it('never keeps a package path from an error', () => {
    expect(JSON.stringify(parsePrepare(fixture('prepare', 'execution-failed.json')))).not.toContain(
      'synthetic-left-pad',
    );
  });

  it('reports unparseable for other operations and for malformed output', () => {
    expect(parsePrepare(fixture('reproduced.json')).status).toBe('unparseable');
    expect(parsePrepare('{').status).toBe('unparseable');
  });
});

describe('parseInspect', () => {
  const inspected: InspectOperationResult = {
    result_schema_version: 1,
    operation: 'inspect',
    status: 'inspected',
    artifact_version: 1,
    artifact_digest: 'd'.repeat(64),
    warnings: [],
    errors: [],
    inspection: {
      runtime: 'node',
      runtime_version: '24.18.0',
      operating_system: 'linux',
      image: `node@sha256:${'e'.repeat(64)}`,
      command: { program: 'node', argument_count: 3, working_directory: '.' },
      files: [
        { path: 'test/a.test.js', role: 'reproduction', bytes: 120, sha256: 'a'.repeat(64) },
        { path: 'package.json', role: 'dependency', bytes: 900, sha256: 'b'.repeat(64) },
      ],
      expectations: {
        exit_code: 1,
        stdout_count: 1,
        stderr_count: 0,
        stdout_expectations: [{ mode: 'contains', normalize: [] }],
        stderr_expectations: [],
      },
      limits: {
        cpus: 1,
        memory_mb: 512,
        output_bytes_per_stream: 1048576,
        processes: 64,
        timeout_seconds: 60,
      },
      redaction: {
        enabled: true,
        finding_count: 1,
        findings: [{ category: 'password', target: 'lib/a.js', count: 1 }],
      },
    },
  };

  it('reads a contract-shaped inspection', () => {
    const observed = parseInspect(JSON.stringify(inspected));

    expect(observed.status).toBe('inspected');
    expect(observed.artifact_digest).toBe('d'.repeat(64));
    expect(observed.inspection).toMatchObject({
      runtime_version: '24.18.0',
      files: [
        { path: 'test/a.test.js', role: 'reproduction', bytes: 120 },
        { path: 'package.json', role: 'dependency', bytes: 900 },
      ],
      expectations: { exit_code: 1, stdout_count: 1, stderr_count: 0 },
      limits: { timeout_seconds: 60 },
      redaction: { finding_count: 1, findings: [{ category: 'password', count: 1 }] },
    });
  });

  it('reports unparseable for other operations', () => {
    expect(parseInspect(fixture('reproduced.json')).status).toBe('unparseable');
    expect(parseInspect('nope').status).toBe('unparseable');
  });
});

describe('parseRecordOutput', () => {
  const preview = 'ProofIssue recording preview\n\nAuthorized command (no shell):\n  node "x"\n\n';

  it('reads a created recording from the last line', () => {
    expect(parseRecordOutput(`${preview}Artifact created.\n`)).toEqual({ status: 'created' });
  });

  it('reads a failed recording and its message', () => {
    expect(
      parseRecordOutput(
        `${preview}Recording failed: An expected stdout literal was not observed in retained output.\n`,
      ),
    ).toEqual({
      status: 'failed',
      message: 'An expected stdout literal was not observed in retained output.',
    });
  });

  it('reads a cancelled recording', () => {
    expect(parseRecordOutput(`${preview}Recording cancelled; no artifact was written.\n`)).toEqual({
      status: 'cancelled',
    });
  });

  it('reads CRLF output and bounds the message', () => {
    expect(parseRecordOutput('Artifact created.\r\n')).toEqual({ status: 'created' });
    const failed = parseRecordOutput(`Recording failed: ${'m'.repeat(5000)}\n`);
    expect(failed.status === 'failed' ? failed.message.length : 0).toBe(1024);
  });

  it('reports unparseable for empty output or an unknown last line', () => {
    expect(parseRecordOutput('')).toEqual({ status: 'unparseable' });
    expect(parseRecordOutput('\n\n')).toEqual({ status: 'unparseable' });
    expect(parseRecordOutput(`${preview}Something else happened.\n`)).toEqual({
      status: 'unparseable',
    });
  });
});

describe('classifyLimit', () => {
  const exited = {
    duration_ms: 1000,
    termination_reason: 'exited' as const,
    stdout: { retained_bytes: 1, total_bytes: 1, truncated: false },
    stderr: { retained_bytes: 0, total_bytes: 0, truncated: false },
  };

  it('names a timeout from the error code or the termination reason', () => {
    expect(classifyLimit({ errors: [{ code: 'timeout', message: 'm' }] })).toEqual({
      limit: 'time',
    });
    expect(
      classifyLimit({ errors: [], execution: { ...exited, termination_reason: 'timeout' } }),
    ).toEqual({ limit: 'time' });
  });

  it('names a resource termination', () => {
    expect(classifyLimit({ errors: [{ code: 'resource_termination', message: 'm' }] })).toEqual({
      limit: 'memory_or_kill',
    });
    expect(
      classifyLimit({ errors: [], execution: { ...exited, termination_reason: 'resource_limit' } }),
    ).toEqual({ limit: 'memory_or_kill' });
  });

  it('names workspace space for an npm ENOSPC install failure', () => {
    expect(
      classifyLimit({
        errors: [
          {
            code: 'dependency_install_failed',
            message: 'The locked packages could not be installed offline (npm error ENOSPC).',
          },
        ],
      }),
    ).toEqual({ limit: 'workspace_space', install_error_code: 'ENOSPC' });
  });

  it('names another install failure, keeping the npm code when there is one', () => {
    expect(
      classifyLimit({
        errors: [
          {
            code: 'dependency_install_failed',
            message: 'The locked packages could not be installed offline (npm error EAGAIN).',
          },
        ],
      }),
    ).toEqual({ limit: 'install_failed', install_error_code: 'EAGAIN' });
    expect(
      classifyLimit({
        errors: [
          {
            code: 'dependency_install_failed',
            message: 'The locked packages could not be installed offline.',
          },
        ],
      }),
    ).toEqual({ limit: 'install_failed' });
  });

  it('names truncated output', () => {
    expect(
      classifyLimit({
        errors: [],
        execution: { ...exited, stdout: { retained_bytes: 10, total_bytes: 99, truncated: true } },
      }),
    ).toEqual({ limit: 'output' });
  });

  it('reports none otherwise', () => {
    expect(classifyLimit({ errors: [], execution: exited })).toEqual({ limit: 'none' });
    expect(classifyLimit({ errors: [{ code: 'engine_unavailable', message: 'm' }] })).toEqual({
      limit: 'none',
    });
  });

  it('puts a timeout ahead of truncated output', () => {
    expect(
      classifyLimit({
        errors: [{ code: 'timeout', message: 'm' }],
        execution: {
          ...exited,
          termination_reason: 'timeout',
          stdout: { retained_bytes: 10, total_bytes: 99, truncated: true },
        },
      }),
    ).toEqual({ limit: 'time' });
  });
});

describe('toReplayRun', () => {
  it('adds what the harness measured and the limit classification', () => {
    const run = toReplayRun(parseReplay(fixture('reproduced.json')), {
      index: 2,
      cliExitCode: 0,
      wallMs: 1234.6,
    });

    expect(run).toMatchObject({
      index: 2,
      cli_exit_code: 0,
      wall_ms: 1235,
      status: 'reproduced',
      limit: 'none',
    });
  });
});
