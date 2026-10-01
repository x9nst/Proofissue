/**
 * Validates per-case trial results from an untrusted source, aggregates them, and renders the
 * summary.
 *
 * The summary job runs on a fresh VM with no third-party code, but the files it reads were
 * produced by a job that did run third-party code. Every file is therefore validated field by
 * field, every string is bounded, and every rendered value is escaped. Nothing here is trusted
 * because it has the right shape: replay-run summaries are recomputed from the runs.
 */
import { readExecution, readLimits, type Limit, type ReplayRun } from './cli-results.js';
import {
  COMMIT,
  CPU_MODEL,
  KERNEL_RELEASE,
  RUNNER_IMAGE_PART,
  VERSION,
  WORD,
} from './environment.js';
import {
  booleanField,
  countField,
  isOneOf,
  isRecord,
  numberField,
  patternField,
  recordField,
  stringField,
  stringItems,
  type JsonRecord,
} from './guards.js';
import { parseManifestValue } from './manifest.js';
import { summarizeRuns } from './outcome.js';
import {
  CLASSIFICATIONS,
  OUTCOME_CODES,
  OUTCOME_STAGES,
  type BaselineStage,
  type CaseRecord,
  type Classification,
  type CliFailureKind,
  type EnvironmentRecord,
  type FetchStage,
  type FileRecord,
  type FilesStage,
  type HostInstallStage,
  type Outcome,
  type PrepareStage,
  type PreflightStage,
  type RecordStage,
  type RunsStage,
  type SnapshotStage,
  type StageStatus,
  type TrialResult,
  type TrialStages,
} from './result-model.js';

// ---------------------------------------------------------------------------------------------
// Validation

class Invalid extends Error {
  readonly where: string;

  constructor(where: string) {
    super(where);
    this.name = 'Invalid';
    this.where = where;
  }
}

const fail = (where: string): never => {
  throw new Invalid(where);
};

const need = <T>(value: T | undefined, where: string): T =>
  value === undefined ? fail(where) : value;

const asRecord = (value: unknown, where: string): JsonRecord =>
  isRecord(value) ? value : fail(where);

const str = (record: JsonRecord, key: string, max: number, where: string): string =>
  need(stringField(record, key, max), `${where}.${key}`);

const pat = (
  record: JsonRecord,
  key: string,
  pattern: RegExp,
  max: number,
  where: string,
): string => need(patternField(record, key, pattern, max), `${where}.${key}`);

const int = (record: JsonRecord, key: string, max: number, where: string): number =>
  need(countField(record, key, max), `${where}.${key}`);

const flag = (record: JsonRecord, key: string, where: string): boolean =>
  need(booleanField(record, key), `${where}.${key}`);

const oneOf = <T extends string>(
  record: JsonRecord,
  key: string,
  allowed: readonly T[],
  where: string,
): T => {
  const value = record[key];
  return isOneOf(value, allowed) ? value : fail(`${where}.${key}`);
};

const items = (record: JsonRecord, key: string, max: number, where: string): readonly unknown[] => {
  const value = record[key];
  return Array.isArray(value) && value.length <= max
    ? (value as unknown[])
    : fail(`${where}.${key}`);
};

const strings = (
  record: JsonRecord,
  key: string,
  maxItems: number,
  maxLength: number,
  where: string,
): readonly string[] => {
  const list = items(record, key, maxItems, where);
  const result = stringItems(record, key, maxLength, maxItems);
  return result.length === list.length ? result : fail(`${where}.${key}`);
};

