# GitHub Action

ProofIssue ships two Actions: the replay Action (`action`) and the prepare Action
(`action/prepare`). Each section below documents one of them completely. Permissions
and maintainer validation apply to both and are at the end.

## Replay Action

### Purpose

The ProofIssue Action validates and replays one `.proofissue` artifact on an
x86-64 Linux runner. It calls the same application service as the local command
line, so validation, container policy, matching, cleanup, and required-result
behavior do not have separate CI implementations.

The Action does not create issue or pull-request comments and does not call the
GitHub API.

### Example

The approved replay image must be prepared explicitly before the Action runs.
Replay itself never pulls an image.

```yaml
name: Replay ProofIssue

on:
  pull_request:

permissions:
  contents: read

jobs:
  replay:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - name: Prepare the approved image
        env:
          PROOFISSUE_IMAGE: node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6
        run: docker pull "$PROOFISSUE_IMAGE"

      - name: Confirm the failure still reproduces
        id: proofissue
        uses: x9nst/Proofissue/action@FULL_COMMIT_SHA
        with:
          artifact-path: failures/example.proofissue
          replay-mode: snapshot
          required-status: reproduced

      - name: Consume the structured result
        env:
          PROOFISSUE_RESULT: ${{ steps.proofissue.outputs.result }}
        run: node --input-type=module -e "console.log(JSON.parse(process.env.PROOFISSUE_RESULT).status)"
```

Pin the Action to a reviewed full commit SHA. The repository integration fixture
uses `./action` so it exercises the exact checked-out bundle.

### Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `artifact-path` | yes | none | Path to the artifact that replay validates before execution |
| `replay-mode` | no | `snapshot` | `snapshot` or `current-checkout` |
| `checkout-path` | no | `GITHUB_WORKSPACE` | Root used only by `current-checkout` replay |
| `dependency-store` | no | none | Directory filled by the prepare Action. Needed only for an artifact with dependency files; replay never uses the network |
| `required-status` | no | none | `reproduced` or `not_reproduced`; a mismatch fails the step without changing the classification |

Supplying `checkout-path` in snapshot mode is rejected. Current-checkout replay
reads only declared, existing subject paths. It does not discover additions or
infer removals and renames.

### Outputs

| Output | Format | Meaning |
| --- | --- | --- |
| `status` | string | `reproduced`, `not_reproduced`, `invalid_artifact`, or `execution_failed` |
| `mode` | string | `snapshot` or `current_checkout` |
| `result` | JSON object | Complete version 1 replay result |
| `evidence` | JSON array | Explainable checks that matched |
| `differences` | JSON array | Explainable checks that differed |
| `required_status_satisfied` | `true` or `false` | Whether no result was required or the required result matched |

The structured result contains bounded execution facts and counts. It does not
contain raw standard output or standard error.

Evidence and differences use the kinds `exit_code`, `stdout_contains`,
`stderr_contains`, `stdout_exact`, `stderr_exact`, `stdout_regex`, `stderr_regex`,
`stdout_missing`, `stderr_missing`, `stdout_differs`, `stderr_differs`,
`stdout_no_match`, `stderr_no_match`, `regex_step_limit`, and `insufficient_output`.
An item for a normalized comparison also carries a `normalization` object with the
requested rules and the number of replacements each made. This is additive: the
Action has no new inputs or outputs, and the existing `evidence`, `differences`, and
`result` outputs only gain the new kinds and the optional object. See
`result-contract.md`.

### Failure behavior

Without `required-status`, both `reproduced` and `not_reproduced` are successful
completed classifications. `invalid_artifact` and `execution_failed` fail the
step.

With `required-status`, the step succeeds only when the completed classification
equals the requested value. Outputs are written before a required-result mismatch
fails the step, so a later step using `if: always()` can still inspect them.

Invalid Action inputs fail before replay. If GitHub's output or summary files
cannot be written, the Action fails rather than claiming a usable machine result.

A failed replay on a runner is almost always a missing prerequisite. The Action
reports the same error codes as the CLI (`image_unavailable`,
`engine_unavailable`, `engine_capability_unavailable`); the fix for
`image_unavailable` is the pull step shown in the example. The CLI's
`proofissue doctor` diagnoses all of these prerequisites without pulling or running
anything, and the repository's own locked-down job runs it after the pull and
requires it to pass. Use it on a self-hosted machine to find what is missing; the
Action itself neither runs `doctor` nor pulls images.

### Workflow summary

The summary shows only:

- classification and mode;
- counts of evidence, differences, warnings, errors, and substitutions;
- fixed labels for matched and differing checks, for example "stderr matched the expected output exactly", "stdout did not match the expected pattern", "a pattern exceeded its step limit", or "expected stdout text was absent after normalization" (the words "after normalization" are added when the comparison used normalized output);
- required-result and cleanup state.

