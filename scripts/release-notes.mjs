// Usage: node scripts/release-notes.mjs <version|Unreleased> [CHANGELOG.md]
//
// Prints the body of one CHANGELOG.md section (Keep a Changelog format) to standard output, for
// use as GitHub Release notes. Exits 1, printing nothing to standard output, when the section is
// missing, empty, or (for a version) not dated with YYYY-MM-DD. The release workflow uses the
// version form for tag builds and `Unreleased` only for manual dry runs.
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const [section, changelogArgument] = process.argv.slice(2);

const fail = (message) => {
  process.stderr.write(`release-notes: ${message}\n`);
  process.exit(1);
};

if (section === undefined || !/^(?:Unreleased|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/u.test(section)) {
  process.stderr.write(
    'Usage: node scripts/release-notes.mjs <version|Unreleased> [CHANGELOG.md]\n',
  );
  process.exit(2);
}

let changelog;
try {
  changelog = readFileSync(
    path.resolve(changelogArgument ?? path.join(root, 'CHANGELOG.md')),
    'utf8',
  );
} catch {
  fail('The changelog file could not be read.');
}

const lines = changelog.replaceAll('\r\n', '\n').split('\n');
const escaped = section.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const heading = new RegExp(`^## \\[${escaped}\\](?: - (\\d{4}-\\d{2}-\\d{2}))?\\s*$`, 'u');
const start = lines.findIndex((line) => heading.test(line));
if (start === -1) fail(`No "## [${section}]" section was found in the changelog.`);
if (section !== 'Unreleased' && heading.exec(lines[start] ?? '')?.[1] === undefined) {
  fail(`The "## [${section}]" heading must carry a date, as "## [${section}] - YYYY-MM-DD".`);
}

const end = lines.findIndex((line, index) => index > start && /^## /u.test(line));
const body = lines
  .slice(start + 1, end === -1 ? lines.length : end)
  .join('\n')
  .trim();
if (body === '') fail(`The "## [${section}]" section is empty.`);

process.stdout.write(`${body}\n`);
