# ProofIssue Pre–Milestone 2 Readiness Review

## Purpose

This document records the remaining issues, decisions, corrections, and validation work that should be completed or explicitly tracked before Milestone 2 — **Static Artifact Core** — begins.

The project is ready to start Milestone 1. The items below are intended to prevent avoidable redesign during Milestone 2 and later implementation. They do not require expanding the technical prototype slice.

## Readiness Status

**Milestone 1 may begin immediately.**

**Milestone 2 should not be treated as interface-stable until the required items in this document are resolved.**

## Implementation response — 2026-07-14

Milestone 1 is in progress. This review was treated as an implementation gate, not only as background reading.

| Review concern | Current response | Readiness effect |
| --- | --- | --- |
| Process-output semantics | The byte-limit, UTF-8, replacement-character, byte-order-mark, truncation, and discarded-byte rules are fixed in `output-handling.md`. Pure shared code and boundary tests live in `packages/process-output`. | Resolved for Milestone 2 entry. |
| Redaction buffering | Version 1 uses whole-buffer redaction after bounded capture. Streaming redaction is explicitly deferred. | Resolved for Milestone 2 entry. |
| Neutral ownership | `packages/contracts` owns declarative result and evidence types. `packages/application` owns use-case sequencing. CLI and Action are adapters. | Resolved for Milestone 2 entry. |
| Supported execution environment | `supported-environments.md` records the foundation toolchain and a provisional, fail-closed Docker support matrix for replay work. | Resolved as a documented baseline; runtime capability checks remain later work. |
| Machine-readable results | `result-contract.md` defines a versioned, adapter-neutral draft envelope and required-status policy. Detailed process output is not part of the public envelope. | Resolved for implementation; remains provisional until exercised. |
| Documentation consistency | `AGENTS.md`, architecture, milestone terminology, current-checkout limits, matching scope, and Action responsibilities were reconciled. | Resolved; ongoing checks still apply. |
| Artifact input/output rules | `artifact-io-contract.md` fixes parser limits, deterministic serialization rules, bounded errors, and no-overwrite atomic-write behavior. | Resolved as the Milestone 2 implementation contract. |
| Maintainer demand test | Separate participant and facilitator packets plus a session record now support Gate A. Artifact presentation remains explicitly provisional until sessions occur. | Tracked and intentionally open; does not block foundation work. |
| Repository license | The repository owner must select a license; no legal choice is inferred by implementation work. | Open Milestone 1 acceptance item. |
| CI evidence | Linux and Windows workflows are configured. A remote run is still required before Milestone 1 can be marked complete. | Open Milestone 1 acceptance item. |

The original checklist below remains the audit snapshot. This response records the implementation disposition without rewriting the review's original findings.

The highest-risk unresolved areas are:

1. process-output byte and text semantics;
2. redaction buffering behavior;
3. ownership of execution and operation-result contracts;
4. supported container-engine and host environments;
5. the stable machine-readable result envelope;
6. consistency between `AGENTS.md` and the accepted design documents;
7. completion of early maintainer Gate A or an explicit decision to keep presentation interfaces provisional.

---

# 1. Process Output: Byte, Text, Decoding, and Truncation Semantics

## Problem

Selected artifact files are explicitly UTF-8, but a recorded or replayed process can emit arbitrary bytes. The current design does not fully define how raw stdout and stderr become the text used for:

- redaction;
- matching;
- preview output;
- human-readable replay reports;
- structured JSON output;
- truncation decisions.

Without a fixed rule, the recorder, runner, redactor, matcher, CLI, and tests may implement incompatible behavior.

## Decisions required

Define all of the following:

- whether stdout and stderr are captured initially as raw bytes or strings;
- whether byte limits are enforced before or after decoding;
- how invalid UTF-8 is decoded;
- whether truncation may split a multibyte UTF-8 sequence;
- how a partial final code point is represented;
- whether matching operates on bytes or decoded text;
- whether redaction operates on bytes or decoded text;
- how invalid byte sequences appear in human and JSON output;
- whether decoding behavior is identical during recording and replay;
- whether stdout and stderr decoding errors are warnings, metadata, or execution failures.

## Recommended technical-prototype rule

Use this rule unless implementation testing proves it unsuitable:

