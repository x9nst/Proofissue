# ProofIssue

ProofIssue is an open-source tool for creating portable, inspectable, replayable bug reports.

The project is currently building its technical prototype: one dependency-free Node.js failure recorded into a versioned artifact and replayed under strict Linux-container limits. This is not yet stable support for typical Node.js projects.

## Repository Status

- Product and security contracts: complete as reviewed design documents
- Repository foundation: in progress
- Static artifact core: not started
- Recorder, runner, CLI, and GitHub Action behavior: not implemented

See `IMPLEMENTATION_PLAN.md` for acceptance criteria and evidence. See `docs/README.md` for the documentation map.

## Development

Requirements:

- Node.js 24
- npm 11
- Git
- Docker Engine only for later replay integration work; it is not required for foundation checks

Install and verify:

```text
npm ci
npm run check
```

The root check runs formatting, linting, dependency-boundary validation, strict type checking, tests, builds, and repository-hygiene checks.

## Security

Artifacts and replay commands are untrusted input. Do not run a received artifact outside the ProofIssue runner. See `SECURITY.md`, `docs/security-model.md`, and `docs/threat-model.md`.

## License

ProofIssue is licensed under the Apache License 2.0. See `LICENSE` and `docs/license-decision.md`.
