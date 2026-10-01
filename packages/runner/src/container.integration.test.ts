import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { sha256, validateArtifactValue } from '@proofissue/artifact-schema';
import type {
  ArtifactLimitsV1,
  ArtifactV1,
  ValidatedArtifactV1,
} from '@proofissue/artifact-schema';

import { APPROVED_NODE_IMAGE, createDockerRunner, RunnerError } from './index.js';

const enabled = process.env.PROOFISSUE_RUN_CONTAINER_TESTS === '1';
const integration = describe.runIf(enabled);

const defaultLimits: ArtifactLimitsV1 = {
  timeout_seconds: 15,
  memory_mb: 512,
  cpus: 1,
  processes: 64,
  output_bytes_per_stream: 4096,
};

const artifact = (
  source: string,
  limits: ArtifactLimitsV1 = defaultLimits,
): ValidatedArtifactV1 => {
  const reproduction = 'reproduction.mjs';
  const subject = 'subject.mjs';
  const subjectContent = 'export const unused = true;\n';
  const value: ArtifactV1 = {
    version: 1,
    environment: {
      runtime: 'node',
      runtime_version: '24',
      operating_system: 'linux',
      image: APPROVED_NODE_IMAGE,
    },
    capture: {
      host_operating_system: 'linux',
      host_architecture: 'x64',
      node_version: '24.18.0',
    },
    command: { program: 'node', arguments: [reproduction], working_directory: '.' },
    files: [
      {
        path: reproduction,
        role: 'reproduction',
        encoding: 'utf8',
        content: source,
        sha256: sha256(source),
      },
      {
        path: subject,
        role: 'subject',
        encoding: 'utf8',
        content: subjectContent,
        sha256: sha256(subjectContent),
      },
    ],
    expect: {
      exit_code: 1,
      stdout: [],
      stderr: [{ mode: 'contains', value: 'proofissue-marker' }],
    },
    limits,
    redaction: { enabled: true, findings: [] },
  };
  const validated = validateArtifactValue(value);
  if (!validated.ok) throw new Error(validated.errors[0]?.message ?? 'Invalid test artifact.');
  return validated.artifact;
};

