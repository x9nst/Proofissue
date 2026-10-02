# Real-Project Evaluation

## Status

The pilot (three cases) was confirmed in its first hosted run and again in a rerun on `main`. The full set (twelve cases from three repositories) then ran twice on hosted CI; the second run confirmed all twelve. See Results. The numeric thresholds in the first two Milestone 7 acceptance criteria are met by this evidence, with the caveats listed under "Full set, caveats". The maintainer reviewed this evidence, with those caveats, and signed off Milestone 7 on 2026-10-02; the other criteria (security suite, documentation, compatibility) are evidenced in `milestone-7-evidence.md`.

The harness and the hosted workflow exist (see `../benchmarks/real-projects/README.md` and `../.github/workflows/real-project-trials.yml`). This document describes the method and the pilot so that results can be read against stated rules rather than after the fact. Numbers are added only from a recorded run.

## Purpose and Criteria

The evaluation answers one question: does the explicit workflow (record, prepare, offline replay, fix verification) hold up on real Node.js projects, inside the fixed replay budget, without changing the product?

The completion criteria it feeds are the Milestone 7 criteria in `../IMPLEMENTATION_PLAN.md`:

- at least ten real Node.js failures are tested across three external repositories;
- at least 90% of supported artifacts replay consistently across repeated runs.

Gate D in `product-validation.md` adds a process rule: interim results are reviewed after every two external failures, so unsupported assumptions are corrected early. The pilot has three cases; the maintainer reviewed it before the full set ran.

The pilot is a smoke test of the harness and of the budget. It does not by itself support a claim about the 90% target; the full set does (see "Full set, run 2").

## Method

