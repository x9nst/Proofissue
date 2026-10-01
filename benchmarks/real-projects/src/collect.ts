/**
 * Reads per-case results back from a directory of downloaded workflow artifacts.
 *
 * The files were written by a job that ran third-party code, so everything here is defensive:
 * symbolic links are ignored, sizes are bounded before reading, every result goes through
 * {@link parseTrialResult}, and a result file must belong to the case its name claims.
 */
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  parseTrialResult,
  type DigestVerification,
  type InvalidResult,
  type ValidatedResult,
} from './summary.js';
import type { TrialResult } from './result-model.js';

const RESULT_FILE = /^([A-Z][A-Z0-9-]{0,15})\.result\.json$/u;
const MAX_DEPTH = 4;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 1000;

export interface CollectedResults {
  readonly results: readonly ValidatedResult[];
  readonly invalid: readonly InvalidResult[];
}

const displayPath = (relative: string): string =>
  relative
    .split(path.sep)
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 64))
    .join('/')
    .slice(0, 200);

const sha256File = async (file: string): Promise<string | undefined> => {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > MAX_ARTIFACT_BYTES) return undefined;
    return createHash('sha256')
      .update(await readFile(file))
      .digest('hex');
  } catch {
    return undefined;
  }
};

const digestsOf = (
  artifactDigest: string | undefined,
  runs: readonly { readonly artifact_digest?: string }[],
): readonly string[] => [
  ...(artifactDigest === undefined ? [] : [artifactDigest]),
  ...runs.flatMap((run) => (run.artifact_digest === undefined ? [] : [run.artifact_digest])),
];

/**
 * Compares the SHA-256 of each uploaded `.proofissue` file with the digests the case result
 * reports. `null` means there was nothing to compare (the file or the digests are absent).
 */
export const verifyDigests = async (
  result: TrialResult,
  directory: string,
): Promise<DigestVerification> => {
  const id = result.case.id;
  const { stages } = result;
  const main = await sha256File(path.join(directory, `${id}.proofissue`));
  const expected = digestsOf(stages.record.artifact_digest, [
    ...stages.snapshot.runs,
    ...stages.pre_fix_checkout.runs,
    ...stages.fix_verification.runs,
  ]);
  if (main === undefined || expected.length === 0) return null;
  let verified = expected.every((digest) => digest === main);

  const baseline = await sha256File(path.join(directory, `${id}-install-baseline.proofissue`));
  const baselineExpected = digestsOf(
    stages.install_baseline.artifact_digest,
    stages.install_baseline.runs,
  );
  if (baseline !== undefined && baselineExpected.length > 0) {
    verified = verified && baselineExpected.every((digest) => digest === baseline);
  }
  return verified;
};

const walk = async (directory: string, depth: number, found: string[]): Promise<void> => {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries.slice(0, MAX_DIRECTORY_ENTRIES)) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(full, depth + 1, found);
    } else if (entry.isFile() && RESULT_FILE.test(entry.name)) {
      found.push(full);
    }
  }
};

export const collectResults = async (inputDirectory: string): Promise<CollectedResults> => {
  const files: string[] = [];
  await walk(inputDirectory, 1, files);
  files.sort();

  const results: ValidatedResult[] = [];
  const invalid: InvalidResult[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const shown = displayPath(path.relative(inputDirectory, file));
    const claimed = RESULT_FILE.exec(path.basename(file))?.[1];
    const reject = (reason: string): void => {
      invalid.push({ file: shown, reason });
    };
    try {
      const info = await lstat(file);
      if (!info.isFile()) {
        reject('Not a regular file.');
        continue;
      }
      if (info.size > MAX_RESULT_BYTES) {
        reject('The result file is larger than 1 MiB.');
        continue;
      }
      let value: unknown;
      try {
        value = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        reject('The result file is not valid JSON.');
        continue;
      }
      const parsed = parseTrialResult(value);
      if (!parsed.ok) {
        reject(parsed.reason);
        continue;
      }
      if (parsed.result.case.id !== claimed) {
        reject('The result belongs to a different case than its file name says.');
        continue;
      }
      if (seen.has(parsed.result.case.id)) {
        reject('A result for this case was already read.');
        continue;
      }
      seen.add(parsed.result.case.id);
      results.push({
        result: parsed.result,
        digest_verified: await verifyDigests(parsed.result, path.dirname(file)),
      });
    } catch {
      reject('The result file could not be read.');
    }
  }
  return { results, invalid };
};
