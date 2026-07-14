# ProofIssue Implementation Plan

## Purpose

This document turns the product roadmap in `MILESTONES.md` into a dependency-ordered delivery plan. It is the day-to-day source of truth for what is being built, how completion is measured, and what evidence supports each milestone.

The long-term phases remain in `MILESTONES.md`. This plan covers the path through the initial supported Node.js workflow.

## Scope Terminology

These labels describe different completion claims and must not be used interchangeably:

- **Technical prototype slice:** the dependency-free, one-command proof completed by Milestones 2-5. It validates the core architecture but is not general Node.js project support.
- **Initial supported Node.js workflow:** the outcome of Milestone 7, with an accepted dependency strategy, GitHub Actions, security and compatibility coverage, documentation, and real-project evidence.
- **Roadmap Phase 1 product:** the broader phase in `MILESTONES.md`. It is complete only when every Phase 1 deliverable, completion criterion, and success metric there is satisfied.

Completing the technical prototype does not complete the initial supported workflow or roadmap Phase 1. Completing this implementation plan does not automatically complete roadmap Phase 1 if broader commitments remain.

## Status Legend

- `Planned`: work has not started
- `In Progress`: active work is underway
- `Blocked`: progress requires an explicit decision or outside dependency
- `Complete`: every acceptance criterion has evidence

## Current Status

| Milestone | Status | Depends on | Evidence |
| --- | --- | --- | --- |
| 0. Product and security contracts | Complete | None | Decision, architecture, artifact, recording, replay, security, and threat-model documents; acceptance review below |
| 1. Repository foundation | Complete | Milestone 0 | Apache License 2.0 selected; local checks and hosted Linux and Windows CI pass; see `docs/milestone-1-evidence.md` |
| 2. Static artifact core | Planned | Milestone 1 | Schema fixtures and deterministic serialization tests |
| 3. Recorder and redaction | Planned | Milestone 2 | Recording, minimal collection, and secret-leakage tests |
| 4. Locked-down replay and matching | Planned | Milestones 2-3 | Repeated replay and container security tests |
| 5. Fix verification | Planned | Milestone 4 | Original and corrected-source end-to-end fixture |
| 6. GitHub Actions integration | Planned | Milestone 5 | Passing fixture workflow and stable outputs |
| 7. Initial supported Node.js workflow | Planned | Milestone 6 | Progressive real-project trials, compatibility suite, and security suite |
| Early maintainer validation track | In Progress | Runs alongside Milestones 1-7 | Task-based artifact, role, replay, and demand research in `docs/product-validation.md` |

## Early Maintainer Validation Track

Product demand and workflow comprehension are tested alongside implementation, not only at the end. The gates, tasks, pass conditions, and findings log are defined in `docs/product-validation.md`.

- [ ] Before Milestone 2 interfaces are frozen, at least three maintainers review the mock artifact, inspection concept, and result language.
- [ ] Before recorder CLI wording is frozen, at least five maintainers complete file-role and replay-mode tasks.
- [ ] During the technical prototype, at least two maintainers use a guided working workflow.
- [ ] Real-project trials begin as soon as the dependency strategy permits and are reviewed in small batches.

These checks can change terminology, preview content, and prioritization without expanding version 1. Repeated evidence that the workflow is not valuable should pause further hardening for product review.

## Technical Prototype Slice

The technical prototype slice is one dependency-free Node.js failure:

1. A reporter runs one explicit Node.js command.
2. The recorder captures its exit code, standard output, and standard error in memory with hard size limits.
3. The reporter explicitly selects reproduction files and subject files.
4. Redaction runs before a `.proofissue` file is written.
5. The artifact can be inspected and validated without execution.
6. Replay runs inside a network-disabled, resource-bounded Linux container.
7. Matching checks an exact exit code and a literal output fragment.
8. Snapshot replay reproduces the original failure.
9. Replay against an explicitly selected current checkout substitutes only subject files and shows that a corrected implementation no longer reproduces the failure.

The prototype intentionally excludes dependency installation, shell syntax, binary files, regular-expression matching, output normalization, automatic repository collection, issue comments, and a graphical report. It must not be described as stable support for typical Node.js projects.

