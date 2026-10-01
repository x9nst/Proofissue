# Decision 0002: Dependency Strategy for the Initial Supported Node.js Workflow

**Status:** Accepted on 2026-10-01: option B, with lifecycle scripts out of scope. The items marked *assumed* below were not asked of the maintainer and should be confirmed or changed in review.  
**Date:** 2026-10-01

## Context

Decision 0001 narrowed the technical prototype to one dependency-free command so that replay could stay network-disabled. It also requires the initial supported Node.js workflow to choose, before normal npm projects are called supported, either an offline dependency bundle or a separately authorized and constrained setup phase.

This document lays out the realistic options, recommends one, and lists what is needed to decide. It changes no behavior.

### Constraints that already exist

These come from the accepted design and the current code, and every option has to work within them or explicitly change them.

| Constraint | Source |
| --- | --- |
| Replay has no network, and network access is never silently enabled as a fallback. | Decision 0001; `security-model.md` |
| Replay uses one approved, digest-pinned image and no artifact-provided Dockerfile. | Decision 0001; `APPROVED_NODE_IMAGE` |
| Image acquisition is a separate, explicit step; replay never pulls. | `security-model.md`, Image Policy |
| An artifact is one UTF-8 YAML file of at most 5 MiB, with at most 100 files and 4 MiB of file content. Binary files and archives are unsupported. | `ARTIFACT_LIMITS`; Decision 0001 |
| The container has a read-only root, a 64 MiB in-memory workspace mounted `noexec`, one read-only input mount, a process limit, and a time limit of at most 300 seconds. | `buildDockerCreateArguments` |
| Only explicitly allowlisted mounts are permitted. | `AGENTS.md`, Security Requirements |
| Adding dependency installation, network access, custom images, or additional mounts requires a threat-model review. | `threat-model.md` |

Two consequences matter. A real `node_modules` tree is far larger than an artifact can hold, and it contains thousands of files and often native binaries. And the `noexec` workspace means native addons (`.node` files, which are loaded with executable mappings) cannot work from it.

## Options

### A. A setup phase inside replay, with restricted network

The artifact carries `package.json` and the lockfile. Replay runs two containers: an install container with network access limited to a package registry, and then the normal replay container with no network and the installed tree.

- Reproduces the most real projects, because it installs whatever the lockfile asks for.
- Needs a network allowlist by hostname. Docker has no built-in egress policy, so this needs a proxy or firewall rules the runner would have to manage. That is a new privileged component on the host.
- The lockfile is attacker-controlled. Its `resolved` URLs can point anywhere, so they must be rewritten or rejected, and every package verified against its recorded integrity hash.
- Breaks the invariant that replay never touches the network. It would need an explicit opt-in, and it runs attacker-influenced install logic on every replay.
- Largest attack surface and the most new infrastructure. Slowest to build and hardest to reason about.

### B. A separate preparation step, then offline replay (recommended)

The artifact carries `package.json` and the lockfile. A new explicit command, for example `proofissue prepare <artifact>`, is run by whoever intends to replay. It downloads exactly the packages the lockfile names into a local content-addressed store and verifies each against the lockfile's integrity hash. Replay then runs with no network, with the store mounted read-only, and installs from it offline with lifecycle scripts disabled.

- Keeps the strongest property: replay itself never has a network. Networked work is a separate, explicit, auditable step, the same pattern the project already uses for pulling the approved image.
- The artifact stays text. A lockfile fits inside the existing limits.
- The network-facing code is small and runs outside the sandbox on data it can verify: a fixed registry, hashes from the lockfile, and no code execution.
- In CI, the GitHub Action can run `prepare` as its own step with network and replay as the next step without it, so the trust boundary is visible in the workflow.
- Adds one read-only mount, which needs the allowlist change and threat-model review.
- Lifecycle scripts stay disabled, so packages that compile or download binaries at install time are unsupported. That is a real boundary, documented as one.
- Needs an artifact change to carry the dependency manifest (see Impact).

### C. An offline dependency bundle inside the artifact

The artifact embeds the installed dependency tree.

- Fully hermetic and portable: nothing to prepare, nothing to download.
- Does not fit version 1. Real dependency trees exceed 4 MiB and 100 files almost immediately, and contain binary files.
- Would need a new artifact version with archives or binary content. Archive handling is the largest hole the threat model lists: traversal, symlinks, bombs, oversized entries, and path tricks.
- Artifacts become large, hard to inspect, and carry third-party code and licenses along with the bug report. That works against "inspectable".
- Suitable only for tiny dependency trees, which is not the typical case this milestone is about.

### D. A digest-pinned image that already contains the dependencies

The reporter or maintainer builds an image with the dependencies installed and the artifact references its digest. Maintainers add that digest to the local allowlist.

- Reuses the existing model completely: no network, no new mounts, digest-pinned.
- Needs custom-image support, which Decision 0001 defers. Policy has to move from one approved image to an allowlist of many.
- Pushes work onto the reporter, who must build and publish an image, and onto the maintainer, who must decide whether to trust it. Image contents are opaque, and the artifact stops being self-describing.
- Better as a later addition for projects that need it than as the default workflow.

### E. Stay dependency-free

Keep the current scope: Node built-ins plus the up to 100 files a reporter selects, including any vendored code that fits.

- No new risk and no new work.
- Does not meet the milestone's goal of normal Node.js projects, or the success metric of ten failures across three external repositories, because most real projects have dependencies.
- Honest as an interim statement, not as the supported workflow.

