# Command Line Reference

ProofIssue installs one executable, `proofissue`, with four commands: `record`, `validate`, `inspect`, and `replay`. Until the package is published, run it from a built checkout:

```text
npm ci
npm run build
node packages/cli/dist/bin.js <command> ...
```

The examples below write `proofissue` for that invocation. They use the project in `examples/failing-node-test`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command completed. For `replay`, a classification was reached and any `--require-status` was satisfied. For `record`, an artifact was created or you declined at the confirmation prompt. |
| `1` | The command ran but did not succeed: an invalid or missing artifact, a replay that could not complete, a required status that was not met, or a recording that failed. |
| `2` | The arguments were malformed. The message and usage text are printed, and nothing is executed. |

A replay that ends in `reproduced` or `not_reproduced` is a successful classification. Which of the two you want is a policy decision, expressed with `--require-status`.

## `record`

### Purpose

Run one Node.js command that fails, and capture a minimal artifact that describes the failure. The recorder runs the command exactly as you give it, with no shell and an empty environment, then shows what it intends to write and asks you to confirm.

### Syntax

```text
proofissue record --project <directory> --output <file.proofissue>
  --image <repository@sha256:digest>
  --reproduction <path> --subject <path>
  [--expect-stdout <literal>] [--expect-stderr <literal>]
  [--yes] -- node <arguments...>
```

### Options

| Option | Required | Meaning |
| --- | --- | --- |
| `--project <directory>` | yes | The project root. Selected paths are resolved beneath it and symbolic links are refused. |
| `--output <file>` | yes | The new artifact. An existing file is never overwritten. |
| `--image <repo@sha256:digest>` | yes | The replay image. Only the approved Node.js 24 image is accepted by replay. |
| `--reproduction <path>` | at least one | A test, fixture, or input kept exactly as recorded. Repeatable. |
| `--subject <path>` | at least one | Implementation code that a fix may change, and that `replay --against` can replace. Repeatable. |
| `--expect-stdout <literal>`, `--expect-stderr <literal>` | at least one expectation overall | A literal substring the failing output must contain. Repeatable. |
| `--yes` | no | Approve without prompting. Use only after reviewing the project, command, file roles, expectations, and output path. |
| `-- node <arguments...>` | yes | The command. It must start with `node` and have at least one argument. |

The expected exit code is whatever the recorded command actually returned.

### Example

```text
proofissue record \
  --project examples/failing-node-test \
  --output failure.proofissue \
  --image node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  --yes \
  -- node test/reproduction.mjs
```

```text
ProofIssue recording preview

Authorized command (no shell):
  node "test/reproduction.mjs"

Files kept exactly as recorded during fix checks (reproduction):
  test/reproduction.mjs
  A test or fixture placed in the other group may be replaced during a fix check.

Files that may be replaced from the current checkout (subject):
  src/calculate.mjs
  Implementation code placed in the first group stays frozen and may hide a real fix.

Expected failure:
  exit code: 1
  stderr contains: "Expected 4 from calculate(2)"

Limits:
  timeout: 60 seconds
  output retained per stream: 1048576 bytes
  stdout truncated: false
  stderr truncated: false

Redaction findings: 0
  Removed values are never shown. Redaction reduces risk but does not replace review.

Artifact created.
```

Without `--yes`, the recorder asks three questions in turn: whether the reproduction files are classified correctly, whether the subject files are, and whether to create the artifact. Answering no to any of them writes nothing.

### Failure behavior

- Malformed arguments exit `2`: a missing `--project`, `--output`, or `--image`, an unknown option, or a command that does not start with `node` and have an argument.
- A request with no `--reproduction` path, no `--subject` path, or no expectation exits `1` and writes no artifact.
- An expected output literal that the command did not actually print, within the retained output, exits `1` and writes no artifact.
- A command that cannot start, runs out of time, is ended by a signal, or returns no usable exit code exits `1` and writes no artifact.
- A selected path that is missing, a directory, a symbolic link, larger than the limit, not valid UTF-8, or outside the project exits `1` and writes no artifact.
- An `--output` path that already exists exits `1`; artifacts are never overwritten.
- Content that cannot be redacted safely, or that holds more secrets than an artifact can describe, exits `1`.
- A declined confirmation exits `0` and writes no artifact.

### Security notes

You are authorizing the recorder to run the command on your machine, so read the preview before confirming. Secrets are redacted before the artifact is written, but redaction is rule-based and not a guarantee; see `security-model.md`. Only the files you select are collected. See `recording.md` for the full sequence.

## `validate`

### Purpose

Check that an artifact is well formed without running anything: format, schema, paths, hashes, cross-field rules, and aggregate limits.

### Syntax

```text
proofissue validate <artifact.proofissue> [--json]
```

The artifact path must come first; an option before it is rejected.