## Milestone 0 — Product and Security Contracts

**Status:** Complete

**Target outcome:**

The first implementation can begin without inventing public behavior or security rules during coding.

**Scope:**

- version 1 artifact container and data model
- record, inspect, validate, snapshot replay, and current-checkout replay behavior
- file roles and minimal collection rules
- replay result states and command exit behavior
- container image, network, filesystem, process, CPU, memory, and timeout policy
- artifact, output, and file limits
- secret-handling behavior
- dependency-installation boundary
- threat actors, trust boundaries, rejection rules, and containment rules

**Out of scope:**

- executable schema and TypeScript types
- CLI implementation
- container execution
- dependency installation during replay
- binary fixture support
- cryptographic signing or identity

**Acceptance criteria:**

- [x] Every proposed version 1 artifact field has a stated purpose, validation rule, and limit.
- [x] Snapshot replay and current-checkout fix verification are both illustrated.
- [x] Malicious artifact examples have a defined rejection or containment response.
- [x] CLI and CI meanings for `reproduced`, `not_reproduced`, `invalid_artifact`, and `execution_failed` are explicit.
- [x] Image trust, network, filesystem, resource, cleanup, redaction, and logging policies are explicit.
- [x] The offline dependency-installation conflict is resolved for the technical prototype slice.
- [x] No high-priority ambiguity listed in the version 1 decision record remains implicit.

**Required evidence:**

- `docs/decisions/0001-version-1-contracts.md`
- `docs/architecture.md`
- `docs/artifact-format.md`
- `docs/recording.md`
- `docs/replay.md`
- `docs/security-model.md`
- `docs/threat-model.md`
- `docs/testing-strategy.md`
- `docs/product-validation.md`
- `docs/maintainer-review-packet.md`
- a completed acceptance review recorded in this file

**Acceptance review — 2026-07-14:**

| Criterion | Evidence |
| --- | --- |
| Fields, validation, and limits | `docs/artifact-format.md` documents every version 1 mapping and the document-level limits. |
| Both replay workflows | `docs/replay.md` defines and illustrates snapshot and current-checkout replay. |
| Malicious input behavior | `docs/threat-model.md` maps concrete attacks to rejection, containment, or detection. |
| Result and automation meanings | `docs/decisions/0001-version-1-contracts.md` and `docs/replay.md` define four states and required-status behavior. |
| Security policies | `docs/security-model.md` defines image, network, filesystem, resource, cleanup, redaction, and logging controls. |
| Dependency conflict | Version 1 runs a dependency-free Node.js example with no setup and no network. A broader dependency strategy is explicitly deferred. |
| Ambiguities | The accepted decision record closes artifact, command, file-role, replay, matching, image, network, result, secret, and limit decisions; deferred features are explicitly out of scope. |

Milestone 0 is complete as a design milestone. These are reviewed contracts, not yet executable guarantees. Each later milestone must prove its portion with tests.

**Post-review amendments — 2026-07-14:**

- separated the technical prototype, initial supported Node.js workflow, and roadmap Phase 1 product claims;
- added a shared application-service boundary for CLI and GitHub Action use cases;
- documented that current-checkout replay covers declared existing subject paths only;
- made file-role labels subject to task-based maintainer validation before CLI freeze;
- limited deterministic claims to defined algorithms and described container execution as controlled and repeatable;
- added property-based testing, fuzzing, cleanup fault injection, and hostile terminal-output testing.

These amendments clarify and strengthen the accepted contracts without broadening the technical prototype.

## Milestone 1 — Repository Foundation

**Status:** Complete

**Target outcome:**

A contributor can obtain the repository and run the same basic quality checks as CI.

**Deliverables:**

- repository initialization and ignore rules
- npm workspace rooted at the repository
- strict TypeScript configuration
- package boundaries for schema, neutral contracts, bounded output handling, redactor, matcher, recorder, runner, application services, CLI, report UI, and Action adapters
- formatting, linting, type checking, unit testing, and build commands
- Linux CI for all required checks
- Windows CI for non-container behavior
- contribution guide, license, code of conduct, and issue/pull-request templates

**Acceptance criteria:**

