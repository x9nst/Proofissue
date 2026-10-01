import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runTrialCase } from './pipeline.js';
import {
  SAMPLE_CLI_PATH as cliPath,
  SAMPLE_NODE_PATH as nodePath,
  cleanupTrialHarnesses,
  createTrialHarness as setup,
  failedOutcome,
  failedReplayJson,
  listFiles,
  okOutcome,
  readTrialResult as readResult,
  replayJson,
  sampleCase,
  timedOutOutcome,
  timeoutReplayJson,
} from './test-support.js';

afterEach(cleanupTrialHarnesses);

describe('runTrialCase happy path', () => {
  it('writes a confirmed result with the snapshot runs, the pre-fix checkout, and fix verification', async () => {
    const harness = await setup();
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'confirmed',
      code: 'all_stages_passed',
      additional: [],
    });
    expect(result.stages.snapshot.summary).toMatchObject({
      total: 5,
      reproduced: 5,
      consistent: true,
    });
    expect(result.stages.pre_fix_checkout.runs.map((run) => run.status)).toEqual(['reproduced']);
    expect(result.stages.fix_verification.runs.map((run) => run.status)).toEqual([
      'not_reproduced',
    ]);
    expect(result.stages.install_baseline.runs).toHaveLength(3);
    expect(result.stages.install_baseline.reused_tarballs).toBe(340);
    expect(result.stages.install_baseline.runs[0]?.execution?.duration_ms).toBe(12_000);
    expect(result.stages.prepare.preparation).toMatchObject({ packages: 355 });
    expect(result.stages.record.artifact_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(result.stages.record.inspection?.redaction.finding_count).toBe(1);
    expect(result.case.upstream_license).toBe('MIT');
    expect(result.stages.host_install.node_modules).toEqual({
      files: 2,
      bytes: 5002,
      page_rounded_bytes: 12_288,
    });
    expect(await readResult(harness)).toEqual(result);
  });

  it('checks every selected file against its commit and reports carriage returns and configs', async () => {
    const harness = await setup();
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.stages.files.status).toBe('ok');
    expect(
      result.stages.files.files.map((file) => [file.path, file.role, file.matches_commit]),
    ).toEqual([
      ['test/example.test.js', 'reproduction', true],
      ['lib/example.js', 'subject', true],
      ['lib/helper.js', 'subject', true],
      ['package.json', 'dependency', true],
      ['package-lock.json', 'dependency', true],
    ]);
    expect(result.stages.files.files[0]?.carriage_returns).toBe(1);
    expect(result.stages.files.files[1]?.missing_at_fix).toBe(false);
    expect(result.stages.files.unselected_config_files).toEqual(['.mocharc.json']);
  });

  it('writes the artifacts, notice, upstream licence, and summary beside the result', async () => {
    const harness = await setup({}, { renderSummary: () => '# Summary for X1' });
    await runTrialCase(sampleCase, harness.context);
    const names = (await listFiles(path.join(harness.roots.output, 'X1'))).map((file) =>
      path.basename(file),
    );

    expect(names).toEqual([
      'NOTICE.md',
      'UPSTREAM-LICENSE.txt',
      'X1-install-baseline.proofissue',
      'X1.proofissue',
      'X1.result.json',
      'X1.summary.md',
    ]);
    expect(await readFile(path.join(harness.roots.output, 'X1', 'NOTICE.md'), 'utf8')).toContain(
      sampleCase.pre_fix_commit,
    );
  });

  it('runs the documented git and CLI steps in order, once each', async () => {
    const harness = await setup();
    await runTrialCase(sampleCase, harness.context);
    const gitSteps = harness.world.calls
      .filter((call) => call.command === 'git')
      .map((call) => call.args[0]);

    expect(gitSteps.slice(0, 7)).toEqual([
      'init',
      'config',
      'remote',
      'fetch',
      'checkout',
      'checkout',
      'worktree',
    ]);
    const fetch = harness.world.calls.find((call) => call.args[0] === 'fetch');
    expect(fetch?.args).toEqual([
      'fetch',
      '-q',
      '--depth',
      '1',
      '--no-tags',
      'origin',
      sampleCase.pre_fix_commit,
      sampleCase.fix_commit,
    ]);
    expect(harness.world.cliCalls('record')).toHaveLength(2);
    expect(harness.world.cliCalls('inspect')).toHaveLength(2);
    expect(harness.world.cliCalls('prepare')).toHaveLength(2);
    expect(harness.world.cliCalls('replay')).toHaveLength(3 + 5 + 1 + 1);
    const against = harness.world.cliCalls('replay').map((call) => call.args.includes('--against'));
    expect(against.filter(Boolean)).toHaveLength(2);
  });

  it('gives each process only the environment it needs', async () => {
    const harness = await setup();
    await runTrialCase(sampleCase, harness.context);
    const work = path.join(harness.roots.work, 'X1');

    for (const call of harness.world.calls.filter((item) => item.command === 'git')) {
      expect(call.env['HOME']).toBe(path.join(work, 'home'));
      expect(call.env['GIT_TERMINAL_PROMPT']).toBe('0');
      expect(call.env['GIT_CONFIG_NOSYSTEM']).toBe('1');
      expect(call.env['GIT_LITERAL_PATHSPECS']).toBe('1');
      expect(call.env['GIT_CONFIG_GLOBAL']).toBe(path.join(work, 'home', 'gitconfig'));
      expect(call.termination).toBe('immediate');
    }
    const npm = harness.world.calls.find((call) => call.command === 'npm');
    expect(npm?.args).toEqual([
      'ci',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-progress',
    ]);
    expect(npm?.env['npm_config_userconfig']).not.toBe(npm?.env['npm_config_globalconfig']);
    expect(npm?.env['npm_config_cache']).toBe(path.join(work, 'npm-cache'));
    const preflight = harness.world.calls.find(
      (call) => call.command === nodePath && call.args[0] !== cliPath,
    );
    expect(preflight?.env).toEqual({});
    expect(preflight?.args).toEqual(sampleCase.command.slice(1));
    expect(preflight?.cwd).toBe(path.join(work, 'repo'));
    for (const call of harness.world.cliCalls('record')) {
      expect(call.env).toEqual({ PATH: '/mnt/ci/bin' });
      expect(call.termination).toBe('graceful');
    }
  });

  it('logs only the case ID, stage names, enums, and numbers', async () => {
    const harness = await setup();
    await runTrialCase(sampleCase, harness.context);

    expect(harness.lines.length).toBeGreaterThan(10);
    for (const line of harness.lines) {
      expect(line.startsWith('[X1] ')).toBe(true);
      expect(line).not.toContain('::');
      expect(line).not.toContain(harness.root);
    }
    expect(harness.lines.at(-1)).toBe('[X1] outcome: confirmed all_stages_passed');
  });
});

