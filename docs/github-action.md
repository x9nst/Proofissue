# GitHub Action

## Purpose

The ProofIssue Action validates and replays one `.proofissue` artifact on an
x86-64 Linux runner. It calls the same application service as the local command
line, so validation, container policy, matching, cleanup, and required-result
behavior do not have separate CI implementations.

The Action does not create issue or pull-request comments and does not call the
GitHub API.

## Example

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

## Inputs

| Input | Required | Default | Meaning |
| --- | --- | --- | --- |
| `artifact-path` | yes | none | Path to the artifact that replay validates before execution |
| `replay-mode` | no | `snapshot` | `snapshot` or `current-checkout` |
| `checkout-path` | no | `GITHUB_WORKSPACE` | Root used only by `current-checkout` replay |
| `required-status` | no | none | `reproduced` or `not_reproduced`; a mismatch fails the step without changing the classification |

Supplying `checkout-path` in snapshot mode is rejected. Current-checkout replay
reads only declared, existing subject paths. It does not discover additions or
infer removals and renames.

## Outputs

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

## Step Results and Failures

Without `required-status`, both `reproduced` and `not_reproduced` are successful
completed classifications. `invalid_artifact` and `execution_failed` fail the
step.

With `required-status`, the step succeeds only when the completed classification
equals the requested value. Outputs are written before a required-result mismatch
fails the step, so a later step using `if: always()` can still inspect them.

Invalid Action inputs fail before replay. If GitHub's output or summary files
cannot be written, the Action fails rather than claiming a usable machine result.

## Workflow Summary

The summary shows only:

- classification and mode;
- counts of evidence, differences, warnings, errors, and substitutions;
- fixed labels for matched and differing checks;
- required-result and cleanup state.

It never publishes command output, file contents, expected text, environment
values, or application error messages. Use the structured `result` output for
bounded diagnostic codes and details.

## Permissions and Security

The Action itself needs no `GITHUB_TOKEN` and makes no GitHub API request. A
typical workflow grants only `contents: read` so `actions/checkout` can read the
repository. `persist-credentials: false` prevents checkout credentials from
remaining in the worktree.

Use a supported x86-64 Linux runner with Docker Engine. The host Action process
uses the local Docker command line, but the replayed container never receives the
Docker socket, repository credentials, job secrets, host network, or undeclared
host files. The Action passes no workflow environment variables into the replay
container.

Treat artifacts from untrusted contributors as malicious. Keep the job free of
unnecessary secrets and permissions, and use an additional disposable machine
boundary for highly adversarial artifacts.

## Maintainer Validation

The committed `action/dist/index.js` is generated from the TypeScript sources so
consumers do not install dependencies before the Action starts. Bundled
third-party notices are retained beside it.

```bash
npm ci
npm run build
npm run check
git diff --exit-code
```

The final command verifies that the committed bundle matches its source. The
Linux fixture workflow additionally runs snapshot and current-checkout replay,
requires both supported result policies, consumes the JSON outputs, and checks
that no replay container remains.
