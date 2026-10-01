# Machine-Readable Result Contract

## Status

Version 1 draft accepted for implementation behind provisional interfaces. It is versioned independently from the artifact schema. Public compatibility begins only after Milestone 2 readiness and fixture review pass.

The neutral TypeScript owner is `packages/contracts`. The package is declarative and contains no parsing, filesystem, container, adapter, or orchestration behavior.

## Common Envelope

Every operation result contains:

```text
result_schema_version: 1
operation: record | validate | inspect | prepare | replay
status: operation-specific value
artifact_version: optional artifact version
artifact_digest: optional digest
warnings: bounded typed warning list
errors: bounded typed error list
```

`artifact_digest` is the lowercase hexadecimal SHA-256 of the exact bytes of the
`.proofissue` file. `record`, `validate`, `inspect`, `prepare`, and `replay` report the same
value for the same file, so a digest printed when an artifact is created can be
compared with the digest reported when it is later validated or replayed.

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
- `dependencies_not_prepared`: the artifact carries dependency files and the prepared store is missing, unusable, or incomplete.
- `dependency_install_failed`: the offline install inside the sandbox did not complete. The message may carry one npm error code such as `ENOSPC` and never any package text.
- `lockfile_rejected`: the artifact's lockfile failed validation, so nothing was fetched. `details.reason` is the lockfile error code and `details.package_path` the offending `node_modules/...` location, truncated to 200 characters.
- `dependency_download_failed`: a package could not be downloaded or verified. `details.reason` is the download error (`integrity_mismatch`, `http_status`, `redirect_refused`, `content_encoding_refused`, `size_limit_exceeded`, `total_size_limit_exceeded`, `timeout`, `cancelled`, `network_error`, `url_refused`), `details.http_status` the status code for `http_status`, and `details.package_path` the location, truncated to 200 characters.
- `dependency_store_unusable`: the store location was unsafe or not writable. `details.reason` is `store_unsafe` or `store_write_failed`.
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

## Prepare Envelope

`prepare` turns an artifact's locked npm packages into a verified local store for a later offline replay. It adds:

- `status`: `prepared`, `not_required`, `invalid_input`, `invalid_artifact`, or `execution_failed`;
- `preparation`, present only when `prepared`: `packages` (install locations for the replay platform), `downloaded_tarballs`, `downloaded_bytes`, `reused_tarballs`, `skipped_for_platform`, and `install_script_packages`.

`not_required` means the artifact has no dependency files: nothing was fetched and no store was created. `invalid_artifact` covers both an invalid artifact and an unusable lockfile (`lockfile_rejected`); in both cases nothing was fetched and the store was not touched. `invalid_input` means no store directory was given.

Packages that declare install scripts produce at most one aggregated warning, `install_scripts_not_run`, carrying a count and no package names. The result never contains package names, tarball paths, response bodies, or the store location. The only `details` keys are `reason`, `package_path` (a validated `node_modules/...` key of at most 200 characters), and `http_status`.

A failed preparation is `execution_failed` and is never evidence about the original failure. Replay reports a missing or incomplete store as its own `dependencies_not_prepared` error.

## Classification and Policy

Required-status policy is evaluated after classification. It produces adapter success or failure without mutating the underlying operation result. CLI and GitHub Action adapters consume the same application outcome.

GitHub-specific annotations, step outputs, and workflow fields do not enter this contract.

## Inspection Envelope

A successful inspection adds a content-free summary of the runtime, pinned image, command shape, declared file paths and hashes, expectation counts, and redaction metadata. Redaction findings are grouped by target and category with counts. File content, command arguments, expected output text, replacement fields, and removed values are not returned by the stable inspection result.

## Fixtures and Validation

Before compatibility is claimed, retain valid fixtures for every operation and all four replay statuses. Prepare results are kept in `tests/fixtures/results/v1/prepare`. Tests verify:

- result version and operation-specific status;
- bounds on every list and string;
- safe encoding of hostile text;
- equivalent human and JSON classifications;
- required-status policy leaves classification unchanged;
- cleanup and original errors can coexist;
- unsupported result versions fail explicitly.