const MS_MAX = 7 * 24 * 3600 * 1000;
const BYTES_MAX = 2 ** 50;
const IMAGE = /^node@sha256:[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RUN_URL =
  /^https:\/\/[A-Za-z0-9.-]{1,64}\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\/actions\/runs\/[0-9]{1,20}$/u;
const LICENSE_FIELD = /^[A-Za-z0-9.+() -]{1,64}$/u;
const SAFE_CODE = /^[a-z][a-z_]{0,63}$/u;
const PLACEHOLDER_IMAGE = `node@sha256:${'0'.repeat(64)}`;
const STAGE_STATUS_VALUES: readonly StageStatus[] = ['failed', 'ok', 'skipped'];
const FAILURE_KINDS: readonly CliFailureKind[] = [
  'arguments_rejected',
  'network',
  'refused',
  'unparseable',
];
const RUN_STATUSES = [
  'reproduced',
  'not_reproduced',
  'invalid_artifact',
  'execution_failed',
  'unparseable',
] as const;
const LIMIT_VALUES: readonly Limit[] = [
  'none',
  'time',
  'memory_or_kill',
  'workspace_space',
  'install_failed',
  'output',
];

const readCase = (value: unknown): CaseRecord => {
  const record = asRecord(value, 'case');
  const { upstream_license: license, ...rest } = record;
  const parsed = parseManifestValue({
    manifest_version: 1,
    image: PLACEHOLDER_IMAGE,
    cases: [rest],
  });
  const first = parsed.ok ? parsed.manifest.cases[0] : undefined;
  if (first === undefined) return fail('case');
  if (license !== null && (typeof license !== 'string' || !LICENSE_FIELD.test(license))) {
    return fail('case.upstream_license');
  }
  return {
    id: first.id,
    title: first.title,
    repository: first.repository,
    links: first.links,
    pre_fix_commit: first.pre_fix_commit,
    fix_commit: first.fix_commit,
    dependencies: first.dependencies,
    reproduction_files: first.reproduction_files,
    subject_files: first.subject_files,
    command: first.command,
    expected_exit_code: first.expected_exit_code,
    expectations: first.expectations,
    sets: first.sets,
    upstream_license: license,
  };
};

const version = (record: JsonRecord, key: string, where: string): string => {
  const value = str(record, key, 41, where);
  return value === 'unknown' || VERSION.test(value) ? value : fail(`${where}.${key}`);
};

const readEnvironment = (value: unknown): EnvironmentRecord => {
  const record = asRecord(value, 'environment');
  const where = 'environment';
  const optional = (key: string, pattern: RegExp, max: number): string | undefined =>
    record[key] === undefined ? undefined : pat(record, key, pattern, max, where);
  const commit = optional('harness_commit', COMMIT, 40);
  const url = optional('run_url', RUN_URL, 256);
  const runnerImage =
    record['runner_image'] === undefined ? undefined : str(record, 'runner_image', 65, where);
  if (runnerImage !== undefined) {
    const parts = runnerImage.split('/');
    if (parts.length !== 2 || !parts.every((part) => RUNNER_IMAGE_PART.test(part))) {
      fail('environment.runner_image');
    }
  }
  const npm =
    record['host_npm_version'] === undefined
      ? undefined
      : version(record, 'host_npm_version', where);
  const git =
    record['host_git_version'] === undefined
      ? undefined
      : version(record, 'host_git_version', where);
  const docker =
    record['docker_server_version'] === undefined
      ? undefined
      : version(record, 'docker_server_version', where);
  // Strict patterns for every free-form field: nothing a job wrote can carry markup.
  const platform = pat(record, 'platform', WORD, 16, where);
  const arch = pat(record, 'arch', WORD, 16, where);
  const kernel = pat(record, 'kernel_release', KERNEL_RELEASE, 64, where);
  const cpuModel = pat(record, 'cpu_model', CPU_MODEL, 128, where);
  return {
    ...(commit === undefined ? {} : { harness_commit: commit }),
    ...(url === undefined ? {} : { run_url: url }),
    ...(runnerImage === undefined ? {} : { runner_image: runnerImage }),
    platform,
    arch,
    kernel_release: kernel,
    cpu_count: int(record, 'cpu_count', 4096, where),
    cpu_model: cpuModel,
    memory_total_mb: int(record, 'memory_total_mb', 16_777_216, where),
    host_node_version: version(record, 'host_node_version', where),
    ...(npm === undefined ? {} : { host_npm_version: npm }),
    ...(git === undefined ? {} : { host_git_version: git }),
    ...(docker === undefined ? {} : { docker_server_version: docker }),
    approved_image: pat(record, 'approved_image', IMAGE, 80, where),
  };
};

const failureText = (record: JsonRecord, where: string): { failure?: string } =>
  record['failure'] === undefined ? {} : { failure: str(record, 'failure', 300, where) };

const readFetch = (value: unknown): FetchStage => {
  const record = asRecord(value, 'stages.fetch');
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, 'stages.fetch'),
    duration_ms: int(record, 'duration_ms', MS_MAX, 'stages.fetch'),
    ...failureText(record, 'stages.fetch'),
  };
};

const readFileRecord = (value: unknown): FileRecord => {
  const record = asRecord(value, 'stages.files.files');
  const where = 'stages.files.files';
  const missing =
    record['missing_at_fix'] === undefined ? undefined : flag(record, 'missing_at_fix', where);
  return {
    path: str(record, 'path', 512, where),
    role: oneOf(record, 'role', ['dependency', 'reproduction', 'subject'] as const, where),
    bytes: int(record, 'bytes', BYTES_MAX, where),
    matches_commit: flag(record, 'matches_commit', where),
    carriage_returns: int(record, 'carriage_returns', BYTES_MAX, where),
    ...(missing === undefined ? {} : { missing_at_fix: missing }),
  };
};

const readFiles = (value: unknown): FilesStage => {
  const record = asRecord(value, 'stages.files');
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, 'stages.files'),
    files: items(record, 'files', 200, 'stages.files').map(readFileRecord),
    unselected_config_files: strings(record, 'unselected_config_files', 64, 128, 'stages.files'),
    ...failureText(record, 'stages.files'),
  };
};

const readHostInstall = (value: unknown): HostInstallStage => {
  const record = asRecord(value, 'stages.host_install');
  const where = 'stages.host_install';
  const exit = record['exit_code'] === undefined ? undefined : int(record, 'exit_code', 255, where);
  const modulesRecord =
    record['node_modules'] === undefined ? undefined : recordField(record, 'node_modules');
  if (record['node_modules'] !== undefined && modulesRecord === undefined)
    fail(`${where}.node_modules`);
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, where),
    duration_ms: int(record, 'duration_ms', MS_MAX, where),
    ...(exit === undefined ? {} : { exit_code: exit }),
    timed_out: flag(record, 'timed_out', where),
    ...(modulesRecord === undefined
      ? {}
      : {
          node_modules: {
            files: int(modulesRecord, 'files', BYTES_MAX, `${where}.node_modules`),
            bytes: int(modulesRecord, 'bytes', BYTES_MAX, `${where}.node_modules`),
            page_rounded_bytes: int(
              modulesRecord,
              'page_rounded_bytes',
              BYTES_MAX,
              `${where}.node_modules`,
            ),
          },
        }),
  };
};

