import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Policy checks for .github/workflows/real-project-trials.yml.
 *
 * The workflow runs third-party code on a hosted runner, so these properties are enforced as
 * text checks: no credentials, no write permission, no expression interpolated into a script,
 * no cache that code in the job could seed, and only manual or branch-push triggers.
 */

const workflowText = readFileSync(
  fileURLToPath(new URL('../../../.github/workflows/real-project-trials.yml', import.meta.url)),
  'utf8',
);

/** Each `run:` value: the inline command, or the block scalar lines indented under the key. */
export const extractRunBlocks = (text: string): readonly string[] => {
  const lines = text.split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/u.exec(lines[index] ?? '');
    if (match === null) continue;
    const indent = (match[1] ?? '').length;
    const inline = match[2] ?? '';
    if (inline !== '|' && inline !== '>' && !/^[|>][+-]?$/u.test(inline)) {
      blocks.push(inline);
      continue;
    }
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? '';
      const lineIndent = line.length - line.trimStart().length;
      if (line.trim() !== '' && lineIndent <= indent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
};

/** Splits the steps of every job into blocks, one per `- name:` or `- uses:` entry. */
const stepBlocks = (text: string): readonly string[] => {
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of text.split('\n')) {
    if (/^ {6}- (?:name|uses|run):/u.test(line)) {
      if (current !== undefined) blocks.push(current.join('\n'));
      current = [line];
    } else if (
      current !== undefined &&
      (/^ {8}\S/u.test(line) || line.trim() === '' || /^ {10}/u.test(line))
    ) {
      current.push(line);
    } else if (current !== undefined) {
      blocks.push(current.join('\n'));
      current = undefined;
    }
  }
  if (current !== undefined) blocks.push(current.join('\n'));
  return blocks;
};

const triggerKeys = (
  text: string,
): { readonly keys: readonly string[]; readonly block: string } => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/u.test(line));
  if (start === -1) return { keys: [], block: '' };
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('#')) break;
    body.push(line);
  }
  return {
    keys: body.flatMap((line) => {
      const match = /^ {2}([a-z_]+):/u.exec(line);
      return match?.[1] === undefined ? [] : [match[1]];
    }),
    block: body.join('\n'),
  };
};

export const policyViolations = (text: string): readonly string[] => {
  const violations: string[] = [];

  if (!/^permissions:\n {2}contents: read\n(?! )/mu.test(text)) {
    violations.push('The workflow must set only `permissions: contents: read` at the top level.');
  }
  if ((text.match(/^\s*permissions:/gmu) ?? []).length !== 1) {
    violations.push('There must be exactly one permissions block and no job-level permissions.');
  }
  if (/:\s*write\b|write-all/u.test(text)) violations.push('A write permission appears.');

  for (const block of stepBlocks(text)) {
    if (
      block.includes('uses: actions/checkout@') &&
      !block.includes('persist-credentials: false')
    ) {
      violations.push('A checkout step does not disable persisted credentials.');
    }
    if (block.includes('uses: actions/setup-node@')) {
      if (!block.includes('package-manager-cache: false')) {
        violations.push('A setup-node step does not disable the automatic package-manager cache.');
      }
      if (/^\s+cache:/mu.test(block)) violations.push('A setup-node step enables a cache.');
    }
    if (block.includes('uses: actions/upload-artifact@') && !block.includes('retention-days:')) {
      violations.push('An upload-artifact step sets no retention-days.');
    }
  }

  if (/secrets\.|github\.token|GITHUB_TOKEN|id-token/u.test(text)) {
    violations.push('A secret or token is referenced.');
  }
  if (/actions\/cache@/u.test(text)) violations.push('actions/cache is used.');
  if (/github\.event\.|github\.head_ref/u.test(text)) {
    violations.push('An attacker-controllable context is referenced.');
  }
  for (const block of extractRunBlocks(text)) {
    if (block.includes('${{')) violations.push('An expression is interpolated into a run script.');
  }
  for (const use of text.matchAll(/^\s*(?:- )?uses:\s*(\S+)/gmu)) {
    if (!/^[\w.-]+\/[\w.-]+@v\d+$/u.test(use[1] ?? '')) {
      violations.push('An action is not pinned to a major version tag.');
    }
  }

  const triggers = triggerKeys(text);
  if (triggers.keys.slice().sort().join(',') !== 'push,workflow_dispatch') {
    violations.push('The only triggers must be workflow_dispatch and push.');
  }
  const pushBlock = /^ {2}push:\n((?: {4}.*\n?)*)/mu.exec(triggers.block)?.[1] ?? '';
  const pushLines = pushBlock.split('\n').filter((line) => line.trim() !== '');
  if (
    pushLines.length !== 2 ||
    pushLines[0]?.trim() !== 'branches:' ||
    pushLines[1]?.trim() !== "- 'trials/**'"
  ) {
    violations.push("Push must trigger only for branches matching 'trials/**'.");
  }

  const jobsSection = text.slice(text.indexOf('\njobs:'));
  const jobCount = (jobsSection.match(/^ {2}[a-z][a-z-]*:\s*$/gmu) ?? []).length;
  const timeoutCount = (jobsSection.match(/^ {4}timeout-minutes:/gmu) ?? []).length;
  if (jobCount === 0 || timeoutCount !== jobCount) {
    violations.push('Every job must set timeout-minutes.');
  }
  return violations;
};

