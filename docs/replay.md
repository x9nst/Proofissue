# Replay

## Purpose

Replay validates an artifact, reconstructs only its declared workspace, runs one command in an isolated Linux container, and explains whether the captured failure occurred.

## Static Commands

`proofissue validate failure.proofissue` checks format, schema, paths, hashes, cross-field rules, and aggregate limits. It performs no execution and creates no replay workspace.

`proofissue inspect failure.proofissue --json` performs the same validation and then returns a summary of the command, environment, file roles, expectations, limits, and redaction findings. It does not include full file content or raw captured output. Without `--json`, `inspect` prints its status line and a readable summary of the same facts. See `cli.md`.

## Snapshot Replay

An artifact that carries `dependency` files (a `package.json` and `package-lock.json`) needs its packages prepared first, because replay never has a network. The runner takes the prepared store as an input, checks the whole store read-only before it creates anything, mounts it into the container read-only, and installs the locked packages inside the sandbox with `npm ci --offline --ignore-scripts` before it starts the command. Without a complete store the result is `execution_failed` with `dependencies_not_prepared`, and no container is created. Prepare the store with `proofissue prepare`, then pass the same directory to replay with `--dependency-store` (the GitHub Action: `action/prepare`, then the `dependency-store` input). See `dependencies.md` and `decisions/0002-dependency-strategy.md`.

```text
proofissue prepare failure.proofissue --dependency-store .proofissue-store
proofissue replay failure.proofissue --dependency-store .proofissue-store
```

For an artifact without dependency files, no preparation is needed and `--dependency-store` is ignored:

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
12. Match the bounded result against the artifact expectations. An expectation that lists normalization rules is compared against the normalized redacted output, using the fixed replay directories `/workspace` and `/tmp`. A `regex` expectation is searched with the bounded engine, which runs in time proportional to the output and stops with `regex_step_limit` after a fixed number of steps.
13. Return a structured classification with evidence.

Cleanup runs even when matching or result formatting fails.

## Result States

### `reproduced`

Execution completed and every expected exit-code and output condition matched. Evidence lists each match.

### `not_reproduced`

Execution completed but one or more expectations differed. Differences show the expected exit code, actual exit code, missing literal evidence, the first position at which an exact comparison differed, a pattern that did not match or ran into its step limit, truncation, and other bounded facts needed to understand the result.

Each explanation says which comparison was made and, for a normalized one, which rules changed the replay output, in counts only. For example:

```text
Matched: Normalized replay stderr matched the expected output exactly; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.
Different: Normalized replay stderr differed from the expected output at line 1, column 1 (expected 76 characters, received 0); normalization changed nothing in the replay output.
```

A pattern expectation is explained the same way, without the pattern:

```text
Matched: Normalized replay stderr matched the expected pattern; normalization changed 2 line endings, 2 terminal escape sequences, 1 path, and 1 duration in the replay output.
Different: Normalized replay stderr did not match the expected pattern; normalization changed nothing in the replay output.
Different: The stderr pattern could not be evaluated within the deterministic limit of 20000000 steps.
```

A pattern that reaches the step limit is a result that could not be established, like truncated output, and classifies as `not_reproduced`. `--require-status not_reproduced` can therefore pass for it.

Normalization cannot see a change confined to what it replaces. A fix that only changes a duration, a process ID, or a Node.js internal line number would go unnoticed by a normalized expectation, so a raw literal is the right choice for a number that is the point of the bug. See `output-matching.md`.

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
- a single temporary workspace mount whose host path is validated before it is placed in the mount specification;
- container creation with image pulling disabled;
- no engine-side retention of container output;
- no core dumps and a bounded open-file limit;
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

The runner exposes only a freshly created input directory as a read-only mount. Before the artifact command starts, a fixed trusted container bootstrap copies those declared files into a 64 MiB in-memory workspace and then replaces itself with the exact `node` argument vector. Artifact arguments are positional values and are never interpolated as shell text. The command's environment is exactly `PATH=/usr/local/bin:/usr/bin:/bin` and `HOME=/tmp`, with nothing inherited from the host, and it cannot write to the base filesystem. The container's one runner-owned init process is added outside the artifact's declared process budget so the effective artifact limit remains accurate.

### Home and temporary directories

Replay runs as the numeric user 65532, which has no account entry in the approved image. Recording runs as your own account. Three Node.js calls show the difference:

| Call             | Recording on Linux or macOS | Replay                               |
| ---------------- | --------------------------- | ------------------------------------ |
| `os.homedir()`   | your home directory         | `/tmp`                               |
| `os.tmpdir()`    | `/tmp`                      | `/tmp`                               |
| `os.userInfo()`  | your account                | throws `ERR_SYSTEM_ERROR` (`ENOENT`) |

Without `HOME`, Node.js looks the home directory up in the account database, finds no entry, and throws from `os.homedir()`. A reproduction that reads the home directory, directly or through a configuration loader, would then replay a different failure from the one it recorded, so replay sets `HOME=/tmp`.

`/tmp` is a 16 MiB in-memory directory, separate from the workspace, where files cannot be executed. The command could already write there, so `HOME` adds no access. It only tells programs where to keep caches and settings, which then share the 16 MiB and are discarded with the container. A home path a replayed program prints is a `/tmp` path, so normalized output shows it as `<tmp>`. For an artifact with dependency files, `/tmp` also holds the files the install wrote there, including its log.

Apart from those install files, the home directory starts empty. Nothing from your own home directory is recorded, so a reproduction that depends on a file there, such as `~/.npmrc` or a tool's settings, does not find it during replay. `os.userInfo()` cannot be answered without an account entry and still throws, so a reproduction that calls it does not replay the recorded failure.

## Dependency Boundary

An artifact without dependency files is replayed with no setup step. An artifact with dependency files is replayed in two separate steps. `proofissue prepare` downloads the locked packages from the public npm registry on the host, verifies each against its integrity hash, and keeps them in a store directory you choose; it is the only step that uses the network. Replay then mounts that store read-only and installs from it inside the sandbox with `npm ci --offline --ignore-scripts`, with no network. Replay never downloads anything, runs lifecycle scripts, builds images, or falls back to the network, and a missing or incomplete store is `execution_failed` with `dependencies_not_prepared`, never a reproduction result.

The supported boundary (public registry, lockfile version 3, no install scripts or native addons) and its measured limits are described in `dependencies.md`.

## Failure Behavior

Replay fails before execution if the artifact is invalid, the image is unapproved or unavailable, local policy is stricter than the artifact without acknowledgment, or current-checkout replacement files are unsafe.

Replay reports `execution_failed` if container execution cannot be completed safely. It must not retry with weaker isolation.
