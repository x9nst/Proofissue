// Usage: node scripts/smoke-cli-package.mjs <proofissue-x.y.z.tgz>
//
// Installs the packed CLI the way a user would (global install and npx), then exercises it on a
// copy of examples/failing-node-test. Replay needs a supported Docker host, so it only runs on
// Linux with PROOFISSUE_SMOKE_REPLAY=1; on Windows the script checks the documented refusal.
import { execFileSync, spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const APPROVED_IMAGE =
  'node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6';
const isWindows = process.platform === 'win32';

const [tarballArgument] = process.argv.slice(2);
if (tarballArgument === undefined) {
  process.stderr.write('Usage: node scripts/smoke-cli-package.mjs <package.tgz>\n');
  process.exit(2);
}
const tarball = path.resolve(tarballArgument);
const expectedVersion = JSON.parse(
  await readFile(path.join(root, 'release', 'npm', 'package.json'), 'utf8'),
).version;

const step = (message) => process.stdout.write(`\n== ${message}\n`);
const assert = (condition, message) => {
  if (!condition) throw new Error(`Smoke check failed: ${message}`);
};

// npm is a .cmd shim on Windows. Run its JavaScript entry point directly so arguments are never
// interpreted by a shell; fall back to the shim only if the entry point cannot be found.
const npmCliCandidates = [
  path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(
    path.dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    'npm',
    'bin',
    'npm-cli.js',
  ),
];
let npmCli;
for (const candidate of npmCliCandidates) {
  if ((await stat(candidate).catch(() => undefined))?.isFile()) {
    npmCli = candidate;
    break;
  }
}
const npm = (args, options) =>
  npmCli === undefined
    ? spawnSync('npm', args, { ...options, encoding: 'utf8', shell: isWindows })
    : spawnSync(process.execPath, [npmCli, ...args], { ...options, encoding: 'utf8' });

const run = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', ...options });

const workDirectory = await mkdtemp(path.join(tmpdir(), 'proofissue-smoke-'));
try {
  const prefix = path.join(workDirectory, 'prefix');
  const project = path.join(workDirectory, 'example');
  const cleanDirectory = path.join(workDirectory, 'clean');
  await cp(path.join(root, 'examples', 'failing-node-test'), project, { recursive: true });
  await mkdir(cleanDirectory);

  step('1. Install the tarball globally into a temporary prefix');
  const install = npm(['install', '--global', '--prefix', prefix, tarball], { cwd: workDirectory });
  assert(install.status === 0, `npm install failed:\n${install.stdout}\n${install.stderr}`);
  const entryPoint = [
    path.join(prefix, 'node_modules', 'proofissue', 'dist', 'proofissue.js'),
    path.join(prefix, 'lib', 'node_modules', 'proofissue', 'dist', 'proofissue.js'),
  ].find((candidate) => path.isAbsolute(candidate) && existsSync(candidate));
  assert(entryPoint !== undefined, 'the installed package has no dist/proofissue.js');

  const cli = (args, options = {}) => run(process.execPath, [entryPoint, ...args], options);

  step('2. npx path: run the packed tarball from a clean directory');
  const exec = npm(['exec', '--yes', '--package', tarball, '--', 'proofissue', '--version'], {
    cwd: cleanDirectory,
  });
  assert(exec.status === 0, `npm exec failed:\n${exec.stdout}\n${exec.stderr}`);
  assert(exec.stdout.trim() === expectedVersion, `npm exec printed ${JSON.stringify(exec.stdout)}`);

  step('3. --version and --help');
  const version = cli(['--version']);
  assert(version.status === 0, '--version did not exit 0');
  assert(
    version.stdout === `${expectedVersion}\n`,
    `--version printed ${JSON.stringify(version.stdout)}`,
  );
  if (isWindows) {
    // The .cmd shim is a constant command; no user-controlled value reaches the shell.
    const shim = run(path.join(prefix, 'proofissue.cmd'), ['--version'], { shell: true });
    assert(shim.status === 0 && shim.stdout.trim() === expectedVersion, 'the .cmd shim failed');
  }
  const help = cli(['--help']);
  assert(help.status === 0 && help.stdout.includes('proofissue record'), '--help failed');

  step('4. record, validate, inspect the example');
  const artifact = path.join(project, 'failure.proofissue');
  // TODO(record defaults PR): once record defaults the image, project, and artifact name, drop
  // --project, --image, and --output here and check for the default file name instead.
  const record = cli(
    [
      'record',
      '--yes',
      '--project',
      project,
      '--image',
      APPROVED_IMAGE,
      '--output',
      artifact,
      '--reproduction',
      'test/reproduction.mjs',
      '--subject',
      'src/calculate.mjs',
      '--expect-stderr',
      'Expected 4 from calculate(2)',
      '--',
      'node',
      'test/reproduction.mjs',
    ],
    { cwd: project },
  );
  assert(record.status === 0, `record failed:\n${record.stdout}\n${record.stderr}`);
  assert(record.stdout.includes('Artifact created.'), 'record did not report creation');
  assert((await stat(artifact)).isFile(), 'the artifact file was not written');
  // TODO: also run doctor once the command exists (it is not implemented yet).
  const validate = cli(['validate', artifact]);
  assert(validate.status === 0 && validate.stdout.startsWith('valid'), 'validate failed');
  const inspect = cli(['inspect', artifact, '--json']);
  assert(inspect.status === 0, 'inspect failed');
  assert(JSON.parse(inspect.stdout).status === 'inspected', 'inspect did not report inspected');

  if (process.platform === 'linux' && process.env.PROOFISSUE_SMOKE_REPLAY === '1') {
    step('5. Replay in the approved image, then verify a fix');
    execFileSync('docker', ['pull', APPROVED_IMAGE], { stdio: 'inherit' });
    const reproduced = cli(['replay', artifact, '--require-status', 'reproduced']);
    assert(
      reproduced.status === 0,
      `replay did not reproduce:\n${reproduced.stdout}\n${reproduced.stderr}`,
    );

    const subject = path.join(project, 'src', 'calculate.mjs');
    const source = await readFile(subject, 'utf8');
    assert(source.includes('value + 1'), 'the example subject changed unexpectedly');
    await writeFile(subject, source.replace('value + 1', 'value * 2'));
    const fixed = cli([
      'replay',
      artifact,
      '--against',
      project,
      '--require-status',
      'not_reproduced',
    ]);
    assert(fixed.status === 0, `the fix was not verified:\n${fixed.stdout}\n${fixed.stderr}`);
  } else if (isWindows) {
    step('6. Windows: replay is refused with the documented code');
    const replay = cli(['replay', artifact, '--json']);
    assert(replay.status === 1, `replay --json exited ${replay.status}, expected 1`);
    const result = JSON.parse(replay.stdout);
    assert(result.status === 'execution_failed', `replay status was ${result.status}`);
    assert(
      replay.stdout.includes('"engine_capability_unavailable"'),
      'replay did not report engine_capability_unavailable',
    );
  } else {
    step('5. Replay skipped (set PROOFISSUE_SMOKE_REPLAY=1 on Linux with Docker)');
  }

  process.stdout.write('\nPackage smoke test passed.\n');
} finally {
  await rm(workDirectory, { force: true, recursive: true });
}
