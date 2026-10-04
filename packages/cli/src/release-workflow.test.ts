import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Policy checks for .github/workflows/release.yml and tests for scripts/release-notes.mjs.
 *
 * The release workflow cannot be run before a tag exists, so its safety properties are enforced
 * as text checks: least-privilege permissions, OIDC-only npm publishing with no token, tag-only
 * publishing jobs, and SHA-pinned third-party actions.
 */

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const workflowText = readFileSync(
  path.join(repositoryRoot, '.github', 'workflows', 'release.yml'),
  'utf8',
);

/** The text of each job, keyed by job name. */
const jobBlocks = (text: string): ReadonlyMap<string, string> => {
  const jobs = new Map<string, string>();
  const lines = text.slice(text.indexOf('\njobs:') + 1).split('\n');
  let name: string | undefined;
  let body: string[] = [];
  for (const line of lines.slice(1)) {
    const header = /^ {2}([a-z][a-z-]*):\s*$/u.exec(line);
    if (header !== null) {
      if (name !== undefined) jobs.set(name, body.join('\n'));
      name = header[1];
      body = [];
    } else if (name !== undefined) {
      body.push(line);
    }
  }
  if (name !== undefined) jobs.set(name, body.join('\n'));
  return jobs;
};

const jobOf = (name: string): string => {
  const job = jobBlocks(workflowText).get(name);
  if (job === undefined) throw new Error(`The release workflow has no job named ${name}.`);
  return job;
};

/** The job-level `permissions:` block as `key: value` lines, or undefined when there is none. */
const jobPermissions = (job: string): readonly string[] | undefined => {
  const match = /^ {4}permissions:\n((?: {6}\S.*\n?)+)/mu.exec(job);
  return match?.[1]
    ?.split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim());
};

/** Each `run:` value: the inline command, or the block scalar lines under the key. */
const runBlocks = (text: string): readonly string[] => {
  const lines = text.split('\n');
  const blocks: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/u.exec(lines[index] ?? '');
    if (match === null) continue;
    const indent = (match[1] ?? '').length;
    const inline = match[2] ?? '';
    if (!/^[|>][+-]?$/u.test(inline)) {
      blocks.push(inline);
      continue;
    }
    const body: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next] ?? '';
      if (line.trim() !== '' && line.length - line.trimStart().length <= indent) break;
      body.push(line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
};

const triggerBlock = (text: string): string => {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^on:\s*$/u.test(line));
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== '' && !line.startsWith(' ') && !line.startsWith('#')) break;
    body.push(line);
  }
  return body.join('\n');
};

