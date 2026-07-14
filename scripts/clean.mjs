import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

const workspaceRoot = path.resolve(import.meta.dirname, '..');
const packageRoot = path.join(workspaceRoot, 'packages');

const packageDirectories = (await readdir(packageRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(packageRoot, entry.name));

for (const directory of [...packageDirectories, path.join(workspaceRoot, 'action')]) {
  await rm(path.join(directory, 'dist'), { force: true, recursive: true });
}

await rm(path.join(workspaceRoot, 'coverage'), { force: true, recursive: true });
