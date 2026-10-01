/**
 * Reads the ProofIssue CLI's output as a black box.
 *
 * Every parser treats the output as untrusted: it narrows the JSON field by field, bounds every
 * string, and reports `unparseable` instead of throwing. Only result-contract fields, counts, and
 * durations are kept; decoded program output never appears in these views.
 */
import type { PrepareStatus, ReplayStatus, TerminationReason } from '@proofissue/contracts';

import {
  arrayField,
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

export type Limit =
  'memory_or_kill' | 'workspace_space' | 'install_failed' | 'output' | 'time' | 'none';

export interface StreamView {
  readonly retained_bytes: number;
  readonly total_bytes: number;
  readonly truncated: boolean;
}

export interface ExecutionView {
  readonly duration_ms: number;
  readonly exit_code?: number;
  readonly signal?: string;
  readonly termination_reason: TerminationReason;
  readonly stdout: StreamView;
  readonly stderr: StreamView;
}

export interface LimitsView {
  readonly cpus: number;
  readonly memory_mb: number;
  readonly output_bytes_per_stream: number;
  readonly processes: number;
  readonly timeout_seconds: number;
  readonly writable_workspace_mb: number;
}

export interface ErrorView {
  readonly code: string;
  readonly message: string;
}

export interface ReplayObservation {
  readonly status: ReplayStatus | 'unparseable';
  readonly mode?: 'current_checkout' | 'snapshot';
  readonly artifact_digest?: string;
  readonly image_digest?: string;
  readonly effective_limits?: LimitsView;
  readonly execution?: ExecutionView;
  /** Sorted. Kinds are additive in the result contract, so they are kept as opaque strings. */
  readonly evidence_kinds: readonly string[];
  readonly difference_kinds: readonly string[];
  readonly errors: readonly ErrorView[];
  readonly warning_codes: readonly string[];
  readonly substituted_paths: readonly string[];
  readonly cleanup_completed?: boolean;
}

export interface ReplayRun extends ReplayObservation {
  readonly index: number;
  readonly cli_exit_code: number | null;
  readonly wall_ms: number;
  readonly limit: Limit;
  readonly install_error_code?: string;
}

export interface PrepareErrorView {
  readonly code: string;
  readonly reason?: string;
  readonly http_status?: number;
}

export interface PreparationView {
  readonly packages: number;
  readonly downloaded_tarballs: number;
  readonly downloaded_bytes: number;
  readonly reused_tarballs: number;
  readonly skipped_for_platform: number;
  readonly install_script_packages: number;
}

export interface PrepareObservation {
  readonly status: PrepareStatus | 'unparseable';
  readonly artifact_digest?: string;
  readonly preparation?: PreparationView;
  readonly errors: readonly PrepareErrorView[];
  readonly warning_codes: readonly string[];
}

export interface InspectionFileView {
  readonly path: string;
  readonly role: 'dependency' | 'reproduction' | 'subject';
  readonly bytes: number;
  readonly sha256: string;
}

export interface InspectionExpectationView {
  readonly mode: 'contains' | 'exact';
  readonly normalize: readonly string[];
}

export interface InspectionView {
  readonly runtime_version: string;
  readonly files: readonly InspectionFileView[];
  readonly expectations: {
    readonly exit_code: number;
    readonly stdout_count: number;
    readonly stderr_count: number;
    readonly stdout_expectations: readonly InspectionExpectationView[];
    readonly stderr_expectations: readonly InspectionExpectationView[];
  };
  readonly limits: {
    readonly cpus: number;
    readonly memory_mb: number;
    readonly output_bytes_per_stream: number;
    readonly processes: number;
    readonly timeout_seconds: number;
  };
  readonly redaction: {
    readonly finding_count: number;
    readonly findings: readonly {
      readonly category: string;
      readonly target: string;
      readonly count: number;
    }[];
  };
}

export interface InspectObservation {
  readonly status: 'inspected' | 'invalid_artifact' | 'unparseable';
  readonly artifact_digest?: string;
  readonly inspection?: InspectionView;
}

export type RecordObservation =
  | { readonly status: 'created' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'unparseable' };

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const IMAGE_DIGEST = /^sha256:[a-f0-9]{64}$/u;
const REPLAY_STATUSES: readonly ReplayStatus[] = [
  'reproduced',
  'not_reproduced',
  'invalid_artifact',
  'execution_failed',
];
const PREPARE_STATUSES: readonly PrepareStatus[] = [
  'prepared',
  'not_required',
  'invalid_input',
  'invalid_artifact',
  'execution_failed',
];
const TERMINATION_REASONS: readonly TerminationReason[] = [
  'exited',
  'signaled',
  'timeout',
  'resource_limit',
  'runner_failure',
];
const MAX_MESSAGE_LENGTH = 1024;
const MAX_CODE_LENGTH = 64;
const MAX_RECORD_MESSAGE_LENGTH = 1024;

const parseJsonObject = (text: string): JsonRecord | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return undefined;
  }
  return isRecord(value) ? value : undefined;
};

