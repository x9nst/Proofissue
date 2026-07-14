# Fixture Policy

Fixtures are public compatibility and security evidence. They must be minimal, reviewable, and free of real project data.

## Directories

- `artifacts/v1`: provisional version 1 artifact fixtures until Milestone 2 freezes the executable schema.
- `results/v1`: provisional machine-result fixtures until the result contract is accepted.
- `synthetic-secrets`: unmistakably fake values used only to prove redaction and leakage checks.

## Rules

- Never copy a credential, private repository file, username, hostname, or absolute local path into a fixture.
- Synthetic credentials must use reserved example domains or obvious `SYNTHETIC_TEST_ONLY` markers.
- Snapshot output must contain replacement markers, never the original synthetic secret.
- Every supported artifact and result schema version retains compatibility fixtures.
- A compatibility fixture is not reformatted merely because a newer serializer changes style.
- Provisional fixtures are clearly labeled and carry no compatibility promise.

The first provisional artifact pair and all four replay-result statuses are present. Artifact fixtures become executable schema evidence in Milestone 2; result fixtures already have a foundation test that preserves status coverage and prevents detailed decoded output from entering the public examples.