describe('the release workflow', () => {
  it('grants only contents: read at the top level', () => {
    expect(workflowText).toMatch(/^permissions:\n {2}contents: read\n(?! )/mu);
    expect((workflowText.match(/^permissions:/gmu) ?? []).length).toBe(1);
    expect(workflowText).not.toContain('write-all');
  });

  it('grants id-token only to the attestation and publish jobs', () => {
    const jobs = jobBlocks(workflowText);
    expect([...jobs.keys()]).toEqual([
      'verify',
      'smoke',
      'github-release',
      'npm-publish',
      'move-major-tag',
    ]);
    for (const [name, job] of jobs) {
      const holdsIdToken = (jobPermissions(job) ?? []).includes('id-token: write');
      expect(holdsIdToken, name).toBe(name === 'github-release' || name === 'npm-publish');
    }
    expect(jobPermissions(jobOf('github-release'))).toEqual([
      'contents: write',
      'id-token: write',
      'attestations: write',
    ]);
    expect(jobPermissions(jobOf('npm-publish'))).toEqual(['id-token: write']);
    expect(jobPermissions(jobOf('move-major-tag'))).toEqual(['contents: write']);
    expect(jobPermissions(jobOf('verify'))).toBeUndefined();
    expect(jobPermissions(jobOf('smoke'))).toBeUndefined();
  });

  it('never references NPM_TOKEN or NODE_AUTH_TOKEN', () => {
    expect(workflowText).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|_authToken|npm_[A-Za-z0-9]{20}/u);
    // The only credential is the run's own short-lived token, passed to the gh CLI.
    expect(workflowText).not.toContain('secrets.');
    const tokens = [...workflowText.matchAll(/\$\{\{ ([^}]*token[^}]*) \}\}/giu)].map(
      (match) => match[1],
    );
    expect(new Set(tokens)).toEqual(new Set(['github.token']));
  });

  it('publishes only from the npm-publish environment and when NPM_TRUSTED_PUBLISHING is true', () => {
    const publishing = [...jobBlocks(workflowText)].filter(([, job]) =>
      /\bnpm publish\b/u.test(job),
    );

    expect(publishing.map(([name]) => name)).toEqual(['npm-publish']);
    const job = jobOf('npm-publish');
    expect(job).toMatch(/^ {4}environment: npm-publish$/mu);
    expect(job).toContain("vars.NPM_TRUSTED_PUBLISHING == 'true'");
    expect(job).toContain("github.event_name == 'push'");
    expect(job).toContain('registry-url: https://registry.npmjs.org');
    expect(job).toMatch(/npm publish "\$RUNNER_TEMP"\/package\/proofissue-\*\.tgz/u);
    expect(job).toContain('sha256sum --check SHA256SUMS');
  });

  it('triggers only on vX.Y.Z tags, plus a manual dry run', () => {
    const block = triggerBlock(workflowText);

    expect(block).toMatch(/^ {2}push:\n {4}tags:\n {6}- 'v\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+'\n/mu);
    expect(block).not.toContain('branches');
    expect([...block.matchAll(/^ {2}([a-z_]+):/gmu)].map((match) => match[1])).toEqual([
      'push',
      'workflow_dispatch',
    ]);
    expect(workflowText).not.toMatch(/pull_request|schedule:|workflow_run|^ {2}release:/mu);
  });

  it('skips every job that publishes unless the run was a tag push', () => {
    for (const name of ['github-release', 'npm-publish', 'move-major-tag']) {
      const job = jobOf(name);
      expect(job, name).toMatch(
        /^ {4}if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)/mu,
      );
    }
    expect(jobOf('verify')).not.toMatch(/^ {4}if:/mu);
    expect(jobOf('smoke')).not.toMatch(/^ {4}if:/mu);
  });

  it('releases only after verification and smoke tests, as a prerelease with provenance', () => {
    const job = jobOf('github-release');

    expect(job).toMatch(/needs:\n {6}- verify\n {6}- smoke\n/u);
    expect(job).toContain('actions/attest-build-provenance@');
    expect(job).toContain('--verify-tag');
    expect(job).toContain('--prerelease');
    expect(job).toContain('--notes-file');
    expect(jobOf('npm-publish')).toMatch(
      /needs:\n {6}- verify\n {6}- smoke\n {6}- github-release\n/u,
    );
  });

  it('pins every third-party action to a full commit SHA with a version comment', () => {
    const uses = [...workflowText.matchAll(/^\s*(?:- )?uses:\s*(.*)$/gmu)].map(
      (match) => match[1] ?? '',
    );

    expect(uses.length).toBeGreaterThan(8);
    for (const use of uses) {
      expect(use).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+(?:\.\d+)*$/u);
    }
  });

  it('keeps credentials, caches, and attacker-controlled text out of the jobs', () => {
    expect(workflowText).not.toMatch(/actions\/cache@|github\.event\.|github\.head_ref/u);
    for (const run of runBlocks(workflowText)) expect(run).not.toContain('${{');
    const checkouts = workflowText.split('actions/checkout@').slice(1);
    expect(checkouts.length).toBe(2);
    for (const checkout of checkouts) {
      expect(checkout.slice(0, 200)).toContain('persist-credentials: false');
    }
    const setups = workflowText.split('actions/setup-node@').slice(1);
    for (const setup of setups)
      expect(setup.slice(0, 250)).toContain('package-manager-cache: false');
    expect(workflowText).toMatch(
      /^concurrency:\n {2}group: release\n {2}cancel-in-progress: false\n/mu,
    );
  });

  it('requires the tag to be on main and to equal the package versions before building', () => {
    const verify = jobOf('verify');

    expect(verify).toContain('git merge-base --is-ancestor "$GITHUB_SHA" origin/main');
    expect(verify).toContain('release/npm/package.json');
    expect(verify).toContain('PROOFISSUE_VERSION');
    expect(verify).toContain('fetch-depth: 0');
    expect(verify).toContain('node scripts/release-notes.mjs "$section"');
    expect(verify).toContain('--reproducible');
  });

  it('moves the major tag through the API without persisting git credentials', () => {
    const job = jobOf('move-major-tag');

    expect(job).toContain('gh api');
    expect(job).not.toMatch(/\bgit (?:push|tag)\b/u);
    expect(job).not.toContain('actions/checkout');
  });
});

