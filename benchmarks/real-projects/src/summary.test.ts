import { afterEach, describe, expect, it } from 'vitest';

import { runTrialCase } from './pipeline.js';
import type { TrialResult } from './result-model.js';
import {
  aggregate,
  caseRow,
  escapeMarkdownCell,
  parseTrialResult,
  renderCaseMarkdown,
  renderMarkdown,
  summaryIsValid,
  type ValidatedResult,
} from './summary.js';
import { selfCheck } from './pipeline.js';
import {
  cleanupTrialHarnesses,
  createTrialHarness,
  failedOutcome,
  sampleCase,
  timeoutReplayJson,
  type FakeOptions,
} from './test-support.js';

afterEach(cleanupTrialHarnesses);

const jsonCopy = (value: unknown): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

const produce = async (options: FakeOptions = {}, id = 'X1'): Promise<TrialResult> => {
  const harness = await createTrialHarness(options);
  return await runTrialCase({ ...sampleCase, id }, harness.context);
};

const section = (value: Record<string, unknown>, name: string): Record<string, unknown> =>
  value[name] as Record<string, unknown>;

const stage = (value: Record<string, unknown>, name: string): Record<string, unknown> =>
  section(section(value, 'stages'), name);

const firstRun = (value: Record<string, unknown>): Record<string, unknown> =>
  (stage(value, 'snapshot')['runs'] as Record<string, unknown>[])[0] ?? {};

const validated = (result: TrialResult, digest: boolean | null = true): ValidatedResult => ({
  result,
  digest_verified: digest,
});

describe('parseTrialResult', () => {
  it('accepts a result the pipeline produced and recomputes the snapshot summary', async () => {
    const result = await produce();
    const parsed = parseTrialResult(jsonCopy(result));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.result.outcome).toEqual(result.outcome);
    expect(parsed.result.stages.snapshot.summary).toEqual(result.stages.snapshot.summary);
    expect(parsed.result.case).toEqual(result.case);
  });

  it('does not trust a stored summary', async () => {
    const result = jsonCopy(await produce());
    stage(result, 'snapshot')['summary'] = { total: 99, reproduced: 99, consistent: true };
    const parsed = parseTrialResult(result);

    expect(parsed.ok && parsed.result.stages.snapshot.summary.total).toBe(5);
  });

  it('rejects non-objects and the wrong version', () => {
    expect(parseTrialResult(null).ok).toBe(false);
    expect(parseTrialResult([]).ok).toBe(false);
    expect(parseTrialResult('text').ok).toBe(false);
    expect(parseTrialResult({ trial_result_version: 2 }).ok).toBe(false);
  });

  it('rejects malformed fields and names only the location, never the value', async () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const mutations: readonly [string, (value: Record<string, unknown>) => void][] = [
      [
        'case path',
        (value) => {
          section(value, 'case')['subject_files'] = ['../escape'];
        },
      ],
      [
        'case id',
        (value) => {
          section(value, 'case')['id'] = hostile;
        },
      ],
      [
        'classification',
        (value) => {
          section(value, 'outcome')['classification'] = hostile;
        },
      ],
      [
        'outcome code',
        (value) => {
          section(value, 'outcome')['code'] = 'invented_code';
        },
      ],
      [
        'detail length',
        (value) => {
          section(value, 'outcome')['detail'] = 'x'.repeat(601);
        },
      ],
      [
        'cpu model',
        (value) => {
          section(value, 'environment')['cpu_model'] = hostile;
        },
      ],
      [
        'run url',
        (value) => {
          section(value, 'environment')['run_url'] = hostile;
        },
      ],
      [
        'approved image',
        (value) => {
          section(value, 'environment')['approved_image'] = hostile;
        },
      ],
      [
        'stage status',
        (value) => {
          stage(value, 'fetch')['status'] = hostile;
        },
      ],
      [
        'run status',
        (value) => {
          firstRun(value)['status'] = hostile;
        },
      ],
      [
        'run digest',
        (value) => {
          firstRun(value)['artifact_digest'] = hostile;
        },
      ],
      [
        'run error code',
        (value) => {
          firstRun(value)['errors'] = [{ code: hostile, message: 'm' }];
        },
      ],
      [
        'too many runs',
        (value) => {
          stage(value, 'snapshot')['runs'] = Array.from({ length: 51 }, () => ({}));
        },
      ],
    ];
    const base = await produce();

    for (const [name, mutate] of mutations) {
      const value = jsonCopy(base);
      mutate(value);
      const parsed = parseTrialResult(value);
      expect(parsed.ok, name).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.reason, name).toMatch(/^Invalid value at [A-Za-z0-9_.]+\.$/u);
      expect(parsed.reason, name).not.toContain('img');
    }
  });

  it('accepts a minimal harness-error result with every stage skipped', async () => {
    const harness = await createTrialHarness({}, { cliMissing: true });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({ classification: 'harness_error', code: 'cli_missing' });
    expect(parseTrialResult(jsonCopy(result)).ok).toBe(true);
  });
});