> Capture stdout and stderr as raw bounded byte streams. Apply stream limits to raw bytes. Continue draining and discarding bytes after the retention limit so the child cannot block. After execution, decode retained bytes as UTF-8, replacing invalid sequences with U+FFFD. Redaction and matching operate on the decoded bounded text. Truncation and decoding replacement are recorded explicitly and independently.

## Required documentation updates

Update:

- `docs/decisions/0001-version-1-contracts.md`;
- `docs/recording.md`;
- `docs/replay.md`;
- `docs/testing-strategy.md`;
- the future structured-result specification.

## Required tests

Add cases for:

- valid multibyte text split across process-read chunks;
- invalid UTF-8;
- a byte limit cutting through a multibyte sequence;
- very long output with safe continued draining;
- different invalid byte sequences yielding stable safe output;
- matching after decoding replacement;
- redaction adjacent to invalid byte sequences;
- separate stdout and stderr decoding metadata.

## Completion evidence

- accepted written rule;
- unit fixtures for decoding and truncation;
- shared decoder used by recorder and runner;
- no adapter-specific decoding behavior.

---

# 2. Redaction Buffering and Chunk-Boundary Contract

## Problem

The design says output is retained in bounded memory and redacted before serialization or presentation. The testing strategy also refers to secrets split across arbitrary chunks. This can accidentally imply a streaming redactor even if the intended implementation is whole-buffer redaction.

A streaming redactor is substantially harder because patterns can span chunks and replacement decisions may require overlap or delayed output.

## Decision required

Choose one explicit model for the technical prototype.

### Option A — Whole-buffer redaction

- retain bounded raw output bytes;
- decode after execution;
- redact the complete bounded decoded string once;
- pipe-read chunk boundaries have no semantic meaning.

### Option B — Streaming redaction

- redact while bytes or text chunks are arriving;
- preserve enough overlap or state to detect split secrets;
- define delayed emission and truncation interactions;
- prove that no raw output reaches logs or presentation before redaction.

## Recommendation

Use **whole-buffer redaction** for the technical prototype. It is consistent with the existing bounded-memory design and avoids unnecessary complexity.

## Required document correction

If whole-buffer redaction is selected, change tests described as “redaction across arbitrary stream chunk boundaries” to distinguish:

- process-read chunking, which must not affect the final joined buffer;
- UTF-8 decoder chunk boundaries;
- secret placement near the retention limit;
- secret placement near truncation;
- multiple and overlapping detections in the final bounded text.

## Required tests

- join process output chunks before redaction;
- same output split into different chunks produces identical redaction;
- secrets at buffer start and end;
- secrets adjacent to truncation;
- multiple secrets and overlapping candidate patterns;
- replacement markers are idempotent;
- raw synthetic credentials do not survive in findings, errors, logs, snapshots, or JSON output.

## Completion evidence

- selected model recorded in the version-1 decision record;
- redactor interface reflects the selected model;
- tests no longer imply unsupported streaming guarantees.

---

# 3. Ownership of Execution and Public Result Contracts

## Problem

The matcher consumes a bounded execution result, while the runner produces it. That result contains runtime concepts that do not belong in the artifact schema:

- stdout and stderr;
- exit code or signal;
- truncation state;
- termination reason;
- duration;
- effective limits;
- cleanup state;
- container lifecycle facts.

Allowing the matcher to import runner-owned types couples pure logic to a side-effect package. Putting those types into `artifact-schema` gives the schema package responsibility for unrelated runtime contracts.

## Decision required

Select a neutral owner for shared execution, evidence, error, and operation-result types.

## Recommendation

Add a small package:

```text
packages/contracts
```

Suggested ownership:

```text
artifact-schema
  Owns artifact canonical models, schemas, validation types, and version compatibility.

contracts
  Owns execution results, match evidence, public operation outcomes,
  typed errors, warnings, effective policy summaries, and stable result envelopes.

runner
  Produces bounded execution results defined in contracts.

matcher
  Consumes bounded execution results and produces match evidence defined in contracts.

application
  Coordinates lower-level packages and returns adapter-neutral operation outcomes.
```

## Guardrails

`packages/contracts` must remain small and declarative. It must not contain:

