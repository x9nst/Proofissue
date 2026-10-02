# Changelog

All notable changes to ProofIssue are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

ProofIssue 0.1.0 is a preview release of the initial supported Node.js workflow. It has not completed roadmap Phase 1, and its supported environment is deliberately narrow (see `docs/supported-environments.md`).

## [Unreleased]

This section lists what the first preview release, 0.1.0, contains so far. It is dated and renamed when the release is cut.

### Added

- Version 1 of the `.proofissue` artifact format, with a JSON Schema, validation without execution, and compatibility fixtures.
- `proofissue record`: captures one command, selected reproduction and subject files, expected exit code, and output expectations, with secret redaction before anything is written and an explicit confirmation of what will be collected.
- `proofissue validate` and `proofissue inspect`, which read an artifact without running it.
- `proofissue replay`: runs a validated artifact in a locked-down Linux container (no network, fixed CPU, memory, process, time, and output limits, temporary workspace, cleanup afterwards) and explains why it did or did not reproduce the recorded failure.
- Fix verification with `replay --against <directory>`, which substitutes only the declared subject files from a current checkout, and `--require-status` for use in scripts.
- Output matching modes `contains`, `exact`, and bounded `regex`, with documented normalization rules, alongside exit-code matching.
- Dependency capture: a validated npm lockfile (version 3, public registry) can be recorded with an artifact, installed by `proofissue prepare` into an explicit local dependency store, and replayed offline.
- A GitHub Action for validation and replay, and a `prepare` Action, both built on the shared application layer.
- A real-project evaluation harness and its recorded results across three external repositories.
- `proofissue --version`.
- The `proofissue` npm package, a single bundled file for Node.js 24 or newer with no runtime dependencies, with a packed-CLI check and a smoke test on Linux and Windows.
- A tag-triggered release workflow that verifies and rebuilds the package, attests its build provenance, and creates a GitHub prerelease. See `docs/release.md`.

### Security

- Replay runs in a container without privileges, without the host Docker socket, and without network access by default; artifacts are treated as untrusted until validated.
- The release workflow holds no npm token. Publishing uses npm trusted publishing (OpenID Connect) from version 0.1.1; version 0.1.0 is published by hand.

### Known limits

- Replay supports only a local, rootful Docker Engine 27 or newer on x86-64 Linux.
- Dependencies come from an npm lockfile version 3 on the public registry only, and install scripts never run.
- Only pure-JavaScript test runners are supported; recording is not sandboxed.
