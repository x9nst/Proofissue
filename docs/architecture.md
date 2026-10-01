# Architecture

## Purpose

ProofIssue turns a reported failure into portable evidence that can be inspected without execution and replayed under strict limits. The design separates untrusted data handling, host-side recording, application orchestration, isolated execution, and deterministic matching so each boundary can be tested independently.

## Core Flow

```text
CLI or GitHub Action adapter
            ↓
    Application service
      ↙             ↘
Record workflow   Replay workflow
  ↓                   ↓
Recorder/Redactor   Validator/Policy/Runner
  ↓                   ↓
Artifact writer   Bounded execution result
                          ↓
                       Matcher
                          ↓
              Explained classification
```

Validation occurs before any workspace creation or container execution. Replay does not trust data merely because it was produced by the official recorder.

## Package Boundaries

### `packages/output-rules`

Owns the documented output normalization rules and the exact-directory path contexts the `paths` rule uses. It is a pure package: strings in, strings and replacement counts out, with no filesystem, process, or network access, and every rule is linear in the length of its input.

It exists so that static validation, matching, recording, and the application's self-check all use the same rule names and the same definitions. A normalization rule name has one frozen definition; see `output-matching.md` and `decisions/0003-output-matching-modes.md`.

It depends only on `contracts`, for the rule-name type.

### `packages/artifact-schema`

Owns the versioned canonical model, JSON Schema, bounded YAML parsing, semantic validation, deterministic serialization, file hashes, and compatibility fixtures.

It depends on `output-rules` only, for the normalization rule names and the check that a normalized expectation value is unchanged by its own rules.

### `packages/dependencies`

Owns everything about a project's npm dependencies that happens before replay: validating the lockfile, choosing the packages for the replay platform, downloading them, and keeping verified tarballs in a local store. It is kept apart from the sandboxed runner on purpose, because it is the only part of ProofIssue that uses the network.

Its parts are separated by what they may do. Lockfile validation and platform matching are pure: strings in, typed results out. The fetcher is the only code that makes a network request and is injectable, so everything above it is tested without a network. The store is the only code that writes files. Nothing in this package extracts or executes a package. The package is marked free of side effects so a consumer that needs only validation, such as the recorder and the replay GitHub Action, does not bundle the download code. Only the application layer's prepare use case, and through it the command line and the separate prepare Action, reach the fetcher. See `dependencies.md` and `decisions/0002-dependency-strategy.md`.

### `packages/contracts`

Owns side-effect-free shared execution results, match evidence, public operation outcomes, typed errors, warnings, effective policy summaries, scope limitations, and cleanup summaries.

The public result schema is versioned independently from the artifact schema. This package contains declarations only: no parser, filesystem, container, presentation, GitHub, or orchestration behavior.

### `packages/process-output`

Owns shared byte limits, UTF-8 decoding, truncation metadata, and bounded output capture. Recorder and runner use this package so their output semantics cannot drift.

### `packages/redactor`

Owns deterministic secret-detection rules, replacements, findings, and safe summaries. It must operate on strings and byte-bounded content without performing file or process operations.

It may depend on shared types from `artifact-schema` only when the type is part of the public artifact contract. Detection logic should otherwise remain independent.

### `packages/matcher`

Compares expected evidence with a bounded execution result and returns explicit matches and differences. Each output expectation names a mode (`contains` or `exact`) and optionally the normalization rules applied to the replay output first; the explanation says which rules changed it. It performs no command execution, filesystem access, or container control.

### `packages/recorder`

Runs one user-authorized host command, captures bounded output, reads explicitly selected regular files, gathers allowlisted environment metadata, invokes redaction, constructs the canonical artifact, and requests confirmation before serialization.

For exact and normalized output expectations it derives the stored value from the recording itself, with the host's real project and temporary directories replaced by tokens, and refuses a value that is unsafe to store: a truncated, empty, oversized, or redacted exact stream, a likely secret that normalization reveals, or a path from this computer.

It does not own YAML details or CLI presentation.

### `packages/runner`

Accepts only a validated canonical artifact plus local replay policy. It prepares a temporary workspace, substitutes declared subject files when requested, controls container creation and termination, captures bounded execution events, and guarantees cleanup.

It does not decide whether the failure matched.

### `packages/application`

Owns the product use cases shared by every delivery adapter:

- record and write an artifact, after checking with the matcher that the recording satisfies its own expectations;
- validate an artifact;
- inspect an artifact;
- prepare an artifact's locked npm packages into a verified local store, validating the artifact and lockfile before any request;
- replay an artifact in snapshot or current-checkout mode;
- apply local replay policy;
- invoke matching after bounded execution;
- evaluate an optional required result status;
- return adapter-neutral results and events.

