import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { ReplayOperationResult } from '@proofissue/application';

import {
  createActionAdapter,
  createGitHubActionRuntime,
  parseActionInputs,
  renderActionSummary,
  runAction,
  type ActionApplicationServices,
  type ActionRuntime,
} from './index.js';

const replayResult = (
  status: ReplayOperationResult['status'],
  overrides: Partial<ReplayOperationResult> = {},
): ReplayOperationResult => ({
  result_schema_version: 1,
  operation: 'replay',
  status,
  mode: 'snapshot',
  warnings: [],
  errors: [],
  evidence:
    status === 'reproduced'
      ? [
          { kind: 'exit_code', message: 'Exit code matched: 1.' },
          { kind: 'stderr_contains', message: 'Expected stderr text was present.' },
        ]
      : [],
  differences: [],
  substituted_paths: [],
  scope_limitations: [],
  ...overrides,
});

const runtimeFixture = (inputs: Readonly<Record<string, string>>) => {
  const outputs = new Map<string, string>();
  const summaries: string[] = [];
  const failures: string[] = [];
  const information: string[] = [];
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
    writeInfo: (message) => {
      information.push(message);
    },
  };
  return { failures, information, outputs, runtime, summaries };
};

describe('Action application boundary', () => {
  it('keeps the adapter limited to the shared replay service', () => {
    const application: ActionApplicationServices = {
      replay: () => Promise.resolve(replayResult('reproduced')),
    };

    expect(createActionAdapter(application)).toEqual({ application });
  });
});

describe('Action metadata', () => {
  it('declares the Node 24 bundle and every stable output', async () => {
    const metadata = await readFile('action/action.yml', 'utf8');

    expect(metadata).toContain('using: node24');
    expect(metadata).toContain('main: dist/index.js');
    expect(metadata).toContain('dependency-store:');
    for (const output of [
      'status:',
      'mode:',
      'result:',
      'evidence:',
      'differences:',
      'required_status_satisfied:',
    ]) {
      expect(metadata).toContain(output);
    }
  });
});

describe('Action inputs', () => {
  it('defaults to snapshot replay with no required result', () => {
    const values: Record<string, string> = { 'artifact-path': 'failure.proofissue' };

    expect(parseActionInputs((name) => values[name] ?? '')).toEqual({
      artifact_path: 'failure.proofissue',
      mode: 'snapshot',
    });
  });

  it('parses dependency-store only when given', () => {
    const base: Record<string, string> = { 'artifact-path': 'failure.proofissue' };
    const withStore: Record<string, string> = { ...base, 'dependency-store': 'prepared-store' };

    expect(parseActionInputs((name) => base[name] ?? '')).not.toHaveProperty('dependency_store');
    expect(parseActionInputs((name) => withStore[name] ?? '')).toMatchObject({
      dependency_store: 'prepared-store',
    });
  });

  it('uses the explicit checkout for current-checkout replay', () => {
    const values: Record<string, string> = {
      'artifact-path': 'failure.proofissue',
      'checkout-path': 'corrected',
      'replay-mode': 'current-checkout',
      'required-status': 'not_reproduced',
    };

    expect(parseActionInputs((name) => values[name] ?? '', 'workspace')).toEqual({
      artifact_path: 'failure.proofissue',
      against_path: 'corrected',
      mode: 'current_checkout',
      required_status: 'not_reproduced',
    });
  });

  it('uses the GitHub workspace when current-checkout has no explicit path', () => {
    const values: Record<string, string> = {
      'artifact-path': 'failure.proofissue',
      'replay-mode': 'current-checkout',
    };

    expect(parseActionInputs((name) => values[name] ?? '', 'workspace')).toMatchObject({
      against_path: 'workspace',
      mode: 'current_checkout',
    });
  });

  it.each([
    [{}, 'artifact-path'],
    [{ 'artifact-path': 'failure.proofissue', 'replay-mode': 'browser' }, 'replay-mode'],
    [{ 'artifact-path': 'failure.proofissue', 'required-status': 'valid' }, 'required-status'],
    [{ 'artifact-path': 'failure.proofissue', 'checkout-path': 'checkout' }, 'checkout-path'],
  ])('rejects invalid configuration without replaying it', (values, expected) => {
    expect(() =>
      parseActionInputs((name) => (values as Record<string, string>)[name] ?? '', ''),
    ).toThrow(expected);
  });
});

