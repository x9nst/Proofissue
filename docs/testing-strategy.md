# Testing Strategy

## Purpose

ProofIssue handles untrusted files and commands, so example-based tests alone are insufficient. This strategy combines ordinary behavior tests with generated inputs, fuzzing, lifecycle fault injection, hostile-output tests, compatibility fixtures, and repeated execution evidence.

The foundation selects `fast-check` for property-based tests. Milestone 2 will evaluate `@jazzer.js/core` for scheduled fuzz targets before adding it as a dependency; retained regression-corpus tests do not depend on the fuzzer being installed. The techniques and acceptance expectations are fixed here independently of a particular runner.

## Test Layers

### Unit tests

Cover pure parsing helpers, schema-related transformations, path rules, hashing, redaction, matching, policy calculation, result formatting data, and error classification.

### Integration tests

Cover application services across package boundaries, recorder process capture, workspace construction, container lifecycle, resource controls, and adapter behavior.

### Security tests

Exercise malicious formats, paths, commands, output, resource consumption, environment access, network access, and cleanup failures described in `threat-model.md`.

### Compatibility tests

Retain at least one valid and representative invalid fixture for every supported artifact version. A compatibility fixture is never rewritten merely to match a new serializer.

### Product workflow tests

Use task-based maintainer sessions from `product-validation.md` to test whether the artifact, file roles, replay modes, limitations, and result explanations are understandable and useful.

## Property-Based Testing

Generated values must remain inside deliberate size bounds so failures are reproducible and shrinking is safe.

Required properties include:

- serializing the same canonical artifact always produces identical bytes;
- parsing a serialized valid canonical artifact yields the same canonical value;
- parse, serialize, and parse preserves file content and hashes;
- accepted paths always remain beneath an assigned root when joined by the production path routine;
- rejected path classes never become accepted through normalization or case changes;
- duplicate and ASCII case-colliding paths are always rejected regardless of order;
- local security policy can only preserve or tighten artifact limits, never weaken them;
- redaction is idempotent for its own replacement markers;
- nonmatching benign text is unchanged by redaction;
- a detected synthetic secret never survives in returned content or finding metadata;
- matching the same bounded execution result twice yields the same classification and explanation;
- changing an independent expectation's order does not change its evidence meaning;
- truncated content cannot satisfy an expectation that depends on discarded bytes.

Every property failure records its minimized input as a permanent regression case when it represents a distinct bug.

## Fuzzing

Fuzz targets accept raw or structured hostile input without invoking commands or containers unless the target is explicitly an isolated runner test.

Initial targets:

- restricted YAML byte input;
- YAML-to-canonical-model conversion;
- semantic path validation and collision detection;
- aggregate size and count validation;
- process-read chunk joining and whole-buffer redaction equivalence;
- UTF-8 decoding across arbitrary retained-byte chunk boundaries;
- control-character escaping and human presentation;
- structured error formatting.

Fuzz expectations:

- no crash or uncaught internal exception;
- no command execution, workspace creation, image operation, or network activity;
- bounded time, memory, output, and error count;
- deterministic handling of a retained failing input;
- no raw synthetic secret in errors or logs.

Short seeded fuzz runs may run on pull requests. Longer campaigns may run on a schedule. Every crash, timeout, excessive-allocation input, or security-relevant discrepancy is reduced and committed to the regression corpus without including real secrets.

## Cleanup Fault Injection

Container and workspace control must be provided through interfaces whose operations can fail independently in tests.

Inject failures at:

- temporary-root allocation;
- workspace directory creation;
- file reconstruction;
- subject-file substitution;
- container creation;
- container start;
- output attachment and collection;
- graceful stop;
- forced kill;
- container removal;
- workspace removal;
- result matching and formatting after execution.

For each injection point, verify:

- cleanup attempts every resource that may have been created;
- cleanup is safe to call more than once;
- a cleanup failure cannot overwrite the original failure without being reported;
- the structured result identifies residual resources without exposing unsafe attacker-controlled text;
- a follow-up bounded cleanup attempt occurs where it is safe;
- no success or reproduction result is emitted when required cleanup is incomplete.

Real container tests must also interrupt replay at controlled lifecycle points and then query for residual labeled containers, networks, volumes, and temporary workspaces.

## Hostile Terminal and Log Output

Test output must include:

- ANSI color and cursor-control sequences;
- terminal title and hyperlink sequences;
- carriage returns and backspaces;
- tabs, NULs, and other control characters;
- bidirectional text controls and misleading direction changes;
- invalid UTF-8 byte sequences;
- extremely long unbroken strings;
- GitHub workflow command and annotation syntax;
- strings resembling ProofIssue headings or structured events.

Verification criteria:

- human output visibly escapes or safely replaces control behavior;
- output cannot create a GitHub workflow command or annotation unless generated by the trusted Action adapter;
- structured JSON remains valid and preserves a safe bounded representation;
- truncation remains explicit;
- redaction occurs before presentation;
- logs cannot be visually confused with trusted lifecycle events.

## Controlled Replay Repeatability

Container execution is measured as controlled and repeatable under supported conditions, not declared deterministic.

A repeated-run record includes:

- artifact digest;
- approved image digest;
- effective resource policy;
- runner and container-engine version;
- host operating system and architecture class;
- classification and expected evidence from each run.

The technical prototype requires five consecutive runs with the same classification and expected evidence under one documented environment. The initial supported Node.js workflow expands this evidence across supported environments and real projects.

## Coverage Is Not the Completion Claim

Line or branch coverage may identify untested code, but milestone completion depends on demonstrated invariants, attack rejection, containment, cleanup, compatibility, and product workflows. Security-critical branches require direct evidence even when overall coverage is high.

## Evidence Retention

Tests and evaluations retain:

- minimal regression inputs;
- compatibility fixtures;
- synthetic-secret assertions;
- repeatability summaries;
- anonymized product-research findings;
- documented skipped platform tests and their reason.

No evidence file may contain a real credential, private repository content, username, hostname, or local absolute path.