- parser logic;
- filesystem operations;
- container operations;
- CLI formatting;
- GitHub-specific fields;
- application orchestration.

## Required architecture updates

Update:

- package list;
- dependency-direction diagram;
- Milestone 1 deliverables;
- `AGENTS.md` repository structure;
- TypeScript project references.

## Completion evidence

- dependency graph accepted;
- no runner-to-matcher or matcher-to-runner dependency;
- CLI and Action depend on application services, not lower-level orchestration packages directly;
- contract package contains no side effects.

---

# 4. Supported Container Engine and Host Matrix

## Problem

The project defines strong isolation requirements but does not yet state exactly which container engine and host combinations the technical prototype supports.

Controls can differ across:

- Docker Engine on Linux;
- Docker Desktop on macOS;
- Docker Desktop on Windows;
- rootless Docker;
- Podman;
- remote Docker contexts;
- x86-64 and ARM64 hosts.

Resource limits, process limits, filesystem semantics, networking, read-only filesystems, and cleanup behavior may not be identical.

## Decisions required

Define the technical prototype support matrix:

- supported container engine;
- minimum engine version;
- CLI invocation versus engine API;
- supported host operating system for replay;
- supported CPU architecture;
- rootful versus rootless support;
- local versus remote engine support;
- behavior when a security control is unavailable;
- whether Docker Desktop environments are supported or experimental.

## Recommended initial support claim

A conservative first claim is:

> The technical prototype supports Docker Engine on an x86-64 Linux host. Recording may run on Windows, macOS, or Linux. Other replay hosts and engines are experimental until separately tested and documented.

This can be broadened later with evidence.

## Required behavior

Before replay, the runner should perform a capability check for required controls. If a mandatory control is unsupported, replay must fail before container creation or execution. It must never silently weaken isolation.

## Required tests

- supported engine/version detection;
- unsupported or unavailable engine;
- missing required capabilities;
- image architecture mismatch;
- remote context behavior if remote contexts are disallowed;
- cleanup and resource enforcement on every claimed supported environment.

## Completion evidence

- support matrix documented;
- CI environment selected to match the support claim;
- unsupported environments receive clear typed errors;
- documentation does not imply broader support than tests prove.

---

# 5. Machine-Readable Operation Result Envelope

## Problem

Structured JSON is intended to be the stable automation interface, but the top-level schema has not yet been defined. Delaying this decision risks incompatible return types across application services, CLI output, GitHub Action outputs, and fixtures.

## Decision required

Define a versioned, adapter-neutral result envelope before implementing stable application-service interfaces.

## Recommended baseline

```ts
type OperationResult = {
  result_schema_version: 1;
  operation: "record" | "validate" | "inspect" | "replay";
  status: string;
  artifact_version?: 1;
  artifact_digest?: string;
  warnings: Warning[];
  errors: ProofIssueError[];
};
```

Replay should additionally define stable fields such as:

```ts
type ReplayOperationResult = OperationResult & {
  operation: "replay";
  status:
    | "reproduced"
    | "not_reproduced"
    | "invalid_artifact"
    | "execution_failed";
  mode: "snapshot" | "current_checkout";
  image_digest?: string;
  effective_limits?: EffectiveLimits;
  execution?: BoundedExecutionSummary;
  evidence: MatchEvidence[];
  differences: Difference[];
  substituted_paths: string[];
  scope_limitations: ScopeLimitation[];
  cleanup?: CleanupSummary;
};
```

## Design rules

- version the result schema independently from the artifact schema;
- keep public operation results separate from internal lifecycle events;
- do not expose raw command output by default in the stable envelope;
- bound every attacker-controlled string and list;
- use typed error codes rather than only free-form messages;
- represent truncation explicitly;
- represent effective local policy explicitly;
- represent cleanup failure without losing the original error;
- keep GitHub-specific fields out of the core result schema;
- make human output a rendering of the same outcome, not a separate source of truth.

## Required tests

- JSON Schema or equivalent validation for result fixtures;
- stable valid fixtures for each replay status;
- bounded error and warning arrays;
- hostile text remains safely encoded;
- human and JSON renderings reflect the same classification;
- required-status policy does not mutate the underlying classification.

## Completion evidence