const readPreflight = (value: unknown): PreflightStage => {
  const record = asRecord(value, 'stages.preflight');
  const where = 'stages.preflight';
  const exit = record['exit_code'] === undefined ? undefined : int(record, 'exit_code', 255, where);
  const observed = items(record, 'expectations_observed', 16, where).map((item) =>
    typeof item === 'boolean' || item === null ? item : fail(`${where}.expectations_observed`),
  );
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, where),
    duration_ms: int(record, 'duration_ms', MS_MAX, where),
    ...(exit === undefined ? {} : { exit_code: exit }),
    expected_exit_code: int(record, 'expected_exit_code', 255, where),
    timed_out: flag(record, 'timed_out', where),
    expectations_observed: observed,
    stdout_bytes: int(record, 'stdout_bytes', BYTES_MAX, where),
    stderr_bytes: int(record, 'stderr_bytes', BYTES_MAX, where),
  };
};

const readFailureKind = (record: JsonRecord, where: string): { failure_kind?: CliFailureKind } =>
  record['failure_kind'] === undefined
    ? {}
    : { failure_kind: oneOf(record, 'failure_kind', FAILURE_KINDS, where) };

const readCliExit = (record: JsonRecord, where: string): { cli_exit_code?: number | null } => {
  const value = record['cli_exit_code'];
  if (value === undefined) return {};
  if (value === null) return { cli_exit_code: null };
  return { cli_exit_code: int(record, 'cli_exit_code', 255, where) };
};

const readInspection = (value: unknown): NonNullable<RecordStage['inspection']> => {
  const record = asRecord(value, 'stages.record.inspection');
  const where = 'stages.record.inspection';
  const expectations = asRecord(record['expectations'], `${where}.expectations`);
  const limits = asRecord(record['limits'], `${where}.limits`);
  const redaction = asRecord(record['redaction'], `${where}.redaction`);
  const outputExpectations = (
    key: string,
  ): NonNullable<RecordStage['inspection']>['expectations']['stdout_expectations'] =>
    items(expectations, key, 16, where).map((item) => {
      const entry = asRecord(item, `${where}.expectations.${key}`);
      return {
        mode: oneOf(entry, 'mode', ['contains', 'exact'] as const, `${where}.expectations.${key}`),
        normalize: strings(entry, 'normalize', 16, 64, `${where}.expectations.${key}`),
      };
    });
  return {
    runtime_version: str(record, 'runtime_version', 64, where),
    files: items(record, 'files', 200, where).map((item) => {
      const entry = asRecord(item, `${where}.files`);
      return {
        path: str(entry, 'path', 512, `${where}.files`),
        role: oneOf(
          entry,
          'role',
          ['dependency', 'reproduction', 'subject'] as const,
          `${where}.files`,
        ),
        bytes: int(entry, 'bytes', BYTES_MAX, `${where}.files`),
        sha256: pat(entry, 'sha256', SHA256, 64, `${where}.files`),
      };
    }),
    expectations: {
      exit_code: int(expectations, 'exit_code', 255, `${where}.expectations`),
      stdout_count: int(expectations, 'stdout_count', 1000, `${where}.expectations`),
      stderr_count: int(expectations, 'stderr_count', 1000, `${where}.expectations`),
      stdout_expectations: outputExpectations('stdout_expectations'),
      stderr_expectations: outputExpectations('stderr_expectations'),
    },
    limits: {
      cpus: need(numberField(limits, 'cpus'), `${where}.limits.cpus`),
      memory_mb: int(limits, 'memory_mb', 1_000_000, `${where}.limits`),
      output_bytes_per_stream: int(limits, 'output_bytes_per_stream', BYTES_MAX, `${where}.limits`),
      processes: int(limits, 'processes', 100_000, `${where}.limits`),
      timeout_seconds: int(limits, 'timeout_seconds', 1_000_000, `${where}.limits`),
    },
    redaction: {
      finding_count: int(redaction, 'finding_count', 100_000, `${where}.redaction`),
      findings: items(redaction, 'findings', 100, `${where}.redaction`).map((item) => {
        const entry = asRecord(item, `${where}.redaction.findings`);
        return {
          category: str(entry, 'category', 64, `${where}.redaction.findings`),
          target: str(entry, 'target', 512, `${where}.redaction.findings`),
          count: int(entry, 'count', 100_000, `${where}.redaction.findings`),
        };
      }),
    },
  };
};

const readRecord = (value: unknown): RecordStage => {
  const record = asRecord(value, 'stages.record');
  const where = 'stages.record';
  const digest =
    record['artifact_digest'] === undefined
      ? undefined
      : pat(record, 'artifact_digest', SHA256, 64, where);
  const message =
    record['failure_message'] === undefined
      ? undefined
      : str(record, 'failure_message', 1024, where);
  return {
    status: oneOf(record, 'status', ['created', 'failed', 'skipped'] as const, where),
    duration_ms: int(record, 'duration_ms', MS_MAX, where),
    ...readCliExit(record, where),
    ...readFailureKind(record, where),
    ...(message === undefined ? {} : { failure_message: message }),
    ...(digest === undefined ? {} : { artifact_digest: digest }),
    ...(record['inspection'] === undefined
      ? {}
      : { inspection: readInspection(record['inspection']) }),
  };
};

