# Command Line Reference

ProofIssue installs one executable, `proofissue`, with five commands: `record`, `validate`, `inspect`, `prepare`, and `replay`. Until the package is published, run it from a built checkout:

```text
npm ci
npm run build
node packages/cli/dist/bin.js <command> ...
```

The examples below write `proofissue` for that invocation. They use the project in `examples/failing-node-test`.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The command completed. For `replay`, a classification was reached and any `--require-status` was satisfied. For `record`, an artifact was created or you declined at the confirmation prompt. For `prepare`, the packages were prepared or the artifact needs none. |
| `1` | The command ran but did not succeed: an invalid or missing artifact, a replay that could not complete, a required status that was not met, a preparation that failed, or a recording that failed. |
| `2` | The arguments were malformed. The error, a one-line synopsis, and a pointer to the command's help are printed, and nothing is executed. |

Running `proofissue` with no arguments, or with `--help` or `-h`, prints the usage text and exits `0`; nothing is executed. `proofissue --version` prints the bare version, for example `0.1.0`, and exits `0`; quote it when you report a problem. `proofissue <command> --help` prints only that command's options and also exits `0` (a `-h` is recognized only as the first argument after the command name, and nothing after a `--` separator is read as a ProofIssue option). After an unknown command or malformed arguments, ProofIssue prints `Error: <what is wrong>`, a one-line synopsis, and `Run "proofissue <command> --help" for all options.`, and exits `2` without printing the full help.

A replay that ends in `reproduced` or `not_reproduced` is a successful classification. Which of the two you want is a policy decision, expressed with `--require-status`.

## `record`

### Purpose

Run one Node.js command that fails, and capture a minimal artifact that describes the failure. The recorder runs the command exactly as you give it, with no shell and a minimal environment, then shows what it intends to write and asks you to confirm. The environment is empty on Linux and macOS; on Windows, process creation adds a few names such as `USERNAME` and `TEMP` (see `recording.md`).

### Syntax

```text
proofissue record --reproduction <path> --subject <path>
  [--project <directory>] [--output <file>]
  [--image <repository@sha256:digest>]
  [--expect-stdout <literal>] [--expect-stderr <literal>]
  [--expect-stdout-normalized <text>] [--expect-stderr-normalized <text>]
  [--expect-stdout-regex <pattern>] [--expect-stderr-regex <pattern>]
  [--expect-stdout-exact] [--expect-stderr-exact]
  [--expect-stdout-exact-normalized] [--expect-stderr-exact-normalized]
  [--dependencies] [--yes] [--json] -- node <arguments...>
```

### Options

| Option | Required | Meaning |
| --- | --- | --- |
| `--project <directory>` | no | The project root. Defaults to the current directory. Selected paths are resolved beneath it and symbolic links are refused. |
| `--output <file>` | no | The new artifact. Defaults to `<name of the first --reproduction file>.proofissue.yaml` in the current directory, for example `reproduction.proofissue.yaml`; when that name is taken, `-2` through `-99` is added before the extension, and after that the command asks for `--output`. A name you give is used exactly as written, so `.proofissue` and `.proofissue.yaml` are both valid. An existing file is never overwritten. |
| `--image <repo@sha256:digest>` | no | The replay image. Defaults to the approved Node.js 24 image, the only one replay accepts. Another image is recorded as given, and the preview warns that replay will refuse it. |
| `--reproduction <path>` | at least one | A test, fixture, or input kept exactly as recorded. Repeatable. A leading `./` is removed, and on Windows backslashes become forward slashes, so `.\test\a.mjs` is stored as `test/a.mjs`. |
| `--subject <path>` | at least one | Implementation code that a fix may change, and that `replay --against` can replace. Repeatable. Spelled like `--reproduction`. |
| `--expect-stdout <literal>`, `--expect-stderr <literal>` | at least one expectation overall | A literal substring the failing output must contain, byte for byte. Repeatable. |
| `--expect-stdout-normalized <text>`, `--expect-stderr-normalized <text>` | no | Text as it was printed on your machine. Replay compares after ignoring line endings, terminal escape sequences, trailing whitespace, the project and temporary directories, durations, process IDs, the Node.js version, and Node.js internal line numbers. Repeatable. |
| `--expect-stdout-regex <pattern>`, `--expect-stderr-regex <pattern>` | no | A pattern that must match somewhere in the stream after the same normalization, written against the normalized text (for example `took <duration>` or `<project>/test/a\.mjs:\d+:\d+`). The language is a bounded subset of JavaScript regular expressions that always runs in linear time: no lookaround or backreferences, at most 1024 characters, and a pattern that can match nothing, such as `a*`, is refused. It is checked before the command runs and must match the recording. Repeatable. |
| `--expect-stdout-exact`, `--expect-stderr-exact` | no | A flag, with no value. The whole stream must match exactly. At most one exact option per stream. |
| `--expect-stdout-exact-normalized`, `--expect-stderr-exact-normalized` | no | A flag, with no value. The whole stream must match exactly after the same normalization. At most one exact option per stream, counting the raw one. |
| `--dependencies` | no | Also record `package.json` and `package-lock.json` from the project root, so the locked npm packages can be installed later. Needs lockfile version 3 and the public npm registry. Replay such an artifact only after `prepare`. See `dependencies.md`. |
| `--yes` | no | Approve without prompting. Use only after reviewing the project, command, file roles, expectations, and output path. |
| `--json` | no | Needs `--yes`. Prints one `RecordOperationResult` line on stdout (`created`, `cancelled`, `invalid_input`, or `execution_failed`, with the artifact digest when created) and sends the preview to stderr. The result never contains output text. Without `--yes` it is a usage error, exit `2`. |
| `-- node <arguments...>` | yes | The command. It must start with `node` and have at least one argument. No argument may hold the project or home directory, and on Windows none may spell a project file with backslashes (write `test/a.mjs`); both are refused before anything runs. |