describe('caseRow', () => {
  it('derives the replay statistics, baseline, headroom, and sizes', async () => {
    const row = caseRow(await produce(), true);

    expect(row).toMatchObject({
      id: 'X1',
      classification: 'confirmed',
      record: 'created',
      prepare: { status: 'ok', packages: 355, downloaded_mib: 19.1 },
      snapshot: { reproduced: 5, total: 5, consistent: true },
      replay_ms: { min: 20_100, median: 20_300, max: 20_500 },
      baseline_median_ms: 12_000,
      estimated_command_ms: 8300,
      headroom: 0.658,
      timeout_seconds: 60,
      pre_fix: 'reproduced',
      fix_verified: true,
      digest_verified: true,
      node_modules: { files: 2, page_rounded_mib: 0 },
    });
    expect(row.limits).toEqual({});
  });

  it('counts the limits that were reached', async () => {
    const result = await produce({
      replay: (call) =>
        call.kind === 'snapshot' && call.index === 2
          ? failedOutcome(1, timeoutReplayJson())
          : undefined,
    });
    const row = caseRow(result, null);

    expect(row.limits).toEqual({ time: 1 });
    expect(row.classification).toBe('finding');
    expect(row.snapshot).toMatchObject({ reproduced: 4, total: 5, consistent: false });
  });
});

describe('aggregate', () => {
  it('totals the cases and the medians across cases', async () => {
    const confirmed = await produce({}, 'X1');
    const timedOut = await produce(
      {
        replay: (call) =>
          call.kind === 'snapshot' && call.index === 1
            ? failedOutcome(1, timeoutReplayJson())
            : undefined,
      },
      'X2',
    );
    const summary = aggregate({
      results: [validated(confirmed), validated(timedOut)],
      missingCases: [],
      invalidResults: [],
    });

    expect(summary.totals).toEqual({
      cases: 2,
      confirmed: 1,
      findings: 1,
      setup_failed: 0,
      harness_errors: 0,
      artifacts_created: 2,
      artifacts_prepared: 2,
      artifacts_replayed: 2,
      consistent_artifacts: 1,
      fix_verified: 2,
    });
    expect(summary.snapshot_runs_per_case).toBe(5);
    expect(summary.sets).toEqual(['unit']);
    expect(summaryIsValid(summary)).toBe(true);
  });

  it('is not valid when a case is setup_failed, missing, or invalid', async () => {
    const setupFailed = await produce({ hostInstall: failedOutcome(1) });
    expect(
      summaryIsValid(
        aggregate({ results: [validated(setupFailed)], missingCases: [], invalidResults: [] }),
      ),
    ).toBe(false);
    const confirmed = await produce();
    expect(
      summaryIsValid(
        aggregate({ results: [validated(confirmed)], missingCases: ['T1'], invalidResults: [] }),
      ),
    ).toBe(false);
    expect(
      summaryIsValid(
        aggregate({
          results: [validated(confirmed)],
          missingCases: [],
          invalidResults: [{ file: 'a/X.result.json', reason: 'bad' }],
        }),
      ),
    ).toBe(false);
  });
});

