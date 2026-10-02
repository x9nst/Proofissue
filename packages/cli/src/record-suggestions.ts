import {
  SUGGESTION_LIMITS,
  type CommandHint,
  type DependencyProbe,
  type FileSuggestions,
  type RecordFilePlan,
  type SuggestedFile,
} from '@proofissue/application';

import type { GuidedIo } from './guided-record.js';
import { escapePresentationText, quotePathForCommand } from './presentation.js';

/** How many unusable answers to a question are tolerated before the recording is cancelled. */
export const MAX_QUESTION_ATTEMPTS = 3;

const plural = (count: number, noun: string): string =>
  `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const shown = (value: string): string => escapePresentationText(value);

// ---------------------------------------------------------------------------------------
// Dependency files
// ---------------------------------------------------------------------------------------

type FoundProbe = Exclude<DependencyProbe, { readonly status: 'absent' }>;

/** What was found, shown before the question. Holds counts and bounded reasons only. */
export const renderDependencyFacts = (probe: FoundProbe): string => {
  if (probe.status === 'usable') {
    return [
      `package.json and package-lock.json found: ${plural(probe.package_count, 'package')} locked, and the lockfile can be used for dependency replay.`,
      ...(probe.install_script_packages > 0
        ? [
            `  ${plural(probe.install_script_packages, 'package')} ${probe.install_script_packages === 1 ? 'declares' : 'declare'} install scripts, which are never run.`,
          ]
        : []),
      '',
    ].join('\n');
  }
  return [
    'package.json and package-lock.json found, but the lockfile cannot be used for dependency replay:',
    ...probe.reasons.map((reason) => `  - ${shown(reason)}`),
    ...(probe.unlisted_reasons > 0 ? [`  - and ${String(probe.unlisted_reasons)} more`] : []),
    '',
  ].join('\n');
};

/** The question is a default Yes only when the lockfile is usable and dependencies are declared. */
export const dependencyDefault = (probe: FoundProbe): boolean =>
  probe.status === 'usable' && probe.declares_dependencies;

export type DependencyAnswer = 'cancelled' | 'no' | 'yes';

/**
 * Shows what was found and asks whether to record package.json and package-lock.json. Enter
 * takes the default: Yes only when the lockfile is usable and dependencies are declared. An
 * answer that is not yes or no is asked again; the recording is cancelled after three, or when
 * input ends.
 */
export const askAboutDependencyFiles = async (
  io: GuidedIo,
  probe: FoundProbe,
): Promise<DependencyAnswer> => {
  io.write(renderDependencyFacts(probe));
  const defaultYes = dependencyDefault(probe);
  const prompt = `Record package.json and package-lock.json so replay can install the locked packages? ${defaultYes ? '[Y/n]' : '[y/N]'} `;
  for (let attempt = 1; attempt <= MAX_QUESTION_ATTEMPTS; attempt += 1) {
    const answer = await io.ask(prompt);
    if (answer === undefined) {
      io.write('\nNo answer was given.\n');
      return 'cancelled';
    }
    const normalized = answer.trim().toLowerCase();
    if (normalized === '') return defaultYes ? 'yes' : 'no';
    if (normalized === 'y' || normalized === 'yes') return 'yes';
    if (normalized === 'n' || normalized === 'no') return 'no';
    io.write('Answer y or n, or press Enter for the default.\n');
  }
  io.write(`No valid answer was given after ${String(MAX_QUESTION_ATTEMPTS)} attempts.\n`);
  return 'cancelled';
};

/** The preview warning for a lockfile that exists but is not being recorded. */
export const DEPENDENCY_WARNING =
  'Warning: package.json and package-lock.json exist in the project but are not being recorded. If the failure needs installed packages, replay cannot reproduce it; run again with --dependencies to record them, or with --no-dependencies to silence this warning.';

// ---------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------

const renderFileLine = (file: SuggestedFile): string =>
  `    ${shown(file.path)}  (${shown(file.reason)})`;

/** The notes that apply however the roles are filled: limits, warnings, uncollected files. */
export interface SuggestionNotes {
  /** Paths already selected, so they are not listed again as uncollected. */
  readonly selected_paths: readonly string[];
  readonly include_dependencies: boolean;
  /** Whether the reproduction role was filled from suggestions (package.json is then among them). */
  readonly reproduction_suggested: boolean;
}

const renderLimits = (suggestions: FileSuggestions): readonly string[] =>
  suggestions.limits_reached.map((limit) => {
    if (limit === 'files') {
      return `Scanning stopped after ${plural(SUGGESTION_LIMITS.files, 'file')}; imports beyond that were not followed.`;
    }
    if (limit === 'bytes') {
      return `Scanning stopped after ${String(SUGGESTION_LIMITS.total_bytes / 1024 / 1024)} MiB of source; imports beyond that were not followed.`;
    }
    return `Scanning stopped after ${plural(SUGGESTION_LIMITS.specifier_lookups, 'import')}; imports beyond that were not followed.`;
  });

export const renderSuggestionNotes = (
  suggestions: FileSuggestions,
  notes: SuggestionNotes,
): readonly string[] => {
  const selected = new Set(notes.selected_paths.map((value) => value.toLowerCase()));
  const lines: string[] = [...renderLimits(suggestions)];
  for (const warning of suggestions.warnings) lines.push(`Warning: ${shown(warning)}`);
  if (
    suggestions.manifest_sets_type &&
    !notes.include_dependencies &&
    !notes.reproduction_suggested &&
    !selected.has('package.json')
  ) {
    lines.push(
      'package.json sets "type", which decides how Node.js reads .js files, but it is not selected: add it with --reproduction package.json if the files need it.',
    );
  }
  const uncollected = suggestions.uncollected_config_files.filter(
    (name) => !selected.has(name.toLowerCase()),
  );
  if (uncollected.length > 0) {
    lines.push(
      'Not collected (add with --reproduction <file> if your test runner reads it):',
      ...uncollected.map((name) => `    ${shown(name)}`),
    );
  }
  return lines;
};

/** The suggested files with their reasons, for the roles the request left empty. */
export const renderFileSuggestions = (plan: RecordFilePlan): string => {
  const lines: string[] = [
    'Suggested files (nothing is recorded until you confirm them; the files are read before the command runs):',
  ];
  if (plan.missing.reproduction) {
    lines.push(
      '  Kept exactly as recorded during a fix check (reproduction):',
      ...(plan.reproduction.length === 0
        ? ['    (none suggested)']
        : plan.reproduction.map(renderFileLine)),
    );
  }
  if (plan.missing.subject) {
    lines.push(
      '  May be replaced from the current checkout during a fix check (subject):',
      ...(plan.subject.length === 0 ? ['    (none suggested)'] : plan.subject.map(renderFileLine)),
    );
  }
  return `${lines.join('\n')}\n`;
};

export interface FileChoice {
  readonly reproduction_paths: readonly string[];
  readonly subject_paths: readonly string[];
}

export type FileChoiceResult =
  { readonly choice: FileChoice; readonly status: 'chosen' } | { readonly status: 'cancelled' };

const parsePaths = (answer: string, platform: 'posix' | 'win32'): readonly string[] => {
  const paths: string[] = [];
  for (const token of answer.trim().split(/\s+/u)) {
    if (token === '') continue;
    let value = platform === 'win32' ? token.replaceAll('\\', '/') : token;
    while (value.startsWith('./')) value = value.slice(2);
    if (!paths.includes(value)) paths.push(value);
  }
  return paths;
};

/**
 * Shows the suggested files and asks `Use these files?`. Answering no (or having no suggestion
 * for a role) asks for space-separated paths for each empty role, where Enter keeps that role's
 * suggestion. Roles the request already gave are never touched. Whatever is chosen is shown
 * again, with the rest of the recording, in the preview.
 */
export const confirmSuggestedFiles = async (
  io: GuidedIo,
  plan: RecordFilePlan,
  notes: readonly string[],
  platform: 'posix' | 'win32',
): Promise<FileChoiceResult> => {
  io.write(renderFileSuggestions(plan));
  if (notes.length > 0) io.write(`${notes.join('\n')}\n`);
  const suggestedAny = plan.reproduction.length + plan.subject.length > 0;
  const accepted = suggestedAny && (await io.confirm('Use these files?'));

  const choose = async (
    role: 'reproduction' | 'subject',
    missing: boolean,
    suggested: readonly SuggestedFile[],
  ): Promise<readonly string[] | undefined> => {
    if (!missing) return [];
    const kept = suggested.map((file) => file.path);
    if (accepted && kept.length > 0) return kept;
    const label = role === 'reproduction' ? 'Reproduction' : 'Subject';
    const keep =
      kept.length > 0 ? `, or press Enter to keep ${plural(kept.length, 'suggested file')}` : '';
    const answer = await io.ask(
      `${label} files (paths relative to the project, separated by spaces${keep}): `,
    );
    if (answer === undefined) {
      io.write('\nNo answer was given.\n');
      return undefined;
    }
    return answer.trim() === '' ? kept : parsePaths(answer, platform);
  };

  const reproduction = await choose('reproduction', plan.missing.reproduction, plan.reproduction);
  if (reproduction === undefined) return { status: 'cancelled' };
  const subject = await choose('subject', plan.missing.subject, plan.subject);
  if (subject === undefined) return { status: 'cancelled' };
  return { status: 'chosen', choice: { reproduction_paths: reproduction, subject_paths: subject } };
};

/**
 * The suggestions as flags to copy, for when nothing may be chosen for the person: under --yes,
 * with --json, or without a terminal. Nothing here is applied.
 */
export const renderSuggestedFlags = (plan: RecordFilePlan): string => {
  const entries: { readonly file: SuggestedFile; readonly flag: string }[] = [
    ...plan.reproduction.map((file) => ({ file, flag: '--reproduction' })),
    ...plan.subject.map((file) => ({ file, flag: '--subject' })),
  ];
  if (entries.length === 0) {
    return 'No files could be suggested from the command. Name them with --reproduction <path> and --subject <path>.\n';
  }
  const missing = [
    ...(plan.missing.reproduction && plan.reproduction.length === 0 ? ['--reproduction'] : []),
    ...(plan.missing.subject && plan.subject.length === 0 ? ['--subject'] : []),
  ];
  return [
    'Suggested files (not applied: suggestions are only used after you confirm them in a terminal, never with --yes or --json):',
    ...entries.map(
      ({ file, flag }) => `  ${flag} ${quotePathForCommand(file.path)}  (${shown(file.reason)})`,
    ),
    ...(missing.length > 0
      ? [`  Nothing was suggested for ${missing.join(' and ')}: name it yourself.`]
      : []),
    'To use them, add these to the command:',
    `  ${entries.map(({ file, flag }) => `${flag} ${quotePathForCommand(file.path)}`).join(' ')}`,
    '',
  ].join('\n');
};

// ---------------------------------------------------------------------------------------
// Commands that do not start with node
// ---------------------------------------------------------------------------------------

/** Explains how to write the command for node. Nothing was run, and the command is not rewritten. */
export const renderCommandHint = (hint: CommandHint): string => {
  if (hint.kind === 'package_manager') {
    return [
      `Hint: ${hint.manager} commands are not run. A recording runs node directly, with no shell and no package scripts.`,
      'Find what the script runs (see "scripts" in package.json), and write its node form after --, for example:',
      '  -- node node_modules/<package>/<script> <arguments>',
      'Record package.json and package-lock.json with --dependencies so replay can install the packages. Nothing was run.',
      '',
    ].join('\n');
  }
  const written = [
    'node',
    quotePathForCommand(`node_modules/${hint.package_name}/${hint.script}`),
    ...hint.rest_arguments.map(quotePathForCommand),
  ].join(' ');
  return [
    `Hint: the package ${shown(hint.package_name)} in package-lock.json provides this program. A recording runs node directly, so write it as:`,
    `  -- ${written}`,
    'Record package.json and package-lock.json with --dependencies so replay can install the packages. Nothing was run.',
    '',
  ].join('\n');
};
