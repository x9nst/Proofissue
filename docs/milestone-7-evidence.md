# Milestone 7 Evidence

## Status

Milestone 7 — Initial supported Node.js workflow remains In Progress. No
acceptance box is ticked: the maintainer decides, and the first two criteria
(real-project trials and repeatability) are recorded separately in
`real-project-evaluation.md`.

This document records the audit of the four remaining criteria: credential
leakage, the security test categories, command documentation, and
compatibility of version 1 fixtures. For each it says what proves the claim,
where the test runs, and how strong the proof is. It also lists the decisions
the audit took by default so the maintainer can confirm or change them.

The container-backed tests run only on a hosted Linux runner, in the job
`Locked-down replay (Linux)` of `.github/workflows/foundation.yml`. Hosted
run 36980876258 of the `Foundation checks` workflow passed all three jobs on
commit `427bb55`, which holds every test described here; the commits after it
change only documentation. The run is
<https://github.com/x9nst/Proofissue/actions/runs/36980876258>. Locally,
on the Windows development host, the container tests are skipped because the
host cannot run Linux containers.

## Security evidence matrix

Strength: **container** means the behavior was observed inside the real
locked-down container on a hosted runner; **host** means a test on the hosted
Linux and Windows `check` jobs against real files; **unit** means an injected
fake, so it proves the code path and not the boundary.

| Criterion | Sub-item | Test (file, name) | CI job | Strength |
| --- | --- | --- | --- | --- |
| Path traversal | Artifact paths | `packages/artifact-schema/src/index.test.ts`: rejects generated traversal paths; keeps every accepted generated path under the assigned root | `check` | host |
| Path traversal | Archive entries during the offline install | `packages/runner/src/dependencies.integration.test.ts`: writes nothing outside the package for hostile archive entries | `locked-down-replay` | container |
| Symbolic-link escape | Artifact file, store, and lockfile | `artifact-schema` rejects symbolic-link artifact input; `dependencies` store tests; `recorder` refuses a symbolic-link subject and lockfile | `check` (Linux; skipped on Windows without the privilege) | host |
| Symbolic-link escape | Checkout subject file | `packages/runner/src/index.test.ts`: rejects a symbolic-link subject that escapes the selected checkout | `check` (Linux) | host |
| Symbolic-link escape | Checkout directory and root | `packages/runner/src/index.test.ts`: rejects a declared subject reached through a symbolic-link directory; rejects a current checkout that is itself a symbolic link (junctions on Windows, so these run on both hosts) | `check` | host |
| Symbolic-link escape | Archive entries | `dependencies.integration.test.ts`: writes nothing outside the package through a symbolic link (also covered by `npm-offline.test.ts`) | `locked-down-replay` | container |
| Symbolic-link escape | Links the replayed command creates | `packages/runner/src/container.integration.test.ts`: keeps the input mount read-only and confines symbolic links the command creates (links to the input mount, a host sentinel file, and `/etc/passwd`; the host sentinel is unchanged and its directory holds only the sentinel) | `locked-down-replay` | container |
| Environment leakage | Replayed command | `container.integration.test.ts`: exposes only PATH and HOME to the replayed process | `locked-down-replay` | container |
| Environment leakage | After the offline install | `dependencies.integration.test.ts`: exposes only PATH and HOME to the command after the offline install | `locked-down-replay` | container |
| Environment leakage | Recorded command | `packages/recorder/src/index.test.ts`: does not expose host environment values to the recorded command | `check` | host |
| Command injection | Recorder | `recorder`: never invokes a shell for argument interpretation | `check` | host |
| Command injection | Container bootstrap | `container.integration.test.ts`: passes shell metacharacters in command arguments to node literally (command substitution, backticks, `;`, `&&`, `|`, `${HOME}`, a glob, quotes, and `--`; no marker file is created) | `locked-down-replay` | container |
| Oversized input | Artifact, files, and archives | `artifact-schema` rejects invalid UTF-8 and oversized input; `recorder` rejects directories and oversized files; `dependencies.integration.test.ts`: stops an archive that expands past the workspace limit | `check`, `locked-down-replay` | host and container |
| Oversized input | Output and workspace | `container.integration.test.ts`: enforces output, process-count, and writable-workspace limits; bounds the in-memory /tmp at 16 MiB | `locked-down-replay` | container |
| Process exhaustion | Process limit | `container.integration.test.ts`: refuses process creation past the process limit; the applied limit equals the declared one | `locked-down-replay` | container |
| Memory | Memory limit | `container.integration.test.ts`: kills a process that allocates past the memory limit and reports resource termination | `locked-down-replay` | container |
| Timeout | Time limit | `container.integration.test.ts`: terminates CPU/time and memory exhaustion and leaves no residual resources | `locked-down-replay` | container |
| Timeout | A command that ignores SIGTERM | `container.integration.test.ts`: escalates to a kill when the command ignores SIGTERM at the time limit (under 45 s in total) | `locked-down-replay` | container |
| Timeout | Interruption | `container.integration.test.ts`: stops and cleans a replay interrupted through its abort signal | `locked-down-replay` | container |
| Timeout | Recorder | `recorder`: terminates a command that exceeds the wall-clock limit; terminates the whole process tree at the wall-clock limit (a grandchild process must be gone within 10 s) | `check` (Ubuntu and Windows) | host |
| Network | General, DNS, IPv6 | `container.integration.test.ts`: blocks network, host files, root writes, capabilities, root identity, and the Docker socket; blocks DNS resolution and IPv6 connections as well as IPv4 | `locked-down-replay` | container |
| Network | Metadata address and bridge gateway | `container.integration.test.ts`: blocks the link-local metadata address and the bridge gateway | `locked-down-replay` | container |
| Network | During the install | `dependencies.integration.test.ts`: has no network while installing or running | `locked-down-replay` | container |
| Read-only base and mounts | Root filesystem, input mount, store | `container.integration.test.ts`: blocks ... root writes; keeps the input mount read-only ...; `dependencies.integration.test.ts`: cannot write to the prepared store from inside the container | `locked-down-replay` | container |