describe('the real-project trials workflow', () => {
  it('satisfies every policy', () => {
    expect(policyViolations(workflowText)).toEqual([]);
  });

  it('runs on branch pushes to trials/** and manual dispatch only', () => {
    const triggers = triggerKeys(workflowText);

    expect(triggers.keys).toEqual(['workflow_dispatch', 'push']);
    expect(triggers.block).not.toContain('pull_request');
    expect(workflowText).not.toContain('pull_request_target');
    expect(workflowText).not.toContain('schedule:');
  });

  it('passes inputs to scripts only through environment variables', () => {
    const runs = extractRunBlocks(workflowText);

    expect(runs.length).toBeGreaterThan(8);
    expect(runs.some((run) => run.includes('"$TRIAL_SET"'))).toBe(true);
    expect(runs.some((run) => run.includes('"$TRIAL_CASE"'))).toBe(true);
    for (const run of runs) expect(run).not.toContain('${{');
  });

  it('keeps the approved image digest out of the workflow text', () => {
    expect(workflowText).not.toMatch(/sha256:[a-f0-9]{64}/u);
  });
});

describe('policyViolations', () => {
  const clean = (): string => workflowText;

  it('detects a write permission', () => {
    expect(policyViolations(clean().replace('contents: read', 'contents: write'))).not.toEqual([]);
    expect(
      policyViolations(
        clean().replace(
          '    timeout-minutes: 10\n',
          '    timeout-minutes: 10\n    permissions:\n      id-token: write\n',
        ),
      ),
    ).not.toEqual([]);
  });

  it('detects persisted checkout credentials', () => {
    expect(
      policyViolations(clean().replaceAll('          persist-credentials: false\n', '')),
    ).toContain('A checkout step does not disable persisted credentials.');
  });

  it('detects a secret or token', () => {
    expect(
      policyViolations(
        clean().replace('TRIAL_CASE: ${{ matrix.case }}', 'TRIAL_CASE: ${{ secrets.TOKEN }}'),
      ),
    ).toContain('A secret or token is referenced.');
    expect(
      policyViolations(
        clean().replace(
          '    env:\n      PROOFISSUE_IMAGE',
          '    env:\n      GH_TOKEN: ${{ github.token }}\n      PROOFISSUE_IMAGE',
        ),
      ),
    ).toContain('A secret or token is referenced.');
  });

  it('detects an expression interpolated into a script', () => {
    const inline = clean().replace('run: npm ci', 'run: echo ${{ inputs.set }}');
    const block = clean().replace(
      '          uname -m\n',
      '          echo ${{ inputs.cases }}\n          uname -m\n',
    );
    const folded = clean().replace(
      '--cases "$TRIAL_CASE" --runs "$TRIAL_RUNS"',
      '--cases ${{ matrix.case }} --runs "$TRIAL_RUNS"',
    );

    for (const text of [inline, block, folded]) {
      expect(policyViolations(text)).toContain('An expression is interpolated into a run script.');
    }
  });

  it('detects a cache', () => {
    expect(
      policyViolations(clean().replaceAll('          package-manager-cache: false\n', '')),
    ).toContain('A setup-node step does not disable the automatic package-manager cache.');
    expect(
      policyViolations(
        clean().replace(
          '          node-version: 24.18.0\n',
          '          node-version: 24.18.0\n          cache: npm\n',
        ),
      ),
    ).toContain('A setup-node step enables a cache.');
  });

  it('detects extra triggers', () => {
    expect(policyViolations(clean().replace('  push:\n', '  pull_request:\n  push:\n'))).toContain(
      'The only triggers must be workflow_dispatch and push.',
    );
    expect(policyViolations(clean().replace("      - 'trials/**'", "      - '**'"))).toContain(
      "Push must trigger only for branches matching 'trials/**'.",
    );
  });

  it('detects an upload without retention and a missing job timeout', () => {
    expect(policyViolations(clean().replace('          retention-days: 90\n', ''))).toContain(
      'An upload-artifact step sets no retention-days.',
    );
    expect(policyViolations(clean().replace('    timeout-minutes: 60\n', ''))).toContain(
      'Every job must set timeout-minutes.',
    );
  });

  it('detects an attacker-controllable context and an unpinned action', () => {
    expect(
      policyViolations(
        clean().replace(
          'TRIAL_CASE: ${{ matrix.case }}',
          'TRIAL_CASE: ${{ github.event.pull_request.title }}',
        ),
      ),
    ).toContain('An attacker-controllable context is referenced.');
    expect(
      policyViolations(clean().replace('actions/checkout@v7', 'actions/checkout@main')),
    ).toContain('An action is not pinned to a major version tag.');
  });
});
