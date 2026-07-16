# MILESTONES.md

## Purpose

This file tracks the planned development of ProofIssue from the first usable prototype to a mature open-source standard for replayable bug reports.

It is intended to answer four questions:

1. What are we building now?
2. What comes next?
3. What must be true before moving to the next phase?
4. What does the project ultimately become?

Milestones should be updated as decisions are made, assumptions are tested, and community feedback changes the roadmap.

Near-term delivery status, acceptance criteria, and evidence are tracked in `IMPLEMENTATION_PLAN.md`. Detailed technical and security documents are indexed in `docs/README.md`.

## Scope Terminology

- **Technical prototype slice:** the dependency-free architectural proof in the implementation plan. It is not a stable support claim.
- **Initial supported Node.js workflow:** the first real-project workflow with a dependency strategy, CI integration, security evidence, and measured compatibility.
- **Roadmap Phase 1 product:** everything promised under Phase 1 below, including all deliverables, completion criteria, and success metrics.

These labels are cumulative but not equivalent. A working prototype does not complete the initial supported workflow, and the initial supported workflow does not complete Phase 1 while broader Phase 1 commitments remain.

---

## Long-Term Product Direction

ProofIssue should become an open, portable, and secure standard for describing, replaying, and verifying software failures.

The final product should allow a bug report to move through this lifecycle:

```text
Failure observed
    ↓
Reproduction recorded
    ↓
Artifact validated
    ↓
Failure replayed safely
    ↓
Maintainer confirms root cause
    ↓
Fix implemented
    ↓
Original failure replayed again
    ↓
Fix verified
    ↓
Artifact retained as a regression case
```

The project should eventually support multiple runtimes, richer failure types, integrations with major code-hosting platforms, artifact minimization, and a broader ecosystem of compatible tools.

The project must remain centered on reproducibility, trust, and safe execution.

---

# Phase 0 — Project Foundation

## Goal

Create the repository structure, contribution rules, technical direction, and security baseline before implementing major functionality.

## Deliverables

- repository initialized
- `AGENTS.md`
- `MILESTONES.md`
- contribution guide
- code of conduct
- license
- issue and pull-request templates
- architecture overview
- security model
- threat model
- package workspace configuration
- TypeScript strict mode
- formatting, linting, testing, and CI setup
- initial artifact schema proposal

## Completion Criteria

- contributors can clone, install, test, and build the project
- repository structure is stable enough for parallel work
- security assumptions are documented
- the first milestone can be implemented without major architectural uncertainty
- CI passes on the supported development environment

## Status

`Complete`

The repository foundation is complete. Product and security contracts, repository tooling, contributor material, Apache License 2.0, strict TypeScript workspaces, executable foundation tests, and pinned Linux and Windows CI are present and verified. Product implementation continues through the milestones in `IMPLEMENTATION_PLAN.md`.

---

# Phase 1 — Minimum Replayable Bug Report

## Goal

Prove the core idea with one narrow, reliable workflow:

> Record a failing Node.js command and replay the same failure inside an isolated Linux container.

## Supported Scope

- Node.js projects
- Linux containers
- terminal commands
- stdout and stderr capture
- exit-code capture
- runtime metadata
- explicit file inclusion
- artifact validation
- controlled, repeatable replay under documented supported conditions
- basic secret redaction
- GitHub Actions integration

## Core User Workflow

```bash
proofissue record
proofissue inspect failure.proofissue
proofissue validate failure.proofissue
proofissue replay failure.proofissue
```

## Deliverables

### CLI

- `proofissue record`
- `proofissue inspect`
- `proofissue validate`
- `proofissue replay`

### Artifact Format

- versioned schema
- YAML serialization
- canonical JSON representation
- environment metadata
- an accepted dependency representation and, if applicable, explicit bounded setup steps
- reproduction steps
- expected exit code
- expected stdout or stderr fragments
- file manifest
- resource limits
- redaction metadata

### Recorder

- command capture
- working-directory capture
- Node.js version detection
- selected file collection
- stdout and stderr capture
- user confirmation before artifact creation

### Runner

- isolated container execution
- disabled network by default
- CPU limit
- memory limit
- timeout
- process limit
- temporary workspace
- cleanup after execution

### Matcher

- exit-code matching
- exact output matching
- normalized output matching
- substring matching
- regular-expression matching

### Redactor

- environment-variable filtering
- API-key pattern detection
- authorization-header masking
- private-key detection
- user review of redacted output

### GitHub Action

- validate artifact
- replay artifact
- expose machine-readable result
- publish a concise workflow summary
- optionally comment on an issue or pull request

