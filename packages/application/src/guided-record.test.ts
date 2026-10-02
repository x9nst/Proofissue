import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readArtifactFile } from '@proofissue/artifact-schema';

import {
  createRecordApplicationService,
  type ExpectationChoice,
  type RecordApplicationRequest,
  type RecordConfirmation,
  type RecordObservationView,
  type RecordPreview,
} from './index.js';

const roots: string[] = [];
const confirmed: RecordConfirmation = {
  reproduction_files_confirmed: true,
  subject_files_confirmed: true,
  write_confirmed: true,
};

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});

const exists = async (location: string): Promise<boolean> => {
  try {
    await access(location);
    return true;
  } catch {
    return false;
  }
};

const MARKER = 'ran.marker';

interface Fixture {
  readonly output: string;
  readonly request: RecordApplicationRequest;
  readonly root: string;
}

const fixture = async (): Promise<Fixture> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-guided-'));
  roots.push(root);
  await mkdir(path.join(root, 'test'));
  await mkdir(path.join(root, 'src'));
  await writeFile(
    path.join(root, 'test', 'reproduction.mjs'),
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(new URL('../${MARKER}', import.meta.url), 'ran');`,
      "console.log('checking 3 inputs');",
      "console.error('AssertionError: expected 3 to equal 4');",
      "console.error('Expected 4 from calculate(2)');",
      "console.error('unrelated Authorization: Bear' + 'er abcdefghijklmnop1234567890');",
      'process.exitCode = 1;',
      '',
    ].join('\n'),
  );
  await writeFile(path.join(root, 'src', 'subject.mjs'), 'export const value = 3;\n');
  const output = path.join(root, 'out.proofissue.yaml');
  return {
    output,
    root,
    request: {
      arguments: ['test/reproduction.mjs'],
      environment_image: `node@sha256:${'1'.repeat(64)}`,
      expect_stderr: [],
      expect_stdout: [],
      output_path: output,
      program: 'node',
      project_root: root,
      reproduction_paths: ['test/reproduction.mjs'],
      subject_paths: ['src/subject.mjs'],
    },
  };
};

describe('guided recording', () => {
  it('calls the selector after the command ran and stores the chosen lines', async () => {
    const { output, request, root } = await fixture();
    let sawMarkerBeforeChoice = false;
    let view: RecordObservationView | undefined;
    let preview: RecordPreview | undefined;

    const result = await createRecordApplicationService(
      (value) => {
        preview = value;
        return Promise.resolve(confirmed);
      },
      undefined,
      undefined,
      {
        select_expectations: async (listing) => {
          view = listing;
          sawMarkerBeforeChoice = await exists(path.join(root, MARKER));
          return { status: 'chosen', line_ids: ['e2', 'o1'] };
        },
      },
    ).record(request);

    expect(result.status).toBe('created');
    expect(sawMarkerBeforeChoice).toBe(true);
    expect(view?.suggestion).toMatchObject({ id: 'e1', rule: 'assertion_error' });
    expect(view?.stderr.lines.map((line) => [line.id, line.selectable])).toEqual([
      ['e1', true],
      ['e2', true],
      ['e3', false],
    ]);
    expect(preview?.expectations.stderr.map((item) => item.value)).toEqual([
      'Expected 4 from calculate(2)',
    ]);
    expect(preview?.expectations.stdout.map((item) => item.value)).toEqual(['checking 3 inputs']);
    const read = await readArtifactFile(output);
    if (!read.ok) throw new Error('The written artifact is invalid.');
    expect(read.artifact.expect.stderr).toEqual([
      expect.objectContaining({ mode: 'contains', value: 'Expected 4 from calculate(2)' }),
    ]);
  });

  it('never places output text in the operation result', async () => {
    const { request } = await fixture();
    const results = [];
    for (const ids of [['e2'], ['e3'], ['e99'], ['nonsense']]) {
      results.push(
        await createRecordApplicationService(
          () => Promise.resolve(confirmed),
          undefined,
          undefined,
          {
            select_expectations: () => Promise.resolve({ status: 'chosen', line_ids: ids }),
          },
        ).record({ ...request, output_path: `${request.output_path}.${ids.join('')}` }),
      );
    }

    const text = JSON.stringify(results);
    expect(text).not.toContain('Expected 4');
    expect(text).not.toContain('AssertionError');
    expect(text).not.toContain('checking 3');
    expect(text).not.toContain('abcdefghijklmnop');
    expect(results.map((result) => result.status)).toEqual([
      'created',
      'invalid_input',
      'invalid_input',
      'invalid_input',
    ]);
  });

  it.each<[string, ExpectationChoice]>([
    ['the person cancels', { status: 'cancelled' }],
    ['no line is chosen', { status: 'chosen', line_ids: [] }],
  ])('cancels and writes nothing when %s', async (_name, choice) => {
    const { output, request } = await fixture();
    const confirm = vi.fn(() => Promise.resolve(confirmed));

    const result = await createRecordApplicationService(confirm, undefined, undefined, {
      select_expectations: () => Promise.resolve(choice),
    }).record(request);

    expect(result.status).toBe('cancelled');
    expect(confirm).not.toHaveBeenCalled();
    expect(await exists(output)).toBe(false);
  });

  it('refuses more than 16 lines and unlisted or unselectable ids', async () => {
    const { output, request } = await fixture();
    for (const ids of [
      Array.from({ length: 17 }, (_, index) => `e${String(index + 1)}`),
      ['e3'],
      ['o2'],
    ]) {
      const result = await createRecordApplicationService(
        () => Promise.resolve(confirmed),
        undefined,
        undefined,
        { select_expectations: () => Promise.resolve({ status: 'chosen', line_ids: ids }) },
      ).record(request);
      expect(result.status).toBe('invalid_input');
    }
    expect(await exists(output)).toBe(false);
  });

  it('applies the self-check to selected lines', async () => {
    const { output, request } = await fixture();
    const confirm = vi.fn(() => Promise.resolve(confirmed));
    const disagreeing = {
      match: vi.fn(() => ({
        reproduced: false,
        evidence: [],
        differences: [{ kind: 'stderr_differs' as const, message: 'A fixed explanation.' }],
      })),
    };
    const recorderModule = await import('@proofissue/recorder');

    const result = await createRecordApplicationService(
      confirm,
      recorderModule.createRecorder(),
      disagreeing,
      { select_expectations: () => Promise.resolve({ status: 'chosen', line_ids: ['e2'] }) },
    ).record(request);

    expect(disagreeing.match).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('invalid_input');
    expect(result.errors[0]?.message).toContain('does not satisfy its own expectations');
    expect(confirm).not.toHaveBeenCalled();
    expect(await exists(output)).toBe(false);
  });

  it('does not call the selector when the request names its expectations', async () => {
    const { request } = await fixture();
    const select = vi.fn(() => Promise.resolve<ExpectationChoice>({ status: 'cancelled' }));

    const result = await createRecordApplicationService(
      () => Promise.resolve(confirmed),
      undefined,
      undefined,
      { select_expectations: select },
    ).record({ ...request, expect_stderr: ['Expected 4 from calculate(2)'] });

    expect(result.status).toBe('created');
    expect(select).not.toHaveBeenCalled();
  });

  it('fails with an explanation when the command printed no usable line', async () => {
    const { output, request, root } = await fixture();
    await writeFile(
      path.join(root, 'test', 'reproduction.mjs'),
      'process.stderr.write("\\n\\n");\nprocess.exitCode = 1;\n',
    );
    const select = vi.fn(() => Promise.resolve<ExpectationChoice>({ status: 'cancelled' }));

    const result = await createRecordApplicationService(
      () => Promise.resolve(confirmed),
      undefined,
      undefined,
      { select_expectations: select },
    ).record(request);

    expect(result.status).toBe('invalid_input');
    expect(result.errors[0]?.message).toContain('printed no line that can be recorded');
    expect(select).not.toHaveBeenCalled();
    expect(await exists(output)).toBe(false);
  });

  it('asks for expectations as before when no selector is given', async () => {
    const { request } = await fixture();

    const result = await createRecordApplicationService(() => Promise.resolve(confirmed)).record(
      request,
    );

    expect(result.status).toBe('invalid_input');
    expect(result.errors[0]?.message).toContain('needs an expected stdout or stderr literal');
  });
});
