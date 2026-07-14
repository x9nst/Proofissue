# Milestone 2 Evidence

## Status

Milestone 2 — Static Artifact Core is complete. ProofIssue can read, validate, inspect, and deterministically write version 1 artifacts without executing their commands or creating a replay workspace.

The artifact's human presentation and public compatibility promise remain provisional until the external maintainer Gate A review. This does not defer the completed static implementation or its retained compatibility fixtures.

## Acceptance record

| Acceptance criterion | Evidence |
| --- | --- |
| Valid fixtures pass schema and semantic validation | The original version 1 fixture and the canonical byte fixture pass the published JSON Schema, digest checks, path rules, aggregate rules, and cross-field checks. |
| Hostile or invalid artifacts are rejected | Tests cover unknown fields, duplicate and case-colliding paths, absolute and traversal paths, malformed YAML, duplicate keys, aliases, anchors, tags, multiple documents, invalid hashes and limits, invalid UTF-8, excessive depth and nodes, oversized file content, and oversized input. |
| Validation is static | An integration test embeds a command that would create a sentinel file, validates the artifact, and proves the sentinel was never created. Validation only reads the selected regular artifact file. |
| Serialization is deterministic | Repeated serialization is byte-identical. A permanent canonical fixture fixes field order, quoting, indentation, LF behavior, and the final newline. Generated cases preserve empty content, Unicode, tabs, CRLF, and zero, one, or multiple trailing line feeds. |
| Inspection is safe | The application inspection service reports file identities, counts, execution limits, and grouped redaction categories and targets. It omits file content, expectation text, replacement fields, and removed values. |
| Compatibility is retained | The published JSON Schema is checked against the executable schema, and permanent version 1 valid, invalid, and canonical fixtures run in the normal test suite. |
| Generated invariants hold | Property tests cover canonical round trips, exact file content and hashes, safe path resolution, traversal rejection, duplicate collision handling, and bounded random byte inputs. |
| Parser failures are bounded | The parser enforces the accepted 5 MiB input, 32-level depth, 10,000-node, 1 MiB scalar, 50-error, and 32 KiB aggregate-message limits. A reusable restricted-YAML corpus is retained under `tests/fuzz-corpus/yaml`. |

## Security and compatibility impact

Artifacts remain untrusted until both schema and semantic validation succeed. Symbolic-link and non-regular inputs are rejected, output paths are never overwritten, and publication uses a same-directory exclusive temporary file plus no-replace hard-link publication. Failed publication makes a bounded temporary-file cleanup attempt.

Version 1 intentionally rejects unknown fields and ambiguous YAML features. File paths use the narrow cross-platform-safe grammar documented in `artifact-format.md`. The fixture and schema are now permanent test evidence, while public stability language remains withheld pending maintainer review.

## Verification run — 2026-07-14

Environment:

- Windows host
- Node.js 24.15.0
- npm 11.12.1

Commands and results:

1. `npm ci` — passed from the updated lockfile; 194 packages audited with no reported vulnerabilities.
2. `npm run check` — passed after the clean installation.
3. Formatting — passed.
4. Linting — passed with zero warnings.
5. Dependency boundaries — passed for all 11 workspaces.
6. Strict type checking — passed.
7. Tests — 37 tests in 6 files passed.
8. Build — passed.
9. Repository hygiene — passed.
10. `git diff --check` — passed with no whitespace errors.