### Application Services

- one shared application layer for record, validate, inspect, replay, matching, policy, and required-status behavior
- CLI and GitHub Action adapters that do not independently coordinate core use cases

## Early Product Validation

Maintainer research begins before the CLI and schema presentation are frozen. Mock artifacts, inspection summaries, file-role tasks, replay-mode tasks, and demand interviews are tracked in `docs/product-validation.md`.

Real-project evaluation starts incrementally as soon as the implementation can support it. The success metrics below remain the completion threshold, but learning is not deferred until the end of Phase 1.

## Completion Criteria

A user can:

1. record a failing Node.js test,
2. create a valid `.proofissue` artifact,
3. inspect the artifact before sharing,
4. replay it locally,
5. reproduce the same failure inside a locked-down container,
6. replay it in GitHub Actions,
7. apply a code fix,
8. run the same artifact again,
9. receive a clear result showing that the failure no longer occurs.

## Success Metrics

- at least 10 real Node.js failures reproduced
- at least 3 external repositories tested
- at least 90% of supported example artifacts replay consistently
- no known credential leakage in test fixtures
- supported artifacts produce repeatable classifications and expected evidence across repeated runs under documented conditions

## Status

`Planned`

---

# Phase 2 — Reliable Failure Verification

## Goal

Move beyond “the command failed” and determine whether the replay produced the same underlying failure.

## Main Problem

Two executions can both fail for different reasons.

For example:

```text
Original failure:
AuthenticationError at src/auth.ts:84

Replay failure:
Dependency installation timeout
```

A useful reproduction system must distinguish these cases.

## Deliverables

### Structured Failure Evidence

Capture and compare:

- exception class
- error code
- failing file
- failing line
- stack-frame signatures
- test name
- HTTP status
- assertion message
- normalized output
- process signal
- relevant file diff

### Match Explanation

Replay results should explain:

- what matched
- what differed
- what was ignored during normalization
- why the result was classified as reproduced or not reproduced

### Matching Profiles

Support:

- exact
- normalized
- exception
- test
- HTTP
- custom assertion

### Replay Confidence

A score may be presented only when it is backed by visible evidence.

Example:

```text
Reproduction result: MATCHED

Evidence:
- same exception class
- same test name
- same failing source location
- stderr differs only in temporary paths
```

### Regression Verification

Add a first-class result for:

```text
original failure reproduced
original failure no longer reproduced
new unrelated failure occurred
artifact could not be executed
```

## Completion Criteria

- replay can distinguish same failure from unrelated failure
- every match result includes an explanation
- regression verification is usable in CI
- matcher behavior has strong fixture coverage
- output normalization rules are documented
- custom matching does not bypass sandbox restrictions

## Success Metrics

- at least 25 real failures evaluated
- false-match rate measured and documented
- false-non-match rate measured and documented
- match explanation accepted as useful by external maintainers
- at least 5 real fixes verified through replay

## Status

`Planned`

---

# Phase 3 — Reproduction Minimization

## Goal

Reduce a large reproduction into the smallest artifact that still causes the same failure.

## Main Problem

Real bug reports often include too many files, commands, dependencies, or setup steps.

Large reproductions are:

- slower to inspect
- harder to trust
- more likely to contain secrets
- more expensive to replay
- harder to preserve long term

## Deliverables

### File Minimization

Determine which included files are necessary.

### Step Minimization

Remove setup or reproduction steps that do not affect the failure.

### Environment Minimization

Identify which environment variables and configuration values are relevant.

### Dependency Reduction

Where feasible, identify unnecessary dependencies or lockfile changes.

### Reproduction Stability Check

A minimized artifact must reproduce the same failure multiple times before it is accepted.

### Human Review

Users must be able to inspect and approve the minimized artifact.

## Initial Approach

Start with deterministic reduction techniques:

- delta debugging
- binary elimination
- dependency graph analysis
- repeated replay verification

AI-assisted suggestions may be explored later, but they must not replace deterministic validation.

## Completion Criteria

- minimization can reduce supported example artifacts
- minimized artifacts preserve the same failure evidence
- users can compare original and minimized artifacts
- minimization is bounded by time and resource limits
- secret exposure is reduced rather than increased

## Success Metrics

- median artifact-size reduction measured
- median replay-time reduction measured
- at least 10 real artifacts minimized
- zero accepted minimized artifacts that fail stability checks
- reduction process is explainable

## Status

`Planned`

---

# Phase 4 — Broader Runtime Support

## Goal

Expand beyond Node.js without weakening reliability or security.

## Candidate Runtime Order

