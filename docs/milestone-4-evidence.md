# Milestone 4 Evidence

## Status

Milestone 4 — Locked-Down Replay and Basic Matching is in progress. The implementation, pure matching tests, lifecycle fault injection, shared application path, CLI result handling, and Linux container test job are present. The hosted Linux container job must pass before the milestone is marked complete.

## Implemented workflow

A replay now validates the artifact before any runner call, accepts only the approved Node.js image digest, checks the local Docker host and security profile, reconstructs only declared files, and creates a container with networking disabled, a non-root user, a read-only base filesystem, all capabilities dropped, no-new-privileges, and bounded CPU, memory, process count, output, workspace storage, and elapsed time.

The command runs from a 64 MiB in-memory workspace. The host-side input directory is mounted read-only and removed after the labeled container is removed. Replay output is captured with the same bounded byte rules as recording, redacted before matching, and omitted from the stable result. Matching explains the exact exit-code decision and every literal stdout or stderr decision.

## Current evidence

- Matcher tests distinguish an unrelated failure with the same exit code and report insufficient evidence when output was truncated.
- Runner tests assert the complete Docker security argument set, bounded output, timeout termination, memory-limit classification, structured lifecycle events, and cleanup ordering.
- Fault injection covers container creation, start, stop, kill, removal, and workspace removal. Workspace allocation cleans its own partial directory on reconstruction failure.
- Application tests prove invalid artifacts never invoke the runner and produce the same classification and evidence five consecutive times through a controlled runner.
- CLI tests prove classification and required-status policy remain separate, JSON output stays machine-readable, and terminal controls, bidirectional controls, and GitHub workflow-command syntax are neutralized.
- The Linux container suite checks five real repeated runs, network denial, host-file isolation, non-root execution, zero effective capabilities, absent Docker socket, read-only root, bounded output, process count, workspace storage, CPU/time termination, memory termination, and cleanup.

## Remaining completion evidence

The real container suite is deliberately skipped during ordinary cross-platform unit tests and enabled by `PROOFISSUE_RUN_CONTAINER_TESTS=1`. The hosted `locked-down-replay` job explicitly pulls the approved image before replay, runs this suite on Ubuntu, and checks that no labeled replay container remains. Its passing hosted result is required before checking the Milestone 4 acceptance boxes or calling the milestone complete.

## Security and compatibility impact

The new trust boundary executes validated artifact commands only inside the documented Linux Docker baseline. Artifacts cannot authorize images, network access, extra mounts, root, capabilities, larger resource limits, or image pulls. Cleanup failures prevent a successful classification and report only generic residual resource kinds.

The artifact schema did not change. The provisional replay result envelope is now produced by the shared application service and still omits full stdout and stderr. Snapshot replay is implemented; current-checkout substitution remains Milestone 5 and fails closed if requested through the runner.