Every container test asserts `cleanup: { completed: true, residual_resources: [] }`
or `cleanup.completed`, and the job ends by confirming no labelled replay
container remains. The tests use allocations of 64 MiB or less (except the
memory test, which stops at 512 MiB) and a bounded number of processes, so they
are safe on a shared host.

## Credential-leakage evidence

No committed secret was found. The audit ran the repository's own redactor
over every tracked text file and then added standing checks:

- `packages/redactor/src/committed-evidence.test.ts` scans fixtures, the fuzz
  corpus, recorded trial results, the example, workflows, Action metadata,
  documentation, and the top-level guides with the redactor (`check` job, both
  hosts). The findings must equal an exact allowlist of one: the table row in
  `security-model.md` that describes the password rule itself, which is not a
  credential. A redaction-limit error fails the test, and so does a Vitest
  snapshot directory (snapshots could hold output).
- `scripts/check-repository-hygiene.mjs` now scans `.proofissue` files as well
  as the other text types, for user-home paths, private-key blocks, and bearer
  tokens.
- `packages/application/src/fix-verification.integration.test.ts`: a
  reproduction prints a synthetic secret built at run time; the replay result is
  `reproduced`, carries the `replay_output_redacted` warning, and contains
  neither the secret nor any output text. It runs against the real container in
  the `locked-down-replay` job and against a local engine in the `check` job.
- `packages/cli/src/index.test.ts`: an expected value that holds a likely secret
  is refused, is not repeated in the output or the result, and no artifact is
  written.

Logs are covered by code-path tests rather than by reading past hosted logs:
results and summaries carry counts and fixed messages, the Action summary tests
inject sensitive messages and prove none reach it, and the trial harness checks
its own output for the text it must never contain. A manual review of past hosted
CI logs is optional and left to the maintainer (decision D).

## Compatibility evidence

Parsing was already strong: every committed valid fixture parsed, and the
canonical fixture is byte-compared. This audit added:

- `packages/artifact-schema/src/index.test.ts`: parses every committed valid
  fixture and round-trips it canonically (parse, serialize, parse gives equal
  content; not byte-compared, because `minimal` is not in canonical form); rejects
  every committed invalid fixture. The directories are listed at run time, so a
  fixture added later is covered without editing the test.
- `packages/application/src/fix-verification.integration.test.ts`, in the real
  container: every file in `tests/fixtures/artifacts/v1/valid` is replayed
  (`canonical`, `exact-output`, `minimal`, `normalized-output`, `regex-output`,
  and `with-dependencies`, found by listing the directory). Each is reproduced
  in snapshot mode, and with a corrected `calculate.mjs` it is not reproduced in
  current-checkout mode with `calculate.mjs` as the only substituted path. The
  dependency fixture is prepared first through a fetcher that fails every
  request, which proves it needs no network. Before this audit only `canonical`
  and the Action fixture were replayed in a container.

"Replay-compatible" is defined in decision A below. Result fixtures are not
covered (decision B).

## Documentation evidence

- `docs/cli.md`: `inspect` has real output and failure and security notes;
  `replay` lists every `execution_failed` code with its meaning and remedy; the
  security notes of `record`, `validate`, and `replay` are extended, including
  that recording is not sandboxed; `--help`, `-h`, and no arguments are
  documented.
- `docs/github-action.md`: the replay and prepare Actions each have purpose,
  example, inputs, outputs, failure behavior, summary, and security notes.
- `packages/cli/src/documentation.test.ts` keeps this from drifting: each of the
  five commands must have all six required subsections, every `--option` in the
  CLI help text must appear in `docs/cli.md`, and each Action must have its seven
  subsections.
- `packages/cli`: usage errors, which echo the user's own arguments, now escape
  control characters (a command name or option containing an escape sequence can
  no longer rewrite the terminal). Test: escapes control characters in an unknown
  command name and in an unknown option name.

## Decisions for the maintainer

The audit took the recommended default for each. Please confirm or change them.

- **A.** "Replay-compatible" means a fixture replays unchanged except that
  `environment.image` is replaced by the currently approved digest. Fixtures carry
  the placeholder `node@sha256:1111...`, and fixtures are never edited.
- **B.** The compatibility criterion covers artifact fixtures. Result fixtures
  (`tests/fixtures/results/v1`) stay provisional, as `tests/fixtures/README.md`
  says.
- **C.** The secret scan uses the repository's own redactor plus the extended
  hygiene check, with no new dependency.
- **D.** "Logs" are covered by code-path tests and the trial harness self-check;
  a manual review of past hosted logs is optional.
- **E.** Echoed command-line arguments in usage errors are escaped (implemented).
- **F.** Recording stays unsandboxed on the host by design and is documented as
  such.

## Known limitations

- Recording is not sandboxed. The command runs with the user's privileges; only
  time and retained output are bounded and the process tree is ended at the limit.
- Replay-compatibility substitutes the image digest (decision A); a fixture that
  needed a different image would not be covered.
- Result fixtures are provisional (decision B).
- The symbolic-link tests that create file links are skipped on Windows hosts
  without the privilege; the directory and checkout-root tests use junctions and
  run there. The container tests and every symbolic-link behavior inside the
  container run only on the hosted Linux job.
- The container tests prove the documented controls on the supported runner
  (Docker Engine 27 or newer, x86-64 Linux). They are not a proof against kernel
  or engine vulnerabilities; see `security-model.md`.
