import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import ncc from '@vercel/ncc';

const root = path.resolve(import.meta.dirname, '..');

// The replay Action and the prepare Action are bundled separately on purpose: the replay bundle
// must never carry the package download code.
const bundles = [
  {
    name: 'replay',
    entryPoint: path.join(root, 'action', 'lib', 'main.js'),
    outputDirectory: path.join(root, 'action', 'dist'),
  },
  {
    name: 'prepare',
    entryPoint: path.join(root, 'action', 'lib', 'prepare-main.js'),
    outputDirectory: path.join(root, 'action', 'prepare', 'dist'),
  },
];

for (const { name, entryPoint, outputDirectory } of bundles) {
  const bundle = await ncc(entryPoint, {
    cache: false,
    license: 'third-party-licenses.txt',
    minify: true,
    sourceMap: false,
    target: 'es2024',
  });
  const licenses = bundle.assets['third-party-licenses.txt'];
  if (licenses === undefined) {
    throw new Error(`The ${name} Action bundle did not produce license notices.`);
  }

  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, 'index.js'), bundle.code, 'utf8');
  await writeFile(path.join(outputDirectory, 'third-party-licenses.txt'), licenses.source);
  process.stdout.write(`GitHub Action ${name} bundle generated.\n`);
}