integration('real locked-down Docker replay', () => {
  it('produces the same classification evidence five consecutive times', async () => {
    const runner = createDockerRunner();
    const input = artifact("process.stderr.write('proofissue-marker'); process.exitCode=1;\n");
    const results = [];
    for (let index = 0; index < 5; index += 1) {
      results.push(await runner.run({ artifact: input, mode: 'snapshot' }));
    }
    expect(results.map((result) => result.execution.exit_code)).toEqual([1, 1, 1, 1, 1]);
    expect(results.every((result) => result.cleanup.completed)).toBe(true);
    expect(results.map((result) => result.execution.stderr.decoded_text)).toEqual(
      Array(5).fill('proofissue-marker'),
    );
  }, 120_000);

  it('blocks network, host files, root writes, capabilities, root identity, and the Docker socket', async () => {
    const hostRoot = await mkdtemp(path.join(tmpdir(), 'proofissue-host-sentinel-'));
    const sentinel = path.join(hostRoot, 'secret.txt');
    await writeFile(sentinel, 'host-only');
    const source = `
        import * as fs from 'node:fs';
        import * as net from 'node:net';
        const failures = [];
        if (process.getuid() === 0) failures.push('root');
        const caps = fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\\s*(.+)$/m)?.[1];
        if (caps !== '0000000000000000') failures.push('capabilities');
        if (fs.existsSync('/var/run/docker.sock')) failures.push('docker-socket');
        if (fs.existsSync(${JSON.stringify(sentinel)})) failures.push('host-file');
        try { fs.writeFileSync('/root-write', 'x'); failures.push('root-write'); } catch {}
        const socket = net.connect({host:'1.1.1.1',port:80});
        const finish = () => { process.stderr.write(failures.length ? failures.join(',') : 'proofissue-marker'); process.exitCode=1; };
        socket.once('connect', () => { failures.push('network'); socket.destroy(); finish(); });
        socket.once('error', finish);
        setTimeout(() => { failures.push('network-timeout'); socket.destroy(); finish(); }, 2000).unref();
      `;
    try {
      const result = await createDockerRunner().run({
        artifact: artifact(source),
        mode: 'snapshot',
      });
      expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
      expect(result.cleanup.completed).toBe(true);
    } finally {
      await rm(hostRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it('enforces output, process-count, and writable-workspace limits', async () => {
    const output = await createDockerRunner().run({
      artifact: artifact(
        "process.stdout.write('x'.repeat(10000)); process.stderr.write('proofissue-marker'); process.exitCode=1;\n",
      ),
      mode: 'snapshot',
    });
    expect(output.execution.stdout).toMatchObject({ retained_bytes: 4096, truncated: true });

    const processSource = `
        import * as fs from 'node:fs';
        const candidates = ['/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max'];
        const path = candidates.find((candidate) => fs.existsSync(candidate));
        const appliedLimit = path ? fs.readFileSync(path, 'utf8').trim() : 'missing';
        process.stderr.write(appliedLimit === '17' ? 'proofissue-marker' : 'limit-failed:' + appliedLimit);
        process.exitCode = 1;
      `;
    const processes = await createDockerRunner().run({
      artifact: artifact(processSource, { ...defaultLimits, processes: 16 }),
      mode: 'snapshot',
    });
    expect(processes.execution.stderr.decoded_text).toContain('proofissue-marker');

    const diskSource = `
        import * as fs from 'node:fs';
        try { fs.writeFileSync('/workspace/fill',Buffer.alloc(70*1024*1024)); process.stderr.write('limit-failed'); }
        catch { process.stderr.write('proofissue-marker'); }
        process.exitCode=1;
      `;
    const disk = await createDockerRunner().run({
      artifact: artifact(diskSource),
      mode: 'snapshot',
    });
    expect(disk.execution.stderr.decoded_text).toBe('proofissue-marker');
  }, 60_000);

  it('exposes only PATH and HOME to the replayed process and still streams output with daemon logs disabled', async () => {
    const source = `
        const keys = Object.keys(process.env).sort().join(',');
        const fixed = keys === 'HOME,PATH' && process.env.HOME === '/tmp';
        process.stdout.write('stdout-visible');
        process.stderr.write(fixed ? 'proofissue-marker' : 'environment-leak:' + keys);
        process.exitCode = 1;
      `;
    const result = await createDockerRunner().run({ artifact: artifact(source), mode: 'snapshot' });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
    expect(result.execution.stdout.decoded_text).toBe('stdout-visible');
    expect(result.cleanup.completed).toBe(true);
  }, 30_000);

  it('gives the replay user a writable home directory although it has no account entry', async () => {
    // Recording runs as a real account, so os.homedir() resolves there even with no HOME.
    // The replay user is a bare numeric id: without HOME the call threw ENOENT here, and
    // os.userInfo() still does, because only an account entry could answer it.
    const source = `
        import { writeFileSync } from 'node:fs';
        import { homedir, tmpdir, userInfo } from 'node:os';
        import { join } from 'node:path';
        const attempt = (action) => {
          try { return String(action()); } catch (error) { return error.code + '/' + error.info?.code; }
        };
        const writable = () => { writeFileSync(join(homedir(), '.proofissue-probe'), 'x'); return 'yes'; };
        process.stdout.write([
          'homedir=' + attempt(homedir),
          'home-writable=' + attempt(writable),
          'tmpdir=' + attempt(tmpdir),
          'userinfo=' + attempt(() => userInfo().username),
        ].join(' '));
        process.stderr.write('proofissue-marker');
        process.exitCode = 1;
      `;
    const result = await createDockerRunner().run({ artifact: artifact(source), mode: 'snapshot' });

    expect(result.execution.stdout.decoded_text).toBe(
      'homedir=/tmp home-writable=yes tmpdir=/tmp userinfo=ERR_SYSTEM_ERROR/ENOENT',
    );
    expect(result.cleanup.completed).toBe(true);
  }, 30_000);

  it('blocks DNS resolution and IPv6 connections as well as IPv4', async () => {
    const source = `
        import * as dns from 'node:dns/promises';
        import * as net from 'node:net';
        const failures = [];
        const lookup = dns.lookup('example.com').then(
          () => { failures.push('dns-resolved'); },
          () => undefined,
        );
        const ipv6 = new Promise((resolve) => {
          const socket = net.connect({ host: '2606:4700:4700::1111', port: 80 });
          socket.once('connect', () => { failures.push('ipv6-connected'); socket.destroy(); resolve(); });
          socket.once('error', () => { resolve(); });
          setTimeout(() => { socket.destroy(); resolve(); }, 3000).unref();
        });
        await Promise.race([
          Promise.all([lookup, ipv6]),
          new Promise((resolve) => setTimeout(resolve, 8000).unref()),
        ]);
        process.stderr.write(failures.length ? failures.join(',') : 'proofissue-marker');
        process.exitCode = 1;
      `;
    const result = await createDockerRunner().run({
      artifact: artifact(source),
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
    expect(result.cleanup.completed).toBe(true);
  }, 30_000);

  it('refuses process creation past the process limit', async () => {
    // A bounded stand-in for a fork bomb: it makes far more fork attempts than the
    // limit allows, but never enough to harm the host if the limit were missing.
    const source = `
        import { spawn } from 'node:child_process';
        const children = [];
        let refused = 0;
        for (let index = 0; index < 100; index += 1) {
          const child = spawn('sleep', ['30'], { stdio: 'ignore' });
          child.once('error', () => { refused += 1; });
          children.push(child);
        }
        setTimeout(() => {
          for (const child of children) child.kill('SIGKILL');
          process.stderr.write(refused > 0 ? 'proofissue-marker' : 'process-limit-not-enforced');
          process.exitCode = 1;
        }, 1500);
      `;
    const result = await createDockerRunner().run({
      artifact: artifact(source, { ...defaultLimits, processes: 16 }),
      mode: 'snapshot',
    });

    expect(result.execution.stderr.decoded_text).toBe('proofissue-marker');
    expect(result.cleanup).toMatchObject({ completed: true, residual_resources: [] });
  }, 60_000);

  it('kills a process that allocates past the memory limit and reports resource termination', async () => {
    // Stops at 512 MiB so a missing limit cannot exhaust the host.
    const source = `
        const held = [];
        for (let total = 0; total < 512; total += 8) held.push(Buffer.alloc(8 * 1024 * 1024, 1));
        process.stderr.write('memory-limit-not-enforced');
        process.exitCode = 1;
      `;
    let failure: RunnerError | undefined;
    let completed: Awaited<ReturnType<ReturnType<typeof createDockerRunner>['run']>> | undefined;
    try {
      completed = await createDockerRunner().run({
        artifact: artifact(source, { ...defaultLimits, memory_mb: 64 }),
        mode: 'snapshot',
      });
    } catch (error: unknown) {
      if (error instanceof RunnerError) failure = error;
    }

    // If the run resolves instead of throwing, say what it did rather than "undefined".
    const observed =
      completed === undefined
        ? 'the run threw'
        : `the run resolved with exit_code=${String(completed.execution.exit_code)} termination_reason=${completed.execution.termination_reason}`;
    expect(failure, observed).toMatchObject({
      code: 'resource_termination',
      cleanup: { completed: true, residual_resources: [] },
    });
    expect(failure?.execution?.stderr.decoded_text ?? '').not.toContain('not-enforced');
  }, 60_000);

  it('terminates CPU/time and memory exhaustion and leaves no residual resources', async () => {
    let timeoutError: RunnerError | undefined;
    try {
      await createDockerRunner().run({
        artifact: artifact('while(true){}\n', { ...defaultLimits, timeout_seconds: 1, cpus: 0.25 }),
        mode: 'snapshot',
      });
    } catch (error: unknown) {
      if (error instanceof RunnerError) timeoutError = error;
    }
    expect(timeoutError).toMatchObject({
      code: 'timeout',
      cleanup: { completed: true, residual_resources: [] },
    });

    const memorySource = `
        import * as fs from 'node:fs';
        const candidates = ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes'];
        const path = candidates.find((candidate) => fs.existsSync(candidate));
        const appliedLimit = path ? fs.readFileSync(path, 'utf8').trim() : 'missing';
        process.stderr.write(appliedLimit === '67108864' ? 'proofissue-marker' : 'limit-failed:' + appliedLimit);
        process.exitCode = 1;
      `;
    const memory = await createDockerRunner().run({
      artifact: artifact(memorySource, { ...defaultLimits, memory_mb: 64 }),
      mode: 'snapshot',
    });
    expect(memory.execution.stderr.decoded_text).toBe('proofissue-marker');
  }, 60_000);
});