It coordinates the schema, recorder, redactor, runner, and matcher packages through narrow interfaces. It does not parse command-line arguments, call GitHub Actions APIs, print output, or directly implement container mechanics.

This layer is the only place that sequences full use cases. The CLI and Action must not independently re-create validation, policy, replay, matching, or required-status behavior.

### `packages/cli`

Owns command-line parsing, prompts, human-readable formatting, structured JSON formatting, and mapping an application outcome to an operating-system process exit. It delegates every product use case to `packages/application`.

### `action`

Adapts `packages/application` to GitHub Actions inputs, outputs, required-status failure reporting, and workflow summaries. It has two entry points with separate bundles: the replay Action (`action/`) and the prepare Action (`action/prepare/`), so the step that uses the network is a distinct workflow step and the replay bundle carries no download code. It must not contain a second validator, replay coordinator, policy evaluator, runner, or matcher.

### `packages/report-ui`

Renders structured execution and comparison results. It is deferred until the command-line workflow is reliable and is never required for replay.

## Dependency Direction

Allowed dependencies point inward toward pure contracts and rules, then outward through one application boundary:

```text
cli ───────────────┐
action ────────────┴→ application
application ────────→ artifact-schema, contracts, dependencies, matcher, output-rules, process-output, recorder, redactor, runner
recorder ───────────→ artifact-schema, contracts, dependencies, output-rules, process-output, redactor
runner ─────────────→ artifact-schema, contracts, dependencies, process-output
process-output ─────→ contracts
output-rules ───────→ contracts
artifact-schema ────→ output-rules
dependencies ───────→ (none)
matcher ────────────→ contracts, output-rules
report-ui ──────────→ contracts
```

Recorder and runner do not depend on each other. The application layer coordinates use cases and depends on the lower-level packages. CLI and Action adapters depend on the application layer and may share presentation-only utilities. Cyclic package dependencies are prohibited.

## Canonical Data Boundaries

There are three distinct forms:

1. Raw YAML bytes are untrusted input and subject to a byte limit.
2. A parsed value remains untrusted until schema and semantic validation pass.
3. A validated canonical artifact is the only form accepted by recorder serialization, workspace preparation, matcher setup, or replay.

TypeScript types alone do not establish validation.

## Side-Effect Boundaries

Pure behavior includes schema-related transformations, path syntax checks, redaction rules, hashing, matching, error formatting data, and deterministic serialization planning.

Side effects are isolated behind narrow interfaces for command execution, file reads, clock access, temporary workspace creation, and container control. Tests can replace these interfaces without hidden global state.

## Structured Results

Public operations return typed outcomes from `packages/contracts` rather than booleans or thrown strings. Replay results use the four states accepted in the version 1 contract and carry evidence or actionable errors.

Logs are structured operational events. User-facing summaries are derived from results and never serve as the only machine-readable record.

The runner produces a bounded internal execution result from the contracts package. The matcher consumes that result and produces contract-owned evidence without depending on the runner. The application layer removes detailed redacted output from the stable envelope unless an explicitly designed detailed-output mode is requested.

## Determinism and Repeatability

ProofIssue uses **deterministic** only for behavior whose output is fully determined by defined inputs:

- restricted YAML parsing and canonical conversion;
- schema and semantic validation;
- path normalization and collision checks;
- file hashing and deterministic serialization;
- redaction rules for a given bounded input;
- matching and result-policy evaluation for a given bounded execution result;
- effective policy calculation from artifact and local policy.

Container execution is not claimed to be deterministic. ProofIssue makes it **controlled and repeatable under supported conditions** by pinning the image, reconstructing declared files, fixing command arguments, disabling network access, cleaning the environment, and enforcing limits.

The replayed program can still depend on scheduling, clocks, randomness, CPU architecture, kernel behavior, container-engine behavior, or undefined application behavior. Repeated classifications are measured evidence, not a mathematical guarantee. Documentation and user-facing output must not shorten this distinction to an unconditional “deterministic replay” claim.

## Technical Prototype Boundaries

The technical prototype supports one dependency-free Node.js command, UTF-8 files, exact exit-code matching, literal output matching, no setup phase, and no network. It validates the architecture but is not the initial supported Node.js workflow or completion of roadmap Phase 1. Features outside the prototype boundary must not be partially or silently accepted.

## Future Extension Points

Runtime adapters, additional matchers, binary storage, dependency transport, and report renderers can be added behind the existing boundaries. The artifact specification requires separate compatibility review; internal package APIs may evolve until published.
