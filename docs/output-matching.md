# Output Matching and Normalization

## Status

Implemented for the modes `contains` and `exact`, with optional normalization. The design, the choices that await maintainer sign-off, and the planned follow-up for bounded regular expressions are recorded in `decisions/0003-output-matching-modes.md`. This document describes what exists.

## Why

A failure recorded on one machine and replayed in a container is not byte-identical. A test runner prints durations, process IDs, a Node.js version trailer, and line numbers inside `node:` internals. A stack trace prints the reporter's project directory, which in the container is `/workspace`. A color terminal adds escape sequences. A literal expectation either avoids all of those, which forces reporters to pick short fragments, or it fails on the first replay.

Output matching lets an expectation say what to compare and what to ignore, explicitly and per expectation, and the result says which of the ignored things were actually present.

## Modes

Every output expectation has a `mode`:

| Mode | The expectation holds when |
| --- | --- |
| `contains` | The stored value appears somewhere in the stream. |
| `exact` | The whole retained stream equals the stored value. |

An expectation may also list `normalize` rules. When it does, the replay stream is normalized with those rules before the comparison, and the stored value is already normalized. Without `normalize`, the comparison uses the redacted stream as it is, which is the original behavior: a `contains` entry without `normalize` is the prototype's literal check, byte for byte.

An exact comparison can never be established for a truncated stream, because bytes were discarded. The result is `insufficient_output`, never a match or a difference.

An artifact holds at most 16 output expectations in total, and each stored value is at most 8192 UTF-8 bytes, so an `exact` expectation can describe a stream of at most that size.

## Where normalization runs

Normalization is a pure function of redacted text, the rule list, and a path context. It never runs on raw bytes, never before redaction, and never on a stream for a raw expectation.

```text
Record:  raw bytes → bounded retention → UTF-8 decoding → redaction → normalization* → stored value
Replay:  raw bytes → bounded retention → UTF-8 decoding → redaction → normalization* → comparison

* only for expectations that list `normalize`
```

The record path context holds the reporter's own directories. The replay path context is fixed: replay always runs in `/workspace` with `/tmp` as the temporary directory (the runner exports both names, and a container test proves a replayed command sees exactly these). Classification therefore depends only on the program's redacted output and exit code, not on the machine that runs ProofIssue. The exit code is always compared exactly.

## The rules

A rule list is explicit for each expectation. Rules apply in the canonical order below, and an artifact must list a subset in that order, so each intent has one spelling. Every rule is linear in the length of the text. The `record` command options apply all eight rules.

| # | Name | What it does | Replacement |
| --- | --- | --- | --- |
| 1 | `line_endings` | `\r\n` and then any remaining `\r` become `\n`. | none |
| 2 | `ansi_escapes` | Removes terminal escape sequences. | none |
| 3 | `trailing_whitespace` | Removes spaces and tabs at the end of every line and at the end of the text. | none |
| 4 | `paths` | Replaces the exact project and temporary directories, in every spelling the platform prints. | `<project>`, `<tmp>` |
| 5 | `node_version` | `Node.js v24.15.0` becomes `Node.js <node-version>`. | `<node-version>` |
| 6 | `node_internal_locations` | The line and column of `node:` frames. | `<line>`, `<column>` |
| 7 | `process_ids` | `(node:2196)` becomes `(node:<pid>)`. | `<pid>` |
| 8 | `durations` | Test-runner durations. | `<duration>` |

### `line_endings`

`a\r\nb\rc` becomes `a\nb\nc`. The count is the number of carriage returns replaced.

### `ansi_escapes`

A hand-written scanner removes these, and nothing else:

- control sequences: ESC `[`, parameter bytes `0x30-0x3F`, intermediate bytes `0x20-0x2F`, and a final byte `0x40-0x7E`, for example `ESC[31m`;
- the single-character control-sequence introducer U+009B, followed by the same;
- operating-system commands: ESC `]` through BEL or through ESC `\`, for example terminal titles and hyperlinks (the link text is kept);
- nF sequences: ESC, intermediate bytes `0x20-0x2F`, and a byte `0x30-0x7E`, for example `ESC(B`;
- two-character sequences: ESC and one byte `0x30-0x7E`, for example `ESC7`.

An escape character or U+009B that does not start a valid sequence is removed alone, and what follows stays. Device control strings are not recognized as strings: only the introducer is removed. The output never contains ESC or U+009B, which makes the rule idempotent. The count is the number of sequences and lone characters removed.

### `trailing_whitespace`

Spaces (U+0020) and tabs (U+0009) before every line feed and at the end of the text are removed. Other Unicode spaces are kept. The count is the number of lines changed.

### `paths`

This rule works from exact roots, not heuristics. It never guesses that some other absolute path is a project path.

The record context knows the real project directory (as given and as resolved), the temporary directory (as `os.tmpdir()` reports it, resolved, and the platform default), and every declared artifact path. The replay context is `/workspace` and `/tmp`.

For each root, every spelling a program can print is replaced:

- POSIX: the path and its `file://` URL.
- Windows: the native path (`D:\src\project`), the escaped path that `util.inspect` and TAP print (`D:\\src\\project`), the forward-slash path (`D:/src/project`), and the `file:///` URL, each with the drive letter in either case.

The longest spelling wins, so a project inside the temporary directory becomes `<project>`. A root is replaced only as a whole path component: `/srv/app` is not replaced inside `/srv/app2`, `/srv/app.bak`, `/data/srv/app`, or after a closing `>`. The separators of the path that follows (a run of `/`, `\`, or `\\` joined to plain file-name characters `A-Za-z0-9_.~@+%-`) become `/`. On a Windows recording, a declared relative path printed with backslashes (`test\reproduction.mjs`) becomes `test/reproduction.mjs`.

Filesystem roots, relative roots, roots over 1024 characters, and roots containing control characters are ignored. The count is the number of replacements.

```text
D:\src\project\test\a.mjs:3:9          →  <project>/test/a.mjs:3:9
file:///D:/src/project/test/a.mjs:3:9  →  <project>/test/a.mjs:3:9   (and the same text on replay)
file:///workspace/test/a.mjs:3:9       →  <project>/test/a.mjs:3:9
```

### `node_version`, `node_internal_locations`, `process_ids`

| Before | After |
| --- | --- |
| `Node.js v24.15.0` | `Node.js <node-version>` |
| `node:internal/test_runner/test:1201:25` | `node:internal/test_runner/test:<line>:<column>` |
| `(node:2196) Warning` | `(node:<pid>) Warning` |

Only `node:` frames lose their line and column. A `file:` frame, or a frame in your own code, is left alone.

### `durations`

| Before | After |
| --- | --- |
| `(2.4784ms)`, `(52ms)`, `(3 ms)` | `(<duration>)` |
| `duration_ms: 48.6749`, `duration_ms 9.9138` | `duration_ms: <duration>`, `duration_ms <duration>` |
| `Time:        1.234 s` | `Time:        <duration>` |
| `Duration  1.23s (transform 20ms)` | `Duration  <duration> (transform <duration>)` |

A number counts as a duration only when it stands alone: `v1.2.3ms`, `id12ms`, `3s`, `5 sec`, and `12msg` are left alone, and seconds need a decimal point.

## Tokens

The tokens `<project>`, `<tmp>`, `<node-version>`, `<line>`, `<column>`, `<pid>`, and `<duration>` are part of the rules' definitions. They are not special characters in the matching language, and Node.js itself prints tokens in this style (`<anonymous>`).

Known limitation: output that literally contains `<project>` is treated as equal to the project path.

A closing angle bracket blocks a path root and starts no word boundary for the later rules. That keeps the rule chain idempotent: normalizing a normalized value changes nothing, which is why a normalized value can be validated without a path context.

## What the result says

Every explanation is a fixed sentence built from counts and positions. It never contains an expected value or any output text.

| Situation | Message |
| --- | --- |
| `contains`, found | `Expected stderr text was present.` |
| `contains`, found after normalization | `Expected stderr text was present after normalization; normalization changed 2 line endings and 1 duration in the replay output.` |
| `contains`, absent | `Expected stderr text was not present.` |
| `contains`, truncated and absent | `Retained stderr was truncated before the expected text could be established.` |
| `exact`, equal | `Replay stdout matched the expected output exactly.` |
| `exact`, equal after normalization | `Normalized replay stdout matched the expected output exactly; normalization changed nothing in the replay output.` |
| `exact`, different | `Replay stderr differed from the expected output at line 2, column 9 (expected 28 characters, received 28).` |
| `exact`, truncated | `Retained stderr was truncated, so its exact content could not be established.` |

Line and column are 1-based and count Unicode code points. Lengths are code points. A normalized evidence or difference item also carries a `normalization` object naming the requested rules (in canonical order) and the number of replacements each made in the replay output; rules that changed nothing are omitted. See `result-contract.md`.

## Choosing an expectation

| You want to say | Use |
| --- | --- |
| This exact text appears, and nothing about it varies | `--expect-stderr <literal>` |
| This text appears, but durations, paths, escape sequences, or line endings may differ | `--expect-stderr-normalized <text>` |
| The whole output is the failure, and it fits in 8 KiB | `--expect-stderr-exact` (raw) or `--expect-stderr-exact-normalized` |
| A number is the point of the bug (a count, a version, a size) | A raw literal. Normalization would hide a change to it. |

## Known limitations

- Normalized tokens hide changes to durations, process IDs, Node.js internal line numbers, the Node.js version, and path roots. A fix that changes only one of those is not visible to a normalized expectation.
- Output that literally contains `<project>` collides with the path token.
- Not normalized: path tails that contain spaces; backslash relative paths that are not declared files (for example `node_modules\...` on Windows); timestamps, ports, and random suffixes; and test-runner marks that differ by platform (mocha prints different symbols on Windows).
- The command-line options always apply all eight rules. The artifact format allows any subset.
- `exact` is limited to what fits in one stored value, 8 KiB.
- `insufficient_output` classifies as `not_reproduced`, so `--require-status not_reproduced` can pass when the stream was truncated. This predates output modes.
- Human `inspect` still prints only the status line; use `--json` for the expectation modes and rules.
- Regular-expression matching is not implemented yet. It is the next step in `decisions/0003-output-matching-modes.md`.
