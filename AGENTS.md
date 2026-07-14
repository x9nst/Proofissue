# AGENTS.md

## Project Overview

**ProofIssue** is an open-source tool for creating replayable bug reports.

A normal bug report describes a failure in prose. ProofIssue captures the environment, commands, relevant files, expected behavior, and actual failure in a portable artifact that can be replayed locally or in CI.

The core product promise is:

> Make bug reports executable, verifiable, and reusable as regression checks.

The project should remain focused on deterministic reproduction rather than autonomous debugging or code generation.

---

## Core User Workflow

1. A user encounters a software failure.
2. The user runs `proofissue record`.
3. ProofIssue captures the reproduction steps and relevant environment metadata.
4. ProofIssue creates a portable `.proofissue` artifact.
5. The artifact is attached to a GitHub issue or shared directly.
6. A maintainer runs `proofissue replay <artifact>`.
7. ProofIssue executes the reproduction in an isolated environment.
8. The matcher determines whether the same failure occurred.
9. After a fix, the artifact is replayed again to verify that the original failure no longer occurs.

---

## Initial Scope

The initial supported Node.js workflow should support:

- Node.js projects
- Linux containers
- terminal-command recording
- exit-code assertions
- stdout and stderr matching
- runtime and operating-system metadata
- GitHub Actions integration
- secret redaction
- CPU, memory, network, and execution-time limits

Do not expand the scope until this workflow is reliable.

Out of scope for the initial release:

- autonomous code fixing
- general-purpose AI agents
- vector databases
- browser recording
- desktop GUI applications
- multi-language support
- hosted SaaS infrastructure
- unrestricted network execution

### Scope terminology

Keep these completion claims distinct:

- **Technical prototype slice:** the dependency-free, one-command proof of the architecture. It is not stable Node.js project support.
- **Initial supported Node.js workflow:** the first real-project workflow with an accepted dependency strategy, GitHub Actions, security evidence, documentation, and measured compatibility.
- **Roadmap Phase 1 product:** every deliverable, completion criterion, and success metric listed under Phase 1 in `MILESTONES.md`.

Do not describe completion of the prototype as completion of the supported workflow or Phase 1.

---

## Repository Structure

Use the following structure unless there is a strong technical reason to change it:

```text
proofissue/
├── packages/
│   ├── cli/
│   ├── recorder/
│   ├── runner/
│   ├── matcher/
│   ├── redactor/
│   ├── artifact-schema/
│   ├── contracts/
│   ├── process-output/
│   ├── application/
│   └── report-ui/
├── action/
├── examples/
├── docs/
├── benchmarks/
├── tests/
└── AGENTS.md
```

### Package responsibilities

#### `packages/cli`

Owns the public command-line interface.

Expected commands:

```bash
proofissue record
proofissue replay <artifact>
proofissue inspect <artifact>
proofissue validate <artifact>
```

The CLI should remain thin. It delegates complete product use cases to `packages/application`; specialized business logic remains in the dedicated lower-level packages.

#### `packages/recorder`

Captures:

- executed commands
- working directory
- selected environment metadata
- relevant file changes
- stdout and stderr
- exit codes
- user-defined expectations

The recorder must avoid collecting unrelated files or sensitive data.

#### `packages/runner`

Replays artifacts inside an isolated container or sandbox.

The runner is responsible for:

- image selection
- filesystem setup
- command execution
- resource limits
- network policy
- cleanup
- structured execution events

The runner may eventually coordinate an accepted dependency setup mechanism. The technical prototype performs no dependency installation.

#### `packages/matcher`

Determines whether the replay produced the same failure.

Technical prototype matching modes:

- exact exit-code matching
- substring matching

Initial supported Node.js workflow matching modes may add:

- exact output matching
- normalized stdout and stderr matching
- safely bounded regular-expression matching

Later structured-evidence phases may add exception-type and stack-location matching.

Matching logic must be deterministic and explainable.

#### `packages/redactor`

Detects and removes likely secrets before artifact creation.

Examples include:

- API keys
- access tokens
- authorization headers
- private keys
- passwords
- sensitive environment variables
- common credential-file contents

Redaction must happen before artifacts are written to disk whenever possible.

#### `packages/artifact-schema`

Owns the versioned artifact format and JSON Schema.

All producers and consumers must validate against the schema.

