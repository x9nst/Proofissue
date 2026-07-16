# Milestone 5 Evidence

## Status

Milestone 5 — Fix Verification is complete. The same dependency-free artifact can reproduce its embedded snapshot and then check corrected contents for only its explicitly declared, existing subject paths.

This completes the technical prototype slice. It does not complete the initial supported Node.js workflow or roadmap Phase 1. Dependency installation, normal Node.js project support, and GitHub Action delivery remain later milestones.

## Implemented workflow

`proofissue replay failure.proofissue` continues to reconstruct every file from the artifact.

`proofissue replay failure.proofissue --against <checkout>` now keeps every reproduction file exactly as embedded and replaces each declared subject file from the identical relative path beneath the selected checkout. It does not scan the checkout, discover new files, or infer renames and removals.

Human and structured results list every substituted path. Current-checkout results also state that undeclared additions, removals, and renames were not evaluated.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Snapshot reproduces; corrected subject does not | A shared-application fixture executes the same artifact twice and asserts `reproduced` for the snapshot and `not_reproduced` with exit code `0` for the corrected subject. A Docker-backed copy runs in the dedicated supported-Linux replay job. |
| Reproduction content stays frozen | The checkout fixture deliberately changes the reproduction file. Workspace tests and the executable fixture prove that the embedded reproduction is still used. |
| Only declared subjects are read | The runner derives its checkout reads from validated files whose role is `subject`. The fixture adds an undeclared file and changes an undeclared reproduction path; neither enters the reconstructed workspace. |
| Unsafe declared paths fail closed | Tests cover missing paths representing removal or rename, a subject changed into a directory, symbolic-link escape where the platform permits link creation, missing checkout selection, and ambiguous snapshot selection. No workspace or container is created after these failures. |
| Substitutions and limits are visible | Application and command-line tests assert the substituted-path list and the declared-path limitation in human and JSON results. |
| Four machine states remain distinct | Permanent version 1 result fixtures cover `reproduced`, `not_reproduced`, `invalid_artifact`, and `execution_failed` without exposing detailed output. |

## Security analysis

The changed trust boundary is the selected current checkout. Subject contents and path components are treated as untrusted even when the checkout belongs to the maintainer.

The reader opens only validated manifest paths with the `subject` role. It rejects a checkout root that is missing, not a directory, or itself a symbolic link; rejects symbolic-link path components, non-regular final paths, missing declared subjects, oversized content, aggregate reconstructed content above the artifact limit, and invalid UTF-8; uses no-follow opening where the platform provides it; compares the opened file identity and size with the inspected file; and verifies the final resolved path remains beneath the selected checkout. Files are copied into the existing isolated replay workspace and receive the same container controls as snapshot content.

The abuse cases considered were traversal or link escape, rename and removal being mistaken for a successful fix, type changes, undeclared-file collection, file growth during reading, oversized replacement sets, and replacing the frozen reproduction. Tests demonstrate rejection or non-collection. No raw replacement content or hash is added to human or stable machine output.

Residual risk remains for hostile filesystem races that cannot be eliminated portably without directory-relative operating-system APIs. The implementation combines component checks, no-follow opening, opened-file identity checks, and final root verification; highly adversarial local checkouts should still be handled in an additional disposable environment. The existing container and kernel residual risks remain unchanged.

## Compatibility impact

The artifact schema and version do not change. The version 1 result shape does not change; fields already reserved for mode, substituted paths, and scope limitations are now populated. The command line gains the additive `--against <directory>` option. Snapshot behavior is preserved. A current-checkout request that was previously rejected is now supported under the already documented declared-path rules.

## Validation

The ordinary executable fixture uses a synthetic dependency-free project and a test-only injected process boundary so it can run on Windows without weakening the product runner. The production path still executes received artifacts only through the restricted container. The same fixture has a real-container variant included in the dedicated Linux replay job.

Final local verification ran on 2026-07-16 with Node.js 24.15.0 and npm 11.12.1 on Windows:

1. `npm run check` — passed.
2. Formatting — passed.
3. Linting — passed with zero warnings.
4. Dependency boundaries — passed for all 11 packages.
5. Strict type checking — passed.
6. Tests — 100 tests in 11 files passed; the five supported-Linux Docker tests were skipped on this unsupported Windows replay host.
7. Build — passed.
8. Repository hygiene — passed.
9. `git diff --check` — passed.

The supported real-container variant requires the documented x86-64 Linux Docker host and is intentionally skipped on unsupported Windows replay hosts. The dedicated Linux job now includes both the existing four locked-down replay tests and the new fix-verification fixture, then checks for residual replay containers.
