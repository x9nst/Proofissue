# Artifact Format

## Status

This is the accepted design for the technical prototype slice and a provisional proposal for artifact version 1. Presentation details remain provisional until maintainer Gate A is completed. The executable JSON Schema, golden fixture, and compatibility tests will be created in Milestone 2 before the interface is called stable.

## Container

A version 1 artifact is one UTF-8 YAML document with a `.proofissue` extension. It embeds all selected file content and can be validated without running its command.

It is not an archive and must not contain multiple YAML documents, custom YAML tags, anchors, aliases, or merge keys.

## Illustrative Artifact

The digest values below are illustrative placeholders, not a runnable image selection.

```yaml
version: 1
environment:
  runtime: node
  runtime_version: "24"
  operating_system: linux
  image: "node@sha256:0000000000000000000000000000000000000000000000000000000000000000"
capture:
  host_operating_system: win32
  host_architecture: x64
  node_version: "24.15.0"
command:
  program: node
  arguments:
    - test/reproduction.mjs
  working_directory: .
files:
  - path: test/reproduction.mjs
    role: reproduction
    encoding: utf8
    content: |-
      import { calculate } from "../src/calculate.mjs";
      if (calculate(2) !== 4) {
        console.error("Expected 4 from calculate(2)");
        process.exit(1);
      }
    sha256: "1111111111111111111111111111111111111111111111111111111111111111"
  - path: src/calculate.mjs
    role: subject
    encoding: utf8
    content: |-
      export function calculate(value) {
        return value + 1;
      }
    sha256: "2222222222222222222222222222222222222222222222222222222222222222"
expect:
  exit_code: 1
  stdout: []
  stderr:
    - mode: contains
      value: "Expected 4 from calculate(2)"
limits:
  timeout_seconds: 60
  memory_mb: 512
  cpus: 1
  processes: 64
  output_bytes_per_stream: 1048576
redaction:
  enabled: true
  findings: []
```

## Canonical Model

All mappings reject unknown fields. All required fields must be present, including empty expectation and finding lists. This keeps producer behavior consistent and makes omissions visible.

### Top-level fields

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `version` | Selects parsing and compatibility rules | Required integer; exactly `1` |
| `environment` | Declares the isolated replay runtime | Required mapping described below |
| `capture` | Records minimal source-environment facts | Required mapping; no user, hostname, path, or environment variables |
| `command` | Declares the single replay command | Required mapping; one command only |
| `files` | Carries the explicit replay workspace | Required list; 1-100 unique paths |
| `expect` | Describes the captured failure | Required mapping; exact exit and bounded literal checks |
| `limits` | Bounds replay resources | Required mapping; values cannot exceed version 1 ranges |
| `redaction` | States whether and where redaction occurred | Required mapping; never stores removed values |

### `environment`

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `runtime` | Selects the runtime adapter | Required enum; only `node` in version 1 |
| `runtime_version` | Selects the supported Node.js major | Required decimal string; only supported majors accepted by local policy |
| `operating_system` | States replay operating system | Required enum; only `linux` |
| `image` | Identifies the replay image immutably | Required `repository@sha256:<64 lowercase hex>` string; maximum 255 characters; must pass local allowlist policy |

The schema proves syntax. The runner separately proves that the digest is approved. A syntactically valid artifact cannot force use of an arbitrary image.

### `capture`

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `host_operating_system` | Helps explain host/replay differences | Required enum: `win32`, `darwin`, or `linux` |
| `host_architecture` | Records the Node.js architecture label | Required allowlisted string; maximum 32 characters |
| `node_version` | Records the reporter's Node.js version | Required semantic-version string without arbitrary suffix data; maximum 64 characters |

No capture timestamp is included because it does not help replay and prevents otherwise identical artifacts from being identical. No environment-variable values are collected in version 1.

### `command`

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `program` | Names the executable inside the approved image | Required; exactly `node` in the technical prototype |
| `arguments` | Preserves the argument boundaries | Required list; 1-128 strings; each at most 8 KiB; NUL and control characters other than tab are invalid |
| `working_directory` | Sets the command location inside the reconstructed workspace | Required; exactly `.` in the technical prototype |

Arguments are passed directly to the container process. They are never concatenated into a host or container shell command.

