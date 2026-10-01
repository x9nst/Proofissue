/**
 * The harness command: `list`, `run`, and `summarize`.
 *
 *   list      [--manifest f] [--set s] [--cases csv] [--ref r]
 *   run       [--manifest f] (--set s | --cases csv) --work-dir d --output d --diagnostics d
 *             [--runs 1..10 = 5] [--baseline-runs 0..5 = 3] [--fix-runs 1..3 = 1] [--cli path]
 *   summarize --input d --output d [--expected-cases json]
 *
 * Exit codes: 0 when every case produced valid evidence (whether or not it reproduced), 1 when
 * any case is setup_failed or harness_error (or a listed selection is empty or invalid), and 2
 * for bad arguments or an unsupported host.
 *
 * Third-party text never reaches this program's output: only case IDs, stage names, enums, and
 * numbers are printed, and every line is escaped first.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { collectEnvironment, readSystemInfo, type SystemInfo } from './environment.js';
import { collectResults } from './collect.js';
import {
  parseManifest,
  selectCases,
  selectionFromInputs,
  toGithubOutputs,
  type TrialManifest,
} from './manifest.js';
import { runTrialCase, selfCheck } from './pipeline.js';
import { runBounded, type Executor } from './process.js';
import { createScrubber, escapeForLog, type ScrubRoot } from './scrub.js';
import { aggregate, renderCaseMarkdown, renderMarkdown, summaryIsValid } from './summary.js';

export interface MainIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface MainDeps {
  readonly platform: string;
  readonly arch: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exec: Executor;
  readonly now: () => number;
  readonly readText: (file: string) => Promise<string>;
  readonly fileExists: (file: string) => Promise<boolean>;
  readonly systemInfo: () => SystemInfo;
  readonly nodePath: string;
  /** The directory this module was loaded from (`.../benchmarks/real-projects/dist`). */
  readonly moduleDirectory: string;
  readonly homeDirectory: string | undefined;
  readonly tmpDirectory: string;
}

export type ExitCode = 0 | 1 | 2;

const OPTION_NAMES = {
  list: ['--manifest', '--set', '--cases', '--ref'],
  run: [
    '--manifest',
    '--set',
    '--cases',
    '--work-dir',
    '--output',
    '--diagnostics',
    '--runs',
    '--baseline-runs',
    '--fix-runs',
    '--cli',
  ],
  summarize: ['--input', '--output', '--expected-cases'],
} as const;

type Command = keyof typeof OPTION_NAMES;

type ParsedOptions =
  | { readonly ok: true; readonly values: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly error: string };

/** Every option takes one value. An empty value means "not given". */
export const parseOptions = (command: Command, args: readonly string[]): ParsedOptions => {
  const allowed: readonly string[] = OPTION_NAMES[command];
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || !allowed.includes(name)) {
      return { ok: false, error: 'An option is not recognized for this command.' };
    }
    if (value === undefined) return { ok: false, error: `${name} needs a value.` };
    if (values.has(name)) return { ok: false, error: `${name} was given more than once.` };
    values.set(name, value);
  }
  return { ok: true, values };
};

const given = (values: ReadonlyMap<string, string>, name: string): string | undefined => {
  const value = values.get(name);
  return value === undefined || value === '' ? undefined : value;
};