const readRun = (value: unknown, where: string): ReplayRun => {
  const record = asRecord(value, where);
  const cli = record['cli_exit_code'];
  const execution = record['execution'] === undefined ? undefined : readExecution(record);
  const limits = record['effective_limits'] === undefined ? undefined : readLimits(record);
  if (record['execution'] !== undefined && execution === undefined) fail(`${where}.execution`);
  if (record['effective_limits'] !== undefined && limits === undefined)
    fail(`${where}.effective_limits`);
  const mode =
    record['mode'] === undefined
      ? undefined
      : oneOf(record, 'mode', ['snapshot', 'current_checkout'] as const, where);
  const artifactDigest =
    record['artifact_digest'] === undefined
      ? undefined
      : pat(record, 'artifact_digest', SHA256, 64, where);
  const imageDigest =
    record['image_digest'] === undefined
      ? undefined
      : pat(record, 'image_digest', IMAGE_DIGEST, 80, where);
  const cleanup =
    record['cleanup_completed'] === undefined
      ? undefined
      : flag(record, 'cleanup_completed', where);
  const installCode =
    record['install_error_code'] === undefined
      ? undefined
      : pat(record, 'install_error_code', /^E[A-Z0-9_]{2,30}$/u, 40, where);
  const errors = items(record, 'errors', 32, where).map((item) => {
    const entry = asRecord(item, `${where}.errors`);
    return {
      code: pat(entry, 'code', SAFE_CODE, 64, `${where}.errors`),
      message: str(entry, 'message', 1024, `${where}.errors`),
    };
  });
  if (cli !== null && countField(record, 'cli_exit_code', 255) === undefined)
    fail(`${where}.cli_exit_code`);
  const kinds = (key: string): readonly string[] => {
    const list = strings(record, key, 64, 64, where);
    return list.every((kind) => SAFE_CODE.test(kind)) ? list : fail(`${where}.${key}`);
  };
  return {
    index: int(record, 'index', 1000, where),
    cli_exit_code: cli === null ? null : int(record, 'cli_exit_code', 255, where),
    wall_ms: int(record, 'wall_ms', MS_MAX, where),
    status: oneOf(record, 'status', RUN_STATUSES, where),
    ...(mode === undefined ? {} : { mode }),
    ...(artifactDigest === undefined ? {} : { artifact_digest: artifactDigest }),
    ...(imageDigest === undefined ? {} : { image_digest: imageDigest }),
    ...(limits === undefined ? {} : { effective_limits: limits }),
    ...(execution === undefined ? {} : { execution }),
    evidence_kinds: kinds('evidence_kinds'),
    difference_kinds: kinds('difference_kinds'),
    errors,
    warning_codes: kinds('warning_codes'),
    substituted_paths: strings(record, 'substituted_paths', 100, 512, where),
    ...(cleanup === undefined ? {} : { cleanup_completed: cleanup }),
    limit: oneOf(record, 'limit', LIMIT_VALUES, where),
    ...(installCode === undefined ? {} : { install_error_code: installCode }),
  };
};

const readRuns = (record: JsonRecord, where: string): readonly ReplayRun[] =>
  items(record, 'runs', 50, where).map((item) => readRun(item, `${where}.runs`));

const readPrepare = (value: unknown): PrepareStage => {
  const record = asRecord(value, 'stages.prepare');
  const where = 'stages.prepare';
  const preparation =
    record['preparation'] === undefined
      ? undefined
      : asRecord(record['preparation'], `${where}.preparation`);
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, where),
    duration_ms: int(record, 'duration_ms', MS_MAX, where),
    ...readCliExit(record, where),
    ...readFailureKind(record, where),
    ...(preparation === undefined
      ? {}
      : {
          preparation: {
            packages: int(preparation, 'packages', 1_000_000, `${where}.preparation`),
            downloaded_tarballs: int(
              preparation,
              'downloaded_tarballs',
              1_000_000,
              `${where}.preparation`,
            ),
            downloaded_bytes: int(
              preparation,
              'downloaded_bytes',
              BYTES_MAX,
              `${where}.preparation`,
            ),
            reused_tarballs: int(preparation, 'reused_tarballs', 1_000_000, `${where}.preparation`),
            skipped_for_platform: int(
              preparation,
              'skipped_for_platform',
              1_000_000,
              `${where}.preparation`,
            ),
            install_script_packages: int(
              preparation,
              'install_script_packages',
              1_000_000,
              `${where}.preparation`,
            ),
          },
        }),
    errors: items(record, 'errors', 32, where).map((item) => {
      const entry = asRecord(item, `${where}.errors`);
      const reason =
        entry['reason'] === undefined
          ? undefined
          : pat(entry, 'reason', SAFE_CODE, 64, `${where}.errors`);
      const status =
        entry['http_status'] === undefined
          ? undefined
          : int(entry, 'http_status', 999, `${where}.errors`);
      return {
        code: pat(entry, 'code', SAFE_CODE, 64, `${where}.errors`),
        ...(reason === undefined ? {} : { reason }),
        ...(status === undefined ? {} : { http_status: status }),
      };
    }),
    warning_codes: strings(record, 'warning_codes', 32, 64, where),
  };
};

