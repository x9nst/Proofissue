import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { ArtifactOutputExpectationV1 } from '@proofissue/artifact-schema';
import {
  DEFAULT_OUTPUT_NORMALIZATION,
  containsContextPath,
  createOutputPathContext,
  normalizeOutput,
} from '@proofissue/output-rules';
import type { OutputPathContext, OutputPathPlatform } from '@proofissue/output-rules';
import type { Redactor } from '@proofissue/redactor';

import { RecorderError } from './errors.js';

/**
 * One output expectation a reporter asks for.
 *
 * A plain string is a raw literal that must appear in the redacted stream (the original
 * form). The object forms ask for more, and are derived from the recording itself:
 *
 * - `contains` with `normalized: true`: the literal is normalized with every rule, as the
 *   reporter saw it printed locally, and must appear in the normalized recording.
 * - `exact`: the whole stream (redacted, and normalized when `normalized` is true).
 */
export type RecordOutputExpectation =
  | string
  | { readonly mode: 'contains'; readonly normalized: boolean; readonly value: string }
  | { readonly mode: 'exact'; readonly normalized: boolean };

export const MAX_OUTPUT_VALUE_BYTES = 8192;

type StreamName = 'stderr' | 'stdout';

/** The literal a reporter typed, for the forms that carry one. */
const literalOf = (item: RecordOutputExpectation): string | undefined => {
  if (typeof item === 'string') return item;
  return item.mode === 'contains' ? item.value : undefined;
};

export const isExactExpectation = (item: RecordOutputExpectation): boolean =>
  typeof item !== 'string' && item.mode === 'exact';

/** Every literal the reporter typed, to be checked for secrets and length before anything runs. */
export const requestedLiterals = (items: readonly RecordOutputExpectation[]): readonly string[] =>
  items.flatMap((item) => literalOf(item) ?? []);

/** Checks the request shape before the command runs: the command never runs for a bad request. */
export const validateExpectationRequest = (
  stdout: readonly RecordOutputExpectation[],
  stderr: readonly RecordOutputExpectation[],
  maximum: number,
): void => {
  if (stdout.length + stderr.length === 0) {
    throw new RecorderError(
      'invalid_request',
      'A failing recording needs an expected stdout or stderr literal.',
    );
  }
  if (
    stdout.length > maximum ||
    stderr.length > maximum ||
    stdout.length + stderr.length > maximum ||
    [...requestedLiterals(stdout), ...requestedLiterals(stderr)].some(
      (value) => value.length === 0 || value.length > MAX_OUTPUT_VALUE_BYTES,
    )
  ) {
    throw new RecorderError('invalid_request', 'Expected output literals exceed artifact limits.');
  }
  if (
    stdout.filter(isExactExpectation).length > 1 ||
    stderr.filter(isExactExpectation).length > 1
  ) {
    throw new RecorderError(
      'invalid_request',
      'At most one exact expectation is allowed for each output stream.',
    );
  }
};

/**
 * The directories this recording can print. They are host paths: the recorder uses them to
 * replace paths and to refuse values that would leak them, and they must never be serialized,
 * logged, or previewed.
 */
export interface RecordPathContexts {
  /** Where the project's own directory and the temporary directory become tokens. */
  readonly host: OutputPathContext;
  /** Normalizes recorded output: the project, the temporary directory, and declared paths. */
  readonly output: OutputPathContext;
}

const unique = (values: readonly (string | undefined)[]): readonly string[] => [
  ...new Set(values.filter((value): value is string => value !== undefined && value !== '')),
];

const resolvedOrUndefined = async (location: string): Promise<string | undefined> => {
  try {
    return await realpath(location);
  } catch {
    return undefined;
  }
};

const homeDirectory = (): string | undefined => {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
};

export const createRecordPathContexts = async (input: {
  readonly declared_paths: readonly string[];
  readonly project_root: string;
  readonly requested_root: string;
}): Promise<RecordPathContexts> => {
  const platform: OutputPathPlatform = process.platform === 'win32' ? 'win32' : 'posix';
  const temporary = os.tmpdir();
  const systemRoot = process.env.SystemRoot;
  const temporaryRoots = unique([
    temporary,
    await resolvedOrUndefined(temporary),
    platform === 'win32'
      ? systemRoot === undefined
        ? undefined
        : path.win32.join(systemRoot, 'temp')
      : '/tmp',
  ]);
  const projectRoots = unique([input.project_root, path.resolve(input.requested_root)]);
  const home = homeDirectory();
  const homeRoots = unique([
    home,
    home === undefined ? undefined : await resolvedOrUndefined(home),
  ]);
  return {
    host: createOutputPathContext({
      platform,
      project_roots: [...projectRoots, ...homeRoots],
      temporary_roots: [],
    }),
    output: createOutputPathContext({
      declared_paths: input.declared_paths,
      platform,
      project_roots: projectRoots,
      temporary_roots: temporaryRoots,
    }),
  };
};