- accepted result schema draft;
- result types owned by the neutral contracts layer;
- CLI and Action adapters consume the same application outcome.

---

# 6. Bring `AGENTS.md` into Alignment

## Problem

`AGENTS.md` still contains stale examples and responsibilities that conflict with the accepted prototype documents. Since coding agents and contributors may rely on it directly, these inconsistencies could produce incorrect implementation decisions.

## Required corrections

### 6.1 Remove or replace the stale artifact example

The current example includes concepts that do not match the accepted technical-prototype schema, including:

- a mutable image tag;
- setup commands;
- shell-style `run` fields;
- noncanonical file inclusion;
- different environment layout.

Replace the example with a link to `docs/artifact-format.md`, or copy the accepted version-1 example exactly. Linking is safer because it avoids duplicated schema documentation.

### 6.2 Correct runner dependency-installation responsibility

Replace any unconditional statement that the runner owns dependency installation with:

> The runner may eventually coordinate an accepted dependency setup mechanism. The technical prototype performs no dependency installation.

### 6.3 Correct Action comment responsibilities

Issue and pull-request comments are deferred and optional. The Action’s current responsibilities should be limited to:

- validate;
- replay;
- produce structured outputs;
- produce a concise workflow summary;
- apply required-status policy through application services.

### 6.4 Separate matcher scopes

Distinguish:

- technical prototype: exact exit code and literal stdout/stderr containment;
- initial supported Node.js workflow: exact, normalized, substring, and safely bounded regex as accepted;
- later phases: exception type, stack location, and richer structured evidence.

### 6.5 Replace unconditional “safe to share” language

Use language such as:

> designed for inspection and review before sharing

or:

> designed to reduce accidental secret exposure before sharing

Redaction is defense in depth, not a guarantee.

### 6.6 Correct the “First Milestone” section

The current section combines technical prototype behavior with GitHub Actions. Split it into:

- technical prototype completion;
- initial supported Node.js workflow completion.

## Completion evidence

- no direct contradiction between `AGENTS.md` and accepted design documents;
- schema details have a single primary source;
- package responsibilities match architecture;
- scope terminology is used consistently.

---

# 7. Reconcile Roadmap Phase 1 Dependency and Setup Language

## Problem

Phase 1 currently lists setup commands as a deliverable, while the dependency strategy remains deliberately undecided. The accepted contract allows either:

- an offline dependency representation; or
- a separately authorized and constrained setup phase.

Unconditionally requiring setup commands prejudges the deferred design.

## Required correction

Change the Phase 1 deliverable from unconditional setup commands to language such as:

> an accepted dependency representation and, if applicable, explicit bounded setup steps

## Required follow-up decision before the initial supported Node.js workflow

The eventual dependency design must define:

- package-manager support;
- lockfile requirements;
- lifecycle-script behavior;
- network authorization;
- cache or bundle provenance;
- setup isolation;
- setup resource limits;
- setup output redaction;
- setup failure classification;
- compatibility impact on artifact version 1.

This dependency decision does not block Milestone 2, but the roadmap wording should not imply that one option is already selected.

---

# 8. Maintainer Review Packet Safety and Research Administration

## Problem

The maintainer review packet intentionally reverses file roles in one task. This is useful research design, but the intentionally incorrect example could be copied later as real documentation.

## Required changes

- mark the facilitator version prominently:

```text
INTENTIONALLY INCORRECT CLASSIFICATION — RESEARCH TASK ONLY
DO NOT REUSE AS PRODUCT DOCUMENTATION
```

- create a separate participant-facing packet without facilitator notes or the answer key;
- record the packet version used in each research session;
- do not count participants exposed to the answer key as successful task completions;
- keep intentionally incorrect examples out of general product documentation.

## Completion evidence

- separate participant and facilitator files;
- versioned session template;
- no ambiguous mock example in public implementation guidance.

---

# 9. Add Explicit Product-Validation Failure and Pause Criteria

## Problem

The validation plan has strong pass conditions but lacks equally explicit failure triggers. Without them, weak evidence may be rationalized rather than causing a product review.

## Recommended failure triggers

Trigger a documented product review if any of the following occur:

- fewer than two of five maintainers identify a recent bug where the workflow would have saved meaningful effort;
- fewer than two of five would ask a reporter to use the workflow;
- most participants refuse local, CI, or disposable-environment replay even after inspection;
- role classification remains below the Gate B target after two terminology revisions;
- participants consistently judge artifact creation harder than preparing a minimal repository;
- maintainers understand the workflow but cannot identify a practical adoption path;
- trust information requested by multiple participants cannot be presented clearly without exposing excessive complexity.

## Possible outcomes of the review

- adjust terminology or preview design;
- narrow the target audience;
- change the reporter workflow;
- reposition the product around CI or maintainer-created artifacts;
- modify milestone priorities;
- pause hardening;
- stop the project if the core workflow shows insufficient value.

## Completion evidence

- failure triggers included in `docs/product-validation.md`;
- each gate records both pass and fail outcomes;
- roadmap decisions cite actual research evidence.

---

# 10. Compare ProofIssue Directly with Existing Alternatives

## Problem

Evidence that maintainers understand or like ProofIssue is insufficient. The workflow must show comparative advantage over existing ways to provide reproductions.

## Alternatives to compare

- minimal Git repository;
- failing test pull request;
- Dockerfile or container image;
- standalone reproduction script;
- hosted browser or code sandbox where applicable;
- detailed issue template with logs and environment data.

## Required research questions

Add questions such as:

- For your recent bug, would you prefer asking for a ProofIssue artifact or a minimal repository?
- Which approach requires less reporter effort?
- Which approach requires less maintainer effort?
- Which is easier to inspect before execution?
- Which would you trust more?
- Which would you retain as a regression case?
- Under what conditions would the artifact be clearly better?
- Under what conditions would a normal repository remain better?

## Suggested metrics

- time to prepare the reproduction;
- time to inspect it;
- time to reproduce successfully;
- number of follow-up questions;
- willingness to replay;
- likelihood of reuse after the fix;
- repeated use by the same maintainer.

## Completion evidence

- comparative questions added to the research plan;
- findings record alternatives considered;
- product claims are based on comparative evidence, not enthusiasm alone.

---

# 11. Gate A Before Milestone 2 Interface Freeze

## Problem

The product-validation plan requires early maintainer review before schema and inspection presentation are frozen. No sessions have yet been completed.

## Required action

Before treating Milestone 2 presentation interfaces as stable:

- run Gate A with at least three Node.js maintainers from at least two projects;
- record comprehension errors, trust concerns, missing inspection information, and demand evidence;
- update terminology and inspection-summary requirements where repeated problems appear.

## Allowed alternative

Milestone 2 implementation may begin before Gate A is complete only if:

- the canonical schema remains explicitly provisional;
- human inspection layout remains provisional;
- CLI wording remains provisional;
- no public compatibility promise is made;
- likely research-driven changes are kept inexpensive.

## Completion evidence

- Gate A findings log populated;
- decisions linked to findings;
- no claim that product terminology is validated before evidence exists.

---

# 12. Additional Implementation Contracts Worth Resolving During Milestone 1

These items are lower risk than the previous sections but should be decided before their affected code becomes stable.

## 12.1 Error taxonomy

Define stable top-level error categories and codes for:

- malformed input;
- unsupported artifact version;
- schema violation;
- semantic violation;
- policy rejection;
- unsafe checkout file;
- image unavailable;
- engine unavailable;
- container creation failure;
- timeout;
- resource termination;
- cleanup failure;
- record command failure;
- atomic write failure.

Errors should be typed, bounded, safe to display, and usable in automation.

## 12.2 Validation limits

Convert document statements into exact constants for:

- maximum YAML depth;
- maximum YAML node count;
- maximum scalar size;
- maximum validation errors returned;
- maximum error-message length;
- maximum path count and aggregate text retained in errors.

The current documents require these limits but do not assign every exact number.

## 12.3 Deterministic serializer specification

Define:

- field order;
- indentation;
- line ending;
- scalar style selection;
- quoting rules;
- final newline;
- empty-list and empty-map representation;
- multiline string behavior;
- handling of trailing newlines in embedded files.

Store golden byte fixtures before the serializer is treated as compatible.

## 12.4 Atomic write behavior

Define:

- exclusive creation versus overwrite behavior;
- temporary-file location;
- permissions;
- fsync expectations where supported;
- rename behavior across filesystems;
- cleanup after failed writes;
- Windows-specific behavior;
- treatment of pre-existing output paths and symlinks.

## 12.5 Image preparation workflow

Although image acquisition is separate from replay, define at least the expected future boundary now:

- replay never pulls automatically;
- image preparation is explicit;
- requested digest and registry are shown;
- the digest is verified;
- local approval is recorded or determined by policy;
- artifact input alone cannot approve an image.

The exact command can remain deferred.

---

# 13. Items That Do Not Block Milestone 2

The following can remain deferred and should not be used to expand Milestone 2:

- normal npm dependency installation;
- package-manager cache transport;
- regular-expression implementation details;
- normalized-output rules beyond documenting the deferral;
- structured exception or stack matching;
- binary file support;
- file-role expansion beyond the accepted two-role schema;
- manifest evolution for added, removed, or renamed subject files;
- multi-command workflows;
- browser or service workflows;
- additional runtimes;
- artifact signing or identity;
- GitHub issue and pull-request comments;
- hosted execution;
- an open extension namespace;
- general Podman or multi-engine support unless included in the selected prototype support matrix.

---

# 14. Recommended Pre–Milestone 2 Checklist

## Required before Milestone 2 is interface-stable

- [ ] Process-output byte capture and UTF-8 decoding semantics are accepted.
- [ ] Truncation semantics are accepted and tested in design fixtures.
- [ ] Whole-buffer or streaming redaction is explicitly selected.
- [ ] Redaction chunk-boundary tests match the selected design.
- [ ] Shared execution and public-result contract ownership is accepted.
- [ ] Architecture and package structure reflect that ownership.
- [ ] Technical-prototype container engine and host support matrix is documented.
- [ ] Required engine capability-check behavior is documented.
- [ ] Versioned machine-readable result envelope is drafted.
- [ ] Error taxonomy is drafted.
- [ ] `AGENTS.md` is aligned with accepted contracts.
- [ ] Phase 1 dependency/setup wording no longer prejudges the deferred design.
- [ ] Maintainer participant and facilitator packets are separated.
- [ ] Product-validation failure and pause criteria are added.
- [ ] Comparative-alternative questions are added to product validation.
- [ ] Gate A is completed, or all affected interfaces remain explicitly provisional.
- [ ] Exact parser depth, node, scalar, and error-count limits are selected.
- [ ] Deterministic serializer rules are written precisely enough for golden fixtures.
- [ ] Atomic artifact-write behavior is specified.

## Recommended during Milestone 1

- [ ] Add `packages/contracts` or document the selected alternative.
- [ ] Configure TypeScript project references to enforce dependency direction.
- [ ] Add a dependency-cycle check to CI.
- [ ] Create initial valid and invalid artifact fixtures.
- [ ] Create stable operation-result fixtures for all four replay statuses.
- [ ] Select property-testing and fuzzing libraries.
- [ ] Establish a synthetic-secret fixture policy.
- [ ] Establish a regression-corpus directory and retention rules.
- [ ] Document the exact Linux CI environment used for prototype replay.

---

# 15. Definition of Ready for Milestone 2

Milestone 2 is ready to begin when:

1. repository tooling and package boundaries exist;
2. the artifact schema remains the sole authority for artifact fields;
3. process-output semantics no longer require package-specific guesses;
4. redaction buffering behavior is explicit;
5. shared execution and result types have a neutral owner;
6. the supported replay environment is bounded and documented;
7. stable machine-output shape has a versioned draft;
8. stale guidance in `AGENTS.md` has been removed;
9. early maintainer feedback has either been incorporated or affected presentation interfaces remain explicitly provisional;
10. exact parser and serializer rules are sufficient to create compatibility fixtures.

## Final recommendation

Begin Milestone 1 now. Treat the issues in Sections 1–7 and 11 as the primary pre–Milestone 2 work. The remaining sections improve product validation, documentation integrity, and implementation discipline without broadening the technical prototype.

The project does not need another major architectural redesign before construction. It needs these remaining contracts made explicit so the static artifact core becomes a stable foundation rather than an accidental source of future compatibility debt.
