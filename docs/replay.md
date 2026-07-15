# Replay

## Purpose

Replay validates an artifact, reconstructs only its declared workspace, runs one command in an isolated Linux container, and explains whether the captured failure occurred.

## Static Commands

`proofissue validate failure.proofissue` checks format, schema, paths, hashes, cross-field rules, and aggregate limits. It performs no execution and creates no replay workspace.

`proofissue inspect failure.proofissue` performs the same validation and then shows a human-readable summary of the command, environment, file roles, expectations, limits, and redaction findings. It does not print full file content or raw captured output by default.

## Snapshot Replay

```text
proofissue replay failure.proofissue
```

Snapshot replay reconstructs every file from the artifact. Its purpose is to prove that the captured failure is portable.

Use `--json` for the versioned machine-readable result. Use `--require-status reproduced` or `--require-status not_reproduced` when the command's process success must require one classification. The underlying classification is unchanged by this process policy.

## Current-Checkout Replay

```text
proofissue replay failure.proofissue --against .
```

Current-checkout replay reconstructs reproduction files from the artifact and substitutes each subject file from the identical relative path under the selected checkout. It does not copy or inspect undeclared checkout files.

This mode tests whether the declared current implementation files still produce the captured failure while keeping the original reproduction fixed.

### Exact limitation

Current-checkout replay is a declared-path substitution, not a general comparison with the whole checkout.

- A newly added path is not visible because it was not declared and embedded when the artifact was recorded.
- A removed declared subject file is missing and causes replay preparation to fail.
- A renamed declared subject file appears as a missing old path and causes replay preparation to fail.
- Undeclared dependency, configuration, generated, or implementation changes remain at their embedded artifact versions.

Therefore, `not_reproduced` means that the captured failure was absent under the substitutions ProofIssue actually performed. It does not prove that every part of the current checkout was evaluated or that a multi-file structural fix is fully represented.

Human and structured results must list all substituted subject paths and state this limitation. Fixes that add, remove, or rename required files need a newly recorded artifact or a future explicit manifest-evolution feature; version 1 must not silently read extra checkout files to make them work.

## Replay Sequence

1. Perform complete static artifact validation.
2. Apply local image and resource policy.
3. If current-checkout mode is selected, resolve and validate every declared subject replacement without following symbolic links.
4. Create a uniquely named temporary workspace.
5. Write only validated artifact content and approved subject replacements into that workspace.
6. Verify embedded files against their artifact hashes; compute and record hashes for intentionally changed subject replacements.
7. Create a container with the security settings in `security-model.md`.
8. Start the one declared process with separate arguments and a clean environment.
9. Capture bounded raw stdout and stderr bytes, drain discarded bytes, decode retained buffers with the shared UTF-8 rules, redact whole decoded buffers, and record exit code, termination reason, duration, and structured lifecycle events.
10. Stop or kill the container when execution finishes, exceeds a limit, or is interrupted.
11. Remove the container and temporary workspace.
12. Match the bounded result against the artifact expectations.
13. Return a structured classification with evidence.

Cleanup runs even when matching or result formatting fails.

## Result States

### `reproduced`

Execution completed and every expected exit-code and output condition matched. Evidence lists each match.

### `not_reproduced`

Execution completed but one or more expectations differed. Differences show the expected exit code, actual exit code, missing literal evidence, truncation, and other bounded facts needed to understand the result.

In current-checkout mode, this classification is limited to the declared subject substitutions listed in the result. It is not a verdict on undeclared checkout changes.

### `invalid_artifact`

Static artifact validation failed. No workspace or container may have been created.

### `execution_failed`

ProofIssue could not complete replay because of runner availability, image policy, unsafe replacement files, container creation, enforced resource termination, or cleanup failure. It includes a typed, actionable error and never masquerades as a reproduced bug.

## Process Exit Policy

Classification and CI policy are separate:

- invalid artifacts and execution failures always fail the process;
- without a required status, `reproduced` and `not_reproduced` both mean that classification completed;
- `--require-status reproduced` fails unless the artifact reproduced;
- `--require-status not_reproduced` fails unless the original failure no longer reproduced.

Structured JSON output is the stable interface for automation. Human output is an explanation of the same data.

The versioned shape and bounds are defined in `result-contract.md`. Full stdout and stderr are not included by default.

## Version 1 Isolation Baseline

Replay uses:

- an approved image pinned by digest;
- Linux containers only;
- no privileged mode;
- no Docker socket mount;
- no external network;
- a non-root user;
- a read-only base filesystem;
- no added capabilities;
- no-new-privileges enforcement;
- a single temporary workspace mount;
- bounded CPU, memory, process count, output, and wall-clock time;
- a deliberately clean environment;
- unconditional container and workspace cleanup.

The exact container-engine arguments are an implementation detail, but tests must prove every listed outcome.

### Technical prototype support matrix

Replay currently supports a local Docker Engine 27 or newer on an x86-64 Linux host, running Linux amd64 containers with Docker's default seccomp profile. Remote Docker contexts are rejected. Docker Desktop, rootless Docker, Podman, macOS replay hosts, Windows replay hosts, and other architectures are not yet supported claims.

The sole approved prototype image is:

```text
node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6
```

It is the Linux amd64 image digest published for the official `node:24.18.0-bookworm-slim` image. The runner checks that this exact digest is already present and never pulls it. Image preparation is an explicit administrator or CI step.

The runner exposes only a freshly created input directory as a read-only mount. Before the artifact command starts, a trusted Node.js bootstrap copies those declared files into a 64 MiB in-memory workspace. The command receives only a minimal `PATH`, runs without a host shell, and cannot write to the base filesystem.

## Dependency Boundary

The technical prototype runs dependency-free Node.js files and performs no setup step. Replay does not run `npm install`, `npm ci`, lifecycle scripts, image builds, or network fallbacks.

Support for normal package installations remains blocked until an offline or explicitly constrained dependency design is accepted.

## Failure Behavior

Replay fails before execution if the artifact is invalid, the image is unapproved or unavailable, local policy is stricter than the artifact without acknowledgment, or current-checkout replacement files are unsafe.

Replay reports `execution_failed` if container execution cannot be completed safely. It must not retry with weaker isolation.