export interface RecordedStream {
  readonly name: StreamName;
  /** The redacted text: what both the artifact and the preview are built from. */
  readonly text: string;
  readonly truncated: boolean;
}

const refuse = (message: string): never => {
  throw new RecorderError('invalid_request', message);
};

const hint = 'Match part of it with a normalized literal instead.';

const deriveExact = (
  stream: RecordedStream,
  normalized: boolean,
  contexts: RecordPathContexts,
): string => {
  const { name } = stream;
  if (stream.truncated) {
    return refuse(
      `The recorded ${name} was truncated, so an exact expectation cannot describe it. ${hint}`,
    );
  }
  if (stream.text.length === 0) {
    return refuse(`The recorded ${name} is empty, so an exact expectation cannot describe it.`);
  }
  if (stream.text.includes('[REDACTED:')) {
    return refuse(
      `The recorded ${name} contains redaction markers, so an exact expectation cannot be used. ${hint}`,
    );
  }
  const value = normalized
    ? normalizeOutput(stream.text, DEFAULT_OUTPUT_NORMALIZATION, contexts.output).text
    : stream.text;
  if (value.length === 0) {
    return refuse(
      `The recorded ${name} is empty after normalization, so an exact expectation cannot describe it.`,
    );
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_OUTPUT_VALUE_BYTES) {
    return refuse(
      `The recorded ${name} is larger than ${String(MAX_OUTPUT_VALUE_BYTES)} bytes, so an exact expectation cannot store it. ${hint}`,
    );
  }
  return value;
};

/**
 * Turns the requested expectations for one stream into artifact entries, in request order, and
 * checks that each one holds for this recording and is safe to store.
 */
export const deriveOutputExpectations = (
  stream: RecordedStream,
  requested: readonly RecordOutputExpectation[],
  contexts: RecordPathContexts,
  redactor: Redactor,
): readonly ArtifactOutputExpectationV1[] => {
  let normalizedStream: string | undefined;
  const normalizedText = (): string => {
    normalizedStream ??= normalizeOutput(
      stream.text,
      DEFAULT_OUTPUT_NORMALIZATION,
      contexts.output,
    ).text;
    return normalizedStream;
  };
  const entries: ArtifactOutputExpectationV1[] = [];

  for (const item of requested) {
    if (typeof item === 'string') {
      if (!stream.text.includes(item)) {
        throw new RecorderError(
          'invalid_request',
          `An expected ${stream.name} literal was not observed in retained output.`,
        );
      }
      entries.push({ mode: 'contains', value: item });
      continue;
    }
    const normalized = item.normalized;
    if (item.mode === 'contains' && !normalized) {
      if (!stream.text.includes(item.value)) {
        throw new RecorderError(
          'invalid_request',
          `An expected ${stream.name} literal was not observed in retained output.`,
        );
      }
      entries.push({ mode: 'contains', value: item.value });
      continue;
    }

    const value =
      item.mode === 'exact'
        ? deriveExact(stream, normalized, contexts)
        : normalizeOutput(item.value, DEFAULT_OUTPUT_NORMALIZATION, contexts.output).text;
    if (value.length === 0) {
      throw new RecorderError(
        'invalid_request',
        `An expected ${stream.name} literal is empty after normalization.`,
      );
    }
    if (item.mode === 'contains' && !normalizedText().includes(value)) {
      throw new RecorderError(
        'invalid_request',
        `An expected ${stream.name} literal was not observed in the normalized output.`,
      );
    }
    if (redactor.redact(value).findings.length > 0) {
      throw new RecorderError(
        'redaction_failed',
        `An expected ${stream.name} value contains a likely secret after normalization.`,
      );
    }
    if (containsContextPath(value, contexts.host)) {
      throw new RecorderError(
        'invalid_request',
        `An expected ${stream.name} value contains a local path from this computer; use a normalized expectation so paths are replaced.`,
      );
    }
    entries.push({
      mode: item.mode,
      ...(normalized ? { normalize: [...DEFAULT_OUTPUT_NORMALIZATION] } : {}),
      value,
    });
  }
  return entries;
};