const readBaseline = (value: unknown): BaselineStage => {
  const record = asRecord(value, 'stages.install_baseline');
  const where = 'stages.install_baseline';
  const digest =
    record['artifact_digest'] === undefined
      ? undefined
      : pat(record, 'artifact_digest', SHA256, 64, where);
  const prepareMs =
    record['prepare_duration_ms'] === undefined
      ? undefined
      : int(record, 'prepare_duration_ms', MS_MAX, where);
  const reused =
    record['reused_tarballs'] === undefined
      ? undefined
      : int(record, 'reused_tarballs', 1_000_000, where);
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, where),
    record_status: oneOf(record, 'record_status', ['created', 'failed', 'skipped'] as const, where),
    ...(digest === undefined ? {} : { artifact_digest: digest }),
    ...(prepareMs === undefined ? {} : { prepare_duration_ms: prepareMs }),
    ...(reused === undefined ? {} : { reused_tarballs: reused }),
    runs: readRuns(record, where),
  };
};

const readSnapshot = (value: unknown): SnapshotStage => {
  const record = asRecord(value, 'stages.snapshot');
  const runs = readRuns(record, 'stages.snapshot');
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, 'stages.snapshot'),
    runs,
    // Recomputed from the runs: a stored summary is never trusted.
    summary: summarizeRuns(runs),
  };
};

const readRunsStage = (value: unknown, where: string): RunsStage => {
  const record = asRecord(value, where);
  return {
    status: oneOf(record, 'status', STAGE_STATUS_VALUES, where),
    runs: readRuns(record, where),
  };
};

const readStages = (value: unknown): TrialStages => {
  const record = asRecord(value, 'stages');
  return {
    fetch: readFetch(record['fetch']),
    files: readFiles(record['files']),
    host_install: readHostInstall(record['host_install']),
    preflight: readPreflight(record['preflight']),
    record: readRecord(record['record']),
    prepare: readPrepare(record['prepare']),
    install_baseline: readBaseline(record['install_baseline']),
    snapshot: readSnapshot(record['snapshot']),
    pre_fix_checkout: readRunsStage(record['pre_fix_checkout'], 'stages.pre_fix_checkout'),
    fix_verification: readRunsStage(record['fix_verification'], 'stages.fix_verification'),
  };
};

const readOutcome = (value: unknown): Outcome => {
  const record = asRecord(value, 'outcome');
  const where = 'outcome';
  return {
    classification: oneOf(record, 'classification', CLASSIFICATIONS, where),
    stage: oneOf(record, 'stage', OUTCOME_STAGES, where),
    code: oneOf(record, 'code', OUTCOME_CODES, where),
    detail: str(record, 'detail', 600, where),
    additional: strings(record, 'additional', 20, 80, where),
  };
};

export type TrialResultParse =
  | { readonly ok: true; readonly result: TrialResult }
  | { readonly ok: false; readonly reason: string };

/** Fully validates one untrusted per-case result. Never throws; the reason names a location only. */
export const parseTrialResult = (value: unknown): TrialResultParse => {
  try {
    const record = asRecord(value, 'result');
    if (record['trial_result_version'] !== 1) return fail('trial_result_version');
    return {
      ok: true,
      result: {
        trial_result_version: 1,
        case: readCase(record['case']),
        environment: readEnvironment(record['environment']),
        stages: readStages(record['stages']),
        outcome: readOutcome(record['outcome']),
      },
    };
  } catch (error: unknown) {
    if (error instanceof Invalid) return { ok: false, reason: `Invalid value at ${error.where}.` };
    return { ok: false, reason: 'The result could not be validated.' };
  }
};

// ---------------------------------------------------------------------------------------------
// Aggregation

export type DigestVerification = boolean | null;

export interface CaseRow {
  readonly id: string;
  readonly repository: string;
  readonly classification: Classification;
  readonly stage: string;
  readonly code: string;
  readonly detail: string;
  readonly additional: readonly string[];
  readonly record: RecordStage['status'];
  readonly prepare: {
    readonly status: StageStatus;
    readonly packages?: number;
    readonly downloaded_mib?: number;
    readonly seconds?: number;
  };
  readonly snapshot: {
    readonly reproduced: number;
    readonly total: number;
    readonly consistent: boolean;
  };
  readonly replay_ms?: { readonly min: number; readonly median: number; readonly max: number };
  readonly baseline_median_ms?: number;
  readonly estimated_command_ms?: number;
  /** One minus the slowest replay over the time limit. Negative would mean the limit was exceeded. */
  readonly headroom?: number;
  readonly timeout_seconds?: number;
  readonly pre_fix: 'failed' | 'not_reproduced' | 'reproduced' | 'skipped';
  readonly fix_verified: boolean | null;
  readonly digest_verified: DigestVerification;
  readonly limits: Readonly<Partial<Record<Limit, number>>>;
  readonly install_error_codes: readonly string[];
  readonly node_modules?: { readonly files: number; readonly page_rounded_mib: number };
  readonly environment: {
    readonly runner_image?: string;
    readonly cpu_count: number;
    readonly cpu_model: string;
    readonly memory_total_mb: number;
    readonly host_node_version: string;
    readonly host_npm_version?: string;
    readonly host_git_version?: string;
    readonly docker_server_version?: string;
  };
}

