# ProofIssue

ProofIssue is an open-source tool for creating portable, inspectable, replayable bug reports.

The project has completed the technical prototype slice. One dependency-free Node.js command can be captured into a validated artifact, replayed from its original snapshot in a restricted Linux container, and checked against corrected contents for its explicitly declared subject paths. Results explain exact exit-code and literal output evidence. This is not yet stable support for typical Node.js projects.

## Repository Status

- Product and security contracts: complete as reviewed design documents
- Repository foundation: complete
- Static artifact core: complete
- Recorder and redaction: complete
- Locked-down replay and basic matching: complete
- Declared-path fix verification: complete
- GitHub Action integration: complete; the fixture workflow passes on a hosted Linux runner

See `IMPLEMENTATION_PLAN.md` for acceptance criteria and evidence. See
`docs/github-action.md` for Action usage and `docs/README.md` for the complete
documentation map.

## Quickstart

Build once, then record a failure, check the artifact, and replay it. The example is a dependency-free script with one bug, in `examples/failing-node-test`.

```text
npm ci
npm run build

node packages/cli/dist/bin.js record   --project examples/failing-node-test --output failure.proofissue   --image node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6   --reproduction test/reproduction.mjs --subject src/calculate.mjs   --expect-stderr "Expected 4 from calculate(2)"   -- node test/reproduction.mjs

node packages/cli/dist/bin.js validate failure.proofissue
node packages/cli/dist/bin.js inspect failure.proofissue --json
```

`record` prints what it will capture and asks you to confirm. `validate` and `inspect` never run the artifact. Replaying needs Docker Engine 27 or newer on x86-64 Linux, with the approved image already pulled:

```text
node packages/cli/dist/bin.js replay failure.proofissue --require-status reproduced
node packages/cli/dist/bin.js replay failure.proofissue --against examples/failing-node-test --require-status not_reproduced
```

The second command checks a fix: change `value + 1` to `value * 2` in `src/calculate.mjs` first. See `docs/cli.md` for every command, option, exit code, and failure mode, and `examples/failing-node-test/README.md` for the full walkthrough.

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
