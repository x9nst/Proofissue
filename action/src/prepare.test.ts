import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import type { PrepareOperationResult } from '@proofissue/application';

import type { ActionRuntime } from './index.js';
import {
  parsePrepareActionInputs,
  renderPrepareActionSummary,
  runPrepareAction,
  type PrepareActionApplicationServices,
} from './prepare.js';

const prepareResult = (
  status: PrepareOperationResult['status'],
  overrides: Partial<PrepareOperationResult> = {},
): PrepareOperationResult => ({
  result_schema_version: 1,
  operation: 'prepare',
  status,
  warnings: [],
  errors: [],
  ...(status === 'prepared'
    ? {
        preparation: {
          packages: 3,
          downloaded_tarballs: 2,
          downloaded_bytes: 2048,
          reused_tarballs: 1,
          skipped_for_platform: 1,
          install_script_packages: 0,
        },
      }
    : {}),
  ...overrides,
});

const runtimeFixture = (inputs: Readonly<Record<string, string>>) => {
  const outputs = new Map<string, string>();
  const summaries: string[] = [];
  const failures: string[] = [];
  const runtime: ActionRuntime = {
    getInput: (name) => inputs[name] ?? '',
    setOutput: (name, value) => {
      outputs.set(name, value);
      return Promise.resolve();
    },
    writeSummary: (markdown) => {
      summaries.push(markdown);
      return Promise.resolve();
    },
    setFailed: (message) => {
      failures.push(message);
    },
    writeInfo: () => undefined,
  };
  return { failures, outputs, runtime, summaries };
};

const validInputs = { 'artifact-path': 'failure.proofissue', 'dependency-store': 'prepared-store' };

describe('prepare Action metadata', () => {
  it('declares a separate Node 24 action with its own bundle and outputs', async () => {
    const metadata = await readFile('action/prepare/action.yml', 'utf8');

    expect(metadata).toContain('using: node24');
    expect(metadata).toContain('main: dist/index.js');
    for (const name of ['artifact-path:', 'dependency-store:', 'status:', 'result:']) {
      expect(metadata).toContain(name);
    }
    expect(metadata).not.toContain('${{');
  });
});

describe('prepare Action inputs', () => {
  it.each([
    [{ 'dependency-store': 's' }, 'artifact-path is required.'],
    [{ 'artifact-path': 'a.proofissue' }, 'dependency-store is required.'],
  ])(
    'requires artifact-path and dependency-store: %j',
    (values: Record<string, string>, message) => {
      expect(() => parsePrepareActionInputs((name) => values[name] ?? '')).toThrow(message);
    },
  );

  it('returns both inputs unchanged', () => {
    expect(
      parsePrepareActionInputs((name) => validInputs[name as keyof typeof validInputs]),
    ).toEqual({ artifact_path: 'failure.proofissue', dependency_store: 'prepared-store' });
  });
});

describe('prepare Action execution', () => {
  it.each(['prepared', 'not_required'] as const)(
    'publishes status and result and succeeds when %s',
    async (status) => {
      const fixture = runtimeFixture(validInputs);
      const received: object[] = [];
      const application: PrepareActionApplicationServices = {
        prepare: (request) => {
          received.push(request);
          return Promise.resolve(prepareResult(status));
        },
      };

      const outcome = await runPrepareAction(application, fixture.runtime);

      expect(outcome.success).toBe(true);
      expect(received).toEqual([
        { artifact_path: 'failure.proofissue', dependency_store: 'prepared-store' },
      ]);
      expect(fixture.outputs.get('status')).toBe(status);
      expect(JSON.parse(fixture.outputs.get('result') ?? '')).toMatchObject({
        operation: 'prepare',
        status,
      });
      expect(fixture.failures).toEqual([]);
      expect(fixture.summaries).toHaveLength(1);
    },
  );

  it.each(['invalid_input', 'invalid_artifact', 'execution_failed'] as const)(
    'fails %s after publishing the result',
    async (status) => {
      const fixture = runtimeFixture(validInputs);

      const outcome = await runPrepareAction(
        { prepare: () => Promise.resolve(prepareResult(status)) },
        fixture.runtime,
      );

      expect(outcome.success).toBe(false);
      expect(fixture.outputs.get('status')).toBe(status);
      expect(fixture.outputs.has('result')).toBe(true);
      expect(fixture.failures).toEqual([
        `ProofIssue dependency preparation did not complete (${status}).`,
      ]);
    },
  );

  it('rejects invalid inputs before invoking the application', async () => {
    const fixture = runtimeFixture({ 'artifact-path': 'failure.proofissue' });
    let called = false;

    const outcome = await runPrepareAction(
      {
        prepare: () => {
          called = true;
          return Promise.resolve(prepareResult('prepared'));
        },
      },
      fixture.runtime,
    );

    expect(outcome.success).toBe(false);
    expect(called).toBe(false);
    expect(fixture.failures).toEqual([
      'ProofIssue prepare action input is invalid. Review the documented inputs.',
    ]);
    expect(fixture.outputs.size).toBe(0);
  });

  it('fails safely when the result cannot be published', async () => {
    const fixture = runtimeFixture(validInputs);
    const runtime: ActionRuntime = {
      ...fixture.runtime,
      setOutput: () => Promise.reject(new Error('disk full')),
    };

    const outcome = await runPrepareAction(
      { prepare: () => Promise.resolve(prepareResult('prepared')) },
      runtime,
    );

    expect(outcome.success).toBe(false);
    expect(fixture.failures).toEqual([
      'ProofIssue prepare action could not publish a safe result.',
    ]);
  });

  it('keeps messages, package locations, and paths out of the summary', () => {
    const summary = renderPrepareActionSummary(
      prepareResult('execution_failed', {
        errors: [
          {
            code: 'dependency_download_failed',
            message: 'secret message from the registry',
            details: { reason: 'http_status', package_path: 'node_modules/synthetic-left-pad' },
          },
        ],
      }),
    );

    expect(summary).toContain('- Result: `execution_failed`');
    expect(summary).toContain('- Errors: 1');
    expect(summary).not.toContain('secret message');
    expect(summary).not.toContain('synthetic-left-pad');
    expect(summary).not.toContain('node_modules');
  });

  it('reports counts when prepared', () => {
    const summary = renderPrepareActionSummary(prepareResult('prepared'));

    expect(summary).toContain('- Packages for the replay platform: 3');
    expect(summary).toContain('- Tarballs downloaded: 2');
    expect(summary).toContain('- Tarballs already in the store: 1');
    expect(summary).toContain('- Skipped for another platform: 1');
  });
});