- [x] A clean checkout installs from a lockfile.
- [x] Format checking, linting, type checking, tests, and builds pass locally and in CI.
- [x] Strict TypeScript is enabled and `any` is not allowed by project convention.
- [x] Package dependency direction matches `docs/architecture.md`.
- [x] CLI and Action entry points both depend on the shared application layer rather than coordinating replay independently.
- [x] Supported Node.js, npm, Docker, and operating-system expectations are documented.
- [x] Generated files, local paths, credentials, and test secrets are excluded.

Local and hosted verification evidence is recorded in `docs/milestone-1-evidence.md`. The owner selected Apache License 2.0 on 2026-07-14, and the foundation workflow passed on the pinned Linux and Windows runners.

**Verification:**

Run the clean installation, formatting, linting, type-checking, test, and build commands on a Linux CI runner. Run all non-container checks on Windows as well.

## Milestone 2 — Static Artifact Core

**Status:** Planned

**Target outcome:**

ProofIssue can safely read, validate, inspect, and deterministically write version 1 artifacts without executing them.

**Deliverables:**

- canonical TypeScript model
- version 1 JSON Schema
- bounded YAML parser
- deterministic YAML serializer
- file-content hashing
- `validate` and `inspect` application services
- version 1 compatibility fixtures
- property-based tests for canonical serialization, path rules, and semantic invariants
- a reusable fuzz corpus for restricted YAML parsing and canonical conversion

**Acceptance criteria:**

- [ ] Valid fixtures pass schema and semantic validation.
- [ ] Unknown fields, duplicate paths, absolute paths, traversal paths, invalid hashes, invalid limits, malformed YAML, aliases, and oversized content are rejected.
- [ ] Validation performs no command execution and creates no workspace.
- [ ] Identical canonical input produces byte-for-byte identical output.
- [ ] Inspection reports redaction metadata and never reveals removed values.
- [ ] A permanent version 1 compatibility fixture is tested.
- [ ] Property-based tests preserve round-trip and path-safety invariants across generated bounded inputs.
- [ ] Parser fuzzing fails safely under byte, depth, node, and time limits without execution or unbounded errors.

## Milestone 3 — Recorder and Redaction

**Status:** Planned

**Target outcome:**

A reporter can create a safe, reviewable artifact from one failing command and an explicit file list.

**Deliverables:**

- argument-vector command execution without a shell
- bounded stdout and stderr capture
- exit-code and runtime metadata capture
- explicit reproduction and subject file selection
- path and file-type checks
- secret detection and replacement
- artifact preview and interactive confirmation
- explicit noninteractive confirmation for automation
- task-tested file-role preview and help text

**Acceptance criteria:**

- [ ] stdout, stderr, and exit code are captured separately.
- [ ] Only explicitly selected regular files are collected.
- [ ] Paths outside the selected project, symbolic links, special files, and oversized inputs are rejected.
- [ ] Representative credentials do not appear in artifacts, logs, snapshots, or terminal summaries.
- [ ] Canceling confirmation writes no artifact.
- [ ] Every emitted artifact passes Milestone 2 validation.
- [ ] Redaction and bounded-output tests vary stream chunk boundaries so split secrets cannot bypass detection.
- [ ] The file-role terminology and preview meet Gate B in `docs/product-validation.md` before CLI wording is declared stable.

## Milestone 4 — Locked-Down Replay and Basic Matching

**Status:** Planned

**Target outcome:**

A valid artifact can reproduce its captured failure in a locked-down Linux container with an explainable result.

**Deliverables:**

- approved, digest-pinned Node.js image policy
- temporary isolated workspace
- non-root container execution
- disabled networking
- read-only base filesystem
- dropped capabilities and no-new-privileges policy
- CPU, memory, process-count, output, and wall-clock limits
- reliable timeout termination and cleanup
- exact exit-code and literal stdout/stderr substring matching
- structured execution events and replay result
- shared replay application service used by every adapter

**Acceptance criteria:**

