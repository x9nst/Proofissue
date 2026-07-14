# Artifact Parsing, Serialization, and Atomic Write Contract

## Status

Implemented in Milestone 2. The bounded parser, semantic validator, deterministic serializer, regular-file reader, and no-overwrite atomic publisher follow this contract and are covered by golden, property, security, and compatibility tests. Public presentation compatibility remains provisional until maintainer Gate A.

## Parser Limits

The parser enforces these limits before or during canonical conversion:

| Item | Limit |
| --- | ---: |
| Artifact input bytes | 5 MiB |
| YAML documents | 1 |
| YAML nesting depth | 32 |
| YAML nodes | 10,000 |
| One YAML scalar after decoding | 1 MiB |
| Validation errors returned | 50 |
| One error message | 1,024 Unicode characters |
| Aggregate error-message text | 32 KiB |
| Paths retained in errors | 100 |
| One retained error path | 512 characters |

Aliases, anchors, merge keys, custom tags, duplicate mapping keys, unknown fields, and non-JSON-compatible values are rejected. Limit failures stop additional error collection when continuing would exceed a bound.

## Deterministic Serialization

Serialization uses:

- UTF-8 without a byte-order mark;
- LF line endings;
- two-space indentation;
- no tabs;
- one final LF and no additional blank line;
- fixed field order from `artifact-format.md` at every mapping level;
- list order from the canonical model, with files sorted by normalized path and redaction findings sorted by target then category;
- lowercase `true` and `false`;
- base-10 integers without leading zeros;
- canonical decimal CPU values with no exponent notation;
- `[]` for empty lists and `{}` for permitted empty mappings;
- double-quoted strings with JSON-compatible escapes by default.

Embedded UTF-8 file content may use a literal block only when it contains LF line endings and no carriage return or disallowed control character. Chomping is exact:

- `|-` for no trailing LF;
- `|` for exactly one trailing LF;
- `|+` for more than one trailing LF.

Content containing carriage returns or characters that cannot be preserved by a literal block uses a double-quoted scalar with explicit escapes. Serialization must round-trip the exact canonical Unicode string and file hash.

Golden fixtures cover empty collections, quoting, Unicode, tabs in content, LF and CRLF content, no trailing newline, one trailing newline, multiple trailing newlines, and every fixed field order.

## Output Publication

Artifact creation never overwrites an existing path.

1. Validate the complete canonical artifact before opening output.
2. Resolve the output parent without following an output-path symbolic link.
3. Create a same-directory temporary regular file with exclusive creation and mode `0600` where supported.
4. Write the complete serialized bytes.
5. Flush the file contents and close it.
6. Publish without replacement by atomically creating the final directory entry from the temporary file on the same filesystem.
7. Flush the parent directory where the platform supports it.
8. Remove the temporary name.

The planned implementation uses same-filesystem no-replace publication, such as an atomic hard-link step. If the platform or filesystem cannot provide the required no-replace guarantee, creation fails with `atomic_write_failed`; it does not fall back to an overwriting rename or non-atomic copy.

Temporary names contain random data but never artifact content. Failed writes make a bounded cleanup attempt. A pre-existing file, directory, or symbolic link at the output path is an error. Cross-filesystem publication is unsupported because the temporary file is always created in the output directory.

Windows and Linux behavior receive separate tests for pre-existing outputs, symbolic links or junctions, write failure, flush failure, publication races, unsupported hard links, and temporary-file cleanup.
