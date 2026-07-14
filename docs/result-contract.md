# Machine-Readable Result Contract

## Status

Version 1 draft accepted for implementation behind provisional interfaces. It is versioned independently from the artifact schema. Public compatibility begins only after Milestone 2 readiness and fixture review pass.

The neutral TypeScript owner is `packages/contracts`. The package is declarative and contains no parsing, filesystem, container, adapter, or orchestration behavior.

## Common Envelope

Every operation result contains:

```text
result_schema_version: 1
operation: record | validate | inspect | replay
status: operation-specific value
artifact_version: optional artifact version
artifact_digest: optional digest
warnings: bounded typed warning list
errors: bounded typed error list
```

Limits:

- at most 50 warnings;
- at most 50 errors;
- each code at most 128 ASCII characters;
- each human message at most 1,024 Unicode characters after control escaping;
- total warning and error message text at most 32 KiB;
- attacker-controlled detail maps use documented keys and bounded scalar values only.

Human output renders this outcome. It is not a separate classification source.

## Error Codes

Version 1 draft top-level codes are:

- `malformed_input`
- `unsupported_artifact_version`
- `schema_violation`
- `semantic_violation`
- `policy_rejection`
- `unsafe_checkout_file`
- `image_unavailable`
- `engine_unavailable`
- `engine_capability_unavailable`
- `container_creation_failed`
- `timeout`
- `resource_termination`
- `cleanup_failed`
- `record_command_failed`
- `atomic_write_failed`
- `internal_error`

Free-form messages explain a code but never replace it. Errors are safe, bounded, and do not contain raw command output, file contents, credentials, or unescaped control characters.

## Replay Envelope

Replay adds:

- `status`: `reproduced`, `not_reproduced`, `invalid_artifact`, or `execution_failed`;
- `mode`: `snapshot` or `current_checkout`;
- approved image digest and effective limits when authorized;
- bounded execution summary when execution began;
- evidence and differences;
- substituted subject paths;
- explicit scope limitations;
- cleanup summary.

The public execution summary includes byte counts, truncation, decoding-replacement flags, duration, exit or signal facts, and termination reason. Full stdout and stderr are absent by default.

Cleanup errors do not erase the original error. An incomplete required cleanup prevents a successful replay classification.

## Classification and Policy

Required-status policy is evaluated after classification. It produces adapter success or failure without mutating the underlying operation result. CLI and GitHub Action adapters consume the same application outcome.

GitHub-specific annotations, step outputs, and workflow fields do not enter this contract.

## Inspection Envelope

A successful inspection adds a content-free summary of the runtime, pinned image, command shape, declared file paths and hashes, expectation counts, and redaction metadata. Redaction findings are grouped by target and category with counts. File content, command arguments, expected output text, replacement fields, and removed values are not returned by the stable inspection result.

## Fixtures and Validation

Before compatibility is claimed, retain valid fixtures for every operation and all four replay statuses. Tests verify:

- result version and operation-specific status;
- bounds on every list and string;
- safe encoding of hostile text;
- equivalent human and JSON classifications;
- required-status policy leaves classification unchanged;
- cleanup and original errors can coexist;
- unsupported result versions fail explicitly.
