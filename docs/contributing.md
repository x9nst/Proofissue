# Contributing

The canonical contributor guide is `../CONTRIBUTING.md`.

Before contributing, also read:

- `../AGENTS.md` for product and security guardrails;
- `../IMPLEMENTATION_PLAN.md` for the active milestone;
- `architecture.md` for package boundaries;
- `security-model.md` and `threat-model.md` for untrusted-input requirements;
- `testing-strategy.md` for required evidence techniques.

Contributions are accepted under the Apache License 2.0. The canonical terms are in `../LICENSE`, and the decision record is in `license-decision.md`.

## Building and testing the npm package

The `proofissue` npm package is a single bundled file built from `release/npm/`. It is not an npm workspace, so the `@proofissue/*` packages stay private. Its output is not committed: `release/npm/dist/` and `release/npm/LICENSE` are gitignored, and the tarball is built in CI.

```text
npm ci
npm run build                 # includes build:package
npm pack ./release/npm --pack-destination <directory>
node scripts/check-cli-package.mjs <directory>/proofissue-<version>.tgz --reproducible
node scripts/smoke-cli-package.mjs <directory>/proofissue-<version>.tgz
```

- `scripts/build-cli-package.mjs` bundles `packages/cli/dist/bin.js` with the same pinned ncc as the Action, without minification, and writes `dist/proofissue.js` (one shebang) and `dist/third-party-licenses.txt`. Building twice gives identical bytes.
- `scripts/check-cli-package.mjs` inspects the tarball without running it: the exact file list, no dependency fields, one shebang, the version matching `PROOFISSUE_VERSION` in `packages/cli/src/version.ts`, no local user paths, and the license text. With `--reproducible` it rebuilds twice and compares hashes.
- `scripts/smoke-cli-package.mjs` installs the tarball into a temporary prefix and through `npm exec`, then runs `--version`, `--help`, `record`, `validate`, and `inspect` on a copy of `examples/failing-node-test`. On Linux with `PROOFISSUE_SMOKE_REPLAY=1` it pulls the approved image and replays, then verifies a fix; on Windows it checks that replay is refused with `engine_capability_unavailable`. Replay needs Docker, so only the hosted Linux job exercises it.
- `.github/workflows/package-smoke.yml` runs all of this on Ubuntu and Windows for every pull request and push.
- `PROOFISSUE_VERSION` and `release/npm/package.json` must have the same version; a test enforces it. Change both together.
- Nothing here publishes anything, and no workflow in this repository holds an npm token.
