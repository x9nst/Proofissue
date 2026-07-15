# ProofIssue

ProofIssue is an open-source tool for creating portable, inspectable, replayable bug reports.

The project has completed locked-down replay and basic matching. One dependency-free Node.js command can be captured into a validated artifact, replayed in a restricted Linux container through the shared application layer, and classified with exact exit-code and literal output evidence. This is the technical prototype slice, not yet stable support for typical Node.js projects.

## Repository Status

- Product and security contracts: complete as reviewed design documents
- Repository foundation: complete
- Static artifact core: complete
- Recorder and redaction: complete
- Locked-down replay and basic matching: complete
- Fix verification and GitHub Action behavior: not implemented

See `IMPLEMENTATION_PLAN.md` for acceptance criteria and evidence. See `docs/README.md` for the documentation map.

## Development

Requirements:

- Node.js 24
- npm 11
- Git
- Docker Engine 27 or newer on x86-64 Linux for replay; it is not required for non-container checks

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
