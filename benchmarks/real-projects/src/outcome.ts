/**
 * Turns what each stage observed into one classification per case.
 *
 * The rule that drives this file: if changing the harness or the manifest would make a case pass
 * without changing what a reporter would reasonably do, it is a harness or setup problem. If a
 * documented ProofIssue boundary stops the case (limits, offline install, noexec workspace,
 * image, redaction, declared-subject scope), it is a finding: recorded, not fixed.
 *
 * Everything here is pure. Detail text is built from fixed templates and numbers only.
 */
import type { Limit, PrepareObservation, ReplayRun } from './cli-results.js';
import type {
  CliFailureKind,
  Classification,
  FindingCode,
  HarnessCode,
  Outcome,
  OutcomeCode,
  OutcomeStage,
  RunSummary,
  SetupCode,
  TrialStages,
} from './result-model.js';

export type ErrorCategory = 'boundary' | 'environment' | 'possible_defect';

/**
 * How a replay error code is treated.
 *
 * - boundary: a documented ProofIssue limit or rule stopped the replay. A finding.
 * - possible_defect: ProofIssue misbehaved. A finding to investigate and report, not fix here.
 * - environment: the replay environment was wrong. A setup failure.
 */
export const ERROR_CODE_CATEGORY: Readonly<Record<string, ErrorCategory>> = {
  timeout: 'boundary',
  resource_termination: 'boundary',
  dependency_install_failed: 'boundary',
  unsafe_checkout_file: 'boundary',
  internal_error: 'possible_defect',
  cleanup_failed: 'possible_defect',
  container_creation_failed: 'possible_defect',
  engine_unavailable: 'environment',
  engine_capability_unavailable: 'environment',
  image_unavailable: 'environment',
  policy_rejection: 'environment',
  dependencies_not_prepared: 'environment',
};

/** The error code the harness gives a run whose CLI call it had to stop. */
export const CLI_TIMEOUT_ERROR_CODE = 'cli_timeout';

const ALL_LIMITS: readonly Limit[] = [
  'none',
  'time',
  'memory_or_kill',
  'workspace_space',
  'install_failed',
  'output',
];

const median = (sorted: readonly number[]): number => {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  const lower = sorted[middle - 1] ?? upper;
  return Math.round((lower + upper) / 2);
};

/** Counts statuses and limits, computes replay duration statistics, and judges consistency. */
export const summarizeRuns = (runs: readonly ReplayRun[]): RunSummary => {
  const limits = Object.fromEntries(ALL_LIMITS.map((limit) => [limit, 0])) as Record<Limit, number>;
  let reproduced = 0;
  let notReproduced = 0;
  let executionFailed = 0;
  let invalidArtifact = 0;
  let unparseable = 0;
  for (const run of runs) {
    limits[run.limit] += 1;
    switch (run.status) {
      case 'reproduced':
        reproduced += 1;
        break;
      case 'not_reproduced':
        notReproduced += 1;
        break;
      case 'execution_failed':
        executionFailed += 1;
        break;
      case 'invalid_artifact':
        invalidArtifact += 1;
        break;
      case 'unparseable':
        unparseable += 1;
        break;
    }
  }
  const durations = runs
    .flatMap((run) => (run.execution === undefined ? [] : [run.execution.duration_ms]))
    .sort((left, right) => left - right);
  const evidenceSignatures = new Set(runs.map((run) => run.evidence_kinds.join(',')));
  const consistent =
    runs.length >= 1 && reproduced === runs.length && evidenceSignatures.size === 1;
  const first = durations[0];
  const last = durations[durations.length - 1];
  return {
    total: runs.length,
    reproduced,
    not_reproduced: notReproduced,
    execution_failed: executionFailed,
    invalid_artifact: invalidArtifact,
    unparseable,
    consistent,
    ...(first === undefined || last === undefined
      ? {}
      : { duration_ms: { min: first, median: median(durations), max: last } }),
    limits,
  };
};

const NETWORK_REASONS: ReadonlySet<string> = new Set(['network_error', 'timeout']);

/**
 * Decides why a prepare step failed. Network trouble is retryable and is a setup problem;
 * integrity, size, and lockfile refusals are ProofIssue boundaries and are findings.
 */
