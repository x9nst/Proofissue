import { describe, expect, it } from 'vitest';

import type { PrepareObservation, ReplayRun } from './cli-results.js';
import {
  CLI_TIMEOUT_ERROR_CODE,
  classifyPrepareFailure,
  decideOutcome,
  summarizeRuns,
} from './outcome.js';
import type { RunsStage, TrialStages } from './result-model.js';

const exited = (durationMs: number): NonNullable<ReplayRun['execution']> => ({
  duration_ms: durationMs,
  exit_code: 1,
  termination_reason: 'exited',
  stdout: { retained_bytes: 100, total_bytes: 100, truncated: false },
  stderr: { retained_bytes: 0, total_bytes: 0, truncated: false },
});

type RunOverrides = { readonly [K in keyof ReplayRun]?: ReplayRun[K] | undefined };

const makeRun = (overrides: RunOverrides = {}): ReplayRun =>
  ({
    index: 1,
    cli_exit_code: 0,
    wall_ms: 21_000,
    status: 'reproduced',
    mode: 'snapshot',
    evidence_kinds: ['exit_code', 'stdout_contains'],
    difference_kinds: [],
    errors: [],
    warning_codes: [],
    substituted_paths: [],
    execution: exited(20_000),
    cleanup_completed: true,
    limit: 'none',
    ...overrides,
  }) as ReplayRun;

const runs = (count: number, overrides: RunOverrides = {}): ReplayRun[] =>
  Array.from({ length: count }, (_, index) => makeRun({ index: index + 1, ...overrides }));

const failedRun = (code: string, overrides: RunOverrides = {}): ReplayRun =>
  makeRun({
    status: 'execution_failed',
    errors: [{ code, message: 'm' }],
    ...overrides,
  });

const stageOf = (items: readonly ReplayRun[]): RunsStage => ({ status: 'ok', runs: items });

const passingStages = (): TrialStages => {
  const snapshotRuns = runs(5);
  return {
    fetch: { status: 'ok', duration_ms: 1000 },
    files: { status: 'ok', files: [], unselected_config_files: [] },
    host_install: { status: 'ok', duration_ms: 9000, exit_code: 0, timed_out: false },
    preflight: {
      status: 'ok',
      duration_ms: 500,
      exit_code: 1,
      expected_exit_code: 1,
      timed_out: false,
      expectations_observed: [true],
      stdout_bytes: 10,
      stderr_bytes: 0,
    },
    record: { status: 'created', duration_ms: 2000, cli_exit_code: 0 },
    prepare: {
      status: 'ok',
      duration_ms: 8000,
      cli_exit_code: 0,
      errors: [],
      warning_codes: [],
    },
    install_baseline: {
      status: 'ok',
      record_status: 'created',
      runs: runs(3, { execution: exited(12_000) }),
    },
    snapshot: { status: 'ok', runs: snapshotRuns, summary: summarizeRuns(snapshotRuns) },
    pre_fix_checkout: stageOf(runs(1, { mode: 'current_checkout' })),
    fix_verification: stageOf(
      runs(1, {
        status: 'not_reproduced',
        mode: 'current_checkout',
        difference_kinds: ['exit_code'],
      }),
    ),
  };
};

const withSnapshot = (items: readonly ReplayRun[]): TrialStages => ({
  ...passingStages(),
  snapshot: { status: 'ok', runs: items, summary: summarizeRuns(items) },
});

describe('summarizeRuns', () => {
  it('computes min, median, and max for an odd run count', () => {
    const summary = summarizeRuns(
      [30_000, 10_000, 20_000].map((duration) => makeRun({ execution: exited(duration) })),
    );

    expect(summary.duration_ms).toEqual({ min: 10_000, median: 20_000, max: 30_000 });
  });

  it('computes the median of an even run count as the rounded mean of the middle two', () => {
    const summary = summarizeRuns(
      [40_000, 10_000, 30_000, 21_001].map((duration) => makeRun({ execution: exited(duration) })),
    );

    expect(summary.duration_ms).toEqual({ min: 10_000, median: 25_501, max: 40_000 });
  });

  it('omits durations when no run reported an execution', () => {
    expect(
      summarizeRuns([failedRun('engine_unavailable', { execution: undefined })]).duration_ms,
    ).toBeUndefined();
    expect(summarizeRuns([]).duration_ms).toBeUndefined();
  });

  it('is consistent only when every run reproduced with the same evidence kinds', () => {
    expect(summarizeRuns(runs(5)).consistent).toBe(true);
    expect(summarizeRuns([]).consistent).toBe(false);
    expect(summarizeRuns([...runs(4), makeRun({ status: 'not_reproduced' })]).consistent).toBe(
      false,
    );
    expect(summarizeRuns([...runs(4), makeRun({ evidence_kinds: ['exit_code'] })]).consistent).toBe(
      false,
    );
  });

  it('counts statuses and limits', () => {
    const summary = summarizeRuns([
      makeRun(),
      makeRun({ status: 'not_reproduced' }),
      failedRun('timeout', { limit: 'time' }),
      failedRun('resource_termination', { limit: 'memory_or_kill' }),
      makeRun({ status: 'unparseable' }),
    ]);

    expect(summary).toMatchObject({
      total: 5,
      reproduced: 1,
      not_reproduced: 1,
      execution_failed: 2,
      unparseable: 1,
      limits: { none: 3, time: 1, memory_or_kill: 1, workspace_space: 0 },
    });
  });
});