describe('scripts/release-notes.mjs', () => {
  const scratch = mkdtempSync(path.join(tmpdir(), 'proofissue-release-notes-'));
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });
  const script = path.join(repositoryRoot, 'scripts', 'release-notes.mjs');
  const notes = (arguments_: readonly string[], changelog?: string) => {
    let file = path.join(repositoryRoot, 'CHANGELOG.md');
    if (changelog !== undefined) {
      file = path.join(scratch, 'CHANGELOG.md');
      writeFileSync(file, changelog);
    }
    return spawnSync(process.execPath, [script, ...arguments_, file], { encoding: 'utf8' });
  };
  const sample = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '### Added',
    '',
    '- Something pending.',
    '',
    '## [0.2.0] - 2026-11-01',
    '',
    '### Fixed',
    '',
    '- A bug in 0.2.0.',
    '',
    '## [0.1.0] - 2026-10-20',
    '',
    '### Added',
    '',
    '- First preview.',
    '',
  ].join('\n');

  it('extracts the version section and fails when it is missing', () => {
    const found = notes(['0.2.0'], sample);
    expect(found.status).toBe(0);
    expect(found.stdout).toBe('### Fixed\n\n- A bug in 0.2.0.\n');

    const last = notes(['0.1.0'], sample);
    expect(last.status).toBe(0);
    expect(last.stdout).toBe('### Added\n\n- First preview.\n');

    const missing = notes(['0.3.0'], sample);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('No "## [0.3.0]" section was found');
  });

  it('refuses an undated or empty version section', () => {
    const undated = notes(['0.1.0'], '## [0.1.0]\n\n- Something.\n');
    expect(undated.status).toBe(1);
    expect(undated.stderr).toContain('must carry a date');

    const empty = notes(['0.1.0'], '## [0.1.0] - 2026-10-20\n\n## [0.0.1] - 2026-01-01\n\n- x\n');
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain('is empty');
  });

  it('does not match a version that is only a prefix of another heading', () => {
    expect(notes(['0.1.0'], '## [0.1.0-rc.1] - 2026-10-01\n\n- Candidate.\n').status).toBe(1);
  });

  it('extracts the Unreleased section for dry runs and rejects malformed arguments', () => {
    const unreleased = notes(['Unreleased'], sample);
    expect(unreleased.status).toBe(0);
    expect(unreleased.stdout).toBe('### Added\n\n- Something pending.\n');

    expect(notes(['v0.1.0'], sample).status).toBe(2);
    expect(spawnSync(process.execPath, [script], { encoding: 'utf8' }).status).toBe(2);
  });

  it('has release notes in the repository changelog for the packaged version', () => {
    const packaged = (
      JSON.parse(
        readFileSync(path.join(repositoryRoot, 'release', 'npm', 'package.json'), 'utf8'),
      ) as { version: string }
    ).version;
    // A release version needs the dated section the tag build reads; a development version
    // keeps its notes under Unreleased until the release is cut.
    const result = notes([/^\d+\.\d+\.\d+$/u.test(packaged) ? packaged : 'Unreleased']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('proofissue --version');
  });
});