export const classifyPrepareFailure = (
  observation: PrepareObservation,
  call: { readonly cliExitCode: number | null; readonly timedOut: boolean },
): CliFailureKind => {
  if (call.cliExitCode === 2) return 'arguments_rejected';
  if (call.timedOut) return 'network';
  if (observation.status === 'unparseable') return 'unparseable';
  const network = observation.errors.some(
    (error) =>
      error.code === 'dependency_download_failed' &&
      ((error.reason !== undefined && NETWORK_REASONS.has(error.reason)) ||
        (error.reason === 'http_status' && (error.http_status ?? 0) >= 500)),
  );
  return network ? 'network' : 'refused';
};

interface Issue {
  readonly stage: OutcomeStage;
  readonly code: OutcomeCode;
  readonly classification: Classification;
  readonly detail: string;
}

const issue = (
  stage: OutcomeStage,
  code: OutcomeCode,
  classification: Classification,
  detail: string,
): Issue => ({ stage, code, classification, detail });

const setup = (stage: OutcomeStage, code: SetupCode, detail: string): Issue =>
  issue(stage, code, 'setup_failed', detail);

const finding = (stage: OutcomeStage, code: FindingCode, detail: string): Issue =>
  issue(stage, code, 'finding', detail);

const harness = (stage: OutcomeStage, code: HarnessCode, detail: string): Issue =>
  issue(stage, code, 'harness_error', detail);

const SAFE_CODE = /^[a-z][a-z_]{0,63}$/u;

const distinctCodes = (runs: readonly ReplayRun[]): string => {
  const codes = new Set<string>();
  for (const run of runs) {
    for (const error of run.errors) if (SAFE_CODE.test(error.code)) codes.add(error.code);
  }
  return [...codes].sort().slice(0, 5).join(', ');
};

const limitsReached = (runs: readonly ReplayRun[]): string => {
  const counts = new Map<Limit, number>();
  for (const run of runs) {
    if (run.limit !== 'none') counts.set(run.limit, (counts.get(run.limit) ?? 0) + 1);
  }
  return [...counts.entries()].map(([limit, count]) => `${limit} ${String(count)}`).join(', ');
};

const categoryOf = (run: ReplayRun): ErrorCategory | undefined => {
  const categories = new Set(run.errors.map((error) => ERROR_CODE_CATEGORY[error.code]));
  if (categories.has('environment')) return 'environment';
  if (categories.has('possible_defect')) return 'possible_defect';
  return categories.has('boundary') ? 'boundary' : undefined;
};

interface RunStageCodes {
  readonly stage: 'fix_verification' | 'pre_fix_checkout' | 'snapshot';
  readonly label: string;
  readonly execution: FindingCode;
}

/** Problems that apply to any replay stage, in precedence order. Undefined when none applies. */
const commonRunProblem = (runs: readonly ReplayRun[], codes: RunStageCodes): Issue | undefined => {
  const total = String(runs.length);
  if (runs.some((run) => run.cli_exit_code === 2)) {
    return harness(
      codes.stage,
      'cli_arguments_rejected',
      `The CLI rejected the ${codes.label} arguments.`,
    );
  }
  const unparseable = runs.filter((run) => run.status === 'unparseable');
  if (unparseable.length > 0) {
    const timedOut = unparseable.every((run) =>
      run.errors.some((error) => error.code === CLI_TIMEOUT_ERROR_CODE),
    );
    return timedOut
      ? finding(
          codes.stage,
          'replay_error',
          `${String(unparseable.length)} of ${total} ${codes.label} runs did not finish before the harness stopped the CLI.`,
        )
      : harness(
          codes.stage,
          'unparseable_cli_output',
          `${String(unparseable.length)} of ${total} ${codes.label} runs gave output the harness could not read.`,
        );
  }
  const environment = runs.filter((run) => categoryOf(run) === 'environment');
  if (environment.length > 0) {
    return setup(
      codes.stage,
      'replay_environment',
      `The replay environment was not usable (${distinctCodes(environment)}).`,
    );
  }
  const defects = runs.filter(
    (run) => categoryOf(run) === 'possible_defect' || run.status === 'invalid_artifact',
  );
  if (defects.length > 0) {
    const codesText = distinctCodes(defects);
    return finding(
      codes.stage,
      'replay_error',
      `${String(defects.length)} of ${total} ${codes.label} runs reported a possible ProofIssue defect${codesText === '' ? ' (the artifact was reported invalid)' : ` (${codesText})`}.`,
    );
  }
  const failed = runs.filter((run) => run.status === 'execution_failed');
  if (failed.length > 0) {
    const reached = limitsReached(failed);
    return finding(
      codes.stage,
      codes.execution,
      `${String(failed.length)} of ${total} ${codes.label} runs did not complete (${distinctCodes(failed) || 'no error code'}${reached === '' ? '' : `; limit reached: ${reached}`}).`,
    );
  }
  return undefined;
};

