/**
 * Replays artifacts that carry dependency files in the real locked-down container.
 *
 * These run only where Docker is available (PROOFISSUE_RUN_CONTAINER_TESTS=1, set by the
 * Linux CI job). They prove the parts that no host test can: that the prepared store is
 * mounted read-only and still installs, that nothing is written outside the package
 * directory by a hostile archive, that install scripts do not run, that a bomb is stopped
 * by the workspace limit, and that a failed install is never mistaken for the command.
 *
 * Every case is fail-safe: allocations are bounded and every escape check looks at the
 * container's own filesystem.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256, validateArtifactValue } from '@proofissue/artifact-schema';
import type {
  ArtifactLimitsV1,
  ArtifactV1,
  ValidatedArtifactV1,
} from '@proofissue/artifact-schema';
import { openPackageStore } from '@proofissue/dependencies';
import { buildTarball, type TarEntry } from '@proofissue/dependencies/testing';

import {
  APPROVED_NODE_IMAGE,
  createDockerRunner,
  DEFAULT_RUNNER_POLICY,
  DEPENDENCY_INSTALL_FAILED_EXIT_CODE,
  RunnerError,
  type RunnerResult,
} from './index.js';

const enabled = process.env.PROOFISSUE_RUN_CONTAINER_TESTS === '1';
const integration = describe.runIf(enabled);

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const defaultLimits: ArtifactLimitsV1 = {
  timeout_seconds: 90,
  memory_mb: 512,
  cpus: 1,
  processes: 64,
  output_bytes_per_stream: 8192,
};

const integrityOf = (content: Uint8Array): string =>
  `sha512-${createHash('sha512').update(content).digest('base64')}`;

interface Dependency {
  readonly entries?: readonly TarEntry[];
  readonly hasInstallScript?: boolean;
  readonly name: string;
  readonly tarball?: Buffer;
}

const packageEntries = (name: string, extra: Record<string, unknown> = {}): TarEntry[] => [
  {
    name: 'package/package.json',
    content: JSON.stringify({ name, version: '1.0.0', main: 'index.js', ...extra }),
  },
  { name: 'package/index.js', content: `module.exports = ${JSON.stringify(`${name} loaded`)};` },
];

interface Project {
  readonly artifact: ValidatedArtifactV1;
  readonly store: string;
}

const project = async (
  source: string,
  dependencies: readonly Dependency[],
  options: {
    readonly limits?: ArtifactLimitsV1;
    readonly storeExtras?: readonly Dependency[];
  } = {},
): Promise<Project> => {
  const root = await mkdtemp(path.join(tmpdir(), 'proofissue-container-deps-'));
  roots.push(root);
  const store = await openPackageStore(path.join(root, 'store'));

  const locked: Record<string, unknown> = {};
  const wanted: Record<string, string> = {};
  for (const dependency of dependencies) {
    const tarball =
      dependency.tarball ?? buildTarball(dependency.entries ?? packageEntries(dependency.name));
    const integrity = integrityOf(tarball);
    await store.add(
      integrity,
      (async function* () {
        yield await Promise.resolve(tarball);
      })(),
    );
    wanted[dependency.name] = '1.0.0';
    locked[`node_modules/${dependency.name}`] = {
      version: '1.0.0',
      resolved: `https://registry.npmjs.org/${dependency.name}/-/${dependency.name.split('/').at(-1) ?? dependency.name}-1.0.0.tgz`,
      integrity,
      ...(dependency.hasInstallScript === true ? { hasInstallScript: true } : {}),
    };
  }

  const manifest = JSON.stringify({ name: 'proj', version: '1.0.0', dependencies: wanted });
  const lockfile = JSON.stringify({
    name: 'proj',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: 'proj', version: '1.0.0', dependencies: wanted }, ...locked },
  });
  const subject = 'export const unused = true;\n';
  const file = (
    filePath: string,
    role: 'dependency' | 'reproduction' | 'subject',
    content: string,
  ) => ({
    path: filePath,
    role,
    encoding: 'utf8' as const,
    content,
    sha256: sha256(content),
  });
  const value: ArtifactV1 = {
    version: 1,
    environment: {
      runtime: 'node',
      runtime_version: '24',
      operating_system: 'linux',
      image: APPROVED_NODE_IMAGE,
    },
    capture: { host_operating_system: 'linux', host_architecture: 'x64', node_version: '24.18.0' },
    command: { program: 'node', arguments: ['reproduction.mjs'], working_directory: '.' },
    files: [
      file('reproduction.mjs', 'reproduction', source),
      file('subject.mjs', 'subject', subject),
      file('package.json', 'dependency', manifest),
      file('package-lock.json', 'dependency', lockfile),
    ],
    expect: {
      exit_code: 1,
      stdout: [],
      stderr: [{ mode: 'contains', value: 'proofissue-marker' }],
    },
    limits: options.limits ?? defaultLimits,
    redaction: { enabled: true, findings: [] },
  };
  const validated = validateArtifactValue(value);
  if (!validated.ok) throw new Error(validated.errors[0]?.message ?? 'Invalid test artifact.');
  return { artifact: validated.artifact, store: store.directory };
};

const failureOf = async (run: () => Promise<RunnerResult>): Promise<RunnerError> => {
  let result: RunnerResult;
  try {
    result = await run();
  } catch (error: unknown) {
    if (error instanceof RunnerError) return error;
    throw error;
  }
  throw new Error(
    `Expected the replay to fail, but the command ran and printed: ${result.execution.stderr.decoded_text}`,
  );
};

integration('replay with prepared dependencies in the real container', () => {
  it('installs the locked packages offline and runs the command with them', async () => {
    const { artifact, store } = await project(
      `import dep from 'dep';
       process.stderr.write('proofissue-marker:' + dep);
       process.exitCode = 1;`,
      [{ name: 'dep' }],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    // Only the command's own output: npm's output never reaches the replay result.
    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker:dep loaded');
    expect(result.execution.stdout.decoded_text).toBe('');
    expect(result.execution.exit_code).toBe(1);
    expect(result.cleanup.completed).toBe(true);
    expect(result.effective_limits.writable_workspace_mb).toBe(256);
  }, 120_000);

  it('gives the command the same writable home directory after the install', async () => {
    const { artifact, store } = await project(
      `import { writeFileSync } from 'node:fs';
       import { homedir } from 'node:os';
       import { join } from 'node:path';
       writeFileSync(join(homedir(), '.proofissue-probe'), 'x');
       process.stderr.write('proofissue-marker:' + homedir());
       process.exitCode = 1;`,
      [{ name: 'dep' }],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker:/tmp');
    expect(result.cleanup.completed).toBe(true);
  }, 120_000);

  it('exposes only PATH and HOME to the command after the offline install', async () => {
    const { artifact, store } = await project(
      `const keys = Object.keys(process.env).sort().join(',');
       const fixed = keys === 'HOME,PATH' && process.env.HOME === '/tmp';
       process.stderr.write(fixed ? 'proofissue-marker' : 'environment-leak:' + keys);
       process.exitCode = 1;`,
      [{ name: 'dep' }],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
    expect(result.cleanup.completed).toBe(true);
  }, 120_000);

  it('installs scoped and nested packages from the store', async () => {
    const { artifact, store } = await project(
      `import a from 'a';
       import b from '@scope/b';
       process.stderr.write('proofissue-marker:' + a + '|' + b);
       process.exitCode = 1;`,
      [{ name: 'a' }, { name: '@scope/b', entries: packageEntries('@scope/b') }],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker:a loaded|@scope/b loaded');
  }, 120_000);

  it('does not run the install scripts of a package', async () => {
    const { artifact, store } = await project(
      `import { existsSync } from 'node:fs';
       const ran = existsSync('/workspace/node_modules/dep/SCRIPT_RAN.txt');
       process.stderr.write(ran ? 'script-ran' : 'proofissue-marker');
       process.exitCode = 1;`,
      [
        {
          name: 'dep',
          hasInstallScript: true,
          entries: packageEntries('dep', {
            scripts: {
              preinstall: "node -e \"require('fs').writeFileSync('SCRIPT_RAN.txt','x')\"",
              postinstall: "node -e \"require('fs').writeFileSync('SCRIPT_RAN.txt','x')\"",
            },
          }),
        },
      ],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
  }, 120_000);

  it('writes nothing outside the package for hostile archive entries', async () => {
    const hostile: TarEntry[] = [
      ...packageEntries('dep'),
      { name: 'package/../../ESCAPED_TRAVERSAL.txt', content: 'escaped' },
      { name: '../ESCAPED_DOTDOT.txt', content: 'escaped' },
      { name: 'package/a/../../../ESCAPED_NESTED.txt', content: 'escaped' },
      { name: '/tmp/ESCAPED_ABSOLUTE.txt', content: 'escaped' },
      { name: 'package/tmp-link', type: 'symlink', link: '/tmp' },
      { name: 'package/tmp-link/ESCAPED_VIA_SYMLINK.txt', content: 'escaped' },
      { name: 'package/up-link', type: 'symlink', link: '../../..' },
      { name: 'package/up-link/ESCAPED_VIA_RELATIVE_SYMLINK.txt', content: 'escaped' },
      { name: 'package/hard', type: 'hardlink', link: '/etc/passwd' },
    ];
    const { artifact, store } = await project(
      `import { existsSync, readdirSync, realpathSync, lstatSync } from 'node:fs';
       import path from 'node:path';
       const problems = [];
       for (const place of [
         '/tmp/ESCAPED_ABSOLUTE.txt', '/tmp/ESCAPED_VIA_SYMLINK.txt', '/ESCAPED_TRAVERSAL.txt',
         '/workspace/ESCAPED_TRAVERSAL.txt', '/workspace/ESCAPED_DOTDOT.txt',
         '/workspace/node_modules/ESCAPED_DOTDOT.txt', '/workspace/ESCAPED_NESTED.txt',
         '/workspace/node_modules/ESCAPED_NESTED.txt', '/ESCAPED_VIA_RELATIVE_SYMLINK.txt',
         '/workspace/ESCAPED_VIA_RELATIVE_SYMLINK.txt',
       ]) if (existsSync(place)) problems.push(place);
       const base = '/workspace/node_modules/dep';
       const walk = (dir) => {
         for (const name of readdirSync(dir)) {
           const full = path.join(dir, name);
           let real;
           try { real = realpathSync(full); } catch { problems.push('dangling ' + full); continue; }
           if (real !== base && !real.startsWith(base + '/')) problems.push('leaves package: ' + full + ' -> ' + real);
           else if (lstatSync(full).isDirectory()) walk(full);
         }
       };
       walk(base);
       process.stderr.write(problems.length === 0 ? 'proofissue-marker' : 'ESCAPED:' + problems.join(','));
       process.exitCode = 1;`,
      [{ name: 'dep', entries: hostile }],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
  }, 120_000);

  it('stops an archive that expands past the workspace limit, and reports it as a failed install', async () => {
    // About 200 MiB of zeros compresses to a few hundred KiB, so this is a decompression bomb.
    const bomb = buildTarball([
      ...packageEntries('dep'),
      { name: 'package/huge.bin', content: Buffer.alloc(200 * 1024 * 1024) },
    ]);
    const { artifact, store } = await project(
      `import { statSync, statfsSync } from 'node:fs';
       const size = statSync('/workspace/node_modules/dep/huge.bin').size;
       const fs = statfsSync('/workspace');
       process.stderr.write('proofissue-marker|huge.bin=' + size + '|free=' + fs.bfree * fs.bsize + '|total=' + fs.blocks * fs.bsize);
       process.exitCode = 1;`,
      [{ name: 'dep', tarball: bomb }],
    );
    const runner = createDockerRunner({
      policy: { ...DEFAULT_RUNNER_POLICY, dependency_workspace_mb: 64 },
    });

    const error = await failureOf(
      async () => await runner.run({ artifact, dependency_store: store, mode: 'snapshot' }),
    );

    expect(error.code).toBe('dependency_install_failed');
    // npm itself reports success when extraction runs out of space, so the bootstrap checks.
    expect(error.message).toContain('ENOSPC');
    expect(error.cleanup).toMatchObject({ completed: true, residual_resources: [] });
    // The command never started.
    expect(error.execution?.stderr.decoded_text ?? '').not.toContain('proofissue-marker');
  }, 180_000);

  it('reports a failed install as such, never as the command failing', async () => {
    const { artifact, store } = await project(
      `process.stderr.write('proofissue-marker'); process.exitCode = 1;`,
      [{ name: 'dep' }],
    );
    // The lockfile and package.json disagree, so npm refuses to install.
    const tampered = {
      ...artifact,
      files: artifact.files.map((file) => {
        if (file.path !== 'package.json') return file;
        const content = JSON.stringify({
          name: 'proj',
          version: '1.0.0',
          dependencies: { dep: '9.9.9' },
        });
        return { ...file, content, sha256: sha256(content) };
      }),
    };

    const error = await failureOf(
      async () =>
        await createDockerRunner().run({
          artifact: tampered,
          dependency_store: store,
          mode: 'snapshot',
        }),
    );

    expect(error.code).toBe('dependency_install_failed');
    expect(error.message).toMatch(/^The locked packages could not be installed offline/u);
    expect(error.execution?.exit_code).toBe(DEPENDENCY_INSTALL_FAILED_EXIT_CODE);
    expect(error.execution?.stderr.decoded_text ?? '').not.toContain('proofissue-marker');
    expect(error.cleanup).toMatchObject({ completed: true });
  }, 120_000);

  it('reports a command that exits with the reserved status as a failed install', async () => {
    const { artifact, store } = await project(
      `process.exitCode = ${String(DEPENDENCY_INSTALL_FAILED_EXIT_CODE)};`,
      [{ name: 'dep' }],
    );

    const error = await failureOf(
      async () =>
        await createDockerRunner().run({ artifact, dependency_store: store, mode: 'snapshot' }),
    );

    expect(error.code).toBe('dependency_install_failed');
  }, 120_000);

  it('refuses before creating a container when a locked package is missing from the store', async () => {
    const { artifact } = await project(`process.exitCode = 1;`, [{ name: 'dep' }]);
    const emptyRoot = await mkdtemp(path.join(tmpdir(), 'proofissue-container-empty-'));
    roots.push(emptyRoot);
    const empty = await openPackageStore(path.join(emptyRoot, 'store'));

    const error = await failureOf(
      async () =>
        await createDockerRunner().run({
          artifact,
          dependency_store: empty.directory,
          mode: 'snapshot',
        }),
    );

    expect(error.code).toBe('dependencies_not_prepared');
    expect(error.events.map((event) => event.type)).not.toContain('container_created');
  }, 60_000);

  it('cannot write to the prepared store from inside the container', async () => {
    const { artifact, store } = await project(
      `import { writeFileSync } from 'node:fs';
       let writable = false;
       try { writeFileSync('/proofissue-cache/WRITTEN.txt', 'x'); writable = true; } catch {}
       process.stderr.write(writable ? 'store-was-writable' : 'proofissue-marker');
       process.exitCode = 1;`,
      [{ name: 'dep' }],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
  }, 120_000);

  it('has no network while installing or running', async () => {
    const { artifact, store } = await project(
      `import { connect } from 'node:net';
       const socket = connect({ host: '1.1.1.1', port: 80 });
       socket.once('connect', () => { process.stderr.write('network'); socket.destroy(); });
       socket.once('error', () => { process.stderr.write('proofissue-marker'); });
       process.exitCode = 1;
       setTimeout(() => process.stderr.write('network-timeout'), 3000).unref();`,
      [{ name: 'dep' }],
    );

    const result = await createDockerRunner().run({
      artifact,
      dependency_store: store,
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
  }, 120_000);
});
