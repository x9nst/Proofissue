# ProofIssue

ProofIssue is an open-source tool for creating portable, inspectable, replayable bug reports.

The project has completed its static artifact core and is implementing the recorder and redaction milestone. One dependency-free Node.js command can now be captured into a validated artifact through the application and CLI layers, with file review, bounded output, and secret replacement. The file-role wording remains provisional pending maintainer testing, and isolated replay is still the next milestone. This is not yet stable support for typical Node.js projects.

## Repository Status

- Product and security contracts: complete as reviewed design documents
- Repository foundation: complete
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
