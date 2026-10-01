import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const fixtureDirectory = path.resolve(import.meta.dirname, '../../../tests/fixtures/results/v1');

const fixtureNames = [
  'reproduced.json',
  'not-reproduced.json',
  'invalid-artifact.json',
  'execution-failed.json',
] as const;

describe('provisional replay result fixtures', () => {
  it('covers every replay status without publishing detailed output', async () => {
    const fixtures = await Promise.all(
      fixtureNames.map(async (name) => {
        const content = await readFile(path.join(fixtureDirectory, name), 'utf8');
        return JSON.parse(content) as unknown;
      }),
    );

    expect(JSON.stringify(fixtures)).not.toContain('decoded_text');

    const statuses = fixtures.map((fixture) => {
      expect(fixture).toMatchObject({ operation: 'replay', result_schema_version: 1 });
      expect(fixture).toHaveProperty('errors');
      expect(fixture).toHaveProperty('warnings');

      if (typeof fixture !== 'object' || fixture === null || !('status' in fixture)) {
        throw new TypeError('Replay result fixture does not have a status.');
      }
      return fixture.status;
    });

    expect(new Set(statuses)).toEqual(
      new Set(['reproduced', 'not_reproduced', 'invalid_artifact', 'execution_failed']),
    );
  });
});

const prepareFixtureNames = [
  'prepared.json',
  'not-required.json',
  'invalid-artifact.json',
  'execution-failed.json',
] as const;

async function readPrepareFixtures(): Promise<Record<string, unknown>[]> {
  return Promise.all(
    prepareFixtureNames.map(async (name) => {
      const content = await readFile(path.join(fixtureDirectory, 'prepare', name), 'utf8');
      return JSON.parse(content) as Record<string, unknown>;
    }),
  );
}

describe('provisional prepare result fixtures', () => {
  it('covers every completed prepare status without package contents', async () => {
    const fixtures = await readPrepareFixtures();

    expect(JSON.stringify(fixtures)).not.toContain('decoded_text');
    for (const fixture of fixtures) {
      expect(fixture).toMatchObject({ operation: 'prepare', result_schema_version: 1 });
      expect(fixture).toHaveProperty('errors');
      expect(fixture).toHaveProperty('warnings');
    }

    expect(new Set(fixtures.map((fixture) => fixture['status']))).toEqual(
      new Set(['prepared', 'not_required', 'invalid_artifact', 'execution_failed']),
    );
  });

  it('reports a preparation summary only when prepared', async () => {
    const fixtures = await readPrepareFixtures();

    for (const fixture of fixtures) {
      expect('preparation' in fixture).toBe(fixture['status'] === 'prepared');
    }
  });
});

const outputMatchingFixtureNames = [
  'reproduced-normalized.json',
  'not-reproduced-output-modes.json',
] as const;

// The canonical rule order is part of the public contract (see docs/output-matching.md).
const canonicalRules = [
  'line_endings',
  'ansi_escapes',
  'trailing_whitespace',
  'paths',
  'node_version',
  'node_internal_locations',
  'process_ids',
  'durations',
];

interface Explained {
  readonly kind: string;
  readonly message: string;
  readonly normalization?: {
    readonly changes: readonly { readonly count: number; readonly rule: string }[];
    readonly rules: readonly string[];
  };
}

const readOutputMatchingFixtures = async (): Promise<
  readonly { readonly differences: Explained[]; readonly evidence: Explained[] }[]
> =>
  await Promise.all(
    outputMatchingFixtureNames.map(async (name) => {
      const content = await readFile(path.join(fixtureDirectory, name), 'utf8');
      return JSON.parse(content) as { differences: Explained[]; evidence: Explained[] };
    }),
  );

describe('output-matching result fixtures', () => {
  it('carry well-formed normalization summaries and no output text', async () => {
    const fixtures = await readOutputMatchingFixtures();

    expect(JSON.stringify(fixtures)).not.toContain('decoded_text');
    const explained = fixtures.flatMap((fixture) => [...fixture.evidence, ...fixture.differences]);
    const normalized = explained.filter((item) => item.normalization !== undefined);
    expect(normalized.length).toBeGreaterThan(0);

    for (const item of normalized) {
      const { changes, rules } = item.normalization ?? { changes: [], rules: [] };
      const positions = (names: readonly string[]): number[] =>
        names.map((name) => canonicalRules.indexOf(name));
      expect(positions(rules).every((position) => position >= 0)).toBe(true);
      expect(positions(rules)).toEqual([...positions(rules)].sort((a, b) => a - b));
      expect(new Set(rules).size).toBe(rules.length);
      expect(positions(changes.map((change) => change.rule))).toEqual(
        [...positions(changes.map((change) => change.rule))].sort((a, b) => a - b),
      );
      for (const change of changes) {
        expect(rules).toContain(change.rule);
        expect(Number.isInteger(change.count) && change.count > 0).toBe(true);
      }
    }
  });

  it('covers the exact and normalized kinds and keeps raw checks free of a summary', async () => {
    const [reproduced, corrected] = await readOutputMatchingFixtures();

    expect(reproduced?.evidence.map((item) => item.kind)).toEqual([
      'exit_code',
      'stdout_exact',
      'stderr_contains',
      'stderr_exact',
    ]);
    expect(reproduced?.evidence[1]).not.toHaveProperty('normalization');
    expect(corrected?.differences.map((item) => item.kind)).toEqual([
      'exit_code',
      'stderr_missing',
      'stderr_differs',
    ]);
  });
});
