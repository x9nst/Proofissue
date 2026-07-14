# Decision 0001: Version 1 Product Contracts

**Status:** Accepted for the technical prototype slice  
**Date:** 2026-07-14

## Context

ProofIssue needs stable behavior for artifacts, commands, replay, and results before public implementation begins. The requirements describe the intended workflow but leave several details open. Implementing those details ad hoc would create compatibility and security problems.

This decision settles the technical prototype slice. Later changes require schema, compatibility, documentation, and migration review.

## Decisions

### Artifact container

Version 1 is one UTF-8 YAML file with the `.proofissue` extension. Selected file contents are embedded in the YAML. It is not a ZIP, tar archive, directory bundle, or executable file.

The initial implementation accepts UTF-8 regular files only. Binary files are unsupported rather than silently transformed.

Reason: a single YAML document is portable and directly inspectable while avoiding archive extraction risks. It also permits a deterministic first implementation.

### Canonical representation

The public file is YAML, but producers and consumers operate on one canonical JSON-compatible data model. The JSON Schema describes that model. YAML parsing must not preserve implementation-specific object types.

Serialization uses a fixed field order, line ending, indentation, scalar style, and final newline. Mapping keys supplied by users are either forbidden or sorted. Identical canonical input must produce identical bytes.

### Recording model

`record` executes one explicit program with a separate argument list. It does not record an interactive shell session and does not interpret pipelines, redirects, substitutions, glob expansion, shell startup files, or aliases.

The working directory must be inside the selected project root. Recording may occur on Windows, macOS, or Linux, but replay is Linux-container-only in version 1.

### File collection

Every collected file is named explicitly. Version 1 does not recursively collect directories and does not follow symbolic links.

Each file has one role:

- `reproduction`: a test, fixture, configuration file, or other input that remains frozen in the artifact;
- `subject`: implementation code embedded for original replay but eligible for exact-path substitution during current-checkout replay.

Paths use normalized, relative, forward-slash form and the portable ASCII character set documented in the threat model. Absolute paths, empty segments, `.` and `..` segments, Windows drive paths, UNC paths, NUL bytes, control characters, exact duplicates, and ASCII case-collisions are invalid.

### Replay modes

Snapshot replay reconstructs every file from the artifact. It demonstrates that the original captured failure is portable.

Current-checkout replay begins from the artifact but replaces each `subject` file with the regular file at the identical relative path under a user-selected checkout. It never reads undeclared checkout paths. Reproduction files remain embedded and unchanged.

Missing, symbolic-link, non-regular, escaping, or oversized replacement files cause execution to fail before a container starts.

This mode cannot represent a fix that requires an undeclared new file, removes a declared subject file, or renames a declared subject path. New files remain invisible; removals and renames make the declared path missing. Results list the paths actually substituted and must not claim that the whole checkout was tested.

### Expectations

The technical prototype supports:

- one exact expected exit code;
- zero or more literal `contains` expectations against stdout or stderr.

At least one output expectation is required for a nonzero failure so that an unrelated failure with the same exit code is less likely to match.

Exact output, normalized output, regular expressions, exception parsing, and stack matching are deferred. New modes must be explicit schema values rather than inferred behavior.

### Result model

Version 1 has four top-level replay results:

- `reproduced`: every configured expectation matched;
- `not_reproduced`: execution completed but one or more expectations did not match;
- `invalid_artifact`: static validation rejected the artifact;
- `execution_failed`: the replay system could not complete the requested execution.

Every result includes evidence or errors. A bare boolean is not a public result.

An unrelated command failure is `not_reproduced` in version 1, with the exit-code and output differences shown. A separate `unrelated_failure` classification is deferred until structured failure evidence exists.

### Command and CI exit behavior

Human-readable output and structured JSON output represent the same result.

The CLI separates classification from policy:

- invalid artifacts and replay-system failures always produce a failing process exit;
- `reproduced` and `not_reproduced` are successful classifications unless the caller supplies a required status;
- `--require-status reproduced` fails unless the failure reproduces;
- `--require-status not_reproduced` fails unless the original failure no longer reproduces.