The expected exit code is whatever the recorded command actually returned. The options that take no value derive the expectation from the recording itself, and the preview shows what will be stored. `output-matching.md` defines each normalization rule and the pattern language, and says how to choose between the options.

### Example

The shortest form names the files, the expected text, and the command. The project is the current directory (here `--project` selects the example from the repository root), the image is the approved one, and the artifact is written to `reproduction.proofissue.yaml` in the current directory:

```text
proofissue record \
  --project examples/failing-node-test \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  --yes \
  -- node test/reproduction.mjs
```

The same recording with every default written out is also valid:

```text
proofissue record \
  --project examples/failing-node-test \
  --output reproduction.proofissue.yaml \
  --image node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  --yes \
  -- node test/reproduction.mjs
```

```text
ProofIssue recording preview

Artifact file: reproduction.proofissue.yaml
Replay image: approved Node.js 24 image

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
Saved: reproduction.proofissue.yaml (sha256 2dda53efd968)
To share it, drag the file into a GitHub issue comment: GitHub accepts the .yaml extension.
A maintainer replays it on x86-64 Linux with Docker:
  proofissue replay reproduction.proofissue.yaml
On x86-64 Linux with Docker you can check it yourself first:
  proofissue replay reproduction.proofissue.yaml --require-status reproduced
```

The preview names the file and image. It adds a warning when the image is not the approved one, and when you recorded with a Node.js major other than 24, because replay always uses Node.js 24. After the artifact is written, the output says where it is, the first 12 characters of its SHA-256, how to attach it, and the commands to replay it; for an artifact recorded with `--dependencies` those are `proofissue prepare <file> --dependency-store .proofissue-store` followed by `proofissue replay <file> --dependency-store .proofissue-store`. GitHub refuses attachments ending in `.proofissue`, so when you chose such a name the output says to copy the file to a name ending in `.yaml` before attaching it. The artifact is YAML either way.

With `--json`, stdout holds one line and the preview and these hints are not printed:

```text
{"result_schema_version":1,"operation":"record","status":"created","artifact_version":1,"artifact_digest":"<64 hex characters>","warnings":[],"errors":[]}
```

For a failure whose output changes from run to run, ask for normalized expectations. The stored text has your project and temporary directories replaced by `<project>` and `<tmp>`, so it never holds a path from your machine, and replay in the container matches it. Suppose a project in `/srv/project` has a failing test that prints `checking calculate(2)` on stdout, and on stderr `Expected 4 from calculate(2) (12ms)` followed by the line `at /srv/project/test/reproduction.mjs`:

```text
proofissue record \
  --output failure.proofissue.yaml \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stdout-exact \
  --expect-stderr-normalized "Expected 4 from calculate(2) (12ms)" \
  --expect-stderr-normalized "at /srv/project/test/reproduction.mjs" \
  --yes \
  -- node test/reproduction.mjs
```