1. Python
2. Go
3. Rust
4. Java
5. browser-based JavaScript

The order may change based on community demand and contributor support.

## Runtime Adapter Model

Each runtime should implement a common interface for:

- runtime detection
- dependency installation
- command execution
- error parsing
- stack-trace normalization
- test-framework detection
- artifact metadata
- sandbox image selection

## Deliverables

- runtime adapter specification
- compatibility test suite
- official Python adapter
- official Go adapter
- official Rust adapter
- runtime-specific example artifacts
- runtime-specific security documentation

## Completion Criteria

A new runtime is considered supported only when:

- record and replay work end to end
- common failure formats are parsed
- official fixtures pass consistently
- security behavior matches the core sandbox policy
- CI covers supported runtime versions
- documentation includes a complete example

## Success Metrics

- at least 3 officially supported runtimes
- at least 20 external repositories tested across runtimes
- runtime adapter API remains stable
- third-party adapter feasibility demonstrated

## Status

`Planned`

---

# Phase 5 — Richer Reproduction Types

## Goal

Support failures that cannot be represented by a single terminal command.

## Candidate Reproduction Types

### HTTP and API Failures

Capture:

- requests
- headers with secret redaction
- request bodies
- response status
- response schema
- response body assertions
- service startup dependencies

### Browser Failures

Capture:

- browser version
- page navigation
- user actions
- console errors
- network failures
- screenshots
- DOM assertions

### Multi-Service Failures

Support controlled execution of:

- application service
- database
- cache
- message queue
- test client

### File and Data Processing Failures

Capture:

- input file
- processing command
- output artifact
- expected and actual result

## Guardrails

- browser support must use reproducible automation, not video-only evidence
- multi-service execution must remain resource bounded
- secrets must be redacted before artifacts are persisted
- external network access must remain disabled unless explicitly allowed
- service images must be pinned

## Completion Criteria

- at least one HTTP workflow supported
- at least one browser workflow supported
- at least one multi-service workflow supported
- new reproduction types share the same artifact and evidence model
- security review completed for each execution mode

## Status

`Planned`

---

# Phase 6 — Ecosystem Integrations

## Goal

Make ProofIssue useful inside the tools maintainers already use.

## Planned Integrations

- GitHub Issues
- GitHub Pull Requests
- GitHub Actions
- GitLab Issues
- GitLab CI
- local pre-commit or pre-push workflows
- CI artifact storage
- test-report formats
- issue templates
- repository health dashboards

## Desired Workflow

A repository may require a ProofIssue artifact for certain bug categories.

Example:

```text
Issue opened
    ↓
Artifact automatically validated
    ↓
Replay runs in CI
    ↓
Issue receives reproduction status
    ↓
Maintainer links fix
    ↓
Artifact verifies the fix
```

## Deliverables

- integration API
- GitHub App or maintained Action
- GitLab integration
- status badges
- machine-readable replay result format
- webhook event model
- reusable issue templates

## Completion Criteria

- integrations use the same core runner and matcher
- issue comments remain concise and actionable
- permission requirements are minimal
- artifacts can be stored and retrieved safely
- maintainers can disable automated comments
- integrations do not require a hosted ProofIssue service

## Status

`Planned`

---

# Phase 7 — Open Standard and Third-Party Implementations

## Goal

Separate the artifact standard from the reference implementation so other tools can create and consume ProofIssue-compatible artifacts.

## Deliverables

- formal artifact specification
- conformance requirements
- compatibility test suite
- version negotiation rules
- extension mechanism
- reserved namespaces
- security requirements for compatible runners
- reference fixtures
- parser libraries
- third-party implementation guide

## Compatibility Levels

Possible conformance levels:

```text
Level 1: Artifact validation
Level 2: Static inspection
Level 3: Safe replay
Level 4: Failure matching
Level 5: Fix verification
```

## Governance

Establish:

- enhancement proposal process
- schema change process
- deprecation policy
- release policy
- security disclosure process
- maintainer roles
- compatibility guarantees

## Completion Criteria

- at least one independent artifact producer exists
- at least one independent artifact consumer exists
- conformance tests are publicly available
- specification changes follow a documented proposal process
- artifact extensions do not break core compatibility

## Status

`Planned`

---

# Phase 8 — Maintainer-Scale Workflows

## Goal

Help maintainers handle large volumes of incoming bug reports without turning ProofIssue into a general issue tracker.

## Deliverables

### Reproduction Queue

Classify incoming reports as:

- valid and reproduced
- valid but not reproduced
- invalid artifact
- unsafe artifact
- unsupported environment
- awaiting reporter input

### Deduplication Assistance