It never publishes command output, file contents, expected text, environment
values, or application error messages. Use the structured `result` output for
bounded diagnostic codes and details.

### Security notes

The artifact is treated as malicious. It is validated first and then replayed in the
same locked-down container as the command line: no network, a read-only base
filesystem, dropped capabilities, and limits on processes, memory, CPU, output, and
time. The container never receives the Docker socket, repository credentials, job
secrets, host network, or undeclared host files, and the Action passes no workflow
environment variables into it. Output is redacted before it is matched, and neither
the outputs nor the summary carry output text. See "Permissions and security" below
and `security-model.md`.

## Prepare Action

### Purpose

An artifact recorded with `--dependencies` carries a lockfile. Its packages are
downloaded by a separate Action, `action/prepare`, so that the one step that uses
the network is a distinct `uses:` line in the workflow, and the replay Action
never contains download code. Run it before replay and give both the same
directory.

### Example

```yaml
      - name: Prepare dependencies
        id: prepare
        uses: x9nst/Proofissue/action/prepare@FULL_COMMIT_SHA
        with:
          artifact-path: failures/example.proofissue
          dependency-store: ${{ runner.temp }}/proofissue-dependency-store

      - name: Confirm the failure still reproduces
        uses: x9nst/Proofissue/action@FULL_COMMIT_SHA
        with:
          artifact-path: failures/example.proofissue
          dependency-store: ${{ runner.temp }}/proofissue-dependency-store
          required-status: reproduced
```

The prepare Action is safe to run unconditionally: an artifact without dependency
files reports `not_required`, fetches nothing, and creates no directory.

### Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `artifact-path` | yes | Path to the artifact whose locked packages are prepared |
| `dependency-store` | yes | Directory for the verified package store; use a directory under the runner's temporary directory, never an npm cache |

### Outputs

| Output | Format | Meaning |
| --- | --- | --- |
| `status` | string | `prepared`, `not_required`, `invalid_input`, `invalid_artifact`, or `execution_failed` |
| `result` | JSON object | Complete version 1 prepare result, without package names, tarball paths, or the store path |

### Failure behavior

The step succeeds for `prepared` and `not_required` and fails for every other
status. Outputs are written before the step fails, so a later step using
`if: always()` can still read them. An empty `artifact-path` or `dependency-store`
fails the step before the application runs, with a fixed message and no outputs.
A failed preparation is not a replay result: a replay without a prepared store
reports `dependencies_not_prepared`.

### Workflow summary

The workflow summary shows the status and
counts only: packages, tarballs downloaded, tarballs already in the store, packages
skipped for another platform, and the numbers of warnings and errors. It never
shows error messages, package locations, or directories; the structured `result`
output carries the bounded details.

### Security notes

This is the only step that uses the network. It contacts only
`https://registry.npmjs.org`, for exactly the tarballs the artifact's lockfile
names, checked against their hashes. It sends no token, follows no redirects, and
extracts and runs nothing. Packages are stored only in the directory you give, which
should be under `runner.temp`, never in the npm cache. The artifact and its lockfile
are validated before any request is made or any directory is created.

## Permissions and Security

The Action itself needs no `GITHUB_TOKEN` and makes no GitHub API request. A
typical workflow grants only `contents: read` so `actions/checkout` can read the
repository. `persist-credentials: false` prevents checkout credentials from
remaining in the worktree.

The prepare Action needs no token either. Like every step on a runner, it runs on
the host with the runner's network, and it contacts only the public npm registry,
for exactly the tarballs the artifact's lockfile names, checked against their
hashes. The replay container never has a network. See `security-model.md`.

Use a supported x86-64 Linux runner with Docker Engine. The host Action process
uses the local Docker command line, but the replayed container never receives the
Docker socket, repository credentials, job secrets, host network, or undeclared
host files. The Action passes no workflow environment variables into the replay
container.

Treat artifacts from untrusted contributors as malicious. Keep the job free of
unnecessary secrets and permissions, and use an additional disposable machine
boundary for highly adversarial artifacts.

## Maintainer Validation

The committed `action/dist/index.js` (replay) and `action/prepare/dist/index.js`
(prepare) are generated from the TypeScript sources so consumers do not install
dependencies before the Action starts. Bundled third-party notices are retained
beside each. The replay bundle is tested to carry no package download code, and the
prepare bundle is tested to carry it, so that guard cannot pass vacuously.

```bash
npm ci
npm run build
npm run check
git diff --exit-code
```

The final command verifies that the committed bundle matches its source. Rebuild it
in any change that touches the application layer or a package beneath it, and again
after merging another such change, because a pull request is only checked against
the `main` it was last tested on. The
Linux fixture workflow additionally runs snapshot and current-checkout replay,
requires both supported result policies, consumes the JSON outputs, and checks
that no replay container remains.