describe('runTrialCase leak controls', () => {
  it('writes no temporary-directory or home path into the result or any output file', async () => {
    const homePath = ['', 'home', 'runner', 'secret-project'].join('/');
    let work = '';
    const harness = await setup({
      replay: (call) =>
        call.kind === 'snapshot' && call.index === 2
          ? failedOutcome(
              1,
              failedReplayJson(
                'internal_error',
                `Failed in ${path.join(work, 'X1', 'repo')}/test.js and ${homePath}/x`,
              ),
            )
          : undefined,
    });
    work = harness.roots.work;
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.stages.snapshot.runs[1]?.errors[0]?.message).toContain('<work>');
    expect(result.stages.snapshot.runs[1]?.errors[0]?.message).toContain('<home>');
    for (const file of await listFiles(harness.roots.output)) {
      if (!/\.(json|md|txt)$/u.test(file)) continue;
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(harness.root);
      expect(text).not.toContain(['', 'home', 'runner'].join('/'));
    }
    for (const file of await listFiles(harness.roots.diagnostics)) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(harness.root);
    }
  });

  it('redacts diagnostics and writes them outside the results directory', async () => {
    const secret = 'SYNTHETIC_TEST_ONLY_value_123';
    const harness = await setup({
      preflight: failedOutcome(1, `1 failing\nfailing literal\nAPI_TOKEN=${secret}\n`),
    });
    await runTrialCase(sampleCase, harness.context);

    const diagnostic = await readFile(
      path.join(harness.roots.diagnostics, 'X1', 'preflight.stdout.txt'),
      'utf8',
    );
    expect(diagnostic).toContain('[REDACTED:');
    expect(diagnostic).not.toContain(secret);
    expect(await stat(path.join(harness.roots.diagnostics, 'X1', 'README.txt'))).toBeTruthy();
    expect(path.relative(harness.roots.output, harness.roots.diagnostics).startsWith('..')).toBe(
      true,
    );
    for (const file of await listFiles(harness.roots.output)) {
      if (/\.proofissue$/u.test(file)) continue;
      expect(await readFile(file, 'utf8')).not.toContain(secret);
    }
  });

  it('replaces a result that holds a likely secret with a minimal harness error', async () => {
    const secret = 'SYNTHETIC_TEST_ONLY_value_456';
    const harness = await setup({
      replay: (call) =>
        call.kind === 'snapshot' && call.index === 1
          ? failedOutcome(1, failedReplayJson('internal_error', `Leaked API_TOKEN=${secret}`))
          : undefined,
    });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'harness_error',
      code: 'secret_like_value_in_result',
      stage: 'write',
    });
    const written = await readFile(path.join(harness.roots.output, 'X1', 'X1.result.json'), 'utf8');
    expect(written).not.toContain(secret);
    expect(JSON.parse(written)).toMatchObject({ outcome: { code: 'secret_like_value_in_result' } });
  });

  it('does not treat a redaction finding category in the result as a leak', async () => {
    const harness = await setup();
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.stages.record.inspection?.redaction.findings[0]?.category).toBe('password');
    expect(result.outcome.code).toBe('all_stages_passed');
  });
});

