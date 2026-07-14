import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const ignoredDirectories = new Set(['.agents', '.git', 'coverage', 'dist', 'node_modules']);
const textExtensions = new Set(['.cjs', '.json', '.md', '.mjs', '.ts', '.yml', '.yaml']);
const violations = [];

const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) await visit(path.join(directory, entry.name));
      continue;
    }

    if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;
    const filePath = path.join(directory, entry.name);
    const relativePath = path.relative(root, filePath).replaceAll('\\', '/');
    const content = await readFile(filePath, 'utf8');

    if (/(?:[A-Za-z]:\\Users\\[^\\\s]+|\/(?:home|Users)\/[^/\s]+)/u.test(content)) {
      violations.push(`${relativePath}: contains a local user path.`);
    }
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(content)) {
      violations.push(`${relativePath}: contains private-key material.`);
    }
    if (/Authorization:\s*Bearer\s+[A-Za-z0-9._~-]{12,}/iu.test(content)) {
      violations.push(`${relativePath}: contains a bearer-token-shaped value.`);
    }
  }
};

await visit(root);

if (violations.length > 0) {
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('Repository hygiene checks passed.\n');
}