const medianOf = (values: readonly number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) return upper;
  return Math.round(((sorted[middle - 1] ?? upper) + upper) / 2);
};

const preFixStatus = (runs: readonly ReplayRun[]): CaseRow['pre_fix'] => {
  const first = runs[0];
  if (first === undefined) return 'skipped';
  if (first.status === 'reproduced' || first.status === 'not_reproduced') return first.status;
  return 'failed';
};

const MIB = 1024 * 1024;
const round1 = (value: number): number => Math.round(value * 10) / 10;

export const caseRow = (result: TrialResult, digest: DigestVerification): CaseRow => {
  const { stages, outcome, environment } = result;
  const summary = stages.snapshot.summary;
  const baselineMedian = medianOf(
    stages.install_baseline.runs.flatMap((run) =>
      run.execution === undefined ? [] : [run.execution.duration_ms],
    ),
  );
  const timeoutSeconds = [...stages.snapshot.runs, ...stages.install_baseline.runs].find(
    (run) => run.effective_limits !== undefined,
  )?.effective_limits?.timeout_seconds;
  const limits: Partial<Record<Limit, number>> = {};
  const installCodes = new Set<string>();
  for (const run of [
    ...stages.snapshot.runs,
    ...stages.install_baseline.runs,
    ...stages.pre_fix_checkout.runs,
    ...stages.fix_verification.runs,
  ]) {
    if (run.limit !== 'none') limits[run.limit] = (limits[run.limit] ?? 0) + 1;
    if (run.install_error_code !== undefined) installCodes.add(run.install_error_code);
  }
  const fixRuns = stages.fix_verification.runs;
  const fixVerified =
    fixRuns.length === 0 ? null : fixRuns.every((run) => run.status === 'not_reproduced');
  const preparation = stages.prepare.preparation;
  const duration = summary.duration_ms;
  const estimated =
    duration === undefined || baselineMedian === undefined
      ? undefined
      : Math.max(0, duration.median - baselineMedian);
  const modules = stages.host_install.node_modules;
  return {
    id: result.case.id,
    repository: result.case.repository,
    classification: outcome.classification,
    stage: outcome.stage,
    code: outcome.code,
    detail: outcome.detail,
    additional: outcome.additional,
    record: stages.record.status,
    prepare: {
      status: stages.prepare.status,
      ...(preparation === undefined
        ? {}
        : {
            packages: preparation.packages,
            downloaded_mib: round1(preparation.downloaded_bytes / MIB),
          }),
      ...(stages.prepare.status === 'skipped'
        ? {}
        : { seconds: round1(stages.prepare.duration_ms / 1000) }),
    },
    snapshot: {
      reproduced: summary.reproduced,
      total: summary.total,
      consistent: summary.consistent,
    },
    ...(duration === undefined ? {} : { replay_ms: duration }),
    ...(baselineMedian === undefined ? {} : { baseline_median_ms: baselineMedian }),
    ...(estimated === undefined ? {} : { estimated_command_ms: estimated }),
    ...(duration === undefined || timeoutSeconds === undefined || timeoutSeconds === 0
      ? {}
      : {
          headroom: Math.round((1 - duration.max / (timeoutSeconds * 1000)) * 1000) / 1000,
        }),
    ...(timeoutSeconds === undefined ? {} : { timeout_seconds: timeoutSeconds }),
    pre_fix: preFixStatus(stages.pre_fix_checkout.runs),
    fix_verified: fixVerified,
    digest_verified: digest,
    limits,
    install_error_codes: [...installCodes].sort(),
    ...(modules === undefined
      ? {}
      : {
          node_modules: {
            files: modules.files,
            page_rounded_mib: round1(modules.page_rounded_bytes / MIB),
          },
        }),
    environment: {
      ...(environment.runner_image === undefined ? {} : { runner_image: environment.runner_image }),
      cpu_count: environment.cpu_count,
      cpu_model: environment.cpu_model,
      memory_total_mb: environment.memory_total_mb,
      host_node_version: environment.host_node_version,
      ...(environment.host_npm_version === undefined
        ? {}
        : { host_npm_version: environment.host_npm_version }),
      ...(environment.host_git_version === undefined
        ? {}
        : { host_git_version: environment.host_git_version }),
      ...(environment.docker_server_version === undefined
        ? {}
        : { docker_server_version: environment.docker_server_version }),
    },
  };
};

export interface ValidatedResult {
  readonly result: TrialResult;
  readonly digest_verified: DigestVerification;
}

export interface InvalidResult {
  /** A path relative to the input directory, made of validated name characters only. */
  readonly file: string;
  readonly reason: string;
}

export interface SummaryTotals {
  readonly cases: number;
  readonly confirmed: number;
  readonly findings: number;
  readonly setup_failed: number;
  readonly harness_errors: number;
  readonly artifacts_created: number;
  readonly artifacts_prepared: number;
  readonly artifacts_replayed: number;
  readonly consistent_artifacts: number;
  readonly fix_verified: number;
}

export interface TrialSummary {
  readonly trial_summary_version: 1;
  readonly run: { readonly run_url?: string; readonly harness_commit?: string };
  readonly image?: string;
  readonly sets: readonly string[];
  readonly snapshot_runs_per_case?: number;
  readonly cases: readonly CaseRow[];
  readonly missing_cases: readonly string[];
  readonly invalid_results: readonly InvalidResult[];
  readonly totals: SummaryTotals;
}