describe('Action execution', () => {
  it('passes the prepared dependency store to replay, and none when the input is empty', async () => {
    const requests: object[] = [];
    const application: ActionApplicationServices = {
      replay: (request) => {
        requests.push(request);
        return Promise.resolve(replayResult('reproduced'));
      },
    };

    await runAction(
      application,
      runtimeFixture({ 'artifact-path': 'a.proofissue', 'dependency-store': 'prepared-store' })
        .runtime,
    );
    await runAction(application, runtimeFixture({ 'artifact-path': 'a.proofissue' }).runtime);

    expect(requests[0]).toMatchObject({ dependency_store: 'prepared-store' });
    expect(requests[1]).not.toHaveProperty('dependency_store');
  });

  it('publishes structured outputs and a content-safe summary for reproduced failures', async () => {
    const application: ActionApplicationServices = {
      replay: vi.fn(() => Promise.resolve(replayResult('reproduced'))),
    };
    const fixture = runtimeFixture({
      'artifact-path': 'failure.proofissue',
      'required-status': 'reproduced',
    });

    const outcome = await runAction(application, fixture.runtime);

    expect(outcome.success).toBe(true);
    expect(application.replay).toHaveBeenCalledWith({
      artifact_path: 'failure.proofissue',
      mode: 'snapshot',
    });
    expect(fixture.outputs.get('status')).toBe('reproduced');
    expect(fixture.outputs.get('mode')).toBe('snapshot');
    expect(JSON.parse(fixture.outputs.get('result') ?? '')).toMatchObject({
      result_schema_version: 1,
      operation: 'replay',
      status: 'reproduced',
    });
    expect(JSON.parse(fixture.outputs.get('evidence') ?? '')).toHaveLength(2);
    expect(JSON.parse(fixture.outputs.get('differences') ?? '')).toEqual([]);
    expect(fixture.outputs.get('required_status_satisfied')).toBe('true');
    expect(fixture.summaries.join('')).toContain('Required result: `reproduced` (satisfied)');
    expect(fixture.failures).toEqual([]);
  });

  it('supports not_reproduced as the required result', async () => {
    const application: ActionApplicationServices = {
      replay: () =>
        Promise.resolve(
          replayResult('not_reproduced', {
            differences: [{ kind: 'exit_code', message: 'Expected exit code 1 but received 0.' }],
          }),
        ),
    };
    const fixture = runtimeFixture({
      'artifact-path': 'failure.proofissue',
      'required-status': 'not_reproduced',
    });

    const outcome = await runAction(application, fixture.runtime);

    expect(outcome.success).toBe(true);
    expect(fixture.outputs.get('status')).toBe('not_reproduced');
    expect(fixture.outputs.get('required_status_satisfied')).toBe('true');
    expect(fixture.failures).toEqual([]);
  });

  it('fails a required-result mismatch without changing the replay classification', async () => {
    const application: ActionApplicationServices = {
      replay: () => Promise.resolve(replayResult('not_reproduced')),
    };
    const fixture = runtimeFixture({
      'artifact-path': 'failure.proofissue',
      'required-status': 'reproduced',
    });

    const outcome = await runAction(application, fixture.runtime);

    expect(outcome.result?.status).toBe('not_reproduced');
    expect(outcome.success).toBe(false);
    expect(fixture.outputs.get('status')).toBe('not_reproduced');
    expect(fixture.outputs.get('required_status_satisfied')).toBe('false');
    expect(fixture.failures).toHaveLength(1);
  });

  it('fails invalid artifacts and execution failures while preserving their structured result', async () => {
    for (const status of ['invalid_artifact', 'execution_failed'] as const) {
      const application: ActionApplicationServices = {
        replay: () => Promise.resolve(replayResult(status)),
      };
      const fixture = runtimeFixture({ 'artifact-path': 'failure.proofissue' });

      const outcome = await runAction(application, fixture.runtime);

      expect(outcome.success).toBe(false);
      expect(fixture.outputs.get('status')).toBe(status);
      expect(JSON.parse(fixture.outputs.get('result') ?? '')).toMatchObject({ status });
      expect(fixture.failures).toHaveLength(1);
    }
  });

  it('does not place potentially sensitive messages in the workflow summary', () => {
    const sensitive = 'Authorization header with synthetic-sensitive-value';
    const result = replayResult('execution_failed', {
      warnings: [{ code: 'synthetic_warning', message: sensitive }],
      errors: [{ code: 'internal_error', message: sensitive }],
      scope_limitations: [{ code: 'output_truncated', message: sensitive }],
    });

    const summary = renderActionSummary(result, undefined, true);

    expect(summary).not.toContain(sensitive);
    expect(summary).not.toContain('decoded_text');
    expect(summary).toContain('Raw command output is not published.');
  });

  it('rejects invalid inputs before invoking the application', async () => {
    const application: ActionApplicationServices = {
      replay: vi.fn(() => Promise.resolve(replayResult('reproduced'))),
    };
    const fixture = runtimeFixture({ 'replay-mode': 'snapshot' });

    const outcome = await runAction(application, fixture.runtime);

    expect(outcome.success).toBe(false);
    expect(application.replay).not.toHaveBeenCalled();
    expect(fixture.outputs.size).toBe(0);
    expect(fixture.failures).toHaveLength(1);
  });
});

describe('GitHub environment-file runtime', () => {
  it('writes multiline-safe outputs and a step summary without workflow commands', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-action-runtime-'));
    const outputPath = path.join(root, 'output.txt');
    const summaryPath = path.join(root, 'summary.md');
    await writeFile(outputPath, '');
    await writeFile(summaryPath, '');
    try {
      const runtime = createGitHubActionRuntime({
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        'INPUT_ARTIFACT-PATH': ' failure.proofissue ',
      });

      expect(runtime.getInput('artifact-path')).toBe('failure.proofissue');
      await runtime.setOutput('result', '{"line":"one\\ntwo"}');
      await runtime.writeSummary('## Safe summary\n');

      const output = await readFile(outputPath, 'utf8');
      expect(output).toMatch(/^result<<proofissue_[0-9a-f-]+\n/u);
      expect(output).toContain('{"line":"one\\ntwo"}');
      expect(output).not.toContain('::set-output');
      expect(await readFile(summaryPath, 'utf8')).toBe('## Safe summary\n');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
