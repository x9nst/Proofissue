# Process Output Handling

## Status

Accepted contract for the technical prototype. Recorder and runner implementations must share one pure decoding implementation and the same metadata rules.

## Capture Model

stdout and stderr are captured independently as raw byte streams. Process-read chunk boundaries have no semantic meaning.

For each stream:

1. count every byte received;
2. retain at most `limits.output_bytes_per_stream` bytes;
3. after the limit, continue draining and count discarded bytes without retaining them;
4. never send raw bytes to logs, previews, errors, snapshots, or adapters;
5. after execution, join the retained chunks in original order;
6. decode the complete retained byte buffer once.

Limits apply to raw bytes before decoding. `retained_bytes + discarded_bytes` equals `total_bytes`. `truncated` is true when at least one byte was discarded.

## UTF-8 Decoding

The shared decoder uses the standard UTF-8 replacement algorithm:

- valid UTF-8 becomes the corresponding Unicode text;
- invalid byte sequences become U+FFFD;
- a leading UTF-8 byte-order mark is omitted;
- a retained buffer ending in a partial multibyte sequence produces U+FFFD;
- decoding never fails the operation by itself.

Before replacement decoding, the implementation checks the retained bytes with fatal UTF-8 validation. `had_decoding_replacement` is true when fatal validation rejects the retained byte sequence. It is not inferred from the presence of U+FFFD in decoded text because U+FFFD may have been valid source text.

Decoding replacement and truncation are independent metadata. A stream may have either, both, or neither.

## Redaction Model

The technical prototype uses whole-buffer redaction:

1. retain bounded raw bytes;
2. decode the complete retained buffer;
3. redact the complete bounded decoded string once;
4. use only redacted text for preview, matching, human output, and any optional detailed structured output.

The redactor does not receive process-read chunks. Different read chunking for the same retained bytes must produce identical decoded and redacted results.

A secret cut by the retention boundary may be incomplete and therefore undetectable. Truncation is always visible, and matching cannot treat discarded bytes as evidence. Minimal environment exposure and bounded clean execution remain primary controls; redaction is defense in depth.

## Matching

Literal matching operates on redacted decoded bounded text, separately for stdout and stderr. It does not operate on raw bytes.

An expectation containing a redaction marker is invalid. If output was truncated and a required literal is absent, the difference records insufficient bounded evidence rather than claiming that discarded output did or did not contain the literal.

## Public Result Boundary

The internal bounded execution result may carry redacted decoded text so the matcher can operate. The stable operation-result envelope does not include full stdout or stderr by default. It includes byte counts, truncation, decoding-replacement metadata, termination facts, evidence, and bounded differences.

Adapters may offer an explicitly requested detailed view later, but it must use the same redacted bounded text and must not change classification.

## Required Tests

- valid multibyte text split across process reads;
- invalid UTF-8 and stable U+FFFD replacement;
- a raw-byte limit cutting through a multibyte sequence;
- leading UTF-8 byte-order mark handling;
- very long output that remains safely drained;
- identical retained bytes split into different chunks;
- secrets at buffer start, end, and near truncation;
- multiple and overlapping redaction candidates;
- matching after replacement decoding;
- independent stdout and stderr metadata;
- no raw synthetic secret in findings, errors, logs, snapshots, or JSON.