describe('runTrialCase failures', () => {
  it('stops before record when a preflight literal is missing', async () => {
    const harness = await setup({ preflight: failedOutcome(1, 'only unrelated output\n') });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'setup_failed',
      stage: 'preflight',
      code: 'preflight_expectation_missing',
    });
    expect(result.stages.preflight.expectations_observed).toEqual([false]);
    expect(result.stages.record.status).toBe('skipped');
    expect(harness.world.cliCalls('record')).toHaveLength(0);
  });

  it('stops before record when the preflight exit code differs', async () => {
    const harness = await setup({ preflight: okOutcome('failing literal\n') });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome.code).toBe('preflight_exit_code_mismatch');
    expect(harness.world.cliCalls('record')).toHaveLength(0);
  });

  it('skips prepare and replay after a record failure and keeps the message', async () => {
    const message = 'An expected stdout literal was not observed in retained output.';
    const harness = await setup({ recordFailure: message });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({ classification: 'finding', code: 'record_refused' });
    expect(result.stages.record).toMatchObject({
      status: 'failed',
      failure_kind: 'refused',
      failure_message: message,
    });
    expect(result.stages.prepare.status).toBe('skipped');
    expect(harness.world.cliCalls('prepare')).toHaveLength(0);
    expect(harness.world.cliCalls('replay')).toHaveLength(0);
  });

  it('skips replay after a prepare refusal and classifies network trouble as setup', async () => {
    const refused = await setup({
      preparedFailure: failedOutcome(
        1,
        `${JSON.stringify({
          result_schema_version: 1,
          operation: 'prepare',
          status: 'invalid_artifact',
          warnings: [],
          errors: [
            {
              code: 'lockfile_rejected',
              message: 'm',
              details: { reason: 'weak_integrity', package_path: 'node_modules/x' },
            },
          ],
        })}\n`,
      ),
    });
    const refusedResult = await runTrialCase(sampleCase, refused.context);
    expect(refusedResult.outcome).toMatchObject({
      classification: 'finding',
      code: 'prepare_refused',
    });
    expect(refused.world.cliCalls('replay')).toHaveLength(0);
    expect(JSON.stringify(refusedResult)).not.toContain('node_modules/x');

    const network = await setup({
      preparedFailure: failedOutcome(
        1,
        `${JSON.stringify({
          result_schema_version: 1,
          operation: 'prepare',
          status: 'execution_failed',
          warnings: [],
          errors: [
            {
              code: 'dependency_download_failed',
              message: 'm',
              details: { reason: 'network_error' },
            },
          ],
        })}\n`,
      ),
    });
    const networkResult = await runTrialCase(sampleCase, network.context);
    expect(networkResult.outcome).toMatchObject({
      classification: 'setup_failed',
      code: 'prepare_network',
    });
  });

  it('records a replay timeout and still runs the remaining stages', async () => {
    const harness = await setup({
      replay: (call) =>
        call.kind === 'snapshot' && call.index === 3
          ? failedOutcome(1, timeoutReplayJson())
          : undefined,
    });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'finding',
      code: 'snapshot_execution_failed',
    });
    expect(result.stages.snapshot.runs).toHaveLength(5);
    expect(result.stages.snapshot.summary.limits.time).toBe(1);
    expect(result.stages.snapshot.runs[2]).toMatchObject({
      status: 'execution_failed',
      limit: 'time',
    });
    expect(result.stages.pre_fix_checkout.runs).toHaveLength(1);
    expect(result.stages.fix_verification.runs).toHaveLength(1);
  });

  it('stops a snapshot series when the harness had to stop the CLI', async () => {
    const harness = await setup({
      replay: (call) => (call.kind === 'snapshot' ? timedOutOutcome() : undefined),
    });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.stages.snapshot.runs).toHaveLength(1);
    expect(result.stages.snapshot.runs[0]?.errors[0]?.code).toBe('cli_timeout');
    expect(result.outcome).toMatchObject({ classification: 'finding', code: 'replay_error' });
  });

  it('treats unparseable CLI output as a harness error', async () => {
    const harness = await setup({
      replay: (call) => (call.kind === 'snapshot' ? okOutcome('this is not json') : undefined),
    });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'harness_error',
      code: 'unparseable_cli_output',
    });
  });

  it('records the k of N reproduced as a finding', async () => {
    const harness = await setup({
      replay: (call) =>
        call.kind === 'snapshot' && call.index === 4
          ? okOutcome(replayJson('not_reproduced'))
          : undefined,
    });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'finding',
      code: 'snapshot_inconsistent',
    });
    expect(result.stages.snapshot.summary).toMatchObject({ reproduced: 4, not_reproduced: 1 });
  });

  it('reports a fix that still reproduces the failure', async () => {
    const harness = await setup({
      replay: (call) => (call.kind === 'fix' ? okOutcome(replayJson('reproduced')) : undefined),
    });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({ classification: 'finding', code: 'fix_not_verified' });
  });

  it('stops after a file that does not match its commit', async () => {
    const harness = await setup({ corruptedFiles: new Set(['lib/example.js']) });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({ classification: 'setup_failed', code: 'file_mismatch' });
    expect(result.stages.files.files.find((file) => file.path === 'lib/example.js')).toMatchObject({
      matches_commit: false,
    });
    expect(harness.world.calls.some((call) => call.command === 'npm')).toBe(false);
  });

  it('stops after a host install failure', async () => {
    const harness = await setup({ hostInstall: failedOutcome(1, '', 'npm error code E404\n') });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'setup_failed',
      code: 'host_install_failed',
    });
    expect(harness.world.cliCalls('record')).toHaveLength(0);
    const log = await readFile(
      path.join(harness.roots.diagnostics, 'X1', 'host-install.log'),
      'utf8',
    );
    expect(log).toContain('E404');
  });

  it('fails the fetch stage when the result directory already exists', async () => {
    const harness = await setup();
    await mkdir(path.join(harness.roots.output, 'X1'), { recursive: true });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({ classification: 'setup_failed', code: 'fetch_failed' });
    expect(harness.world.calls).toHaveLength(0);
  });

  it('turns an unexpected exception into a harness error and keeps earlier stages', async () => {
    const harness = await setup({ throwOn: 'npm' });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.outcome).toMatchObject({
      classification: 'harness_error',
      code: 'unexpected_exception',
    });
    expect(result.stages.files.status).toBe('ok');
    expect(JSON.stringify(result)).not.toContain('told to throw');
    expect((await readResult(harness)).outcome.code).toBe('unexpected_exception');
  });

  it('skips the install baseline when no baseline runs are requested', async () => {
    const harness = await setup({}, { baselineRuns: 0 });
    const result = await runTrialCase(sampleCase, harness.context);

    expect(result.stages.install_baseline.status).toBe('skipped');
    expect(harness.world.cliCalls('record')).toHaveLength(1);
    expect(result.outcome.classification).toBe('confirmed');
  });
});