## Comparison

| | A. Setup phase | B. Prepare, then offline | C. Embedded bundle | D. Prebuilt image | E. None |
| --- | --- | --- | --- | --- | --- |
| Replay has no network | No | Yes | Yes | Yes | Yes |
| Fits the current artifact format | Yes | Yes, with an additive field | No | Yes | Yes |
| New host-side infrastructure | Egress control | Small download tool | Archive extraction | Image allowlist | None |
| New mounts | Yes | One, read-only | No | No | No |
| Handles typical npm projects | Yes | Pure-JavaScript ones | Only tiny ones | Yes | No |
| Reporter effort | Low | Low | Low | High | None |
| Largest new risk | Network and install logic in the sandbox's reach | Registry and package supply chain at preparation time | Archive parsing | Opaque image contents | None |

## Recommendation

Choose **B**. It is the only option that lets typical projects work while keeping replay's no-network invariant. It reuses a pattern the project already accepted, an explicit separate step for anything that needs the network. Its network-facing part is small, uses only a fixed registry, and verifies everything against hashes the artifact already carries. D can follow later for projects whose dependencies need install scripts.

The honest cost is coverage. With lifecycle scripts disabled, projects that depend on native addons or install-time downloads will not replay. Pure-JavaScript projects will, and the real-project evaluation should say how many of the sampled failures fall on each side, because that fraction decides how useful the first supported workflow is.

## Impact of B

None of this is built. It is what the choice would entail.

- **Artifact (`artifact-schema`).** Carry the dependency manifest and lockfile as ordinary files with a new role, or a dedicated additive section. Either way it needs the JSON Schema, version documentation, parser and compatibility tests, and a decision on whether it is an additive change to version 1 or a new version. This is the biggest open design point.
- **Recorder.** Capture `package.json` and the lockfile when present, within existing limits and redaction, and reject unsupported lockfile shapes with a clear error.
- **Preparation (new).** Validate the lockfile before any network use: allowed registry host only, no git, file, or arbitrary-URL sources, and an integrity hash on every entry. Download into a content-addressed store and verify every hash. Never execute package code.
- **Runner.** Mount the store read-only as the one new allowlisted mount, install offline with scripts disabled into the workspace, and keep network off throughout. Resolve how `node_modules` is placed given the `noexec` workspace and the size ceiling.
- **Application, CLI, and Action.** A new `prepare` use case in the application layer, used by both the CLI and the Action, with the Action running it as a distinct step.
- **Result contract.** A way to report that preparation is missing or failed, as `execution_failed` and not as evidence about the original failure.
- **Security.** Threat-model rows for a malicious lockfile, a malicious or compromised package, a registry substitution, store tampering, and install-time scripts, each with a test: path traversal and symlinks in package contents, oversized or numerous packages, and a hash mismatch.

## Decision

Adopt **option B**: a separate, explicit preparation step, then offline replay.

1. **A separate `prepare` step is acceptable.** Replay itself never touches the network. Fetching packages is a distinct command, and in CI a distinct workflow step. *(Decided by the maintainer.)*
2. **Native addons and install scripts are out of scope** for the initial supported workflow. Lifecycle scripts stay disabled, and projects that need them are an explicit, documented boundary that the real-project evaluation measures. *(Decided by the maintainer.)*
3. **The public npm registry is the only source at first.** Lockfile entries that resolve anywhere else, or to a git, file, or arbitrary-URL source, are rejected. Private registries and mirrors are later work. *(Assumed.)*
4. **npm with `package-lock.json` (lockfile version 3) is the only package manager at first.** pnpm and Yarn are later work. *(Assumed.)*
5. **Dependency information is an additive, optional part of artifact version 1 for now.** The schema is marked provisional, existing artifacts stay valid, and a version 1 consumer that does not know the new content already rejects it rather than guessing, which is the documented behavior. This is the "new compatibility decision" that `artifact-format.md` requires for any additive field. The representation is two ordinary `files` entries with a new `dependency` role, `package.json` and `package-lock.json` at the project root, so hashing, path rules, redaction, and size limits are reused. The role means "kept exactly as recorded". It must be revisited, and may become a new artifact version, once the schema leaves provisional status. *(Assumed.)*

### Consequences to plan for

- **Lockfile size.** A single file is limited to 1 MiB and all content to 4 MiB. Many real lockfiles exceed 1 MiB. The first supported workflow therefore covers projects whose lockfile fits, and the evaluation report states how many sampled projects were excluded for size. Raising the limit is a separate compatibility decision.
- **`noexec` workspace.** The prepared tree is not placed in the `noexec` workspace, and loading native code is out of scope.
- **Coverage is unknown until measured.** The share of real failures that are pure JavaScript with a small lockfile decides how useful this is, and the evaluation must report it before the workflow is described as supported.

### Implementation sequence

Each step is a separate, reviewable change with its own tests and security analysis.

1. Artifact: the `dependency` role, its validation rules, schema, documentation, and compatibility fixtures.
2. Recorder: capture `package.json` and `package-lock.json` when present.
3. Lockfile validation: a pure function that accepts only lockfile version 3, the public registry, and an integrity hash on every entry.
4. Preparation: download into a content-addressed store, verifying every hash, tested against a local fake registry.
5. Runner: mount the store read-only and install offline with scripts disabled, with network still off.
6. Application, CLI, and Action: the `prepare` use case and its distinct workflow step.
7. Real-project trials and the evaluation report.
