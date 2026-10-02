# Fixture Policy

Fixtures are public compatibility and security evidence. They must be minimal, reviewable, and free of real project data.

## Directories

- `artifacts/v1`: permanent version 1 valid, invalid, and canonical-byte compatibility fixtures. Public presentation wording remains provisional until maintainer Gate A.
- `artifacts/v1/legacy-schema`: frozen copies of earlier published schemas, used only to prove that a consumer which predates an additive change rejects the new content instead of misreading it. Never edited.
- `results/v1`: provisional machine-result fixtures until the result contract is accepted; `results/v1/prepare` holds the dependency-preparation results. `reproduced-normalized.json`, `not-reproduced-output-modes.json`, `reproduced-regex.json`, and `not-reproduced-regex.json` show the exact, normalized, and pattern output-matching evidence and differences; their messages are checked against the matcher, and they carry counts only, never output text.
- `action`: the approved-image failure and corrected declared subject used by the Linux
  GitHub Action integration workflow.
- `synthetic-secrets`: unmistakably fake values used only to prove redaction and leakage checks.

## Rules

- Never copy a credential, private repository file, username, hostname, or absolute local path into a fixture.
- Synthetic credentials must use reserved example domains or obvious `SYNTHETIC_TEST_ONLY` markers.
- Snapshot output must contain replacement markers, never the original synthetic secret.
- Every supported artifact and result schema version retains compatibility fixtures.
- A compatibility fixture is not reformatted merely because a newer serializer changes style.
- Provisional fixtures are clearly labeled and carry no compatibility promise.

## Compatibility and evidence checks

- **Replay compatibility.** A valid artifact fixture is replay-compatible when it replays unchanged except that `environment.image` is replaced by the currently approved digest; fixtures carry a placeholder digest and are never edited. In the hosted Linux job, `packages/application/src/fix-verification.integration.test.ts` replays every `*.proofissue` file in `artifacts/v1/valid`, reproducing it and then not reproducing it with the declared fix. The directory is listed at run time, so a fixture added there is covered automatically, and a fixture that stops reproducing is a compatibility finding, not a reason to edit the fixture.
- **Enumeration.** `packages/artifact-schema/src/index.test.ts` parses and canonically round-trips every file in `artifacts/v1/valid` and rejects every file in `artifacts/v1/invalid`.
- **Committed-evidence scan.** `packages/redactor/src/committed-evidence.test.ts` runs the repository's redactor over the fixtures, fuzz corpus, trial results, examples, workflows, and documentation, and allows exactly one known finding (the password-rule description in `docs/security-model.md`). `scripts/check-repository-hygiene.mjs` also scans `.proofissue` files for local paths and credential-shaped values. Build any synthetic secret at run time instead of writing it out.
- **Result fixtures** stay provisional and are outside the replay-compatibility rule.

## Current fixtures

Artifacts in `artifacts/v1/valid`: `canonical` (also the permanent canonical-byte fixture), `minimal` (valid but not in canonical form), `exact-output`, `normalized-output`, `regex-output`, and `with-dependencies`. In `artifacts/v1/invalid`: `unknown-field`, `normalize-out-of-order`, and `regex-lookahead`. `action` holds the approved-image failure and corrected checkout, and `results/v1` holds one result fixture per replay status plus the output-matching and preparation results. Milestone 2 tests preserve artifact compatibility, schema synchronization, and exact canonical serialization. Result fixtures retain status coverage and prevent detailed decoded output from entering public examples.