### `files[]`

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `path` | Names the workspace-relative destination | Required normalized forward-slash path; maximum 512 characters; unique after normalization |
| `role` | Controls snapshot and current-checkout replay | Required enum: `reproduction` or `subject` |
| `encoding` | Defines content decoding | Required; exactly `utf8` in version 1 |
| `content` | Carries the selected file | Required Unicode string whose UTF-8 encoding is at most 1 MiB |
| `sha256` | Detects changed or incorrectly reconstructed content | Required 64-character lowercase hexadecimal digest of the exact UTF-8 bytes represented by `content` |

At least one reproduction file and one subject file are required for the first end-to-end fixture. Total decoded file content may not exceed 4 MiB.

Current-checkout replay substitutes only declared, existing `subject` paths. It does not discover newly added files. A removed or renamed declared subject path is missing and causes replay preparation to fail. The artifact roles therefore support targeted file replacement, not a complete overlay of an arbitrary current checkout.

Line endings are part of `content` and its digest. The deterministic writer must use YAML scalar forms that preserve the canonical string; it must not silently normalize file content.

Version 1 paths use only ASCII letters, digits, `_`, `-`, `.`, and `/`. Invalid paths include absolute paths, empty paths or segments, `.` or `..` segments, backslashes, drive prefixes, UNC paths, NUL bytes, control characters, exact duplicates, and ASCII case-collisions. This deliberately narrow rule avoids cross-platform normalization ambiguity.

### `expect`

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `exit_code` | Identifies the expected command termination | Required integer from 0 through 255; nonzero in the first failing example |
| `stdout` | Matches literal standard-output evidence | Required list; 0-16 entries shared with stderr |
| `stderr` | Matches literal standard-error evidence | Required list; 0-16 entries shared with stdout |

Each output entry contains:

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `mode` | Makes matching behavior explicit | Required; exactly `contains` in the technical prototype |
| `value` | Holds the expected literal | Required nonempty string; maximum 8 KiB |

A failing expectation must contain at least one stdout or stderr entry. Values containing a redaction replacement are invalid because they cannot establish original failure identity.

### `limits`

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `timeout_seconds` | Bounds wall-clock execution | Required integer, 1-300; default producer value 60 |
| `memory_mb` | Bounds container memory | Required integer, 64-2048; default 512 |
| `cpus` | Bounds CPU allocation | Required number, 0.25-2; default 1 |
| `processes` | Bounds process count | Required integer, 8-256; default 64 |
| `output_bytes_per_stream` | Bounds captured stdout and stderr separately | Required integer, 1024-1048576; default 1048576 |

Producers write every value rather than relying on runner defaults. A runner may impose stricter local limits but must report that decision before execution.

### `redaction`

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `enabled` | Confirms the producer applied redaction | Required; exactly `true` for official version 1 artifacts |
| `findings` | Allows review without storing secret values | Required list; at most 100 findings |

Each finding contains:

| Field | Purpose | Validation and limit |
| --- | --- | --- |
| `category` | Explains what kind of value was removed | Required documented enum such as `api_key`, `authorization_header`, `private_key`, `password`, or `sensitive_environment` |
| `target` | Names the affected stream or selected file | Required `stdout`, `stderr`, or a valid selected file path |
| `replacement` | Shows the safe marker present in content | Required fixed-format marker containing category but no raw value; maximum 128 characters |

Offsets are not stored because later serialization and repeated replacements can make them misleading. The inspector reports findings grouped by target and category.

## Document-Level Limits

Before YAML parsing, the input must be a regular file no larger than 5 MiB. Parsing additionally enforces maximum nesting depth, total node count, scalar size, and collection sizes. The parser rejects duplicate mapping keys before conversion to the canonical model.

## Semantic Validation Order

Validation proceeds without side effects:

1. verify input file type and byte size;
2. parse one restricted YAML document under parser limits;
3. validate the JSON-compatible value against the version 1 JSON Schema;
4. normalize and validate paths;
5. reject path collisions and aggregate-limit violations;
6. recompute every file digest;
7. validate cross-field rules, including expectations and redaction targets;
8. apply local image and limit policy when preparing replay.

Steps 1-7 are static validation. Step 8 is local replay authorization and must still occur before workspace creation.

## Compatibility Rules

- A version 1 consumer rejects unknown fields rather than guessing their meaning.
- A producer must not emit fields outside the published version 1 schema.
- Additive fields require a new compatibility decision even if made optional.
- Every supported artifact version retains a parser fixture and compatibility test.
- Unsupported future versions produce `invalid_artifact` with an explicit version error.
- Artifact hashes prove content integrity only; they do not prove authorship or trust.