const readStream = (record: JsonRecord, key: string): StreamView | undefined => {
  const stream = recordField(record, key);
  if (stream === undefined) return undefined;
  const retained = countField(stream, 'retained_bytes');
  const total = countField(stream, 'total_bytes');
  const truncated = booleanField(stream, 'truncated');
  if (retained === undefined || total === undefined || truncated === undefined) return undefined;
  return { retained_bytes: retained, total_bytes: total, truncated };
};

const readExecution = (record: JsonRecord): ExecutionView | undefined => {
  const execution = recordField(record, 'execution');
  if (execution === undefined) return undefined;
  const duration = numberField(execution, 'duration_ms');
  const reason = execution['termination_reason'];
  const stdout = readStream(execution, 'stdout');
  const stderr = readStream(execution, 'stderr');
  if (
    duration === undefined ||
    duration < 0 ||
    !isOneOf(reason, TERMINATION_REASONS) ||
    stdout === undefined ||
    stderr === undefined
  ) {
    return undefined;
  }
  const exitCode = countField(execution, 'exit_code', 255);
  const signal = stringField(execution, 'signal', 32);
  return {
    duration_ms: Math.round(duration),
    ...(exitCode === undefined ? {} : { exit_code: exitCode }),
    ...(signal === undefined ? {} : { signal }),
    termination_reason: reason,
    stdout,
    stderr,
  };
};

const readLimits = (record: JsonRecord): LimitsView | undefined => {
  const limits = recordField(record, 'effective_limits');
  if (limits === undefined) return undefined;
  const cpus = numberField(limits, 'cpus');
  const memory = countField(limits, 'memory_mb');
  const output = countField(limits, 'output_bytes_per_stream');
  const processes = countField(limits, 'processes');
  const timeout = countField(limits, 'timeout_seconds');
  const workspace = countField(limits, 'writable_workspace_mb');
  if (
    cpus === undefined ||
    memory === undefined ||
    output === undefined ||
    processes === undefined ||
    timeout === undefined ||
    workspace === undefined
  ) {
    return undefined;
  }
  return {
    cpus,
    memory_mb: memory,
    output_bytes_per_stream: output,
    processes,
    timeout_seconds: timeout,
    writable_workspace_mb: workspace,
  };
};

const kinds = (record: JsonRecord, key: string): readonly string[] =>
  arrayField(record, key, 64)
    .flatMap((item) => {
      if (!isRecord(item)) return [];
      const kind = stringField(item, 'kind', MAX_CODE_LENGTH);
      return kind === undefined ? [] : [kind];
    })
    .sort();

const readErrors = (record: JsonRecord): readonly ErrorView[] =>
  arrayField(record, 'errors', 32).flatMap((item) => {
    if (!isRecord(item)) return [];
    const code = stringField(item, 'code', MAX_CODE_LENGTH);
    if (code === undefined) return [];
    const message = stringField(item, 'message', 100_000) ?? '';
    return [{ code, message: message.slice(0, MAX_MESSAGE_LENGTH) }];
  });