The preview shows each expectation's mode and the rules it uses, and the text that will be stored. This block is rendered by the CLI's own renderer for a recording like the one above, not captured from a live run:

```text
Expected failure:
  exit code: 1
  stdout is exactly: "checking calculate(2)\n"
  stderr contains after normalization: "Expected 4 from calculate(2) (<duration>)"
  stderr contains after normalization: "at <project>/test/reproduction.mjs"
  normalization: line endings, terminal escape sequences, trailing whitespace, paths (<project>, <tmp>), Node.js version, Node.js internal locations, process IDs, durations
```

For text that varies in a way the rules do not cover, such as a port or a count, give a pattern instead. It is written against the normalized output and checked before the command runs. This block is also rendered by the CLI's own renderer, for a recording made with `--expect-stdout-exact`, `--expect-stderr-regex 'Expected \d+ from calculate\(\d+\) \(<duration>\)'`, and `--expect-stderr-regex '^ {4}at <project>/test/reproduction\.mjs$'`; the preview prints a pattern with each backslash doubled, as it does for any quoted value:

```text
Expected failure:
  exit code: 1
  stdout is exactly: "checking calculate(2)\n"
  stderr matches pattern after normalization: "Expected \\d+ from calculate\\(\\d+\\) \\(<duration>\\)"
  stderr matches pattern after normalization: "^ {4}at <project>/test/reproduction\\.mjs$"
  normalization: line endings, terminal escape sequences, trailing whitespace, paths (<project>, <tmp>), Node.js version, Node.js internal locations, process IDs, durations
```

Before it writes anything, the application replays the recording's own output against these expectations with the same matcher a replay uses. A recording that does not satisfy its own expectations is refused.

Without `--yes`, the recorder asks three questions in turn: whether the reproduction files are classified correctly, whether the subject files are, and whether to create the artifact. Answering no to any of them writes nothing.

### Failure behavior

- Malformed arguments exit `2` and print the error, a one-line synopsis, and a pointer to `record --help`: an unknown option, a positional argument before `--` (the error says to put the command after `--`), a command that does not start with `node` and have an argument, `--json` without `--yes`, an exact option given twice for the same stream (a raw and a normalized exact option for one stream count as twice), or a default artifact name whose `-2` through `-99` variants all exist.
- A request with no `--reproduction` path, no `--subject` path, or no expectation exits `1` and writes no artifact.
- An expected output literal that the command did not actually print, within the retained output, exits `1` and writes no artifact. A normalized literal must appear in the normalized output. The message says where the text does appear, without repeating it: that it was printed on the other stream (use `--expect-stdout` or `--expect-stderr`), that it matches only after normalization (use the `-normalized` option), that the stream was truncated, and otherwise how many lines each stream printed. Every error is printed, not only the first.
- A command argument that holds the project or home directory exits `1` before the command runs, and so does, on Windows, an argument that spells an existing project file with backslashes. The message gives the argument's position and, for a backslash path, the forward-slash spelling to use; it never repeats a local path.
- A pattern outside the bounded language (lookaround, a backreference, an unknown escape, an unbalanced bracket, a pattern beyond a limit, or one that can match without consuming output) exits `1` before the command runs, and the message names the feature and its position without repeating the pattern. A pattern that does not match the normalized recording exits `1` and writes no artifact.
- An exact expectation for a stream that was truncated, is empty, is larger than 8192 bytes, or contains a redaction marker exits `1`, and the message suggests a normalized literal instead.
- An expected value that holds a likely secret once escape sequences are removed, or that still holds your project or home directory (in a literal or a pattern), exits `1`. The message never repeats the value.
- A command that cannot start, runs out of time, is ended by a signal, or returns no usable exit code exits `1` and writes no artifact.
- A selected path that is missing, a directory, a symbolic link, larger than the limit, not valid UTF-8, or outside the project exits `1` and writes no artifact.
- An `--output` path that already exists exits `1`; artifacts are never overwritten.
- With `--dependencies`, a missing `package.json` or `package-lock.json`, an unsupported lockfile, or a likely secret in either file exits `1` before anything is written. An unsupported lockfile is reported before the command runs.
- Content that cannot be redacted safely, or that holds more secrets than an artifact can describe, exits `1`.
- A declined confirmation exits `0` and writes no artifact.

### Security notes