#### `packages/contracts`

Owns side-effect-free execution results, evidence, warnings, typed errors, effective-policy summaries, cleanup summaries, and versioned public operation-result envelopes.

It must not contain artifact parsing, filesystem or container operations, CLI or GitHub fields, or application orchestration.

#### `packages/process-output`

Owns byte limits, UTF-8 decoding behavior, truncation metadata, and bounded output capture. It depends only on neutral contracts so recording and replay use the same rules.

#### `packages/application`

Owns the shared product use cases used by every delivery adapter.

Expected responsibilities:

- record and write an artifact
- validate an artifact
- inspect an artifact
- replay an artifact in snapshot or current-checkout mode
- apply local replay policy
- invoke matching after bounded execution
- evaluate an optional required result status
- return adapter-neutral results and events

The CLI and GitHub Action must use this layer. They must not independently coordinate validation, replay, matching, or policy behavior.

#### `packages/report-ui`

Renders a human-readable replay timeline and comparison report.

The report UI must never be required for core replay functionality.

#### `action`

Contains the GitHub Action integration.

The action should:

- invoke validation and replay through application services
- expose the shared machine-readable result for later workflow steps
- publish a concise workflow summary
- apply required-status policy through application services

The Action must call `packages/application` and must not independently coordinate validation, policy, replay, or matching.

Issue and pull-request comments are deferred and optional.

---

## Artifact Design

Artifacts must be:

- portable
- versioned
- deterministic
- inspectable
- designed to reduce accidental secret exposure before sharing
- validatable without executing them

The version 1 artifact model and sole canonical example are maintained in `docs/artifact-format.md`. Do not duplicate or invent schema fields in this file.

Do not add fields without updating:

1. the JSON Schema,
2. artifact-version documentation,
3. parser tests,
4. compatibility tests,
5. migration guidance when required.

---

## Engineering Principles

### 1. Determinism over intelligence

Prefer explicit rules, schemas, assertions, and reproducible execution.

Do not add AI where a deterministic implementation is sufficient.

Use `deterministic` for parsing, validation, serialization, policy calculation, redaction, and matching when outputs are fully determined by defined inputs. Describe container execution as controlled and repeatable under documented supported conditions; replayed programs may still depend on clocks, scheduling, randomness, architecture, kernels, or container engines.

### 2. Security by default

Artifacts may contain untrusted commands and files.

Assume every artifact is malicious until validated and sandboxed.

### 3. Minimal collection

Record only the information needed to reproduce the failure.

Never collect a user's full home directory, shell history, credential store, or unrelated environment variables.

### 4. Explainable results

Every replay result should explain why it matched or failed to match.

Bad:

```text
Confidence: 84%
```

Better:

```text
Reproduction matched:
- same exit code
- same exception type
- same failing file and line
- normalized stderr differed in temporary paths only
```

### 5. Stable interfaces

The artifact format, CLI output, and GitHub Action outputs are public interfaces.

Treat breaking changes carefully.

### 6. Small, reviewable changes

Prefer narrowly scoped pull requests with tests.

Avoid combining refactors, features, and formatting changes in one patch.

---

## Security Requirements

Security is a core product feature, not an optional hardening task.

All replay implementations must enforce:

- no privileged containers
- no host Docker socket mounting
- no host filesystem access outside the workspace
- no host network access by default
- bounded CPU usage
- bounded memory usage
- bounded process count
- bounded execution time
- temporary isolated workspaces
- cleanup after execution
- read-only base filesystem where practical
- explicit allowlists for mounted files
- validation before execution

Never log raw secrets.

Never include secret values in test snapshots.

Never silently enable network access.

Any change involving sandboxing, execution, redaction, or artifact trust boundaries must include a security analysis in the pull-request description.

---

## Coding Standards

Use TypeScript for the initial implementation unless the relevant package has a documented exception.

General expectations:

- enable strict TypeScript settings
- avoid `any`
- validate all external input
- return typed errors
- separate pure logic from side effects
- prefer dependency injection for runners and filesystem access
- keep functions small and testable
- avoid hidden global state
- use structured logging
- include actionable error messages
- document public APIs

Prefer:

```ts
type ReplayResult =
  | { status: "reproduced"; evidence: MatchEvidence[] }
  | { status: "not_reproduced"; differences: Difference[] }
  | { status: "invalid_artifact"; errors: ValidationError[] }
  | { status: "execution_failed"; error: ExecutionError };
```

