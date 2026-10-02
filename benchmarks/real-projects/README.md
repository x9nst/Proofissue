# Real-Project Trial Harness

This directory holds the harness that records, prepares, and replays failures from real Node.js projects through the ProofIssue CLI, and the manifest of cases it runs. The method, budget, outcome classes, and pilot are described in `../../docs/real-project-evaluation.md`.

It is a TypeScript project built by the root `tsconfig.json`, but it is not a workspace package: it has no `package.json`, and no package or Action imports it. The harness drives `packages/cli/dist/bin.js` as a subprocess and parses its `--json` output. It changes nothing in the CLI, the artifact format, the result contract, or the sandbox.

The trial result format (`trial_result_version` 1) and the summary format (`trial_summary_version` 1) are internal evaluation formats. They are not public ProofIssue interfaces and can change without a migration.

## Running the Trials

The runner refuses hosts other than x86-64 Linux, and the harness runs third-party test code on the host during recording, so run it in the hosted workflow.

### In CI

The workflow `.github/workflows/real-project-trials.yml` has two triggers, both requiring write access:

- **Push a branch named `trials/<set>/<label>`**, for example `trials/pilot/run-1`. The set comes from the branch name.
- **Run it manually** (`workflow_dispatch`) with a set, a comma-separated list of case IDs (which overrides the set), and a snapshot run count.

The manifest defines three sets: `pilot` (N1, T1, M3), `full` (the twelve primary cases, including the pilot cases), and `reserve` (N3, N6, run only if fewer than ten cases of `full` end up valid).

It runs one virtual machine per case, then a summary job. Download the results with the GitHub CLI:

```bash
gh run download <run-id> -n trial-summary -D trial-runs/<run-id>/summary
gh run download <run-id> -p "trial-result-*" -D trial-runs/<run-id>/results
gh run download <run-id> -p "trial-diagnostics-*" -D trial-runs/<run-id>/diagnostics
```

Download into a directory outside the repository. Never commit `.proofissue` files or diagnostics.

### On a Linux host with Docker

You need x86-64 Linux, Docker Engine 27 or newer, Node.js 24, npm, and git. The approved image must already be present (`docker pull node@sha256:...`; the digest is in `cases.json`).

```bash
npm ci
npm run build:types
node benchmarks/real-projects/dist/main.js run \
  --cases N1 --runs 5 \
  --work-dir /var/tmp/trials/work \
  --output /var/tmp/trials/results \
  --diagnostics /var/tmp/trials/diagnostics
node benchmarks/real-projects/dist/main.js summarize \
  --input /var/tmp/trials/results --output /var/tmp/trials/summary \
  --expected-cases '["N1"]'
```

The work, output, and diagnostics directories must be separate, and the per-case directories inside them must not exist yet.

## Commands

```text
list      [--manifest f] [--set s] [--cases csv] [--ref r]
run       [--manifest f] (--set s | --cases csv) --work-dir d --output d --diagnostics d
          [--runs 1..10 = 5] [--baseline-runs 0..5 = 3] [--fix-runs 1..3 = 1] [--cli path]
summarize --input d --output d [--expected-cases json]
```

- `list` prints the `cases=` and `image=` lines the workflow reads. A non-empty `--cases` wins over `--set`; with neither, the set comes from a `--ref` of the form `trials/<set>[/...]`. An empty string means "not given".
- `run` runs the selected cases one after another.
- `summarize` validates every `<ID>.result.json` under `--input` (to a depth of four directories), checks each uploaded `.proofissue` file's SHA-256 against the reported digests, and writes `summary.json` and `summary.md`.

Exit codes: 0 when every case produced valid evidence (whether or not it reproduced); 1 when any case is `setup_failed` or `harness_error`, or when `list` finds an empty or invalid selection, or when `summarize` finds a missing or invalid result; 2 for bad arguments or an unsupported host.

## Manifest

`cases.json` is strict: unknown keys are rejected at every level, and the parser reports typed errors with a JSON-pointer path. A unit test parses the committed file.