const snapshotIssue = (stages: TrialStages): Issue | undefined => {
  const stage = stages.snapshot;
  if (stage.status === 'skipped') return undefined;
  const codes: RunStageCodes = {
    stage: 'snapshot',
    label: 'snapshot',
    execution: 'snapshot_execution_failed',
  };
  const common = commonRunProblem(stage.runs, codes);
  if (common !== undefined) return common;
  const summary = stage.summary;
  if (summary.total === 0) {
    return finding('snapshot', 'snapshot_execution_failed', 'No snapshot replay ran.');
  }
  if (summary.reproduced === 0) {
    return finding(
      'snapshot',
      'snapshot_not_reproduced',
      `0 of ${String(summary.total)} snapshot runs reproduced the failure.`,
    );
  }
  if (summary.reproduced < summary.total) {
    return finding(
      'snapshot',
      'snapshot_inconsistent',
      `${String(summary.reproduced)} of ${String(summary.total)} snapshot runs reproduced the failure.`,
    );
  }
  if (!summary.consistent) {
    return finding(
      'snapshot',
      'snapshot_inconsistent',
      `All ${String(summary.total)} snapshot runs reproduced the failure but the evidence kinds differed between runs.`,
    );
  }
  return undefined;
};

const preFixIssue = (stages: TrialStages): Issue | undefined => {
  const stage = stages.pre_fix_checkout;
  if (stage.status === 'skipped') return undefined;
  const common = commonRunProblem(stage.runs, {
    stage: 'pre_fix_checkout',
    label: 'pre-fix checkout',
    execution: 'pre_fix_checkout_failed',
  });
  if (common !== undefined) return common;
  const notReproduced = stage.runs.filter((run) => run.status !== 'reproduced').length;
  return notReproduced === 0 && stage.runs.length > 0
    ? undefined
    : finding(
        'pre_fix_checkout',
        'pre_fix_checkout_failed',
        `${String(notReproduced)} of ${String(stage.runs.length)} pre-fix checkout runs did not reproduce the failure.`,
      );
};

const fixIssue = (stages: TrialStages): Issue | undefined => {
  const stage = stages.fix_verification;
  if (stage.status === 'skipped') return undefined;
  const common = commonRunProblem(stage.runs, {
    stage: 'fix_verification',
    label: 'fix verification',
    execution: 'fix_execution_failed',
  });
  if (common !== undefined) return common;
  const reproduced = stage.runs.filter((run) => run.status === 'reproduced').length;
  return reproduced === 0 && stage.runs.length > 0
    ? undefined
    : finding(
        'fix_verification',
        'fix_not_verified',
        `${String(reproduced)} of ${String(stage.runs.length)} fix verification runs still reproduced the failure.`,
      );
};

const baselineIssue = (stages: TrialStages): Issue | undefined => {
  const stage = stages.install_baseline;
  if (stage.status === 'skipped') return undefined;
  if (stage.record_status === 'failed') {
    return finding(
      'install_baseline',
      'record_refused',
      'The install-only baseline could not be recorded.',
    );
  }
  if (stage.runs.length === 0) {
    return finding(
      'install_baseline',
      'prepare_refused',
      'The install-only baseline could not be prepared.',
    );
  }
  const common = commonRunProblem(stage.runs, {
    stage: 'snapshot',
    label: 'install baseline',
    execution: 'snapshot_execution_failed',
  });
  return common === undefined ? undefined : { ...common, stage: 'install_baseline' };
};

const preflightCode = (stages: TrialStages): Issue => {
  const preflight = stages.preflight;
  if (preflight.timed_out) {
    return setup(
      'preflight',
      'preflight_timeout',
      'The host preflight run did not finish in time.',
    );
  }
  if (preflight.exit_code !== preflight.expected_exit_code) {
    return setup(
      'preflight',
      'preflight_exit_code_mismatch',
      `The host preflight run exited with ${preflight.exit_code === undefined ? 'no exit code' : `code ${String(preflight.exit_code)}`}; the manifest expects ${String(preflight.expected_exit_code)}.`,
    );
  }
  const missing = preflight.expectations_observed.filter((observed) => observed === false).length;
  return setup(
    'preflight',
    'preflight_expectation_missing',
    `${String(missing)} expected literal${missing === 1 ? ' was' : 's were'} not found in the host preflight output.`,
  );
};

