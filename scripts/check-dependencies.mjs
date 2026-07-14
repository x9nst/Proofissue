import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const packageDirectories = [
  ...(await readdir(path.join(root, 'packages'), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(root, 'packages', entry.name)),
  path.join(root, 'action'),
];

const allowedDependencies = new Map([
  ['@proofissue/contracts', new Set()],
  ['@proofissue/process-output', new Set(['@proofissue/contracts'])],
  ['@proofissue/artifact-schema', new Set()],
  ['@proofissue/redactor', new Set()],
  ['@proofissue/matcher', new Set(['@proofissue/contracts'])],
  [
    '@proofissue/recorder',
    new Set([
      '@proofissue/artifact-schema',
      '@proofissue/contracts',
      '@proofissue/process-output',
      '@proofissue/redactor',
    ]),
  ],
  [
    '@proofissue/runner',
    new Set(['@proofissue/artifact-schema', '@proofissue/contracts', '@proofissue/process-output']),
  ],
  [
    '@proofissue/application',
    new Set([
      '@proofissue/artifact-schema',
      '@proofissue/contracts',
      '@proofissue/matcher',
      '@proofissue/process-output',
      '@proofissue/recorder',
      '@proofissue/redactor',
      '@proofissue/runner',
    ]),
  ],
  ['@proofissue/cli', new Set(['@proofissue/application'])],
  ['@proofissue/report-ui', new Set(['@proofissue/contracts'])],
  ['@proofissue/action', new Set(['@proofissue/application'])],
]);

const packageRecords = [];

for (const directory of packageDirectories) {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const internalDependencies = new Set(
    Object.keys({
      ...(manifest.dependencies ?? {}),
      ...(manifest.optionalDependencies ?? {}),
      ...(manifest.peerDependencies ?? {}),
    }).filter((name) => name.startsWith('@proofissue/')),
  );

  packageRecords.push({ directory, internalDependencies, name: manifest.name });
}

const errors = [];
const knownPackages = new Set(packageRecords.map((record) => record.name));

for (const record of packageRecords) {
  const allowed = allowedDependencies.get(record.name);
  if (allowed === undefined) {
    errors.push(`No dependency policy exists for ${record.name}.`);
    continue;
  }

  for (const dependency of record.internalDependencies) {
    if (!knownPackages.has(dependency)) {
      errors.push(`${record.name} declares unknown internal dependency ${dependency}.`);
    } else if (!allowed.has(dependency)) {
      errors.push(`${record.name} is not allowed to depend on ${dependency}.`);
    }
  }

  const sourceDirectory = path.join(record.directory, 'src');
  const sourceEntries = await readdir(sourceDirectory, { recursive: true, withFileTypes: true });
  for (const entry of sourceEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const sourcePath = path.join(entry.parentPath, entry.name);
    const source = await readFile(sourcePath, 'utf8');
    const imports = source.matchAll(/(?:from\s+|import\s*)['"](@proofissue\/[^'"]+)['"]/g);
    for (const match of imports) {
      const imported = match[1];
      if (imported !== undefined && !record.internalDependencies.has(imported)) {
        errors.push(`${record.name} imports ${imported} without declaring it as a dependency.`);
      }
    }
  }
}

const graph = new Map(
  packageRecords.map((record) => [record.name, [...record.internalDependencies]]),
);
const visited = new Set();
const active = new Set();

const visit = (name, trail) => {
  if (active.has(name)) {
    errors.push(`Dependency cycle detected: ${[...trail, name].join(' -> ')}`);
    return;
  }
  if (visited.has(name)) return;

  active.add(name);
  for (const dependency of graph.get(name) ?? []) visit(dependency, [...trail, name]);
  active.delete(name);
  visited.add(name);
};

for (const name of graph.keys()) visit(name, []);

for (const adapter of ['@proofissue/cli', '@proofissue/action']) {
  const dependencies = graph.get(adapter) ?? [];
  if (dependencies.length !== 1 || dependencies[0] !== '@proofissue/application') {
    errors.push(`${adapter} must have @proofissue/application as its only internal dependency.`);
  }
}

if (errors.length > 0) {
  for (const error of errors) process.stderr.write(`${error}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Dependency boundaries valid for ${packageRecords.length} packages.\n`);
}