Recording is not sandboxed. The command runs on your machine with your user's files, processes, and network access; only its wall-clock time and the output ProofIssue retains are bounded, and the whole process tree is ended when the time limit is reached. Record only commands you would run in that shell anyway, and replay the artifact later in the locked-down container. Expected values and patterns are checked for likely secrets, and a value that holds one is refused without being repeated.

You are authorizing the recorder to run the command on your machine, so read the preview before confirming. Secrets are redacted before the artifact is written, but redaction is rule-based and not a guarantee; see `security-model.md`. Only the files you select are collected. Command output reaches the artifact only through your expected literals, which redaction does not check for user names or paths, so leave absolute paths out of them. See `recording.md` for the full sequence.

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

Validation never executes the artifact or creates a workspace. A valid artifact is still untrusted: validation says nothing about whether its command is safe to run. The errors it prints are bounded in number and length, and control characters in them are escaped, so a hostile artifact cannot rewrite your terminal.

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
$ proofissue inspect failure.proofissue
inspected
```

This is real output from `node packages/cli/dist/bin.js inspect tests/fixtures/artifacts/v1/valid/minimal.proofissue --json`, pretty-printed here (the command prints it on one line):

```json
{
  "result_schema_version": 1,
  "operation": "inspect",
  "status": "inspected",
  "artifact_version": 1,
  "artifact_digest": "e30c4eccb623954a5345ab71b57431de2fd11775c50ddf8881f7ee6f302b87b7",
  "warnings": [],
  "errors": [],
  "inspection": {
    "runtime": "node",
    "runtime_version": "24",
    "operating_system": "linux",
    "image": "node@sha256:1111111111111111111111111111111111111111111111111111111111111111",
    "command": {
      "program": "node",
      "argument_count": 1,
      "working_directory": "."
    },
    "files": [
      {
        "path": "calculate.mjs",
        "role": "subject",
        "bytes": 56,
        "sha256": "4efedc1500baf98326c0ec905ce57d08952b86e985598f5dfbc7508262c72b7c"
      },
      {
        "path": "reproduction.mjs",
        "role": "reproduction",
        "bytes": 146,
        "sha256": "3f2b69382a3fb8e0ded1f07b73e7ba06592c1d9bdc82c9235f3f88e132556f3a"
      }
    ],
    "expectations": {
      "exit_code": 1,
      "stdout_count": 0,
      "stderr_count": 1,
      "stdout_expectations": [],
      "stderr_expectations": [
        {
          "mode": "contains",
          "normalize": []
        }
      ]
    },
    "limits": {
      "timeout_seconds": 60,
      "memory_mb": 512,
      "cpus": 1,
      "processes": 64,
      "output_bytes_per_stream": 1048576
    },
    "redaction": {
      "enabled": true,
      "finding_count": 0,
      "findings": []
    }
  }
}
```

The result carries an `inspection` object with the runtime and image, the command's program, argument count and working directory, each file's path, role, size and SHA-256, the expectation counts and, for each expectation, its mode and normalization rules (`stdout_expectations` and `stderr_expectations`, each entry shaped like `{ "mode": "exact", "normalize": [] }`, where an empty list means the raw stream), the limits, and the redaction findings. File contents and expected text are not included.

### Failure behavior

- Malformed arguments (no artifact path, an unknown option) exit `2`, print the error with a one-line synopsis and a pointer to `--help`, and execute nothing.
- An invalid, missing, or oversized artifact exits `1`. Under `--json` the problem is in the `errors` list and there is no `inspection` object:

```text
$ proofissue inspect broken.proofissue --json
{"result_schema_version":1,"operation":"inspect","status":"invalid_artifact","warnings":[],"errors":[{"code":"schema_violation","message":"must have required property 'environment'","details":{"path":"/"}}]}
```

### Security notes

`inspect` is a static command. It reads the artifact only and never executes it or creates a workspace. It shows no file contents, no expected text, and no argument values, only counts, sizes, digests, and modes. Every message it prints is bounded and has control characters escaped.

## `prepare`

### Purpose

Download and verify the npm packages an artifact's lockfile names, so that a later `replay` can install them offline. `prepare` is the only ProofIssue step that makes network requests. It does nothing for an artifact that has no dependency files.

### Syntax

```text
proofissue prepare <artifact.proofissue> --dependency-store <directory> [--json]
```

The artifact path must come first; an option before it is rejected.

### Options

| Option | Required | Meaning |
| --- | --- | --- |
| `--dependency-store <directory>` | yes | Where the verified packages are kept. It is never defaulted and never taken from the artifact. Pass the same directory to `replay`. |
| `--json` | no | Print the versioned result as one line of JSON. |

### Example

```text
$ proofissue prepare failure.proofissue --dependency-store .proofissue-store
Preparation result: prepared
Packages for the replay platform: 3
Tarballs downloaded: 2 (2048 bytes)
Tarballs already in the store: 1
Skipped for another platform: 1
Warning: 1 package declares install scripts, which are never run.
Replay offline with the same --dependency-store.