describe('decideOutcome', () => {
  it('confirms only when every stage passed and all runs agree', () => {
    const outcome = decideOutcome({ stages: passingStages() });

    expect(outcome).toMatchObject({
      classification: 'confirmed',
      code: 'all_stages_passed',
      additional: [],
    });
    expect(outcome.detail).toContain('5 of 5 snapshot runs reproduced');
  });

  it('treats 4 of 5 reproduced as a finding: snapshot_inconsistent', () => {
    const outcome = decideOutcome({
      stages: withSnapshot([...runs(4), makeRun({ index: 5, status: 'not_reproduced' })]),
    });

    expect(outcome).toMatchObject({
      classification: 'finding',
      stage: 'snapshot',
      code: 'snapshot_inconsistent',
    });
    expect(outcome.detail).toContain('4 of 5');
  });

  it('treats the same status with different evidence kinds as inconsistent', () => {
    const outcome = decideOutcome({
      stages: withSnapshot([...runs(4), makeRun({ index: 5, evidence_kinds: ['exit_code'] })]),
    });

    expect(outcome).toMatchObject({ classification: 'finding', code: 'snapshot_inconsistent' });
  });

  it('treats no reproduced run as snapshot_not_reproduced', () => {
    const outcome = decideOutcome({
      stages: withSnapshot(runs(5, { status: 'not_reproduced', evidence_kinds: ['exit_code'] })),
    });

    expect(outcome).toMatchObject({ classification: 'finding', code: 'snapshot_not_reproduced' });
  });

  it('records a timeout in any snapshot run as a finding with limit time', () => {
    const items = [...runs(4), failedRun('timeout', { index: 5, limit: 'time' })];
    const stages = withSnapshot(items);
    const outcome = decideOutcome({ stages });

    expect(outcome).toMatchObject({
      classification: 'finding',
      stage: 'snapshot',
      code: 'snapshot_execution_failed',
    });
    expect(outcome.detail).toContain('limit reached: time 1');
    expect(stages.snapshot.summary.limits.time).toBe(1);
  });

  it('records a resource termination and an ENOSPC install failure as findings', () => {
    expect(
      decideOutcome({
        stages: withSnapshot([failedRun('resource_termination', { limit: 'memory_or_kill' })]),
      }),
    ).toMatchObject({ classification: 'finding', code: 'snapshot_execution_failed' });
    expect(
      decideOutcome({
        stages: withSnapshot([
          failedRun('dependency_install_failed', {
            limit: 'workspace_space',
            install_error_code: 'ENOSPC',
          }),
        ]),
      }).detail,
    ).toContain('workspace_space');
  });

  it('treats image_unavailable as setup_failed: replay_environment', () => {
    const outcome = decideOutcome({ stages: withSnapshot([failedRun('image_unavailable')]) });

    expect(outcome).toMatchObject({
      classification: 'setup_failed',
      stage: 'snapshot',
      code: 'replay_environment',
    });
  });

  it('treats the other environment errors as setup problems too', () => {
    for (const code of [
      'engine_unavailable',
      'engine_capability_unavailable',
      'policy_rejection',
      'dependencies_not_prepared',
    ]) {
      expect(decideOutcome({ stages: withSnapshot([failedRun(code)]) })).toMatchObject({
        classification: 'setup_failed',
        code: 'replay_environment',
      });
    }
  });

  it('treats internal errors and invalid artifacts as findings: replay_error', () => {
    for (const code of ['internal_error', 'cleanup_failed', 'container_creation_failed']) {
      expect(decideOutcome({ stages: withSnapshot([failedRun(code)]) })).toMatchObject({
        classification: 'finding',
        code: 'replay_error',
      });
    }
    expect(
      decideOutcome({
        stages: withSnapshot([
          makeRun({
            status: 'invalid_artifact',
            errors: [{ code: 'schema_violation', message: 'm' }],
          }),
        ]),
      }),
    ).toMatchObject({ classification: 'finding', code: 'replay_error' });
  });

  it('treats a still-reproducing fixed checkout as fix_not_verified', () => {
    const stages: TrialStages = {
      ...passingStages(),
      fix_verification: stageOf(runs(1, { mode: 'current_checkout' })),
    };

    expect(decideOutcome({ stages })).toMatchObject({
      classification: 'finding',
      stage: 'fix_verification',
      code: 'fix_not_verified',
    });
  });

  it('treats a failed fixed-checkout replay as fix_execution_failed', () => {
    const stages: TrialStages = {
      ...passingStages(),
      fix_verification: stageOf([failedRun('unsafe_checkout_file')]),
    };

    expect(decideOutcome({ stages })).toMatchObject({
      classification: 'finding',
      code: 'fix_execution_failed',
    });
  });

  it('treats a pre-fix checkout that did not reproduce as a finding', () => {
    const stages: TrialStages = {
      ...passingStages(),
      pre_fix_checkout: stageOf(runs(1, { status: 'not_reproduced', mode: 'current_checkout' })),
    };

    expect(decideOutcome({ stages })).toMatchObject({
      classification: 'finding',
      code: 'pre_fix_checkout_failed',
    });
  });

  it('treats a preflight mismatch as setup_failed and does not need later stages', () => {
    const base = passingStages();
    const stages: TrialStages = {
      ...base,
      preflight: { ...base.preflight, status: 'failed', exit_code: 0 },
      record: { status: 'skipped', duration_ms: 0 },
      prepare: { status: 'skipped', duration_ms: 0, errors: [], warning_codes: [] },
      install_baseline: { status: 'skipped', record_status: 'skipped', runs: [] },
      snapshot: { status: 'skipped', runs: [], summary: summarizeRuns([]) },
      pre_fix_checkout: { status: 'skipped', runs: [] },
      fix_verification: { status: 'skipped', runs: [] },
    };

    expect(decideOutcome({ stages })).toMatchObject({
      classification: 'setup_failed',
      stage: 'preflight',
      code: 'preflight_exit_code_mismatch',
      additional: [],
    });
  });

  it('names the preflight problem: timeout, exit code, or a missing literal', () => {
    const base = passingStages();
    const preflight = (overrides: Partial<TrialStages['preflight']>): TrialStages => ({
      ...base,
      preflight: { ...base.preflight, status: 'failed', ...overrides },
    });

    expect(decideOutcome({ stages: preflight({ timed_out: true }) }).code).toBe(
      'preflight_timeout',
    );
    expect(decideOutcome({ stages: preflight({ exit_code: 3 }) }).code).toBe(
      'preflight_exit_code_mismatch',
    );
    expect(
      decideOutcome({ stages: preflight({ expectations_observed: [true, false] }) }).code,
    ).toBe('preflight_expectation_missing');
  });

  it('treats a network prepare failure as setup_failed and an integrity failure as a finding', () => {
    const base = passingStages();
    const network: TrialStages = {
      ...base,
      prepare: { ...base.prepare, status: 'failed', failure_kind: 'network' },
    };
    const refused: TrialStages = {
      ...base,
      prepare: { ...base.prepare, status: 'failed', failure_kind: 'refused' },
    };

    expect(decideOutcome({ stages: network })).toMatchObject({
      classification: 'setup_failed',
      code: 'prepare_network',
    });
    expect(decideOutcome({ stages: refused })).toMatchObject({
      classification: 'finding',
      code: 'prepare_refused',
    });
  });

  it('treats fetch, file, and host-install failures as setup problems', () => {
    const base = passingStages();

    expect(
      decideOutcome({ stages: { ...base, fetch: { status: 'failed', duration_ms: 1 } } }).code,
    ).toBe('fetch_failed');
    expect(
      decideOutcome({
        stages: { ...base, files: { status: 'failed', files: [], unselected_config_files: [] } },
      }).code,
    ).toBe('file_mismatch');
    expect(
      decideOutcome({
        stages: {
          ...base,
          host_install: { status: 'failed', duration_ms: 1, timed_out: true },
        },
      }),
    ).toMatchObject({ classification: 'setup_failed', code: 'host_install_failed' });
  });

  it('classifies record failures: refused is a finding, rejected arguments are harness errors', () => {
    const base = passingStages();
    const record = (kind: 'arguments_rejected' | 'refused' | 'unparseable'): TrialStages => ({
      ...base,
      record: { status: 'failed', duration_ms: 1, failure_kind: kind },
    });

    expect(decideOutcome({ stages: record('refused') })).toMatchObject({
      classification: 'finding',
      code: 'record_refused',
    });
    expect(decideOutcome({ stages: record('arguments_rejected') })).toMatchObject({
      classification: 'harness_error',
      code: 'record_arguments_rejected',
    });
    expect(decideOutcome({ stages: record('unparseable') })).toMatchObject({
      classification: 'harness_error',
      code: 'unparseable_cli_output',
    });
  });

  it('treats unparseable replay output as a harness error', () => {
    const outcome = decideOutcome({
      stages: withSnapshot([makeRun({ status: 'unparseable', execution: undefined })]),
    });

    expect(outcome).toMatchObject({
      classification: 'harness_error',
      code: 'unparseable_cli_output',
    });
  });

  it('treats a CLI that the harness had to stop as a finding, not a harness error', () => {
    const outcome = decideOutcome({
      stages: withSnapshot([
        makeRun({
          status: 'unparseable',
          cli_exit_code: null,
          execution: undefined,
          errors: [{ code: CLI_TIMEOUT_ERROR_CODE, message: 'm' }],
        }),
      ]),
    });

    expect(outcome).toMatchObject({ classification: 'finding', code: 'replay_error' });
  });

  it('lets harness errors outrank every other problem', () => {
    const base = passingStages();
    const stages: TrialStages = {
      ...base,
      fetch: { status: 'failed', duration_ms: 1 },
      snapshot: {
        status: 'ok',
        runs: [makeRun({ status: 'unparseable', execution: undefined })],
        summary: summarizeRuns([makeRun({ status: 'unparseable' })]),
      },
    };
    const outcome = decideOutcome({ stages });

    expect(outcome).toMatchObject({ classification: 'harness_error', stage: 'snapshot' });
    expect(outcome.additional).toContain('fetch:fetch_failed');

    const explicit = decideOutcome({
      stages: base,
      harnessError: { code: 'unexpected_exception', detail: 'The harness failed unexpectedly.' },
    });
    expect(explicit).toMatchObject({
      classification: 'harness_error',
      code: 'unexpected_exception',
    });
  });

  it('lists further issues in pipeline order and keeps the first as the outcome', () => {
    const base = passingStages();
    const stages: TrialStages = {
      ...base,
      snapshot: {
        status: 'ok',
        runs: [failedRun('timeout', { limit: 'time' })],
        summary: summarizeRuns([failedRun('timeout', { limit: 'time' })]),
      },
      pre_fix_checkout: stageOf(runs(1, { status: 'not_reproduced' })),
    };
    const outcome = decideOutcome({ stages });

    expect(outcome.code).toBe('snapshot_execution_failed');
    expect(outcome.additional).toEqual(['pre_fix_checkout:pre_fix_checkout_failed']);
  });

  it('does not let an install-baseline problem change the classification of the case', () => {
    const base = passingStages();
    const stages: TrialStages = {
      ...base,
      install_baseline: { status: 'failed', record_status: 'failed', runs: [] },
    };

    expect(decideOutcome({ stages })).toMatchObject({
      classification: 'confirmed',
      additional: ['install_baseline:record_refused'],
    });
  });
});