export const aggregate = (input: {
  readonly results: readonly ValidatedResult[];
  readonly missingCases: readonly string[];
  readonly invalidResults: readonly InvalidResult[];
}): TrialSummary => {
  const rows = input.results.map((item) => caseRow(item.result, item.digest_verified));
  const first = input.results[0]?.result.environment;
  const runCounts = input.results
    .map((item) => item.result.stages.snapshot.runs.length)
    .filter((n) => n > 0);
  const sets = [...new Set(input.results.flatMap((item) => item.result.case.sets))].sort();
  const count = (predicate: (row: CaseRow) => boolean): number => rows.filter(predicate).length;
  return {
    trial_summary_version: 1,
    run: {
      ...(first?.run_url === undefined ? {} : { run_url: first.run_url }),
      ...(first?.harness_commit === undefined ? {} : { harness_commit: first.harness_commit }),
    },
    ...(first === undefined ? {} : { image: first.approved_image }),
    sets,
    ...(runCounts.length === 0 ? {} : { snapshot_runs_per_case: Math.max(...runCounts) }),
    cases: rows,
    missing_cases: [...input.missingCases],
    invalid_results: [...input.invalidResults],
    totals: {
      cases: rows.length,
      confirmed: count((row) => row.classification === 'confirmed'),
      findings: count((row) => row.classification === 'finding'),
      setup_failed: count((row) => row.classification === 'setup_failed'),
      harness_errors: count((row) => row.classification === 'harness_error'),
      artifacts_created: count((row) => row.record === 'created'),
      artifacts_prepared: count((row) => row.prepare.status === 'ok'),
      artifacts_replayed: count((row) => row.snapshot.total > 0),
      consistent_artifacts: count((row) => row.snapshot.consistent),
      fix_verified: count((row) => row.fix_verified === true),
    },
  };
};

/** Whether the summary says every case produced valid evidence (the harness exit status). */
export const summaryIsValid = (summary: TrialSummary): boolean =>
  summary.totals.setup_failed === 0 &&
  summary.totals.harness_errors === 0 &&
  summary.missing_cases.length === 0 &&
  summary.invalid_results.length === 0;

// ---------------------------------------------------------------------------------------------
// Rendering