| Field | Meaning |
| --- | --- |
| `manifest_version` | Always `1`. |
| `image` | The approved replay image, `node@sha256:` and 64 hex characters. It must equal the runner's approved image. |
| `id` | Unique, `^[A-Z][A-Z0-9-]{0,15}$`. |
| `sets` | One or more set names (for example `pilot`). |
| `title`, `links`, `notes` | Display text: a title, up to ten `https://` links, and notes of up to 2000 characters. |
| `repository` | `https://github.com/<owner>/<repository>.git` only. |
| `pre_fix_commit`, `fix_commit` | Full 40-character lowercase SHAs. They must differ. |
| `dependencies` | Whether to record with `--dependencies`. |
| `reproduction_files` | Files copied from the fix commit and kept exactly as recorded. |
| `subject_files` | Files taken from the pre-fix commit that a fix may replace. |
| `command` | `node` followed by arguments, with no shell syntax. |
| `expected_exit_code` | An integer from 1 to 255. |
| `expectations` | One to sixteen items: `stream` (`stdout` or `stderr`), `mode`, and `value`. |

Selected paths are portable POSIX relative paths (no `..`, no backslash, no empty segment), unique ignoring case across both roles, and never `package.json` or `package-lock.json`, which `--dependencies` records. At most 98 files with dependencies, otherwise 100.

Expectation modes map to CLI flags:

| Mode | Flag | `value` |
| --- | --- | --- |
| `contains` | `--expect-<stream>` | required |
| `contains_normalized` | `--expect-<stream>-normalized` | required |
| `exact` | `--expect-<stream>-exact` | forbidden, once per stream |
| `exact_normalized` | `--expect-<stream>-exact-normalized` | forbidden, once per stream |

A `contains` value is 1 to 8192 characters and cannot start with `--`, because the CLI rejects option values that do.

## Adding a Case

1. Find a failing test added with a fix. Take the commit before the fix as `pre_fix_commit` and the fix commit (a merge commit for a pull request) as `fix_commit`.
2. Check the candidate statically before adding it: a version 3 lockfile at the pre-fix commit, no SHA-1 integrity entries, no native addon or build step on the test path, an install that plausibly fits the budget, and files that the redactor does not rewrite.
3. List the test file as a reproduction file and every source file the test loads as subject files.
4. Write the command as a Node.js invocation of the test runner (`node node_modules/mocha/bin/mocha.js ...` rather than `npx`), restricted to the one failing test.
5. Choose literals that contain no paths, durations, or symbols. Prefer `contains` for the pilot. If you use a normalized or exact mode, say why in `notes`.
6. Add the case, run the unit tests, and run the case in the workflow. A case that fails to reproduce is a result, not something to adjust.

## Output Layout

```text
<output>/<ID>/
  <ID>.result.json                 per-case result (scrubbed)
  <ID>.summary.md                  short per-case Markdown summary
  <ID>.proofissue                  the recorded artifact
  <ID>-install-baseline.proofissue the install-only baseline artifact
  NOTICE.md                        third-party material notice
  UPSTREAM-LICENSE.txt             the upstream root licence at the pre-fix commit, when small and clean
<diagnostics>/<ID>/                redacted, path-scrubbed tool output, never evidence
  README.txt, git.txt, host-install.log, preflight.stdout.txt, preflight.stderr.txt,
  record.txt, prepare.txt, baseline-record.txt, baseline-prepare.txt, replay logs
```

Results hold only manifest values, result-contract fields, counts, and durations. Before any result or summary is written it is path-scrubbed and checked against the repository's local-path pattern and ProofIssue's redactor; a file that fails the check is replaced by a minimal result that carries only an error code.

## Committed Results

Evidence from a clean run is committed under `results/<date>-<set>-run<run-id>/`: the per-case `<ID>.result.json` files and `summary.json`, formatted with Prettier. They hold no third-party code. Recorded `.proofissue` files and diagnostics are never committed.

## What the Harness Cannot Observe

The result contract does not report peak memory, the process count, or the split between install and test time. The harness estimates the install time from an install-only baseline artifact and treats the rest as unobservable. See the evaluation document for how that shapes the pilot.

`proofissue record --json` (which needs `--yes`) prints one `RecordOperationResult` line on stdout, with the preview on stderr. The harness reads that line and its exit code, then calls `inspect --json` for structured detail.