const warningCodes = (record: JsonRecord): readonly string[] =>
  arrayField(record, 'warnings', 32).flatMap((item) => {
    if (!isRecord(item)) return [];
    const code = stringField(item, 'code', MAX_CODE_LENGTH);
    return code === undefined ? [] : [code];
  });

const UNPARSEABLE_REPLAY: ReplayObservation = {
  status: 'unparseable',
  evidence_kinds: [],
  difference_kinds: [],
  errors: [],
  warning_codes: [],
  substituted_paths: [],
};

/** Reads one `replay --json` line. Wrong operation, wrong schema version, or no status is `unparseable`. */
export const parseReplay = (stdout: string): ReplayObservation => {
  const record = parseJsonObject(stdout);
  if (
    record === undefined ||
    record['operation'] !== 'replay' ||
    record['result_schema_version'] !== 1
  ) {
    return UNPARSEABLE_REPLAY;
  }
  const status = record['status'];
  if (!isOneOf(status, REPLAY_STATUSES)) return UNPARSEABLE_REPLAY;

  const mode = record['mode'];
  const artifactDigest = patternField(record, 'artifact_digest', SHA256_HEX, 64);
  const imageDigest = patternField(record, 'image_digest', IMAGE_DIGEST, 80);
  const limits = readLimits(record);
  const execution = readExecution(record);
  const cleanup = recordField(record, 'cleanup');
  const cleanupCompleted = cleanup === undefined ? undefined : booleanField(cleanup, 'completed');
  return {
    status,
    ...(mode === 'snapshot' || mode === 'current_checkout' ? { mode } : {}),
    ...(artifactDigest === undefined ? {} : { artifact_digest: artifactDigest }),
    ...(imageDigest === undefined ? {} : { image_digest: imageDigest }),
    ...(limits === undefined ? {} : { effective_limits: limits }),
    ...(execution === undefined ? {} : { execution }),
    evidence_kinds: kinds(record, 'evidence'),
    difference_kinds: kinds(record, 'differences'),
    errors: readErrors(record),
    warning_codes: warningCodes(record),
    substituted_paths: stringItems(record, 'substituted_paths', 512, 100),
    ...(cleanupCompleted === undefined ? {} : { cleanup_completed: cleanupCompleted }),
  };
};

const UNPARSEABLE_PREPARE: PrepareObservation = {
  status: 'unparseable',
  errors: [],
  warning_codes: [],
};

const readPreparation = (record: JsonRecord): PreparationView | undefined => {
  const preparation = recordField(record, 'preparation');
  if (preparation === undefined) return undefined;
  const packages = countField(preparation, 'packages');
  const downloaded = countField(preparation, 'downloaded_tarballs');
  const downloadedBytes = countField(preparation, 'downloaded_bytes');
  const reused = countField(preparation, 'reused_tarballs');
  const skipped = countField(preparation, 'skipped_for_platform');
  const scripts = countField(preparation, 'install_script_packages');
  if (
    packages === undefined ||
    downloaded === undefined ||
    downloadedBytes === undefined ||
    reused === undefined ||
    skipped === undefined ||
    scripts === undefined
  ) {
    return undefined;
  }
  return {
    packages,
    downloaded_tarballs: downloaded,
    downloaded_bytes: downloadedBytes,
    reused_tarballs: reused,
    skipped_for_platform: skipped,
    install_script_packages: scripts,
  };
};

const readPrepareErrors = (record: JsonRecord): readonly PrepareErrorView[] =>
  arrayField(record, 'errors', 32).flatMap((item) => {
    if (!isRecord(item)) return [];
    const code = stringField(item, 'code', MAX_CODE_LENGTH);
    if (code === undefined) return [];
    const details = recordField(item, 'details');
    const reason = details === undefined ? undefined : stringField(details, 'reason', 64);
    const httpStatus = details === undefined ? undefined : countField(details, 'http_status', 999);
    return [
      {
        code,
        ...(reason === undefined ? {} : { reason }),
        ...(httpStatus === undefined ? {} : { http_status: httpStatus }),
      },
    ];
  });

