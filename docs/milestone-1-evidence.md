# Milestone 1 Evidence

## Status

Milestone 1 is **complete**. The repository foundation passes all local acceptance checks on Windows and hosted checks on the pinned Linux and Windows runners. The owner selected Apache License 2.0 on 2026-07-14.

## Acceptance record

| Acceptance criterion | State | Evidence |
| --- | --- | --- |
| Clean checkout installs from a lockfile | Verified | `npm ci` completed locally and on both hosted runners from `package-lock.json` on 2026-07-14. |
| Format, lint, types, tests, and build pass locally and in CI | Verified | `npm run check` passed locally. The equivalent individual checks passed in hosted Linux and Windows jobs. |
| Strict TypeScript and no `any` convention | Verified | The shared strict configuration is inherited by every package; lint rejects explicit `any`; type checking passes. |
| Package direction matches architecture | Verified | The dependency check validated all 11 workspaces and rejects unknown, undeclared, disallowed, or cyclic internal dependencies. |
| CLI and Action use the application boundary | Verified | Both adapters declare `@proofissue/application` as their only internal dependency, and adapter tests pass. |
| Supported environments are documented | Verified | Node.js, npm, operating-system, Docker, container-host, and CI expectations are recorded in `supported-environments.md`. |
| Generated output, local paths, credentials, and test secrets are excluded | Verified | Ignore rules cover dependencies, builds, coverage, environment files, artifacts, caches, and editor state. The hygiene check passed locally and on both hosted runners. |
| Contribution and community foundation | Verified | Contribution, conduct, security, and repository templates exist. The owner selected Apache License 2.0; the complete license text and decision record are present. |

## Verification run — 2026-07-14

Environment:

- Windows host
- Node.js 24.15.0
- npm 11.12.1

Commands and results:

1. `npm ci` — passed from the committed lockfile.
2. `npm run check` — passed.
3. Formatting — passed.
4. Linting — passed with zero warnings.
5. Dependency boundaries — passed for 11 workspaces.
6. Strict type checking — passed.
7. Unit tests — 11 tests in 5 files passed.
8. Build — passed.
9. Repository hygiene — passed.

The clean-install exercise found and corrected an npm cross-platform lockfile issue involving optional peer packages. The final lockfile was verified with `npm ci`, and the complete check suite was rerun from that clean install.

## Readiness-review work included

The response table in `PRE_MILESTONE_2_READINESS_REVIEW.md` records each disposition. Foundation work now includes:

- distinct names for the technical prototype, supported Node.js workflow, and roadmap Phase 1;
- a shared application-service boundary for command-line and GitHub Action use;
- a neutral result contract and error taxonomy;
- shared byte-bounded output handling with decoding and truncation tests;
- exact provisional parser, serializer, and safe-write rules for Milestone 2;
- precise current-checkout replay limitations;
- deterministic-algorithm versus controlled-execution wording;
- property-based, fuzz, cleanup-fault, and terminal-output test plans;
- separate participant and facilitator materials for early maintainer validation.

## Hosted verification run — 2026-07-14

GitHub Actions foundation run [29327099233](https://github.com/x9nst/Proofissue/actions/runs/29327099233) passed for commit `26f6aa4f125c097e496cc720b3f4db4f36b055f5`:

- `ubuntu-24.04` passed in 36 seconds;
- `windows-2025` passed in 1 minute 8 seconds;
- both jobs installed from the lockfile and passed formatting, linting, dependency boundaries, strict type checking, unit tests, build, repository hygiene, and tracked-file integrity checks.

The final evidence update was followed by another clean local installation and complete local check before publication. Milestone 1 is complete; this is the repository foundation milestone, not completion of the technical prototype, initial supported Node.js workflow, or roadmap Phase 1 product.