The GitHub Action exposes the structured status and accepts the same required-status policy. This avoids giving one status two contradictory CI meanings.

### Runtime image

Artifacts declare a logical Node.js runtime requirement and a digest-pinned Linux image identity. A runner applies local policy and rejects unapproved images by default.

Mutable tags alone are invalid for replay. Version 1 does not accept an arbitrary Dockerfile or build instructions from the artifact. The runner does not automatically pull a missing image; image preparation is a separate explicit action.

### Network and dependency installation

Replay networking is always disabled in the technical prototype. No dependency installation is performed. The example uses only files in the artifact and modules built into Node.js.

This deliberately resolves the conflict between `npm ci` and network-disabled replay by narrowing the prototype. The initial supported Node.js workflow must choose and document either an offline dependency bundle or a separately authorized and constrained setup phase before normal npm projects are declared supported.

Network access must never be silently enabled as a fallback.

### Secret handling

Recording captures output in bounded memory, runs redaction, presents a review, and only then writes an artifact. Raw captured output is not written to temporary files or logs.

Selected file contents are scanned before serialization. A replacement is recorded by category and location without recording the original value. Users may cancel artifact creation but may not request that a detected raw secret be saved.

Redaction is defense in depth, not a guarantee. Minimal explicit collection and human inspection remain required.

### Process output and redaction buffering

stdout and stderr are retained as separate bounded raw byte streams. Limits apply before decoding. Bytes beyond the limit are counted and safely drained but not retained. After execution, each retained buffer is decoded once as UTF-8 with invalid sequences replaced by U+FFFD; truncation and decoding replacement are recorded independently.

The technical prototype uses whole-buffer redaction after decoding. Process-read chunk boundaries have no semantic meaning. Matching operates on redacted decoded bounded text. The complete rules and tests are in `../output-handling.md`.

### Shared execution and result contracts

`packages/contracts` owns declarative execution, evidence, warning, error, effective-policy, cleanup, and versioned operation-result types. Runner and matcher share these contracts without depending on each other. Public operation result schema version 1 is independent from artifact version 1 and is specified in `../result-contract.md`.

### Limits

Version 1 fields carry bounded values. Initial implementation constants are:

| Item | Limit |
| --- | ---: |
| Artifact YAML bytes | 5 MiB |
| Collected files | 100 |
| One collected file | 1 MiB |
| Total decoded file content | 4 MiB |
| Command arguments | 128 |
| One argument | 8 KiB |
| Captured stdout | 1 MiB |
| Captured stderr | 1 MiB |
| Writable replay workspace | Fixed 64 MiB local-policy ceiling |
| Setup steps | 0 |
| Replay steps | 1 |
| Timeout | 1-300 seconds; default 60 |
| Memory | 64-2048 MiB; default 512 |
| CPUs | 0.25-2; default 1 |
| Processes | 8-256; default 64 |
| Literal expectations | 16 |
| One expected literal | 8 KiB |

Truncated output cannot satisfy an expectation whose evaluation would require discarded bytes. Truncation is always reported.

These values are public version 1 implementation limits. Changing the schema ranges requires compatibility review; lowering an accepted limit requires migration guidance.

## Deferred Decisions

The following are intentionally deferred and are not implicit version 1 behavior:

- dependency installation and package-manager cache transport;
- binary fixture encoding;
- archive packaging;
- multiple commands or setup steps;
- shell commands;
- regular-expression and normalized matching;
- image extension or custom images;
- artifact signing and reporter identity;
- issue and pull-request comments;
- classification of unrelated failures;
- support for non-Node runtimes.

## Consequences

The technical prototype cannot replay a normal project that requires downloading packages. It can prove the complete capture, validation, isolation, matching, and declared-path fix-verification design using a dependency-free Node.js example.

The artifact schema must include file roles from its first version. Removing them later would break the core fix-verification promise.

The role names are accepted schema terms. Their eventual CLI labels and preview language remain subject to maintainer usability testing before the command interface is declared stable.