/** Reads one `prepare --json` line. */
export const parsePrepare = (stdout: string): PrepareObservation => {
  const record = parseJsonObject(stdout);
  if (
    record === undefined ||
    record['operation'] !== 'prepare' ||
    record['result_schema_version'] !== 1
  ) {
    return UNPARSEABLE_PREPARE;
  }
  const status = record['status'];
  if (!isOneOf(status, PREPARE_STATUSES)) return UNPARSEABLE_PREPARE;
  const artifactDigest = patternField(record, 'artifact_digest', SHA256_HEX, 64);
  const preparation = readPreparation(record);
  return {
    status,
    ...(artifactDigest === undefined ? {} : { artifact_digest: artifactDigest }),
    ...(preparation === undefined ? {} : { preparation }),
    errors: readPrepareErrors(record),
    warning_codes: warningCodes(record),
  };
};

const readInspectionFile = (item: unknown): InspectionFileView | undefined => {
  if (!isRecord(item)) return undefined;
  const path = stringField(item, 'path', 512);
  const role = item['role'];
  const bytes = countField(item, 'bytes');
  const sha256 = patternField(item, 'sha256', SHA256_HEX, 64);
  if (
    path === undefined ||
    !isOneOf(role, ['dependency', 'reproduction', 'subject'] as const) ||
    bytes === undefined ||
    sha256 === undefined
  ) {
    return undefined;
  }
  return { path, role, bytes, sha256 };
};

const readOutputExpectations = (
  record: JsonRecord,
  key: string,
): readonly InspectionExpectationView[] =>
  arrayField(record, key, 16).flatMap((item) => {
    if (!isRecord(item)) return [];
    const mode = item['mode'];
    if (mode !== 'contains' && mode !== 'exact') return [];
    return [{ mode, normalize: stringItems(item, 'normalize', 64, 16) }];
  });

const readInspection = (record: JsonRecord): InspectionView | undefined => {
  const inspection = recordField(record, 'inspection');
  if (inspection === undefined) return undefined;
  const expectations = recordField(inspection, 'expectations');
  const limits = recordField(inspection, 'limits');
  const redaction = recordField(inspection, 'redaction');
  if (expectations === undefined || limits === undefined || redaction === undefined) {
    return undefined;
  }
  const exitCode = countField(expectations, 'exit_code', 255);
  const stdoutCount = countField(expectations, 'stdout_count');
  const stderrCount = countField(expectations, 'stderr_count');
  const cpus = numberField(limits, 'cpus');
  const memory = countField(limits, 'memory_mb');
  const output = countField(limits, 'output_bytes_per_stream');
  const processes = countField(limits, 'processes');
  const timeout = countField(limits, 'timeout_seconds');
  const findingCount = countField(redaction, 'finding_count');
  const runtimeVersion = patternField(inspection, 'runtime_version', /^[0-9A-Za-z.+-]{1,64}$/u, 64);
  if (
    exitCode === undefined ||
    stdoutCount === undefined ||
    stderrCount === undefined ||
    cpus === undefined ||
    memory === undefined ||
    output === undefined ||
    processes === undefined ||
    timeout === undefined ||
    findingCount === undefined ||
    runtimeVersion === undefined
  ) {
    return undefined;
  }
  return {
    runtime_version: runtimeVersion,
    files: arrayField(inspection, 'files', 200).flatMap((item) => {
      const file = readInspectionFile(item);
      return file === undefined ? [] : [file];
    }),
    expectations: {
      exit_code: exitCode,
      stdout_count: stdoutCount,
      stderr_count: stderrCount,
      stdout_expectations: readOutputExpectations(expectations, 'stdout_expectations'),
      stderr_expectations: readOutputExpectations(expectations, 'stderr_expectations'),
    },
    limits: {
      cpus,
      memory_mb: memory,
      output_bytes_per_stream: output,
      processes,
      timeout_seconds: timeout,
    },
    redaction: {
      finding_count: findingCount,
      findings: arrayField(redaction, 'findings', 100).flatMap((item) => {
        if (!isRecord(item)) return [];
        const category = stringField(item, 'category', 64);
        const target = stringField(item, 'target', 512);
        const count = countField(item, 'count');
        return category === undefined || target === undefined || count === undefined
          ? []
          : [{ category, target, count }];
      }),
    },
  };
};

