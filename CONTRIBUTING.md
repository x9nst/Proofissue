# Contributing to ProofIssue

ProofIssue is in an early foundation stage. Contributions should remain narrow, testable, and aligned with the current implementation milestone.

## Before You Start

1. Read `AGENTS.md` for product boundaries, security requirements, and package responsibilities.
2. Read `IMPLEMENTATION_PLAN.md` for the active milestone and acceptance criteria.
3. Read `docs/architecture.md`, `docs/security-model.md`, and `docs/threat-model.md` before changing artifacts, paths, recording, redaction, replay, or output handling.
4. Discuss public artifact, result, or security-policy changes before implementation.

## Development Requirements

- Node.js 24
- npm 11
- Git
- Docker Engine on the supported Linux host only when working on replay integration

Install exactly from the lockfile:

```text
npm ci
```

Run the complete local check:

```text
npm run check
```

Individual commands are available for formatting, linting, dependency checks, type checking, tests, builds, and repository hygiene.

## Package Boundaries

- `contracts` owns side-effect-free shared execution and public result contracts.
- `artifact-schema` owns only artifact versions, models, schemas, and validation.
- `recorder`, `runner`, `matcher`, and `redactor` own specialized behavior.
- `application` coordinates complete product use cases.
- `cli` and `action` adapt application services and do not coordinate lower-level packages directly.

Run `npm run deps:check` after changing package dependencies or internal imports.

## Tests and Evidence

Every behavior change needs a test that would fail without the change. Security-sensitive work must identify the trust boundary, abuse cases, containment or rejection evidence, compatibility impact, and residual risk.

Use synthetic secrets only. Never place real credentials, private repository files, usernames, hostnames, or local absolute paths in fixtures, snapshots, issues, or pull requests.

## Pull Requests

Keep one coherent concern per pull request. Include:

- the problem and user impact;
- the implementation summary;
- commands run and their outcomes;
- security and compatibility impact;
- public-interface changes;
- known limitations;
- sample output or a fixture for user-facing changes.

By submitting a contribution, you agree that it is licensed under the Apache License 2.0, consistent with the repository's `LICENSE` file.