const recordIssue = (stages: TrialStages): Issue | undefined => {
  const record = stages.record;
  if (record.status !== 'failed') return undefined;
  switch (record.failure_kind) {
    case 'arguments_rejected':
      return harness(
        'record',
        'record_arguments_rejected',
        'The CLI rejected the record arguments.',
      );
    case 'unparseable':
      return harness('record', 'unparseable_cli_output', 'The record output could not be read.');
    default:
      return finding(
        'record',
        'record_refused',
        'ProofIssue refused or failed to record the artifact.',
      );
  }
};

const prepareIssue = (stages: TrialStages): Issue | undefined => {
  const prepare = stages.prepare;
  if (prepare.status !== 'failed') return undefined;
  switch (prepare.failure_kind) {
    case 'arguments_rejected':
      return harness(
        'prepare',
        'cli_arguments_rejected',
        'The CLI rejected the prepare arguments.',
      );
    case 'unparseable':
      return harness('prepare', 'unparseable_cli_output', 'The prepare output could not be read.');
    case 'network':
      return setup(
        'prepare',
        'prepare_network',
        'Downloading the locked packages failed on the network.',
      );
    default:
      return finding(
        'prepare',
        'prepare_refused',
        'ProofIssue refused to prepare the locked packages.',
      );
  }
};

const stageIssues = (stages: TrialStages): readonly Issue[] => {
  const candidates: (Issue | undefined)[] = [
    stages.fetch.status === 'failed'
      ? setup('fetch', 'fetch_failed', 'Fetching or checking out the pinned commits failed.')
      : undefined,
    stages.files.status === 'failed'
      ? setup(
          'files',
          'file_mismatch',
          'A selected file did not match its commit or could not be read.',
        )
      : undefined,
    stages.host_install.status === 'failed'
      ? setup(
          'host_install',
          'host_install_failed',
          stages.host_install.timed_out
            ? 'The host npm ci run did not finish in time.'
            : 'The host npm ci run failed.',
        )
      : undefined,
    stages.preflight.status === 'failed' ? preflightCode(stages) : undefined,
    recordIssue(stages),
    prepareIssue(stages),
    snapshotIssue(stages),
    preFixIssue(stages),
    fixIssue(stages),
    baselineIssue(stages),
  ];
  return candidates.filter((candidate): candidate is Issue => candidate !== undefined);
};

export interface HarnessIssue {
  readonly code: HarnessCode;
  readonly detail: string;
  readonly stage?: OutcomeStage;
}

const confirmedDetail = (stages: TrialStages): string => {
  const summary = stages.snapshot.summary;
  return `${String(summary.reproduced)} of ${String(summary.total)} snapshot runs reproduced the failure consistently; the pre-fix checkout reproduced it and the fixed checkout did not.`;
};

/**
 * Picks the outcome. A harness error outranks everything; otherwise the first failing stage in
 * pipeline order decides, and later problems are listed in `additional`. A problem in the
 * install-only baseline never changes the classification of the case itself.
 */
export const decideOutcome = (input: {
  readonly stages: TrialStages;
  readonly harnessError?: HarnessIssue;
}): Outcome => {
  const issues = [...stageIssues(input.stages)];
  const baselineProblems = issues.filter((item) => item.stage === 'install_baseline');
  const caseIssues = issues.filter((item) => item.stage !== 'install_baseline');

  const harnessIssue: Issue | undefined =
    input.harnessError === undefined
      ? issues.find((item) => item.classification === 'harness_error')
      : harness(
          input.harnessError.stage ?? 'harness',
          input.harnessError.code,
          input.harnessError.detail,
        );
  const primary = harnessIssue ?? caseIssues[0];
  const others = [...caseIssues, ...baselineProblems].filter((item) => item !== primary);
  const additional = others.map((item) => `${item.stage}:${item.code}`);

  if (primary === undefined) {
    return {
      classification: 'confirmed',
      stage: 'fix_verification',
      code: 'all_stages_passed',
      detail: confirmedDetail(input.stages),
      additional,
    };
  }
  return {
    classification: primary.classification,
    stage: primary.stage,
    code: primary.code,
    detail: primary.detail,
    additional,
  };
};
