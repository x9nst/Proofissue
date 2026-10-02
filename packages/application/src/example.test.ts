import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

import { sha256 } from '@proofissue/artifact-schema';

import {
  APPROVED_REPLAY_IMAGE,
  createRecordApplicationService,
  createStaticArtifactApplicationServices,
  defaultArtifactPath,
  type RecordPreview,
} from './index.js';

// The arguments below are the ones documented in examples/failing-node-test/README.md and
// docs/cli.md. If the example or the documented command stops working, this fails.
describe('examples/failing-node-test', () => {
  it('records with the documented arguments into an artifact that validates and inspects', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-example-'));
    const output = path.join(root, 'failure.proofissue');
    try {
      const recorded = await createRecordApplicationService(() =>
        Promise.resolve({
          reproduction_files_confirmed: true,
          subject_files_confirmed: true,
          write_confirmed: true,
        }),
      ).record({
        arguments: ['test/reproduction.mjs'],
        environment_image: `node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6`,
        expect_stderr: ['Expected 4 from calculate(2)'],
        expect_stdout: [],
        output_path: output,
        program: 'node',
        project_root: 'examples/failing-node-test',
        reproduction_paths: ['test/reproduction.mjs'],
        subject_paths: ['src/calculate.mjs'],
      });
      expect(recorded).toMatchObject({ status: 'created', errors: [] });

      const services = createStaticArtifactApplicationServices();
      const validated = await services.validate({ artifact_path: output });
      expect(validated).toMatchObject({ status: 'valid', errors: [] });

      const inspected = await services.inspect({ artifact_path: output });
      expect(inspected).toMatchObject({
        status: 'inspected',
        inspection: {
          command: { program: 'node', argument_count: 1 },
          expectations: { exit_code: 1, stdout_count: 0, stderr_count: 1 },
          files: [
            { path: 'src/calculate.mjs', role: 'subject' },
            { path: 'test/reproduction.mjs', role: 'reproduction' },
          ],
          redaction: { finding_count: 0 },
        },
      });

      const digest = sha256(await readFile(output));
      expect(recorded).toMatchObject({ artifact_digest: digest });
      expect(validated).toMatchObject({ artifact_digest: digest });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('records the example without image or output options', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'proofissue-example-defaults-'));
    try {
      // What the CLI fills in when --image and --output are left out.
      const chosen = defaultArtifactPath({
        cwd: root,
        exists: () => false,
        reproduction_paths: ['test/reproduction.mjs'],
      });
      expect(chosen).toEqual({ status: 'chosen', path: 'reproduction.proofissue.yaml' });
      const output = path.join(root, 'reproduction.proofissue.yaml');
      let previewed: RecordPreview | undefined;

      const recorded = await createRecordApplicationService((preview) => {
        previewed = preview;
        return Promise.resolve({
          reproduction_files_confirmed: true,
          subject_files_confirmed: true,
          write_confirmed: true,
        });
      }).record({
        arguments: ['test/reproduction.mjs'],
        environment_image: APPROVED_REPLAY_IMAGE,
        expect_stderr: ['Expected 4 from calculate(2)'],
        expect_stdout: [],
        output_path: output,
        program: 'node',
        project_root: 'examples/failing-node-test',
        reproduction_paths: ['test/reproduction.mjs'],
        subject_paths: ['src/calculate.mjs'],
      });

      expect(recorded).toMatchObject({ status: 'created', errors: [] });
      expect(previewed).toMatchObject({
        output_path: output,
        replay_image: APPROVED_REPLAY_IMAGE,
        host_node_major: Number(process.versions.node.split('.')[0]),
      });
      const validated = await createStaticArtifactApplicationServices().validate({
        artifact_path: output,
      });
      expect(validated).toMatchObject({ status: 'valid', errors: [] });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
