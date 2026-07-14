# Milestone 1 Evidence

## Status

Milestone 1 is **in progress**. The repository foundation passes all local acceptance checks on Windows, and the owner selected Apache License 2.0 on 2026-07-14. Completion still requires a successful hosted Linux and Windows CI run.

## Acceptance record

| Acceptance criterion | State | Evidence |
| --- | --- | --- |
| Clean checkout installs from a lockfile | Locally verified | `npm ci` completed from `package-lock.json` on 2026-07-14. |
| Format, lint, types, tests, and build pass locally and in CI | Partially verified | `npm run check` passed locally after the clean install. The hosted CI run is pending. |
| Strict TypeScript and no `any` convention | Verified | The shared strict configuration is inherited by every package; lint rejects explicit `any`; type checking passes. |
| Package direction matches architecture | Verified | The dependency check validated all 11 workspaces and rejects unknown, undeclared, disallowed, or cyclic internal dependencies. |
| CLI and Action use the application boundary | Verified | Both adapters declare `@proofissue/application` as their only internal dependency, and adapter tests pass. |
| Supported environments are documented | Verified | Node.js, npm, operating-system, Docker, container-host, and CI expectations are recorded in `supported-environments.md`. |
| Generated output, local paths, credentials, and test secrets are excluded | Verified locally | Ignore rules cover dependencies, builds, coverage, environment files, artifacts, caches, and editor state. The hygiene check passed. |
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

## Remaining completion evidence

1. Push the repository so the foundation workflow runs on its pinned Linux and Windows runner labels.
2. Record links to successful CI runs here.
3. Record the successful hosted run links and mark Milestone 1 complete in the implementation plan and roadmap.
4. Repeat `npm ci` and `npm run check` after the final evidence update.

These are completion gates. They do not block continued review or early product-validation sessions, but Milestone 1 must not be marked complete until they are satisfied.