describe('classifyPrepareFailure', () => {
  const observation = (
    errors: PrepareObservation['errors'],
    status: PrepareObservation['status'] = 'execution_failed',
  ): PrepareObservation => ({ status, errors, warning_codes: [] });
  const call = { cliExitCode: 1, timedOut: false };

  it('treats network errors, timeouts, and 5xx responses as network', () => {
    for (const reason of ['network_error', 'timeout']) {
      expect(
        classifyPrepareFailure(observation([{ code: 'dependency_download_failed', reason }]), call),
      ).toBe('network');
    }
    expect(
      classifyPrepareFailure(
        observation([
          { code: 'dependency_download_failed', reason: 'http_status', http_status: 503 },
        ]),
        call,
      ),
    ).toBe('network');
  });

  it('treats integrity, size, 4xx, and lockfile refusals as refused', () => {
    expect(
      classifyPrepareFailure(
        observation([{ code: 'dependency_download_failed', reason: 'integrity_mismatch' }]),
        call,
      ),
    ).toBe('refused');
    expect(
      classifyPrepareFailure(
        observation([
          { code: 'dependency_download_failed', reason: 'http_status', http_status: 404 },
        ]),
        call,
      ),
    ).toBe('refused');
    expect(
      classifyPrepareFailure(
        observation([{ code: 'lockfile_rejected', reason: 'weak_integrity' }], 'invalid_artifact'),
        call,
      ),
    ).toBe('refused');
  });

  it('reports rejected arguments, unparseable output, and a stopped CLI', () => {
    expect(classifyPrepareFailure(observation([]), { cliExitCode: 2, timedOut: false })).toBe(
      'arguments_rejected',
    );
    expect(classifyPrepareFailure(observation([], 'unparseable'), call)).toBe('unparseable');
    expect(
      classifyPrepareFailure(observation([], 'unparseable'), { cliExitCode: null, timedOut: true }),
    ).toBe('network');
  });
});
