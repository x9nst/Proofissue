/**
 * Diagnostic files: the raw material for investigating a trial, kept apart from the result.
 *
 * Third-party tools write this text, so it is never printed to the job log. Before it reaches
 * disk it is redacted with ProofIssue's own redactor and scrubbed of local paths, and each file
 * is bounded. The files are not report evidence.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { RedactionLimitError, redactText } from '@proofissue/redactor';

import type { Scrubber } from './scrub.js';

export const DIAGNOSTIC_FILE_LIMIT_BYTES = 256 * 1024;

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;

export const DIAGNOSTICS_README =
  'These files hold output of third-party tools run by the real-project trial harness.\n' +
  'The text was redacted with the ProofIssue redactor and local paths were replaced with tokens,\n' +
  'but treat it as untrusted. Redaction reduces risk and does not replace review.\n' +
  'The files are for investigating a trial. They are not evidence in the evaluation report.\n';

export interface DiagnosticSink {
  /** Appends text to a diagnostic file. Names are fixed by the harness, never by third parties. */
  add(name: string, text: string): void;
  /** Redacts, scrubs, bounds, and writes every file. Never throws. */
  flush(): Promise<void>;
}

const bound = (text: string): string => {
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes <= DIAGNOSTIC_FILE_LIMIT_BYTES) return text;
  const head = Buffer.from(text, 'utf8').subarray(0, DIAGNOSTIC_FILE_LIMIT_BYTES).toString('utf8');
  return `${head}\n[truncated at ${String(DIAGNOSTIC_FILE_LIMIT_BYTES)} bytes]\n`;
};

const safeText = (text: string, scrub: Scrubber): string => {
  try {
    return scrub(redactText(bound(text)).text);
  } catch (error: unknown) {
    if (error instanceof RedactionLimitError) {
      return '[withheld: the output contained too many likely secrets to redact safely]\n';
    }
    return '[withheld: the output could not be redacted safely]\n';
  }
};

export const createDiagnosticSink = (directory: string, scrub: Scrubber): DiagnosticSink => {
  const files = new Map<string, string[]>();
  return {
    add(name, text) {
      if (!FILE_NAME.test(name)) throw new Error('A diagnostic file name is not valid.');
      const parts = files.get(name) ?? [];
      parts.push(text);
      files.set(name, parts);
    },
    async flush() {
      try {
        await mkdir(directory, { recursive: true });
        for (const [name, parts] of files) {
          await writeFile(path.join(directory, name), safeText(parts.join(''), scrub), 'utf8');
        }
        await writeFile(path.join(directory, 'README.txt'), DIAGNOSTICS_README, 'utf8');
      } catch {
        // Diagnostics are best effort and must never decide a trial's outcome.
      }
    },
  };
};
