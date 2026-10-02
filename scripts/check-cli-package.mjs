// Usage: node scripts/check-cli-package.mjs <proofissue-x.y.z.tgz> [--reproducible]
//
// Inspects an npm tarball produced by `npm pack ./release/npm` without installing or running it.
// With --reproducible it also rebuilds the bundle twice and requires identical bytes, and requires
// the packed bundle to equal that build.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const EXPECTED_FILES = [
  'LICENSE',
  'README.md',
  'dist/proofissue.js',
  'dist/third-party-licenses.txt',
  'package.json',
];
const problems = [];
const fail = (message) => problems.push(message);
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// A minimal ustar reader: names, sizes, and regular-file contents are all that is needed.
const readTarball = (archive) => {
  const files = new Map();
  let offset = 0;
  let longName;
  const field = (start, length) =>
    archive
      .subarray(offset + start, offset + start + length)
      .toString('utf8')
      .replace(/\0.*$/su, '');
  while (offset + 512 <= archive.length) {
    if (archive.subarray(offset, offset + 512).every((byte) => byte === 0)) break;
    const size = Number.parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    let name = prefix === '' ? field(0, 100) : `${prefix}/${field(0, 100)}`;
    const body = archive.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = body.toString('utf8').replace(/\0.*$/su, '');
      continue;
    }
    if (type === 'x' || type === 'g') continue;
    if (longName !== undefined) {
      name = longName;
      longName = undefined;
    }
    if (type !== '0' && type !== '') {
      fail(`${name}: tarball entries must be regular files (type ${type}).`);
      continue;
    }
    files.set(name, Buffer.from(body));
  }
  return files;
};

const build = () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, 'scripts', 'build-cli-package.mjs')],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  if (result.status !== 0) {
    throw new Error(`The package build failed: ${result.stderr}`);
  }
};

const [tarball, ...flags] = process.argv.slice(2);
if (tarball === undefined || flags.some((flag) => flag !== '--reproducible')) {
  process.stderr.write(
    'Usage: node scripts/check-cli-package.mjs <package.tgz> [--reproducible]\n',
  );
  process.exit(2);
}

const entries = readTarball(gunzipSync(await readFile(tarball)));
const names = new Map();
for (const [name, content] of entries) {
  if (!name.startsWith('package/')) fail(`${name}: entries must live under package/.`);
  names.set(name.replace(/^package\//u, ''), content);
}

const actual = [...names.keys()].sort();
if (JSON.stringify(actual) !== JSON.stringify(EXPECTED_FILES)) {
  fail(`The file list is ${JSON.stringify(actual)}; expected ${JSON.stringify(EXPECTED_FILES)}.`);
}

const text = (name) => names.get(name)?.toString('utf8') ?? '';
let manifest = {};
try {
  manifest = JSON.parse(text('package.json'));
} catch {
  fail('package.json in the tarball is not valid JSON.');
}
for (const key of [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundledDependencies',
  'scripts',
  'private',
]) {
  if (key in manifest) fail(`package.json must not declare ${key}.`);
}
if (manifest.name !== 'proofissue') fail('The package name must be proofissue.');
if (manifest.license !== 'Apache-2.0') fail('The package license must be Apache-2.0.');
if (manifest.bin?.proofissue !== 'dist/proofissue.js')
  fail('bin.proofissue must be dist/proofissue.js.');

const bundle = text('dist/proofissue.js');
const shebangs = bundle.split('\n').filter((line) => line.startsWith('#!'));
if (!bundle.startsWith('#!/usr/bin/env node\n') || shebangs.length !== 1) {
  fail('The bundle must start with exactly one #!/usr/bin/env node line.');
}

const source = await readFile(path.join(root, 'packages', 'cli', 'src', 'version.ts'), 'utf8');
const sourceVersion = /PROOFISSUE_VERSION = '([^']+)'/u.exec(source)?.[1];
if (sourceVersion !== manifest.version) {
  fail(
    `PROOFISSUE_VERSION (${sourceVersion}) differs from the package version (${manifest.version}).`,
  );
}
if (!bundle.includes(`'${manifest.version}'`)) {
  fail('The bundle does not embed the package version.');
}

for (const [name, content] of names) {
  if (/(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:home|Users)\/[^/\s]+)/u.test(content.toString('utf8'))) {
    fail(`${name}: contains a local user path.`);
  }
}

if (!names.get('LICENSE')?.equals(await readFile(path.join(root, 'LICENSE')))) {
  fail('LICENSE is missing or differs from the repository LICENSE.');
}
if (text('dist/third-party-licenses.txt').trim() === '') fail('Third-party notices are empty.');

if (flags.includes('--reproducible')) {
  build();
  const first = sha256(await readFile(path.join(root, 'release', 'npm', 'dist', 'proofissue.js')));
  build();
  const second = sha256(await readFile(path.join(root, 'release', 'npm', 'dist', 'proofissue.js')));
  if (first !== second) fail(`Two builds differ: ${first} and ${second}.`);
  if (sha256(names.get('dist/proofissue.js') ?? Buffer.alloc(0)) !== first) {
    fail('The packed bundle is not the bundle this checkout builds.');
  }
  process.stdout.write(`bundle sha256 ${first} (two builds identical)\n`);
}

if (problems.length > 0) {
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  process.exit(1);
}
process.stdout.write(`${path.basename(tarball)} passed the package checks.\n`);
