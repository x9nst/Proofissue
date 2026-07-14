# Recording

## Purpose

Recording creates a minimal, reviewable description of one observed Node.js failure. It is explicit command execution, not a general shell-session recorder.

## First-Slice Workflow

An illustrative command is:

```text
proofissue record \
  --project . \
  --output failure.proofissue \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  -- node test/reproduction.mjs
```

The final CLI spelling and user-facing role labels remain subject to the usability gate in `product-validation.md`; the explicit two-role behavior is fixed by this document.

## Recording Sequence

1. Resolve the selected project root without following an untrusted symbolic link.
2. Validate the explicit reproduction and subject path syntax.
3. Open each selected path relative to the project root and verify it is a bounded regular UTF-8 file, not a symbolic link or special file.
4. Execute the program and argument list directly, without a shell, under the artifact's proposed wall-clock limit.
5. Capture stdout and stderr separately in bounded memory.
6. Record the exit code and minimal allowlisted runtime metadata.
7. Apply redaction to captured output and selected file content.
8. Build the canonical artifact and validate it completely.
9. Show the command, selected paths, expectations, limits, output truncation, and redaction summary.
10. Ask for confirmation.
11. Serialize deterministically to a new artifact using an atomic write.

If any earlier step fails or the user cancels, no artifact is written.

## Authorization Boundary

The user is authorizing the recorder to run the command on the host. The recorder must display or receive that command explicitly. It must not add package installation, shell startup, environment loading, or other hidden commands.

Automated use may provide an explicit noninteractive confirmation flag. Noninteractive mode does not weaken validation, redaction, file limits, or command visibility in structured output.

## Minimal Environment Capture

Version 1 records only:

- host operating-system family;
- host architecture label;
- Node.js version.

It does not collect the username, hostname, home directory, absolute project path, shell history, process list, environment-variable values, npm configuration, Git credentials, or credential files.

The recorded command receives a deliberately defined environment policy during Milestone 3. ProofIssue itself must never enumerate and serialize the host environment.

## File Roles

Reproduction files contain the test or inputs needed to observe the bug. Subject files contain the implementation being tested.

Both roles are embedded so snapshot replay is self-contained. During current-checkout replay, only subject files may be replaced. The preview must group paths by role, explain each role in plain language, and confirm the two groups separately so accidental classification is visible.

Misclassification changes the meaning of fix verification:

- a test or fixture marked as `subject` may be replaced and stop serving as the frozen reproduction;
- implementation code marked as `reproduction` stays frozen at its original broken contents and may make a real fix appear ineffective.

ProofIssue may show examples and warnings but does not silently guess or change a role in version 1. The role names used in the CLI and preview remain provisional until the task-based maintainer research in `product-validation.md` passes.

Version 1 accepts individual file paths only. Directory recursion and glob patterns are deferred because they make minimal collection and review harder.

## Output Capture

stdout and stderr are kept as separate raw byte streams. Each stream has an independent byte limit applied before UTF-8 decoding. When a limit is reached, the recorder stops retaining additional bytes, continues draining and counting discarded bytes so the child cannot block on a full pipe, and marks the capture as truncated. After execution, the retained bytes are joined and decoded once with invalid UTF-8 replaced safely. The command remains subject to its wall-clock limit. If that limit expires, the recorder terminates the process tree and writes no artifact because the observed result is incomplete.

Whole-buffer redaction runs after decoding. Process-read chunk boundaries do not affect redaction. `output-handling.md` is the complete shared recorder and runner contract.

Raw captured output is held in memory only until redaction. It is not written to debug logs, temporary files, crash reports, or snapshots. Terminal summaries show redacted content only.

## Expectations

The observed exit code becomes the proposed exact expectation. A failing artifact also requires at least one explicit literal from stdout or stderr. The user chooses or supplies that literal; ProofIssue does not guess which error text identifies the failure.

The preview explains that volatile values such as temporary paths, timestamps, ports, and random identifiers will make literal matching unstable.

## Redaction Review

The preview shows:

- how many findings occurred;
- each finding category;
- whether it affected stdout, stderr, or a selected path;
- the safe replacement marker;
- whether content or expectations may have changed enough to affect replay.

The original secret is never displayed by the review. If a selected file cannot be safely redacted without invalidating UTF-8 or size rules, recording fails closed.

## Failure Behavior

Recording stops without writing an artifact when:

- the project root or selected path cannot be resolved safely;
- a selected path escapes the project or is not a regular UTF-8 file;
- file, output, argument, or aggregate limits are exceeded incompatibly;
- the command cannot start or has no representable exit result;
- the recording command exceeds its wall-clock limit or cannot be terminated cleanly;
- artifact validation fails;
- atomic output creation fails;
- the user cancels.

Existing output files are not overwritten unless a future explicit overwrite option is designed and confirmed.