Each case runs on its own GitHub-hosted `ubuntu-24.04` virtual machine with host Node.js 24.18.0 (the approved replay image's version), the digest-pinned approved Node.js image, and the Docker Engine version the runner provides (recorded per run). A case goes through these stages. The harness drives the built ProofIssue CLI as a subprocess, exactly as a maintainer would, and reads `--json` output. Nothing in the product is changed for the evaluation.

1. **fetch.** Initialize an empty repository, fetch only the pre-fix and fix commits (depth 1, by full SHA), check out the pre-fix commit, overlay the reproduction files from the fix commit, and add a worktree of the fix commit.
2. **files.** For every selected file, `git hash-object --no-filters` must equal the commit's blob. This proves the bytes are unconverted. The stage also counts carriage returns (informational), notes selected subject files that are missing at the fix, and lists test-runner configuration files that were not selected (for example `.mocharc*`, `.babelrc*`, `jest.config.*`).
3. **host install.** `npm ci --ignore-scripts` on the host, then a walk of `node_modules` for file count, bytes, and bytes rounded up to 4096 per file, as an estimate of in-memory workspace use.
4. **preflight (a gate).** Run the command on the host with an empty environment, as the recorder does. The exit code must match and every raw `contains` literal must appear. A case that does not fail on the host is not recorded.
5. **record.** `proofissue record --dependencies --yes`, then `inspect --json`. `record` has no `--json`, so the harness reads its last line (`Artifact created.` or `Recording failed: ...`) and its exit code.
6. **prepare.** `proofissue prepare --dependency-store ... --json` with a cold store.
7. **install-only baseline.** A second artifact with the same files and dependencies whose command only prints one literal and exits 0. It is prepared into the same store (a warm store) and replayed three times. This also warms Docker before the measured runs.
8. **snapshot replays.** The artifact is replayed in snapshot mode N times, one after another (N = 5 by default).
9. **pre-fix checkout.** One replay with `--against` the pre-fix checkout, expected to reproduce. This shows that current-checkout mode alone does not break reproduction, so a later `not_reproduced` means something.
10. **fix verification.** One replay with `--against` the fix checkout, expected to be `not_reproduced`.

A stage that cannot run because an earlier input is missing is skipped; later stages still run after a finding whenever their inputs exist.

The pilot uses raw `contains` literals only. They contain no paths, durations, or symbols, and recording happens on Linux from LF checkouts, so the strictest check is also the simplest. Normalized and exact output modes are available for full-trial cases whose text is not yet known; a case that uses one must say why in its `notes`.

## The Fixed Budget

The CLI cannot change these limits, and the harness does not either:

- 60 seconds in total, including the in-container offline `npm ci` and the command;
- 512 MB of memory, which includes the 256 MiB in-memory (`tmpfs`) workspace that holds `node_modules`;
- 1 CPU;
- 64 processes;
- 1 MiB of retained output per stream.

Exceeding any of them is a finding, not a harness failure. The evaluation reports it and does not re-pick a literal, shrink a case, or edit a limit to avoid it.

## What Is Measured and What Is Not

Measured, from result-contract fields and the harness's own clock:

- recording, preparation (packages, downloaded MiB, seconds), and replay outcomes;
- replay duration per run (the contract's `execution.duration_ms`, which covers workspace setup, the offline install, and the command), as minimum, median, and maximum;
- the install-only baseline median, and from it an estimated command time (snapshot median minus baseline median, clamped at zero);
- headroom, one minus the slowest replay over the time limit;
- the host `node_modules` size estimate.

Not observable through the result contract:

- peak memory and the process count, so a run that finishes is not measured against those two limits;
- the split between install time and test time, which is only estimated through the baseline;
- a process-limit hit, which can only show up as a failed install or test.

The pilot answers "fits" or "does not fit" from the termination reason and error codes alone (`timeout`, `resource_termination`, `dependency_install_failed` with its npm error code). A host-side resource sampler would be a separate proposal.

## Consistency

A snapshot series is consistent when all N runs report `reproduced` with the same sorted evidence kinds. This follows the repeated-run record in `testing-strategy.md`. Container execution is described as controlled and repeatable under the documented conditions, so results say "replayed consistently", never "deterministic".

A series of k of N reproduced is repeatability evidence and a finding.

## Outcome Classes

Every case gets exactly one classification.

| Classification | Meaning | Harness exit |
| --- | --- | --- |
| `confirmed` | Recorded, prepared, all N snapshot runs reproduced consistently, the pre-fix checkout reproduced, and the fix gave `not_reproduced` | 0 |
| `finding` | A ProofIssue step ran and produced evidence about a support boundary: a refused record or prepare, a timeout, a resource limit, an install failure, an inconsistent or failed replay, or an unverified fix | 0 |
| `setup_failed` | A step outside ProofIssue failed (git, file bytes, host install, a preflight mismatch, a registry network error) or the replay environment was wrong (image or engine missing, policy rejection, store not prepared) | 1 |
| `harness_error` | An unexpected exception, CLI output the harness cannot read, rejected CLI arguments, or a failed leak self-check | 1 |

A green job means every case produced valid evidence. It does not mean every case reproduced.

### Finding or harness bug

If changing the harness or the manifest would make a case pass without changing what a reporter would reasonably do, it is a harness or setup problem and is fixed in the harness. If a documented ProofIssue boundary stops the case (the limits above, the offline install, the no-execute workspace, the approved image, redaction, or the declared-subject scope), it is a finding and is recorded as one. Product code, limits, and the pilot cases are not changed to avoid a finding. Replay errors that look like ProofIssue defects (`internal_error`, `cleanup_failed`, `container_creation_failed`, or an artifact reported invalid) are findings to investigate and report separately.

## Pilot Cases

The pilot is three cases from three repositories, one from each project's recent history. Each was chosen from a failing test added with a fix, using a pre-fix commit (PRE) and the fix commit (FIX). Reproduction files come from FIX; subject files come from PRE.

| ID | Repository | Link | PRE | FIX | Command | Literal |
| --- | --- | --- | --- | --- | --- | --- |
| N1 | nodemailer/nodemailer | [commit](https://github.com/nodemailer/nodemailer/commit/f2096c51b92a69ecfbcc15884c28cb2c2f00b826) | `81de9eb` | `f2096c5` | `node --test --test-name-pattern=... test/addressparser/addressparser-test.js` | `Expected values to be strictly deep-equal` |
| T1 | twigjs/twig.js | [PR 966](https://github.com/twigjs/twig.js/pull/966) | `392dc95` | `eb253e1` | `node node_modules/mocha/bin/mocha.js --require should --grep ... test/test.filters.js` | `expected '' to be '1'` and `1 failing` |
| M3 | postalsys/mailauth | [issue 125](https://github.com/postalsys/mailauth/issues/125), [PR 126](https://github.com/postalsys/mailauth/pull/126) | `dd6bdc2` | `53c4522` | `node node_modules/mocha/bin/mocha.js --grep ... test/spf/macro-test.js` | `expected 'email.example.com' to equal 'included.example.net'` |

The full commits, selected files, and notes are in `../benchmarks/real-projects/cases.json`. T1 has the heaviest install (355 locked packages) and 18 subject files; it is the case most likely to approach the budget.

## Repositories and Caveats

- nodemailer and mailauth share a maintainer. If independent projects matter more than low risk, the full set can use a different third repository.
- None of the primary repositories uses Jest. Jest projects appear only among the alternates, with heavier installs and a need for `--runInBand`.
- The harness records on a Linux host and replays in the approved image. The two differ in details a project can notice, for example the Node.js minor version, the processor count the runtime reports, and the process home directory. A difference that changes the output shows up as `not_reproduced` with a missing-output difference, and is a finding.
- The harness was built from the `main` commit `dfb35eb`. Changes merged to `main` after that, for example to the replayed command's environment, are not part of the harness base. A finding that involves `os.homedir()` is called out as such.

## Candidate Screening

Choosing candidates is separate from running them. Screening uses static evidence only: repository metadata, the committed lockfile run through ProofIssue's own validator, and the redactor run over the files a candidate would need. Nothing is recorded or replayed during screening.

Categories that excluded candidates are useful evidence about the support boundary:

- the lockfile is version 1 or 2, not the version 3 the prepare step accepts;
- a lockfile entry uses SHA-1 integrity, which prepare refuses;
- a lockfile has bundled entries, entries without a registry location, or exceeds the 1 MiB limit;
- the project commits no lockfile;
- the test path needs a native addon or a platform binary (for example an esbuild-based runner), which cannot run in the no-execute workspace;
- the test command needs a build step first, or reads from the network;
- the install is too large for the 256 MiB in-memory workspace and the 60-second budget;
- the redactor rewrites code the test needs, for example a `PWD:` shell fragment in a script, or `privateKey:` code and key fixtures, and recording refuses dependency files it would have to change.

## Where Results Go

Each case writes its outputs to workflow artifacts:

- `trial-result-<ID>` (30 days): the per-case result (`<ID>.result.json`), a short Markdown summary, the recorded `.proofissue` artifacts, `NOTICE.md`, and `UPSTREAM-LICENSE.txt`;
- `trial-diagnostics-<ID>` (14 days): redacted and path-scrubbed output of third-party tools, for investigation only;
- `trial-summary` (90 days): `summary.json` and `summary.md` across the cases of a run.

The result and summary formats are internal evaluation formats (`trial_result_version` 1), not public ProofIssue interfaces. Results and summaries hold only manifest values, result-contract fields, counts, and durations. Diagnostics are never evidence.

`.proofissue` files contain public third-party source code and are never committed to this repository. Per-case result JSON and the summary JSON contain no third-party code and are committed as evidence after a clean run, under `../benchmarks/real-projects/results/<date>-<set>-run<run-id>/`.

## Results

### Pilot, run 1

- Run: [36919125657](https://github.com/x9nst/Proofissue/actions/runs/36919125657), 2026-10-01, about 2 minutes 40 seconds end to end with the three case jobs in parallel.
- Harness commit `817274a` on `agent/real-project-trials`, based on `main` commit `dfb35eb`. The product under test is that tree. It predates the change that sets `HOME` for the replayed command, so `os.homedir()` was not available inside the replay container during this run.
- Environment: runner image `ubuntu24/20260927.320.1`, Docker Engine 28.0.4, host Node.js 24.18.0, npm 11.16.0, git 2.55.0, the approved image digest from `cases.json`, 4 CPUs and about 15.6 GiB per runner (N1 and M3 on an AMD EPYC 7763, T1 on an Intel Xeon Platinum 8573C).
- Settings: 5 snapshot replays, 3 install-only baseline replays, 1 pre-fix checkout replay, and 1 fix-verification replay per case.
- Committed evidence: `../benchmarks/real-projects/results/2026-10-01-pilot-run36919125657/` (the three `<ID>.result.json` files and `summary.json`). The recorded `.proofissue` files and the diagnostics stay in the workflow artifacts.

| Case | Outcome | Prepare: packages / MiB downloaded / s | Snapshot reproduced | Replay s (min / median / max) | Install baseline s (median) | Headroom | Host node_modules (est. MiB) | Pre-fix checkout | Fix verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | confirmed | 270 / 6.4 / 3.5 | 5/5 | 4.2 / 4.2 / 4.3 | 4.5 | 93% | 49.0 | reproduced | yes |
| T1 | confirmed | 355 / 11.4 / 3.6 | 5/5 | 4.4 / 4.5 / 4.6 | 4.4 | 92% | 86.1 | reproduced | yes |
| M3 | confirmed | 254 / 11.9 / 1.9 | 5/5 | 3.4 / 3.4 / 3.4 | 3.3 | 94% | 58.1 | reproduced | yes |

Headroom is one minus the slowest replay over the 60-second limit. Replay time is the contract's `execution.duration_ms`, which includes workspace setup, the offline install, and the command.

### What the pilot found

In plain words:

- **No finding.** None of the three cases reached the time, memory, workspace, process, or output limit, and none was refused at record or prepare. Every artifact replayed consistently: all 15 snapshot replays reproduced with the same evidence kinds, the pre-fix checkout reproduced, and the fix checkout did not.
- **Install time is the whole replay.** The install-only baseline median is within about a quarter of a second of the snapshot median for each case, so the estimated command time is 0.1 seconds or less (N1's baseline was slightly slower than its snapshot replays, so its estimate clamps to zero). The offline install of 254 to 355 packages takes a few seconds, against a 60-second budget. The budget was not the binding constraint for these three projects. Heavier installs were not tested.
- **The in-memory workspace has room.** The host estimates of `node_modules` size (49 to 86 MiB) are well under the 256 MiB workspace. These are host estimates, not measurements inside the container.
- **Peak memory and the process count are still unobserved.** "Fits" here means that no replay was terminated for a limit. The result contract cannot say how close a run came to 512 MB or 64 processes.
- **`os.homedir()` did not matter in these cases.** The replays ran without a home directory and still reproduced, so nothing the three test runners and projects did on this path depended on it. This says nothing about other projects.
- **Output length can vary slightly while the evidence agrees.** N1's stdout was 1433 bytes in four replays and 1429 in one, because `node:test` prints timing text. The raw `contains` literal contains no timing, so the evidence kinds matched. This is the reason the pilot literals avoid durations, paths, and symbols.
- **Unselected configuration files did not change the result.** The harness listed `.c8rc.json` (N1) and `.npmrc` (M3) at the pre-fix commit. Neither is needed by the replayed test.
- **Recording was clean.** No redaction findings on any of the three artifacts (4, 21, and 4 files), and the lockfile checks passed. One nodemailer package declares an install script, which prepare reports and replay never runs.
- **Fix verification used the declared subjects.** Substituting the declared subject files (1, 18, and 1 files) from the fixed checkout turned each reproduction into `not_reproduced`, with the exit code and the missing output as the differences.

Harness observation: `proofissue record` has no `--json` output, so the harness reads its last line and calls `inspect --json`. This is a limitation of the interface, reported and not changed here.

### What the pilot does not show

- It is three failures from three repositories, not ten. It does not count toward the 90% target.
- Consistency was measured with five replays per case, in one environment, on one day.
- nodemailer and mailauth share a maintainer, and all three cases are pure-JavaScript libraries with small test files.
- Install size was far inside the budget. Where the budget starts to bind is not yet known.

The maintainer reviewed the pilot, as Gate D asks, before the full set ran.

### Pilot rerun on `main`

- Run: [36973634809](https://github.com/x9nst/Proofissue/actions/runs/36973634809), 2026-10-02, manual dispatch of the `pilot` set on `main` (harness commit `92b3e63`), whose product tree includes the change that sets `HOME` for the replayed command.
- Result: all three cases confirmed, 5 of 5 snapshot replays each, the pre-fix checkout reproduced, and the fix verified. Replay medians were 3.5 s (M3), 4.2 s (N1) and 6.3 s (T1); headroom was 94%, 93% and 89%. No limit was reached.
- Setting `HOME` therefore did not change any pilot outcome.

## Full Set Cases

The `full` set is the three pilot cases plus nine more: N1, N2, N4, N5 (nodemailer), T1, T2, T3, T4 (twig.js) and M1, M2, M3, M4 (mailauth). The two reserve cases N3 and N6 are in a separate `reserve` set and were not run, because twelve cases ended valid. Every commit SHA, file, and test name was checked against the repositories with the GitHub API before the case was added; the expected literals for the nine new cases were assumptions about test output until the first hosted run tested them.

| ID | Link | PRE | FIX | Literal(s) |
| --- | --- | --- | --- | --- |
| N2 | [GHSA-mm7p-fcc7-pg87](https://github.com/advisories/GHSA-mm7p-fcc7-pg87), [commit](https://github.com/nodemailer/nodemailer/commit/1150d99fba77280df2cfb1885c43df23109a8626) | `3b8982c` | `1150d99` | `false !== true` |
| N4 | [mailparser issue 375](https://github.com/nodemailer/mailparser/issues/375), [commit](https://github.com/nodemailer/nodemailer/commit/fe27f7fd57f7587d897274438da2f628ad0ad7d9) | `1dd8eeb` | `fe27f7f` | `Expected values to be strictly deep-equal` |
| N5 | [commit](https://github.com/nodemailer/nodemailer/commit/8f8a77c67f0ba94ddf4e16c68f604a5920fb5d26) | `ce120a3` | `8f8a77c` | `Expected values to be strictly deep-equal` |
| T2 | [issue 901](https://github.com/twigjs/twig.js/issues/901), [PR 977](https://github.com/twigjs/twig.js/pull/977) | `5f7a325` | `e545910` | `1 failing` |
| T3 | [issue 896](https://github.com/twigjs/twig.js/issues/896), [PR 968](https://github.com/twigjs/twig.js/pull/968) | `eb253e1` | `04d87f1` | `to throw exception`, `1 failing` |
| T4 | [PR 914](https://github.com/twigjs/twig.js/pull/914) | `29addef` | `b2e717b` | `expected '' to be 'text 2'` |
| M1 | [commit](https://github.com/postalsys/mailauth/commit/734db62d09376c631e548f6c8b44a56ba38659c5) | `d2616c6` | `734db62` | `expected [ 'from' ] to deeply equal`, `1 failing` |
| M2 | [commit](https://github.com/postalsys/mailauth/commit/68dfb4262fdae1bedb17019ab8c3c59bc2f4cf8d) | `734db62` | `68dfb42` | the full expected hash, `1 failing` |
| M4 | [commit](https://github.com/postalsys/mailauth/commit/2007ab41cccc41b531f3e5ec65899264b6e3441d) | `a359299` | `2007ab4` | `1 failing` |

N1, T1 and M3 are unchanged from the pilot. The commands, selected files, and notes are in `../benchmarks/real-projects/cases.json`.

## Full Set Results

### Full set, run 1

- Run: [36974395767](https://github.com/x9nst/Proofissue/actions/runs/36974395767), 2026-10-02 (harness commit `ce6efe7`).
- 11 of 12 cases were confirmed. M2 was `setup_failed` with `preflight_expectation_missing`: its literal was one of the assumptions, and it did not appear in the host output. Chai shortens the strings in its one-line message (`expected 'VSura...' to equal '2+0N6T...'`), and prints the full expected hash only in the diff.
- Class: setup. A reporter would put the same literal that the test prints into the expectation; changing the literal does not change what a reporter would reasonably do, and no ProofIssue boundary was involved. The M2 expectation was replaced with the full expected hash (and `1 failing`), taken from the observed preflight output, and the case notes say so. No other case, literal, or harness behavior changed.

### Full set, run 2

- Run: [36974824425](https://github.com/x9nst/Proofissue/actions/runs/36974824425), 2026-10-02, about 2 minutes 47 seconds end to end with the twelve case jobs in parallel.
- Harness commit `3d947ae` on `agent/full-trial`, based on `main` commit `92b3e63` (product tree includes `HOME` for the replayed command). No product code was changed.
- Environment: runner image `ubuntu24/20260927.320.1`, Docker Engine 28.0.4, host Node.js 24.18.0, npm 11.16.0, git 2.55.0, the approved image digest, 4 CPUs and about 15.6 GiB per runner (AMD EPYC and Intel Xeon models varied by case).
- Settings: 5 snapshot replays, 3 install-only baseline replays, 1 pre-fix checkout replay, and 1 fix-verification replay per case.
- Committed evidence: `../benchmarks/real-projects/results/2026-10-02-full-run36974824425/` (twelve `<ID>.result.json` files and `summary.json`).

| Case | Outcome | Prepare: packages / MiB downloaded / s | Snapshot reproduced | Replay s (min / median / max) | Install baseline s (median) | Headroom | Host node_modules (est. MiB) | Pre-fix checkout | Fix verified |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| N1 | confirmed | 270 / 6.4 / 2.5 | 5/5 | 4.0 / 4.0 / 4.1 | 4.0 | 93% | 49.0 | reproduced | yes |
| N2 | confirmed | 274 / 6.7 / 2.1 | 5/5 | 4.6 / 4.6 / 4.7 | 4.7 | 92% | 52.3 | reproduced | yes |
| N4 | confirmed | 263 / 8.6 / 1.7 | 5/5 | 4.2 / 4.3 / 4.3 | 4.1 | 93% | 58.5 | reproduced | yes |
| N5 | confirmed | 268 / 8.8 / 2.4 | 5/5 | 3.2 / 3.3 / 3.3 | 3.2 | 95% | 58.7 | reproduced | yes |
| T1 | confirmed | 355 / 11.4 / 3.1 | 5/5 | 5.4 / 5.4 / 5.5 | 5.3 | 91% | 86.1 | reproduced | yes |
| T2 | confirmed | 355 / 11.4 / 2.9 | 5/5 | 3.5 / 3.5 / 3.5 | 3.4 | 94% | 86.2 | reproduced | yes |
| T3 | confirmed | 355 / 11.4 / 2.1 | 5/5 | 6.1 / 6.2 / 6.2 | 6.2 | 90% | 86.1 | reproduced | yes |
| T4 | confirmed | 355 / 11.4 / 2.5 | 5/5 | 5.9 / 6.0 / 6.1 | 5.9 | 90% | 86.1 | reproduced | yes |
| M1 | confirmed | 254 / 11.9 / 1.5 | 5/5 | 3.5 / 3.5 / 3.6 | 3.3 | 94% | 58.1 | reproduced | yes |
| M2 | confirmed | 254 / 11.9 / 1.5 | 5/5 | 3.3 / 3.3 / 3.3 | 3.2 | 95% | 58.1 | reproduced | yes |
| M3 | confirmed | 254 / 11.9 / 1.5 | 5/5 | 3.4 / 3.5 / 3.5 | 3.3 | 94% | 58.1 | reproduced | yes |
| M4 | confirmed | 247 / 10.3 / 1.6 | 5/5 | 3.4 / 3.4 / 3.5 | 3.2 | 94% | 51.9 | reproduced | yes |

Headroom is one minus the slowest replay over the 60-second limit.

### Consistency

Computed as defined under Consistency: a series is consistent when all N snapshot runs reproduced with the same sorted evidence kinds.

- 12 of 12 artifacts replayed consistently (100%); 60 of 60 snapshot replays reproduced.
- Run 1 gave the same result for the 11 cases that reached replay (55 of 55 snapshot replays). Each run records and replays on fresh virtual machines, so this is two separate hosted recordings and replay series, not one.
- All twelve pre-fix checkout replays reproduced, and all twelve fixed checkouts gave `not_reproduced`.

### Milestone 7 numeric criteria

| Criterion | Evidence | Met by this evidence |
| --- | --- | --- |
| At least ten real Node.js failures across three external repositories | 12 confirmed failures in 3 repositories | yes, numerically, with the independence caveat below |
| At least 90% of supported artifacts replay consistently across repeated runs | 12 of 12 (100%), 5 replays each, in two hosted runs | yes |

The other Milestone 7 criteria (credential leakage, the security suite, command documentation, fixture compatibility) are not addressed by this evidence, and no box is ticked here.

### What the full set found

In plain words:

- **No ProofIssue finding.** No case was refused at record or prepare, hit a limit, or failed an install, and all twelve were confirmed. All 60 snapshot replays reproduced, all 12 pre-fix checkouts reproduced, and all 12 fixed checkouts did not.
- **The one setup failure was a manifest assumption.** The M2 literal was guessed from the test's expected value and never appeared, because chai shortens the strings in its message. It was corrected from observed preflight output and recorded in the case notes. It is not a product problem.
- **The budget was not the binding constraint.** Replay time was 3.2 to 6.2 seconds against a 60-second limit (headroom of at least 90%), and the offline install of up to 355 packages was almost all of it: the estimated command time is 0.3 s or less in every case. Host estimates of `node_modules` size were 49 to 86 MiB against the 256 MiB workspace. Peak memory and the process count are still not observable through the result contract, so "fits" means that no replay was terminated for a limit.
- **Recording was clean everywhere.** There were zero redaction findings in all twelve artifacts (4 to 21 files each), no lockfile rejection, and no refusal. This was true because the cases were chosen from commits whose files the redactor does not rewrite. Candidate screening found real boundaries that excluded other candidates before any run: nodemailer from 2026-03-18 onward has a `package.json` script whose `$PWD:` fragment matches the redactor's password rule, so recording with dependencies is refused; mailauth's signing and ARC code and key fixtures are rewritten by the redactor; and many projects fail the lockfile, native-binding, or footprint rules (see Candidate Screening). Those are evidence about the support boundary, not results of these twelve cases.
- **Install-script warnings do not matter.** Packages that declare install scripts are reported by prepare, and replay never runs them.
- **Same-lockfile cases differ in time.** The four twig.js cases use the same 355-package lockfile, yet their medians range from 3.5 to 6.2 s, and the install-only baselines vary the same way (3.4 to 6.2 s). The variation tracks the baseline, so it is install and runner variance, not the tests. Time was not a constraint at either end of the range.

### Full set, caveats

- **Independence.** nodemailer and mailauth share a maintainer (postalsys). Two of the three repositories are therefore not fully independent projects; a count of "three external repositories" is met numerically but the diversity is weaker than the number suggests. twig.js is independent.
- **Concentration.** Four of the twelve cases (N1, N2, N4, N5) fall in one nodemailer module (`addressparser`) and share a test file. The four twig.js cases share a lockfile and the same 18 subject files.
- **Breadth.** All three are pure-JavaScript libraries whose tests run in process, with no native addon, build step, network access, or `os.homedir()` use on the path. Jest-based projects, TypeScript sources, heavier installs, and other ecosystems were not evaluated.
- **Selection.** The cases were chosen by static screening for replayability, which favors success. The 100% figure describes artifacts from projects already screened as plausible, not typical Node.js projects. Candidate Screening lists the many projects that were excluded for support-boundary reasons.
- **Redaction was not exercised on these cases.** Zero findings means these twelve were chosen to avoid the redaction boundary; it is not evidence that redaction is harmless for real projects.
- **Duration and environment.** Consistency rests on five replays per case, in two hosted runs on one day, on one runner image and Docker version.
- **Reserves.** N3 (stack overflow in the same module, memory-dependent) and N6 (a 14-file subject closure with redaction findings in comments) were not run, because the full set produced twelve valid cases (more than the ten needed). They stay in the `reserve` set.
- **Harness cosmetic.** The summary's "Set" line lists the union of the selected cases' sets (`full, pilot`) rather than the selected set only. It does not affect results.

## Security of the Trial Workflow

The workflow runs third-party test code on the hosted runner during the preflight and during `proofissue record`, outside any sandbox, exactly as it would run in those projects' own CI or on a reporter's machine. Replays run in the existing locked-down container, unchanged.

- Each case runs on its own ephemeral virtual machine. Only uploaded artifacts leave it.
- The workflow has read-only contents permission, references no secret, persists no checkout credentials, and gives no shell step the workflow token. The checkout action uses the read-only token only to fetch this repository and does not keep it.
- Commands run with minimal environments: the preflight and recorded command get an empty environment, git and npm get a scratch home with empty configuration, and the ProofIssue CLI gets only `PATH`. Host `npm ci` uses `--ignore-scripts`.
- Repositories are restricted to `https://github.com`, commits are full SHAs, and selected file bytes are verified against blob hashes.
- Every external step has a timeout and an output cap. CLI steps are stopped gracefully so replay containers are removed, and the last step asserts that none remain.
- No npm cache is used, including the automatic one `actions/setup-node` enables when `package.json` names npm, so job code cannot seed a cache that other workflows restore.
- Third-party output never reaches the job log, so it cannot issue workflow commands. It goes to diagnostic files that are redacted, path-scrubbed, and bounded.
- Only people with write access can start it (manual dispatch or a push to `trials/**`). It has no pull request trigger. Inputs reach scripts only through environment variables. A test enforces these properties against the workflow text.

Residual risk: code in the recording step runs as the runner user and could tamper with its own job's results or uploads, or make outbound requests. It cannot read secrets (there are none) or write to the repository. The summary job runs on a fresh machine with no third-party code and validates every per-case result against the harness schema, bounds and escapes every rendered field, and checks each uploaded artifact's SHA-256 against the digests the CLI reported. Results are reviewed measurements, not security evidence.
