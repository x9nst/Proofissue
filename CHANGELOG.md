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
- `record` defaults: the approved Node.js 24 image, the current directory as the project, and an artifact named after the first reproduction file (`reproduction.proofissue.yaml`, with `-2` through `-99` added when the name is taken). `--image`, `--project`, and `--output` remain available, and a name you give is used exactly as written. The `.yaml` extension lets a reporter attach the file to a GitHub issue, which refuses `.proofissue`.
- Per-command help (`proofissue <command> --help`), and short usage errors: the error, a one-line synopsis, and a pointer to the command's help, instead of the full help text.
- `record --json` (with `--yes`) prints one versioned result line on stdout and sends the preview to stderr.
- Guided expectation selection: with no `--expect-*` option in a terminal, `record` runs the command once, lists the normalized, redacted output lines, and lets you choose the expected lines, with a suggestion by a fixed rule table (Enter accepts it). Nothing is chosen under `--yes`, with `--json`, or without a terminal.
- Explanations when an expected literal was not observed: it names the other stream, normalization, truncation, or the line counts, without repeating the literal or any output.
- File suggestions for roles left out: files named in the command and relative imports reached by a bounded scanner, with reasons, always confirmed (`Use these files?`); `package.json` for ES module projects; a list of runner configuration files that were not collected; a warning for vitest and tsx. Nothing is applied under `--yes`, with `--json`, or without a terminal, where the suggested flags are printed after the error instead.
- Dependency suggestions: when `package.json` and `package-lock.json` exist, a terminal session asks whether to record them, and `--no-dependencies` suppresses the question and the warning shown under `--yes`.
- Hints for commands that do not start with `node`: the equivalent `node node_modules/<package>/<script>` form from the lockfile, and a fixed message for `npm`, `yarn`, and `pnpm`. The command is never rewritten or run.
- Refusal, before anything runs, of command arguments that hold the project or home directory, and on Windows of backslash paths to project files; `./` and Windows separators in `--reproduction` and `--subject` are normalized.
- After recording, the output names the saved file and a digest prefix, says how to attach it to an issue, and prints the replay commands.
- `proofissue doctor`: checks the Node.js version, host, Docker CLI, local context, engine version and architecture, seccomp, and the approved image with read-only Docker commands, prints the exact `docker pull` command when the image is missing, and exits 0 only when replay is ready.
- `proofissue replay --prepare --dependency-store <directory>`: runs `prepare` and then replay with the same store, as an explicit opt-in to the one network step.
- `Next step:` lines on replay errors, and a readable `inspect` summary (runtime, files with roles and sizes, expectation modes, limits, redaction counts, whether prepare is needed) that shows no file contents, argument values, or expected text.
- `proofissue --version`.
- The `proofissue` npm package, a single bundled file for Node.js 24 or newer with no runtime dependencies, with a packed-CLI check and a smoke test on Linux and Windows.
- A tag-triggered release workflow that verifies and rebuilds the package, attests its build provenance, and creates a GitHub prerelease. See `docs/release.md`.

### Security

- Replay runs in a container without privileges, without the host Docker socket, and without network access by default; artifacts are treated as untrusted until validated.
- Command output shown during guided selection is escaped for terminal and bidirectional control characters, and lines that hold a redaction marker, a local path, or a likely secret cannot be chosen.
- File suggestions read only regular files beneath the project, outside `node_modules` and dot-directories, never through symbolic links, and are bounded to 100 files and 4 MiB.
- The release workflow holds no npm token. Publishing uses npm trusted publishing (OpenID Connect) from version 0.1.1; version 0.1.0 is published by hand.

### Known limits

- Replay supports only a local, rootful Docker Engine 27 or newer on x86-64 Linux.
- Dependencies come from an npm lockfile version 3 on the public registry only, and install scripts never run.
- Only pure-JavaScript test runners are supported; recording is not sandboxed.