/** Reads one `inspect --json` line. */
export const parseInspect = (stdout: string): InspectObservation => {
  const record = parseJsonObject(stdout);
  if (
    record === undefined ||
    record['operation'] !== 'inspect' ||
    record['result_schema_version'] !== 1
  ) {
    return { status: 'unparseable' };
  }
  const status = record['status'];
  if (status !== 'inspected' && status !== 'invalid_artifact') return { status: 'unparseable' };
  const artifactDigest = patternField(record, 'artifact_digest', SHA256_HEX, 64);
  const inspection = readInspection(record);
  return {
    status,
    ...(artifactDigest === undefined ? {} : { artifact_digest: artifactDigest }),
    ...(inspection === undefined ? {} : { inspection }),
  };
};

const RECORD_FAILED_PREFIX = 'Recording failed: ';

/** Reads `record` output, which has no JSON form: the last non-empty line says what happened. */
export const parseRecordOutput = (stdout: string): RecordObservation => {
  const lines = stdout
    .split('\n')
    .map((line) => line.replace(/\r$/u, ''))
    .filter((line) => line.trim() !== '');
  const last = lines[lines.length - 1];
  if (last === undefined) return { status: 'unparseable' };
  if (last === 'Artifact created.') return { status: 'created' };
  if (last === 'Recording cancelled; no artifact was written.') return { status: 'cancelled' };
  if (last.startsWith(RECORD_FAILED_PREFIX)) {
    return {
      status: 'failed',
      message: last.slice(
        RECORD_FAILED_PREFIX.length,
        RECORD_FAILED_PREFIX.length + MAX_RECORD_MESSAGE_LENGTH,
      ),
    };
  }
  return { status: 'unparseable' };
};

const NPM_ERROR_CODE = /npm error (E[A-Z0-9_]{2,30})/u;

/**
 * Names the resource limit a replay ran into, from result-contract fields only.
 *
 * A process-limit hit is not directly observable: it appears only as an install failure (an
 * EAGAIN code) or as a failed test, so it cannot be told apart from other failures here.
 */
export const classifyLimit = (
  run: Pick<ReplayObservation, 'errors' | 'execution'>,
): { readonly limit: Limit; readonly install_error_code?: string } => {
  const codes = run.errors.map((error) => error.code);
  if (codes.includes('timeout') || run.execution?.termination_reason === 'timeout') {
    return { limit: 'time' };
  }
  if (
    codes.includes('resource_termination') ||
    run.execution?.termination_reason === 'resource_limit'
  ) {
    return { limit: 'memory_or_kill' };
  }
  const install = run.errors.find((error) => error.code === 'dependency_install_failed');
  if (install !== undefined) {
    const installCode = NPM_ERROR_CODE.exec(install.message)?.[1];
    const withCode = installCode === undefined ? {} : { install_error_code: installCode };
    return installCode === 'ENOSPC'
      ? { limit: 'workspace_space', ...withCode }
      : { limit: 'install_failed', ...withCode };
  }
  if (run.execution?.stdout.truncated === true || run.execution?.stderr.truncated === true) {
    return { limit: 'output' };
  }
  return { limit: 'none' };
};

/** Combines an observation with what the harness measured around the CLI call. */
export const toReplayRun = (
  observation: ReplayObservation,
  measured: {
    readonly index: number;
    readonly cliExitCode: number | null;
    readonly wallMs: number;
  },
): ReplayRun => ({
  ...observation,
  index: measured.index,
  cli_exit_code: measured.cliExitCode,
  wall_ms: Math.max(0, Math.round(measured.wallMs)),
  ...classifyLimit(observation),
});
