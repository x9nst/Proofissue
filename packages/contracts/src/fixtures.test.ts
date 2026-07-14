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
