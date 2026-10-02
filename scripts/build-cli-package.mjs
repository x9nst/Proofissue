import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import ncc from '@vercel/ncc';

const root = path.resolve(import.meta.dirname, '..');
const packageDirectory = path.join(root, 'release', 'npm');
const outputDirectory = path.join(packageDirectory, 'dist');
const SHEBANG = '#!/usr/bin/env node\n';

// The CLI is published as one self-contained file with no runtime dependencies, so the private
// workspace packages never need to be published. Unlike the Action bundles it is not minified:
// a reporter or maintainer who audits the file before running it can read it.
const bundle = await ncc(path.join(root, 'packages', 'cli', 'dist', 'bin.js'), {
  cache: false,
  license: 'third-party-licenses.txt',
  minify: false,
  sourceMap: false,
  target: 'es2024',
});
const licenses = bundle.assets['third-party-licenses.txt'];
if (licenses === undefined) {
  throw new Error('The CLI bundle did not produce license notices.');
}

// Exactly one shebang, whatever the bundler kept from the entry point.
const code = SHEBANG + bundle.code.replace(/^(?:#![^\n]*\n)+/u, '');

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'proofissue.js'), code, 'utf8');
await writeFile(path.join(outputDirectory, 'third-party-licenses.txt'), licenses.source);
await copyFile(path.join(root, 'LICENSE'), path.join(packageDirectory, 'LICENSE'));
process.stdout.write('CLI package bundle generated.\n');
