# Fixture Policy

Fixtures are public compatibility and security evidence. They must be minimal, reviewable, and free of real project data.

## Directories

- `artifacts/v1`: permanent version 1 valid, invalid, and canonical-byte compatibility fixtures. Public presentation wording remains provisional until maintainer Gate A.
- `artifacts/v1/legacy-schema`: frozen copies of earlier published schemas, used only to prove that a consumer which predates an additive change rejects the new content instead of misreading it. Never edited.
- `results/v1`: provisional machine-result fixtures until the result contract is accepted; `results/v1/prepare` holds the dependency-preparation results. `reproduced-normalized.json` and `not-reproduced-output-modes.json` show the exact and normalized output-matching evidence and differences; their messages are checked against the matcher, and they carry counts only, never output text.
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

The first artifact pair, a deterministic canonical byte fixture, and all four replay-result statuses are present. Milestone 2 tests preserve artifact compatibility, schema synchronization, and exact canonical serialization. Result fixtures retain status coverage and prevent detailed decoded output from entering public examples.
