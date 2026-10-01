import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import ncc from '@vercel/ncc';

const root = path.resolve(import.meta.dirname, '..');
const outputDirectory = path.join(root, 'action', 'dist');
const entryPoint = path.join(root, 'action', 'lib', 'main.js');

const bundle = await ncc(entryPoint, {
  cache: false,
  license: 'third-party-licenses.txt',
  minify: true,
  sourceMap: false,
  target: 'es2024',
});
const licenses = bundle.assets['third-party-licenses.txt'];
if (licenses === undefined) throw new Error('The Action bundle did not produce license notices.');

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'index.js'), bundle.code, 'utf8');
await writeFile(path.join(outputDirectory, 'third-party-licenses.txt'), licenses.source);
process.stdout.write('GitHub Action bundle generated.\n');
