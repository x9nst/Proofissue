# Milestone 6 Evidence

## Status

Milestone 6 — GitHub Actions Integration is in progress.

The implementation, local checks, fixture artifact, corrected checkout, and
Linux workflow are present. The dependency advisory reported by the clean
install is triaged and resolved (see Dependency advisory triage). Completion
remains gated on a successful hosted `ubuntu-24.04` run of
`.github/workflows/action-integration.yml`.

## Implemented Workflow

The Action is a self-contained Node.js 24 bundle in `action/dist/index.js`.
It accepts an artifact path, snapshot or current-checkout mode, an optional
checkout root, and an optional required result.

The adapter calls the shared replay application service. That service performs
validation before workspace or container creation, applies replay policy,
executes the controlled container, redacts output, invokes matching, and returns
the versioned result. The adapter uses the shared `evaluateReplayPolicy` evaluator, which the CLI also
uses for its exit code, and does not contain validation, runner, matcher, or
policy logic.

The Action publishes status, mode, the versioned result, evidence, differences,
and required-result satisfaction through GitHub environment files. Its workflow
summary uses fixed labels and counts rather than application messages or raw
execution data.

## Acceptance Evidence

| Criterion | Evidence |
| --- | --- |
| Fixture workflow validates and replays on Linux | `.github/workflows/action-integration.yml` runs the approved-image fixture in both modes on `ubuntu-24.04`; a successful hosted run is still required |
| Either classification can be required | Adapter tests cover successful `reproduced`, successful `not_reproduced`, and a mismatch that preserves the underlying classification |
| Outputs work in later steps | Unit tests parse every JSON output; the fixture workflow consumes snapshot and current-checkout outputs in later steps |
| Summary omits raw sensitive output | Tests inject potentially sensitive warning, error, and limitation messages and prove none enter the summary |
| Core behavior is not duplicated | The Action package has only one internal dependency, `@proofissue/application`; its source delegates replay and success-policy evaluation (`evaluateReplayPolicy`) to that boundary; the CLI exit code uses the same evaluator |

## Security Analysis

The new boundary is the GitHub runner environment. Input paths, artifacts, and
current-checkout content are untrusted. GitHub's output and summary file paths
are trusted runner-provided values.

The adapter validates its finite input choices, passes artifact and checkout
paths to the application service, and does not read artifact contents itself.
Structured outputs use randomized multiline delimiters. The summary is derived
only from typed states, fixed category labels, and numeric counts. It excludes
raw stdout, stderr, file content, expectations, paths, environment values, and
application messages.

The Action uses no GitHub token or API. The example grants `contents: read` only
for checkout and disables persisted checkout credentials. Image acquisition is
an explicit workflow step. The replayed container receives no job secrets,
Docker socket, host network, or repository mount.

The generated bundle is committed because GitHub must execute an Action before
dependency installation. The pinned build dependency and deterministic rebuild
check reduce bundle/source drift; reviewers must continue to review both source
and generated changes.

Residual container, kernel, Docker daemon, approved-image, and local filesystem
race risks remain as documented in the security model. Highly adversarial input
still warrants an additional disposable machine boundary.

## Compatibility Impact

The artifact and result schema versions do not change. The Action exposes the
existing version 1 replay result without adding GitHub fields to the shared
contract. All Action inputs and outputs are additive because no executable
Action interface existed before this milestone.

## Validation

Local validation ran on 2026-07-24 with Node.js 24.15.0 and npm 11.12.1 on
Windows:

1. `npm run check` — passed.
2. Formatting — passed.
3. Linting — passed with zero warnings.
4. Dependency boundaries — passed for all 11 packages.
5. Strict type checking — passed.
6. Tests — 116 tests in 12 files passed; the five supported-Linux Docker tests
   were skipped on this unsupported Windows replay host.
7. Build — passed, including the self-contained Action bundle.
8. Repository hygiene — passed.
9. Action metadata and fixture-workflow YAML parsing — passed.
10. The approved-image Action fixture passed static artifact validation.
11. The generated bundle executed from an isolated temporary directory and
    returned bounded `invalid_artifact` outputs without workspace modules.
12. The Action package dry run contained its metadata and generated entry point.
13. Rebuilding the bundle and third-party notices twice produced identical
    hashes.
14. `git diff --check` — passed.

The supported Docker-backed Action workflow cannot be completed on the local
Windows host. A successful hosted Linux run remains a Milestone 6 completion
gate.

## Dependency advisory triage

The clean install reported high-severity advisories in the repository's
dependency tree. Triage on 2026-10-01 with `npm audit` found:

1. `fast-uri` 3.1.3 (eight advisories, high) — a **production** dependency of
   `ajv`, which `@proofissue/artifact-schema` uses, and therefore bundled into
   `action/dist/index.js`. ProofIssue passes `ajv` only its own bundled
   schema and never resolves untrusted URIs, so the host-confusion and
   request-forgery paths were not reachable from artifact input. It was still
   upgraded rather than accepted.
2. `brace-expansion` and `nanoid` (high) — development-only transitive
   dependencies of `eslint` and `vite`; not shipped.
3. `vitest` 4.1.10 through `@vitest/mocker` (moderate) — development-only.

Resolution: an in-range `npm audit fix` raised `fast-uri` to 3.1.8 and fixed
the two development-only advisories, and `vitest` was pinned to 4.1.11. After
the change `npm audit` and `npm audit --omit=dev` both report zero
vulnerabilities. The Action bundle and third-party notices were rebuilt twice
and produced identical hashes.