Avoid boolean-only results such as:

```ts
const reproduced = true;
```

---

## Testing Requirements

Every behavioral change must include tests.

Required test categories:

### Unit tests

Cover:

- schema validation
- output normalization
- matcher behavior
- redaction rules
- command parsing
- error formatting

### Integration tests

Cover:

- artifact creation
- artifact replay
- container lifecycle
- resource-limit enforcement
- disabled-network behavior
- GitHub Action outputs

### Security tests

Cover:

- path traversal
- symlink escapes
- environment-variable leakage
- secret leakage
- shell injection
- malicious archive contents
- oversized files
- fork bombs
- timeout enforcement
- network-access attempts

### Compatibility tests

Keep fixtures for every supported artifact version.

Old supported artifacts must continue to parse and replay unless a documented migration removes support.

---

## Definition of Done

A change is complete only when:

- implementation is finished
- tests pass
- types pass
- linting passes
- documentation is updated
- security impact is considered
- public-interface changes are documented
- example artifacts are updated when relevant
- no secrets or local paths are committed

For user-facing behavior, include either a CLI example, screenshot, fixture, or recorded output.

---

## Agent Workflow

When working on this repository, agents should follow this sequence.

### 1. Understand the task

Identify:

- the affected package
- the user workflow being changed
- public interfaces involved
- security boundaries involved
- test coverage required

### 2. Inspect before editing

Read the relevant implementation, tests, schemas, and documentation first.

Do not assume package behavior from filenames alone.

### 3. Make the smallest coherent change

Avoid unrelated cleanup.

Preserve existing interfaces unless the task requires changing them.

### 4. Add or update tests

Tests should demonstrate the previous failure and the new expected behavior.

### 5. Validate locally

Run the relevant commands for:

- formatting
- linting
- type checking
- unit tests
- integration tests
- schema validation

### 6. Summarize clearly

Report:

- what changed
- why it changed
- tests added
- commands run
- known limitations
- security implications

---

## Commit and Pull-Request Guidance

Use descriptive commit messages.

Examples:

```text
feat(matcher): add normalized stderr comparison
fix(redactor): mask authorization headers before serialization
docs(schema): document artifact versioning policy
test(runner): verify network access is disabled by default
```

Pull requests should include:

- problem statement
- implementation summary
- test evidence
- security impact
- compatibility impact
- screenshots or sample output when user-facing

Do not claim a bug is fixed without a test that would have caught it.

---

## Documentation Expectations

Keep these documents current:

```text
docs/
├── artifact-format.md
├── architecture.md
├── security-model.md
├── threat-model.md
├── recording.md
├── replay.md
├── github-action.md
└── contributing.md
```

Documentation should favor concrete examples over abstract descriptions.

Every CLI command should include:

- purpose
- syntax
- common options
- example
- failure behavior
- security notes where relevant

---

## Product Guardrails

Before adding a feature, ask:

1. Does this make bug reports easier to reproduce?
2. Does this make replay safer?
3. Does this make results easier to trust?
4. Does this reduce work for reporters or maintainers?
5. Can this be implemented deterministically?

If the answer to all five is no, the feature probably does not belong in the core project.

---

## Non-Goals

ProofIssue is not intended to become:

- a general CI platform
- a remote code-execution service
- an autonomous software engineer
- a bug-tracking replacement
- a complete observability platform
- a full virtual-machine snapshot system
- a general shell-session recorder

Keep the product centered on portable, safe, replayable bug reproductions.

---

## Technical Prototype Completion

The technical prototype is complete when a user can:

1. record a failing Node.js test,
2. produce a valid `.proofissue` artifact,
3. inspect the artifact,
4. replay it in a locked-down Linux container,
5. confirm the same exit code and error output,
6. verify declared existing subject paths against a simple fix.

This dependency-free proof is not stable support for typical Node.js projects.

## Initial Supported Node.js Workflow Completion

The initial supported Node.js workflow additionally requires:

1. an accepted and documented dependency representation or bounded setup mechanism,
2. GitHub Actions replay through the shared application layer,
3. security, compatibility, and repeatability evidence,
4. documented support boundaries and failure behavior,
5. measured real-project evaluation.

Anything not required for this workflow should be considered secondary.