const boundedInteger = (
  text: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined => {
  if (text === undefined) return fallback;
  if (!/^[0-9]{1,2}$/u.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
};

const writeLine = (io: MainIo, text: string): void => {
  io.stdout(`${escapeForLog(text)}\n`);
};

const failLine = (io: MainIo, text: string): void => {
  io.stderr(`${escapeForLog(text)}\n`);
};

const loadManifest = async (
  deps: MainDeps,
  io: MainIo,
  explicit: string | undefined,
): Promise<TrialManifest | undefined> => {
  const manifestPath = explicit ?? path.resolve(deps.moduleDirectory, '..', 'cases.json');
  let text: string;
  try {
    text = await deps.readText(manifestPath);
  } catch {
    failLine(io, 'The manifest could not be read.');
    return undefined;
  }
  const parsed = parseManifest(text);
  if (!parsed.ok) {
    failLine(io, `The manifest is invalid (${String(parsed.errors.length)} problems).`);
    for (const problem of parsed.errors.slice(0, 20)) {
      failLine(io, `  ${problem.path === '' ? '/' : problem.path}: ${problem.message}`);
    }
    return undefined;
  }
  return parsed.manifest;
};

const runList = async (args: readonly string[], deps: MainDeps, io: MainIo): Promise<ExitCode> => {
  const options = parseOptions('list', args);
  if (!options.ok) {
    failLine(io, options.error);
    return 2;
  }
  const manifest = await loadManifest(deps, io, given(options.values, '--manifest'));
  if (manifest === undefined) return 1;
  const selection = selectionFromInputs({
    set: given(options.values, '--set'),
    cases: given(options.values, '--cases'),
    ref: given(options.values, '--ref'),
  });
  if (!selection.ok) {
    failLine(io, selection.error);
    return 1;
  }
  const selected = selectCases(manifest, selection.selection);
  if (!selected.ok) {
    failLine(io, selected.error);
    return 1;
  }
  io.stdout(toGithubOutputs(manifest, selected.cases));
  return 0;
};

const isInside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

const scrubRoots = (
  deps: MainDeps,
  directories: { readonly work: string; readonly output: string; readonly diagnostics: string },
): readonly ScrubRoot[] => [
  { path: directories.work, token: '<work>' },
  { path: directories.output, token: '<results>' },
  { path: directories.diagnostics, token: '<diagnostics>' },
  { path: deps.env['RUNNER_TEMP'], token: '<runner-temp>' },
  { path: deps.env['GITHUB_WORKSPACE'], token: '<workspace>' },
  { path: path.resolve(deps.moduleDirectory, '..', '..', '..'), token: '<proofissue>' },
  { path: deps.homeDirectory, token: '<home>' },
  { path: deps.tmpDirectory, token: '<tmp>' },
];

const runRun = async (args: readonly string[], deps: MainDeps, io: MainIo): Promise<ExitCode> => {
  const options = parseOptions('run', args);
  if (!options.ok) {
    failLine(io, options.error);
    return 2;
  }
  if (deps.platform !== 'linux' || deps.arch !== 'x64') {
    failLine(
      io,
      'The trial run needs an x64 Linux host with Docker; this host is not supported. Use the workflow.',
    );
    return 2;
  }
  const values = options.values;
  const runs = boundedInteger(given(values, '--runs'), 5, 1, 10);
  const baselineRuns = boundedInteger(given(values, '--baseline-runs'), 3, 0, 5);
  const fixRuns = boundedInteger(given(values, '--fix-runs'), 1, 1, 3);
  const workDirectory = given(values, '--work-dir');
  const outputDirectory = given(values, '--output');
  const diagnosticsDirectory = given(values, '--diagnostics');
  if (runs === undefined || baselineRuns === undefined || fixRuns === undefined) {
    failLine(io, '--runs must be 1 to 10, --baseline-runs 0 to 5, and --fix-runs 1 to 3.');
    return 2;
  }
  if (
    workDirectory === undefined ||
    outputDirectory === undefined ||
    diagnosticsDirectory === undefined
  ) {
    failLine(io, '--work-dir, --output, and --diagnostics are required.');
    return 2;
  }
  const directories = {
    work: path.resolve(workDirectory),
    output: path.resolve(outputDirectory),
    diagnostics: path.resolve(diagnosticsDirectory),
  };
  const names = Object.values(directories);
  for (const first of names) {
    for (const second of names) {
      if (first !== second && isInside(first, second)) {
        failLine(io, 'The work, output, and diagnostics directories must not contain each other.');
        return 2;
      }
    }
  }

  const selection = selectionFromInputs({
    set: given(values, '--set'),
    cases: given(values, '--cases'),
  });
  if (!selection.ok) {
    failLine(io, selection.error);
    return 2;
  }
  const manifest = await loadManifest(deps, io, given(values, '--manifest'));
  if (manifest === undefined) return 2;
  const selected = selectCases(manifest, selection.selection);
  if (!selected.ok) {
    failLine(io, selected.error);
    return 2;
  }

  const cliPath = path.resolve(
    given(values, '--cli') ??
      path.resolve(deps.moduleDirectory, '..', '..', '..', 'packages', 'cli', 'dist', 'bin.js'),
  );
  const cliMissing = !(await deps.fileExists(cliPath));
  const scrub = createScrubber(scrubRoots(deps, directories));
  const environment = await collectEnvironment({
    exec: deps.exec,
    systemInfo: deps.systemInfo(),
    env: deps.env,
    approvedImage: manifest.image,
    cwd: deps.moduleDirectory,
  });

  writeLine(
    io,
    `Running ${String(selected.cases.length)} case(s): ${selected.cases.map((item) => item.id).join(', ')}`,
  );
  let valid = true;
  for (const item of selected.cases) {
    const result = await runTrialCase(item, {
      exec: deps.exec,
      now: deps.now,
      environment,
      image: manifest.image,
      roots: directories,
      cliPath,
      nodePath: deps.nodePath,
      pathEnv: deps.env['PATH'],
      runs,
      baselineRuns,
      fixRuns,
      scrub,
      log: (line) => {
        io.stdout(`${line}\n`);
      },
      renderSummary: renderCaseMarkdown,
      cliMissing,
    });
    if (
      result.outcome.classification === 'setup_failed' ||
      result.outcome.classification === 'harness_error'
    ) {
      valid = false;
    }
  }
  return valid ? 0 : 1;
};

const writeChecked = async (
  io: MainIo,
  file: string,
  text: string,
  fallback: string,
): Promise<void> => {
  const problem = selfCheck(text);
  if (problem !== undefined)
    failLine(io, `An output file failed the leak self-check (${problem}).`);
  await writeFile(file, problem === undefined ? text : fallback, { encoding: 'utf8', flag: 'wx' });
};

const runSummarize = async (
  args: readonly string[],
  _deps: MainDeps,
  io: MainIo,
): Promise<ExitCode> => {
  const options = parseOptions('summarize', args);
  if (!options.ok) {
    failLine(io, options.error);
    return 2;
  }
  const input = given(options.values, '--input');
  const output = given(options.values, '--output');
  if (input === undefined || output === undefined) {
    failLine(io, '--input and --output are required.');
    return 2;
  }
  let expected: readonly string[] = [];
  const expectedText = given(options.values, '--expected-cases');
  if (expectedText !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(expectedText);
    } catch {
      failLine(io, '--expected-cases must be a JSON array of case IDs.');
      return 2;
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (item): item is string => typeof item === 'string' && /^[A-Z][A-Z0-9-]{0,15}$/u.test(item),
      )
    ) {
      failLine(io, '--expected-cases must be a JSON array of case IDs.');
      return 2;
    }
    expected = parsed;
  }

  const collected = await collectResults(path.resolve(input));
  const present = new Set(collected.results.map((item) => item.result.case.id));
  const summary = aggregate({
    results: collected.results,
    missingCases: expected.filter((id) => !present.has(id)),
    invalidResults: collected.invalid,
  });

  const outputDirectory = path.resolve(output);
  await mkdir(outputDirectory, { recursive: true });
  const minimal = `${JSON.stringify({ trial_summary_version: 1, withheld: true })}\n`;
  await writeChecked(
    io,
    path.join(outputDirectory, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
    minimal,
  );
  await writeChecked(
    io,
    path.join(outputDirectory, 'summary.md'),
    `${renderMarkdown(summary)}\n`,
    '# Real-project trial summary\n\nThe summary was withheld because it failed the leak self-check.\n',
  );
  writeLine(
    io,
    `Summarized ${String(summary.totals.cases)} case(s): ${String(summary.totals.confirmed)} confirmed, ${String(summary.totals.findings)} findings, ${String(summary.totals.setup_failed)} setup failures, ${String(summary.totals.harness_errors)} harness errors, ${String(summary.missing_cases.length)} missing, ${String(summary.invalid_results.length)} invalid.`,
  );
  return summaryIsValid(summary) ? 0 : 1;
};

/** Runs the command. Never throws for bad input; returns the exit code. */
export const runMain = async (
  argv: readonly string[],
  deps: MainDeps,
  io: MainIo,
): Promise<ExitCode> => {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'list':
        return await runList(rest, deps, io);
      case 'run':
        return await runRun(rest, deps, io);
      case 'summarize':
        return await runSummarize(rest, deps, io);
      default:
        failLine(
          io,
          'Usage: main.js list | run | summarize [options]. See benchmarks/real-projects/README.md.',
        );
        return 2;
    }
  } catch {
    failLine(io, 'The harness failed unexpectedly.');
    return 1;
  }
};

const fileExists = async (file: string): Promise<boolean> => {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
};

const safeHomeDirectory = (): string | undefined => {
  try {
    return homedir();
  } catch {
    return undefined;
  }
};

export const defaultDeps = (): MainDeps => ({
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  exec: runBounded,
  now: () => Math.round(performance.now()),
  readText: (file) => readFile(file, 'utf8'),
  fileExists,
  systemInfo: readSystemInfo,
  nodePath: process.execPath,
  moduleDirectory: import.meta.dirname,
  homeDirectory: safeHomeDirectory(),
  tmpDirectory: tmpdir(),
});

const isEntryPoint = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
};

if (isEntryPoint()) {
  process.exitCode = await runMain(process.argv.slice(2), defaultDeps(), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
}