Identify artifacts that appear to reproduce the same failure evidence.

### Repository Compatibility Profiles

Allow projects to publish:

- supported runtimes
- supported operating systems
- approved base images
- required setup
- redaction policies
- network policy
- artifact-size limits

### Reproduction Health Metrics

Track:

- reproduction success rate
- median replay time
- common unsupported environments
- common missing evidence
- regression verification rate

## Guardrails

- automated classification must remain reviewable
- deduplication should provide evidence, not silently merge reports
- maintainers retain control over repository policies
- metrics must not expose private artifact contents

## Completion Criteria

- maintainers can process many artifacts consistently
- repository-specific policy is supported
- duplicate suggestions are explainable
- metrics are privacy-conscious
- core local workflow remains fully usable without hosted infrastructure

## Status

`Planned`

---

# Phase 9 — Mature Project State

## Goal

Reach a stable state where ProofIssue is trusted infrastructure rather than an experimental tool.

## Characteristics of the Mature Project

- stable artifact specification
- multiple supported runtimes
- strong sandboxing
- reproducible local and CI execution
- rich but explainable failure matching
- deterministic minimization
- active third-party ecosystem
- clear governance
- long-term artifact compatibility
- independent security review
- broad use by open-source maintainers

## Final Product Position

ProofIssue should not attempt to fix every bug automatically.

Its mature role should be:

> The portable evidence layer between a bug reporter, a maintainer, CI, and the eventual fix.

A successful final state means that attaching a replayable artifact to a bug report becomes as normal as attaching logs or a screenshot is today.

## Indicators of Maturity

- artifact format used outside the reference repository
- independent compatible implementations
- security audits completed
- backward-compatibility policy proven across releases
- documented real-world maintainer impact
- stable release cadence
- healthy contributor community
- project decisions made through open governance

## Status

`Long-term`

---

# Cross-Phase Requirements

These requirements apply to every milestone.

## Security

Every phase must preserve:

- untrusted-input validation
- sandboxed execution
- minimal filesystem access
- network disabled by default
- resource limits
- secret redaction
- explicit trust boundaries
- documented threat analysis

## Compatibility

Every artifact change must consider:

- backward compatibility
- migration path
- schema version
- parser behavior
- runner behavior
- third-party consumers

## Documentation

Every completed feature must include:

- user documentation
- CLI examples
- artifact examples
- failure cases
- security notes
- tests

## Testing Techniques

Testing depth should match the boundary under change. In addition to example-based unit and integration tests, plans must consider:

- property-based testing for canonicalization, paths, limits, and matching invariants;
- fuzzing for parsers, schema conversion, path handling, and redaction chunk boundaries;
- fault injection for process, container, and cleanup lifecycle failures;
- terminal-control-sequence and structured-log injection tests;
- repeated execution under documented supported conditions for replay evidence.

Not every feature needs every technique, but security-sensitive changes must state which techniques apply and why.

## Community

Each phase should create contribution opportunities at multiple difficulty levels:

- documentation
- fixtures
- adapters
- tests
- integrations
- security review
- UI improvements
- core implementation

## Evidence

Milestones should be considered complete based on demonstrated workflows and measured results, not only merged code.

---

# Milestone Tracking Template

Use the following template when adding or updating a milestone.

```markdown
## Milestone Name

**Status:** Planned | In Progress | Blocked | Complete

**Target outcome:**

Describe what users will be able to do.

**Scope:**

- item
- item

**Out of scope:**

- item
- item

**Dependencies:**

- dependency

**Deliverables:**

- deliverable

**Completion criteria:**

- measurable condition

**Risks:**

- risk

**Evidence:**

- tests
- demo
- benchmark
- external usage
```

---

# Current Priority Order

The default execution order is:

```text
Phase 0: Foundation
Phase 1: Minimum replayable bug report
Phase 2: Reliable failure verification
Phase 3: Reproduction minimization
Phase 4: Broader runtime support
Phase 5: Richer reproduction types
Phase 6: Ecosystem integrations
Phase 7: Open standard
Phase 8: Maintainer-scale workflows
Phase 9: Mature project state
```

Phases may overlap when work is independent, but Phase 1 and Phase 2 should be proven before major expansion.

---

# Immediate Next Actions

1. add the GitHub Action integration through the shared application layer
2. expose stable structured Action outputs and required-status behavior
3. choose and document the bounded dependency strategy for normal Node.js projects
4. expand matching only within the accepted initial-workflow scope
5. run progressive trials against real public Node.js failures
6. complete the security and compatibility suites for the supported workflow
7. revise the roadmap based on measured evidence