### Options

`--json` prints the versioned result as one line of JSON instead of the short text form.

### Example

```text
$ proofissue validate failure.proofissue
valid
```

```text
$ proofissue validate failure.proofissue --json
{"result_schema_version":1,"operation":"validate","status":"valid","artifact_version":1,"artifact_digest":"2dda53efd968eed7e9b2bf8d6fa25c27acbab4927d70c05676e98a44de00fbfa","warnings":[],"errors":[]}
```

`artifact_digest` is the SHA-256 of the file's exact bytes, and `record`, `inspect`, and `replay` report the same value for the same file.

### Failure behavior

An invalid, unreadable, oversized, or missing artifact prints `invalid_artifact` followed by one `Error:` line per problem, and exits `1`. Under `--json`, the same information is in the `errors` list.

```text
$ proofissue validate broken.proofissue
invalid_artifact
Error: must have required property 'environment'
```

### Security notes

Validation never executes the artifact or creates a workspace. A valid artifact is still untrusted: validation says nothing about whether its command is safe to run.

## `inspect`

### Purpose

Validate an artifact and summarize what it contains, without printing file contents or raw output.

### Syntax

```text
proofissue inspect <artifact.proofissue> [--json]
```

### Options

`--json` prints the summary. Without it, `inspect` prints only the status line, `inspected`, so use `--json` to see the contents.

### Example

```text
$ proofissue inspect failure.proofissue --json
```

The result carries an `inspection` object with the runtime and image, the command's program, argument count and working directory, each file's path, role, size and SHA-256, the expectation counts, the limits, and the redaction findings. File contents and expected text are not included.

### Failure behavior

The same as `validate`: an invalid or missing artifact exits `1`.

### Security notes

`inspect` is a static command. It reads the artifact only.

## `replay`

### Purpose

Run the artifact's command in a locked-down container and report whether the captured failure occurred, with the evidence for the decision.

### Syntax

```text
proofissue replay <artifact.proofissue> [--against <directory>]
  [--require-status reproduced|not_reproduced] [--json]
```

### Options

| Option | Meaning |
| --- | --- |
| `--against <directory>` | Current-checkout mode: replace the artifact's declared subject files from the same relative paths under this directory. Undeclared additions, removals, and renames are not evaluated. |
| `--require-status <status>` | Exit `0` only if the replay ends in this classification. The classification itself is unchanged. |
| `--json` | Print the versioned result as one line of JSON. |

### Example

Reproduce the failure from the artifact alone:

```text
proofissue replay failure.proofissue --require-status reproduced
```

After fixing `src/calculate.mjs` in your checkout, confirm the failure is gone:

```text
proofissue replay failure.proofissue --against . --require-status not_reproduced
```

Replay needs Docker Engine 27 or newer on x86-64 Linux with the approved image already present; it never pulls an image. The human-readable results look like this:

```text
Replay result: reproduced
Mode: snapshot
Approved image: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
Termination: exited
Exit code: 1
Output retained: stdout 0 bytes, stderr 36 bytes
Matched: Exit code matched: 1.
Matched: Expected stderr text was present.
Cleanup complete: true
```

```text
Replay result: not_reproduced
Mode: current_checkout
Termination: exited
Exit code: 0
Output retained: stdout 0 bytes, stderr 0 bytes
Different: Expected exit code 1 but received 0.
Substituted subject: calculate.mjs
Scope: Only listed subject paths were substituted; undeclared additions, removals, and renames were not evaluated.
Cleanup complete: true
```

These two blocks are rendered by the CLI's own renderer from the result fixtures in `tests/fixtures/results/v1`, not captured from a live container, so the image digest in the first is a placeholder.

### Result states

| Status | Meaning |
| --- | --- |
| `reproduced` | The command ended as the artifact expected. |
| `not_reproduced` | The command ran and the expectations did not match. Each difference is listed. |
| `execution_failed` | The replay could not complete: no supported engine, the image is missing, a limit was hit, or cleanup failed. This is not evidence about the original failure. |
| `invalid_artifact` | The artifact failed validation. Nothing was executed. |

A process killed for exceeding the memory limit, including one reported only as exit status 137, is `execution_failed`.

### Failure behavior

Exit `1` for `execution_failed`, `invalid_artifact`, or a status other than the one `--require-status` asked for. Exit `2` for malformed arguments. `Ctrl+C` stops the container and removes the workspace before the command returns.

### Security notes

Treat every artifact as hostile. Replay validates it first, accepts only the approved digest-pinned image, and runs it with no network, a read-only base filesystem, dropped capabilities, no privilege escalation, a non-root user, and limits on processes, memory, CPU, output and time, then removes the container and workspace. See `replay.md` and `security-model.md`. The GitHub Action runs the same replay; see `github-action.md`.