describe('renderMarkdown', () => {
  it('renders the table, the sections, and consistent-replay wording', async () => {
    const summary = aggregate({
      results: [validated(await produce())],
      missingCases: [],
      invalidResults: [],
    });
    const markdown = renderMarkdown(summary);

    expect(markdown).toContain('# Real-project trial summary');
    expect(markdown).toContain('| Case | Repository | Outcome |');
    expect(markdown).toContain(
      '| X1 | example-owner/example-repository | confirmed (all_stages_passed) |',
    );
    expect(markdown).toContain('5/5');
    expect(markdown).toContain('20.1 / 20.3 / 20.5');
    expect(markdown).toContain('## Limits reached');
    expect(markdown).toContain('No resource limit was reached');
    expect(markdown).toContain('## Not observable through the result contract');
    expect(markdown).toContain('replayed consistently');
    expect(markdown).toContain('60 s including the offline install, 512 MB');
    expect(markdown.toLowerCase()).not.toContain('deterministic replay');
  });

  it('lists missing and invalid results and flags a digest mismatch', async () => {
    const summary = aggregate({
      results: [validated(await produce(), false)],
      missingCases: ['T1'],
      invalidResults: [
        { file: 'trial-result-M3/M3/M3.result.json', reason: 'Invalid value at case.' },
      ],
    });
    const markdown = renderMarkdown(summary);

    expect(markdown).toContain('Missing results');
    expect(markdown).toContain('T1');
    expect(markdown).toContain('## Invalid result files');
    expect(markdown).toContain('did not match the reported digests');
  });

  it('escapes table text and keeps hostile text out of the output', () => {
    const hostile = '<script>alert(1)</script> | `x`';
    const summary = aggregate({
      results: [],
      missingCases: [],
      invalidResults: [{ file: hostile, reason: hostile }],
    });
    const markdown = renderMarkdown(summary);

    expect(markdown).not.toContain('<script>');
    expect(markdown).toContain('&lt;script&gt;');
    expect(markdown).not.toContain('`x`');
  });

  it('passes the leak self-check, for the markdown and for the JSON', async () => {
    const summary = aggregate({
      results: [validated(await produce())],
      missingCases: [],
      invalidResults: [],
    });

    expect(selfCheck(renderMarkdown(summary))).toBeUndefined();
    expect(selfCheck(JSON.stringify(summary, null, 2))).toBeUndefined();
  });
});

describe('renderCaseMarkdown', () => {
  it('renders one case with its outcome and table', async () => {
    const markdown = renderCaseMarkdown(await produce());

    expect(markdown).toContain('## Trial X1: confirmed (all_stages_passed)');
    expect(markdown).toContain('| X1 |');
    expect(selfCheck(markdown)).toBeUndefined();
  });
});

describe('escapeMarkdownCell', () => {
  it('escapes pipes, angle brackets, backticks, brackets, backslashes, and newlines', () => {
    const backslash = String.fromCharCode(92);
    const escaped = escapeMarkdownCell(`a|b<c>d\`e[f]g${backslash}h\ni\r\nj`);

    expect(escaped).toBe(
      `a${backslash}|b&lt;c&gt;d&#96;e${backslash}[f${backslash}]g${backslash}${backslash}h i j`,
    );
  });

  it('leaves ordinary text unchanged', () => {
    expect(escapeMarkdownCell('timeout 1, memory_or_kill 0 (ok)')).toBe(
      'timeout 1, memory_or_kill 0 (ok)',
    );
  });
});