- [ ] The dependency-free example produces the same classification and expected evidence five consecutive times under documented supported conditions.
- [ ] Network-access attempts fail.
- [ ] CPU, memory, process-count, output, and timeout limits are demonstrated by tests.
- [ ] The container cannot read host files outside its temporary workspace.
- [ ] Invalid artifacts never start a container.
- [ ] Interrupted and timed-out runs leave no container or workspace behind.
- [ ] Results explain every matched and mismatched expectation.
- [ ] Cleanup fault injection covers failures during container start, stop, kill, removal, workspace creation, and workspace removal.
- [ ] Terminal-control-sequence tests prove that hostile output cannot alter terminal structure or CI annotations.

## Milestone 5 — Fix Verification

**Status:** Planned

**Target outcome:**

The same artifact can reproduce the original snapshot and test corrected contents for the artifact's explicitly declared, existing subject paths.

**Deliverables:**

- snapshot replay mode
- current-checkout replay mode
- subject-file substitution using only manifest paths
- status and evidence formatting for original and corrected cases
- a visible declared-path limitation summary

**Acceptance criteria:**

- [ ] Snapshot replay reports `reproduced`.
- [ ] Replay against the corrected subject file reports `not_reproduced`.
- [ ] Reproduction files remain byte-for-byte identical in both modes.
- [ ] Only declared subject paths are read from the current checkout.
- [ ] Missing, escaping, symbolic-link, and changed-type subject paths fail safely.
- [ ] Results list every substituted subject path and state that undeclared additions, removals, and renames were not evaluated.
- [ ] Fixtures prove that new files are ignored and removed or renamed declared subject files fail safely rather than being treated as a complete fix verdict.
- [ ] Machine output distinguishes all four version 1 result states.

## Milestone 6 — GitHub Actions Integration

**Status:** Planned

**Target outcome:**

Repositories can validate and replay artifacts in GitHub Actions using the same core implementation as the local CLI.

**Deliverables:**

- Action definition and bundled entry point
- artifact path, replay mode, and required-status inputs
- structured status and evidence outputs
- concise workflow summary
- documented minimal permissions

**Acceptance criteria:**

- [ ] A fixture workflow validates and replays on a Linux runner.
- [ ] The Action can require either `reproduced` or `not_reproduced`.
- [ ] Structured outputs are usable by later workflow steps.
- [ ] Workflow summaries do not dump raw potentially sensitive output.
- [ ] Core replay behavior is not duplicated inside the Action.

Issue and pull-request comments remain optional and are not required for this milestone.

## Milestone 7 — Initial Supported Node.js Workflow

**Status:** Planned

**Target outcome:**

The first documented Node.js workflow is reliable enough to support within its stated project and dependency boundaries. This milestone does not complete roadmap Phase 1 unless the broader roadmap criteria also pass.

**Deliverables:**

- documented output normalization
- exact and normalized matching
- safely bounded regular-expression matching
- agreed offline or explicitly controlled dependency setup
- complete CLI and security documentation
- security, integration, and compatibility suites
- real-project evaluation report
- progressive maintainer-validation findings rather than end-loaded evaluation only

**Acceptance criteria:**

- [ ] At least ten real Node.js failures are tested across three external repositories.
- [ ] At least 90% of supported artifacts replay consistently across repeated runs.
- [ ] No known credential leakage exists in fixtures or logs.
- [ ] Path traversal, symbolic-link escape, environment leakage, command injection, oversized input, process exhaustion, timeout, and network tests pass.
- [ ] Every command documents purpose, syntax, examples, failures, and relevant security behavior.
- [ ] All supported version 1 fixtures remain compatible.

## Dependency Order

Work should proceed in this order:

```text
Contracts and threat model
        ↓
Repository foundation
        ↓
Static artifact validation
        ↓
Recording and redaction
        ↓
Locked-down replay and matching
        ↓
Current-code fix verification
        ↓
GitHub Actions
        ↓
Real-project hardening
```

Schema, redaction, and matching tests may proceed independently after the foundation exists. Replay must not begin before static validation and the security baseline are implemented.

## Milestone Update Rules

When a milestone changes status:

1. update the status table and milestone section;
2. link concrete evidence such as tests, fixtures, demonstrations, or measurements;
3. record any changed public or security decision;
4. document known limitations rather than silently carrying them forward;
5. update `MILESTONES.md` when the corresponding product phase changes status.