/** Escapes text for a Markdown table cell or a list item. */
export const escapeMarkdownCell = (value: string): string =>
  value
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/`/gu, '&#96;')
    .replace(/\[/gu, '\\[')
    .replace(/\]/gu, '\\]')
    .replace(/[\r\n]+/gu, ' ');

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

const percent = (fraction: number): string => `${String(Math.round(fraction * 100))}%`;

const BUDGET_LINE =
  'Fixed budget per replay: 60 s including the offline install, 512 MB memory including the ' +
  '256 MiB in-memory workspace, 1 CPU, 64 processes, 1 MiB output per stream.';

const NOT_OBSERVABLE = [
  'Peak memory and the process count are not reported by the result contract, so a run that fits is not measured against those limits.',
  'The install and test times are not reported separately. The install-only baseline median estimates the setup plus offline install; the estimated command time is the snapshot median minus that baseline and is clamped at zero.',
  'A process-limit hit is not directly observable; it can only appear as an install or test failure.',
  'node_modules size is a host estimate (each file rounded up to 4096 bytes) of tmpfs use, not a measurement inside the container.',
];

const cell = (value: string | number | undefined): string =>
  value === undefined ? '-' : escapeMarkdownCell(String(value));

const rowCells = (row: CaseRow): readonly string[] => {
  const prepare =
    row.prepare.packages === undefined
      ? row.prepare.status
      : `${String(row.prepare.packages)} / ${String(row.prepare.downloaded_mib ?? 0)} / ${String(row.prepare.seconds ?? 0)}`;
  const replay =
    row.replay_ms === undefined
      ? '-'
      : `${seconds(row.replay_ms.min)} / ${seconds(row.replay_ms.median)} / ${seconds(row.replay_ms.max)}`;
  return [
    row.id,
    row.repository.replace('https://github.com/', '').replace(/\.git$/u, ''),
    `${row.classification} (${row.code})`,
    row.record,
    prepare,
    `${String(row.snapshot.reproduced)}/${String(row.snapshot.total)}`,
    replay,
    row.baseline_median_ms === undefined ? '-' : seconds(row.baseline_median_ms),
    row.estimated_command_ms === undefined ? '-' : seconds(row.estimated_command_ms),
    row.headroom === undefined ? '-' : percent(row.headroom),
    row.pre_fix,
    row.fix_verified === null ? '-' : row.fix_verified ? 'yes' : 'no',
  ].map((value) => cell(value));
};

const TABLE_HEADER = [
  'Case',
  'Repository',
  'Outcome',
  'Record',
  'Prepare (packages / MiB / s)',
  'Snapshot reproduced',
  'Replay s (min/median/max)',
  'Install baseline s (median)',
  'Est. command s',
  'Headroom',
  'Pre-fix checkout',
  'Fix verified',
];

const table = (rows: readonly CaseRow[]): readonly string[] => [
  `| ${TABLE_HEADER.join(' | ')} |`,
  `| ${TABLE_HEADER.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${rowCells(row).join(' | ')} |`),
];

const limitsText = (row: CaseRow): string =>
  Object.entries(row.limits)
    .map(([limit, count]) => `${limit} ${String(count)}`)
    .join(', ');

const environmentLine = (row: CaseRow): string => {
  const environment = row.environment;
  const tools = [
    `Node.js ${environment.host_node_version}`,
    ...(environment.host_npm_version === undefined ? [] : [`npm ${environment.host_npm_version}`]),
    ...(environment.host_git_version === undefined ? [] : [`git ${environment.host_git_version}`]),
    ...(environment.docker_server_version === undefined
      ? []
      : [`Docker Engine ${environment.docker_server_version}`]),
  ];
  return `- ${cell(row.id)}: ${cell(environment.runner_image ?? 'runner image unknown')}, ${String(environment.cpu_count)} CPUs (${cell(environment.cpu_model)}), ${String(environment.memory_total_mb)} MB, ${cell(tools.join(', '))}`;
};

/** The full summary as Markdown. Every value is escaped; links are only ever validated URLs. */
export const renderMarkdown = (summary: TrialSummary): string => {
  const lines: string[] = ['# Real-project trial summary', ''];
  if (summary.run.run_url !== undefined) lines.push(`- Run: ${summary.run.run_url}`);
  if (summary.run.harness_commit !== undefined) {
    lines.push(`- Harness commit: \`${summary.run.harness_commit}\``);
  }
  lines.push(`- Set: ${cell(summary.sets.join(', ') || '-')}`);
  if (summary.image !== undefined) lines.push(`- Approved image: \`${summary.image}\``);
  if (summary.snapshot_runs_per_case !== undefined) {
    lines.push(`- Snapshot replays per case (N): ${String(summary.snapshot_runs_per_case)}`);
  }
  lines.push(`- ${BUDGET_LINE}`, '');

  const totals = summary.totals;
  lines.push(
    `${String(totals.cases)} case${totals.cases === 1 ? '' : 's'}: ${String(totals.confirmed)} confirmed, ` +
      `${String(totals.findings)} with findings, ${String(totals.setup_failed)} setup failures, ` +
      `${String(totals.harness_errors)} harness errors. ${String(totals.consistent_artifacts)} replayed consistently ` +
      `across all snapshot runs; ${String(totals.fix_verified)} verified against the fixed checkout.`,
    '',
  );
  if (summary.cases.length > 0) lines.push(...table(summary.cases), '');

  if (summary.missing_cases.length > 0) {
    lines.push(
      `Missing results (the case job produced no valid result): ${cell(summary.missing_cases.join(', '))}`,
      '',
    );
  }
  if (summary.invalid_results.length > 0) {
    lines.push('## Invalid result files', '');
    for (const item of summary.invalid_results) {
      lines.push(`- ${cell(item.file)}: ${cell(item.reason)}`);
    }
    lines.push('');
  }

  lines.push('## Limits reached', '');
  const limited = summary.cases.filter((row) => Object.keys(row.limits).length > 0);
  if (limited.length === 0) lines.push('No resource limit was reached in any replay.');
  for (const row of limited) {
    const codes =
      row.install_error_codes.length === 0 ? '' : ` (npm ${row.install_error_codes.join(', ')})`;
    lines.push(`- ${cell(row.id)}: ${cell(limitsText(row))}${cell(codes)}`);
  }
  lines.push('', '## Findings', '');
  lines.push(
    'A finding is evidence about a support boundary or a repeatability result; it is recorded, not fixed. A setup failure or harness error means that case produced no valid evidence.',
    '',
  );
  const notable = summary.cases.filter((row) => row.classification !== 'confirmed');
  if (notable.length === 0) lines.push('Every case was confirmed.');
  for (const row of notable) {
    lines.push(
      `- ${cell(row.id)}: ${row.classification} ${cell(row.code)} (${cell(row.stage)}): ${cell(row.detail)}${
        row.additional.length === 0 ? '' : ` Also: ${cell(row.additional.join(', '))}.`
      }`,
    );
  }
  const unverified = summary.cases.filter((row) => row.digest_verified === false);
  for (const row of unverified) {
    lines.push(
      `- ${cell(row.id)}: the uploaded artifact digest did not match the reported digests.`,
    );
  }

  lines.push('', '## Environment', '');
  for (const row of summary.cases) lines.push(environmentLine(row));
  lines.push('', '## Not observable through the result contract', '');
  for (const text of NOT_OBSERVABLE) lines.push(`- ${text}`);
  return lines.join('\n');
};

/** A short Markdown report for one case, for the job's step summary. */
export const renderCaseMarkdown = (result: TrialResult): string => {
  const row = caseRow(result, null);
  const modules =
    row.node_modules === undefined
      ? ''
      : ` Host node_modules: ${String(row.node_modules.files)} files, about ${String(row.node_modules.page_rounded_mib)} MiB.`;
  return [
    `## Trial ${cell(row.id)}: ${row.classification} (${cell(row.code)})`,
    '',
    ...table([row]),
    '',
    `${cell(row.detail)}${modules}`,
    ...(row.additional.length === 0 ? [] : ['', `Also: ${cell(row.additional.join(', '))}.`]),
  ].join('\n');
};