$ proofissue replay failure.proofissue --dependency-store .proofissue-store --require-status reproduced
```

For an artifact without dependency files:

```text
$ proofissue prepare failure.proofissue --dependency-store .proofissue-store
Preparation result: not_required
The artifact has no dependency files; replay needs no prepared store.
```

Nothing is fetched and the directory is not created in that case, so a workflow can run `prepare` unconditionally.

### Result states

| Status | Meaning |
| --- | --- |
| `prepared` | Every package for the replay platform is in the store and matches its integrity hash. |
| `not_required` | The artifact has no dependency files. Nothing was fetched and no store was created. |
| `invalid_input` | The store directory was empty. |
| `invalid_artifact` | The artifact failed validation, or its lockfile was rejected (`lockfile_rejected`). Nothing was fetched and the store was not touched. |
| `execution_failed` | A download or its verification failed (`dependency_download_failed`), the store location was unsafe or not writable (`dependency_store_unusable`), or the run was cancelled. |

### Failure behavior

- Exit `0` for `prepared` and `not_required`. Exit `1` for `invalid_input`, `invalid_artifact`, and `execution_failed`. Exit `2` for malformed arguments, with nothing executed: no artifact path, a missing `--dependency-store` or value, or an unknown option such as `--against`.
- Each error prints one `Error:` line; when it concerns one package, the `node_modules/...` location follows in parentheses. Package names beyond that location, response bodies, tarball paths, and the store path are never printed.
- A hash mismatch, an oversized or redirected response, a non-success HTTP status, and a timeout each fail the whole preparation and keep nothing from the failing package.
- `Ctrl+C` stops the downloads and reports `execution_failed` with the reason `cancelled`.
- A failed preparation is never a replay result. Replaying without a prepared store reports `dependencies_not_prepared`, and the CLI suggests running `prepare`.

### Security notes

`prepare` contacts only `https://registry.npmjs.org`, and only for the exact tarballs the lockfile names. It sends no credentials, follows no redirects, and applies size and time limits. Nothing is extracted or executed, and install scripts are never run. The artifact and its lockfile are validated before any request is made or any directory is created. The store is written only at the path you give. Use a dedicated directory, never your npm cache: replay mounts the store read-only into the sandbox. A store can be reused; every entry is checked against its hash again before replay. See `dependencies.md` and `security-model.md`.

## `replay`

### Purpose

Run the artifact's command in a locked-down container and report whether the captured failure occurred, with the evidence for the decision.

### Syntax

```text
proofissue replay <artifact.proofissue> [--against <directory>]
  [--dependency-store <directory>]
  [--require-status reproduced|not_reproduced] [--json]
```

### Options

| Option | Meaning |
| --- | --- |
| `--against <directory>` | Current-checkout mode: replace the artifact's declared subject files from the same relative paths under this directory. Undeclared additions, removals, and renames are not evaluated. |
| `--dependency-store <directory>` | The store filled by `prepare`. Needed only for an artifact with dependency files; ignored otherwise. Replay never uses the network. |
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

For an artifact with dependency files, prepare the packages first and pass the same directory to replay:

```text
proofissue prepare failure.proofissue --dependency-store .proofissue-store
proofissue replay failure.proofissue --dependency-store .proofissue-store --require-status reproduced
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

For an artifact with normalized or exact expectations, each line explains the comparison and which rules changed the replay output, in counts only, never in text. This block is rendered from `reproduced-normalized.json`:

```text
Replay result: reproduced
Mode: snapshot
Approved image: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
Termination: exited
Exit code: 1
Output retained: stdout 22 bytes, stderr 89 bytes
Matched: Exit code matched: 1.
Matched: Replay stdout matched the expected output exactly.
Matched: Expected stderr text was present after normalization; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.
Matched: Normalized replay stderr matched the expected output exactly; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.
Cleanup complete: true
```

After a fix, the same artifact explains what no longer holds (rendered from `not-reproduced-output-modes.json`):

```text
Different: Expected exit code 1 but received 0.
Different: Expected stderr text was not present after normalization; normalization changed nothing in the replay output.
Different: Normalized replay stderr differed from the expected output at line 1, column 1 (expected 76 characters, received 0); normalization changed nothing in the replay output.
```

A pattern expectation is explained without the pattern. This block is rendered from `reproduced-regex.json`:

```text
Replay result: reproduced
Mode: snapshot
Approved image: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
Termination: exited
Exit code: 1
Output retained: stdout 22 bytes, stderr 89 bytes
Matched: Exit code matched: 1.
Matched: Replay stdout matched the expected pattern.
Matched: Normalized replay stderr matched the expected pattern; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.
Matched: Normalized replay stderr matched the expected pattern; normalization changed 2 line endings and 1 path in the replay output.
Cleanup complete: true
```

and the differences after a fix, rendered from `not-reproduced-regex.json`, where the last line is a pattern that ran into the deterministic step limit (a result that is never a match):

```text
Different: Expected exit code 1 but received 0.
Different: Normalized replay stderr did not match the expected pattern; normalization changed nothing in the replay output.
Different: The stderr pattern could not be evaluated within the deterministic limit of 20000000 steps.
```

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

An `execution_failed` result carries one error code. None of them is evidence about the original failure. `result-contract.md` defines the full contract.

| Code | Meaning | What to do |
| --- | --- | --- |
| `engine_unavailable` | Docker is not installed, not running, or its context could not be inspected. | Start Docker Engine and run the replay again. |
| `engine_capability_unavailable` | The host is not a local x86-64 Linux Docker Engine 27 or newer with the default seccomp profile, or the Docker context is remote. | Replay on a supported host, such as a GitHub-hosted Ubuntu runner. |
| `image_unavailable` | The approved image is not present locally. Replay never pulls images. | Pull the approved digest yourself, then replay again. |
| `policy_rejection` | The request was refused before any container was created: an image that is not approved, a missing or unneeded `--against` directory, an unsafe workspace location, or a dependency artifact without a lockfile. | Fix the request. Nothing ran. |
| `container_creation_failed` | The container could not be created or completed safely. | Check Docker's health and disk space, then replay again. |
| `unsafe_checkout_file` | With `--against`, a declared subject path is missing, is not a regular file, is a symbolic link or reached through one, is too large, or is not valid UTF-8; or it names a reproduction file. The checkout itself must not be a symbolic link. | Correct the checkout or the artifact. Nothing ran. |
| `dependencies_not_prepared` | The artifact has dependency files and the store is missing, unusable, or incomplete. The CLI suggests the next step. | Run `prepare` with the same `--dependency-store`, then replay. |
| `dependency_install_failed` | The offline install of the locked packages inside the sandbox did not complete. | Re-run `prepare` against a fresh store directory. The message may name one npm error code, such as `ENOSPC`. |
| `timeout` | The replay reached its wall-clock limit, or you interrupted it with `Ctrl+C`. The container was stopped and removed. | Raise the artifact's `timeout_seconds` at record time, or investigate a hang. |
| `resource_termination` | The command was ended by an enforced limit, such as memory, including an exit status of 137. | Treat the limit as part of the reproduction, or record again with an adequate limit. |
| `cleanup_failed` | The replay finished but the container or workspace could not be removed. | Remove the leftover resources named in the result, and check Docker. |
| `internal_error` | An unexpected condition. The message is fixed and carries no details. | Report it with the artifact if it can be shared. |

### Security notes

Treat every artifact as hostile. Replay validates it first, accepts only the approved digest-pinned image, and runs it with no network, a read-only base filesystem, dropped capabilities, no privilege escalation, a non-root user, and limits on processes, memory, CPU, output and time, then removes the container and workspace. Output is redacted for likely secrets before it is matched, and the result and its summaries carry counts and fixed messages, never output text. The Docker CLI is started with an empty environment, and the container receives only `PATH` and `HOME=/tmp`. The input mount is read-only, and `/tmp` is a 16 MiB in-memory filesystem. See `replay.md` and `security-model.md`. The GitHub Action runs the same replay; see `github-action.md`.
