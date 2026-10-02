# Decision 0003: Exact, Normalized, and Bounded Regular-Expression Output Matching

**Status:** Proposed on 2026-10-01. The `contains`, `exact`, and `regex` modes and output normalization are implemented with the defaults below. Every item marked *assumed; awaiting maintainer sign-off* was implemented with the recommended default and should be confirmed or changed in review.  
**Date:** 2026-10-01

## Context

Decision 0001 deferred exact output matching, normalized matching, and regular-expression matching so the technical prototype could stay small: an exact exit code and literal substring checks. Milestone 7 lists all three as deliverables, because the initial supported Node.js workflow has to compare a failure recorded on one machine with a replay in a container.

Real failures are not byte-identical across those two places. A test runner prints durations, process IDs, Node.js version trailers, and line numbers inside `node:` internals. A stack trace prints the reporter's project directory, and the replay runs in `/workspace`. A terminal run adds color escape sequences. A literal expectation either has to avoid every one of those, which forces reporters to pick short fragments, or it fails on the first replay.

This decision adds three things, each additive and explainable:

1. a per-expectation **match mode**: `contains` (today's behavior), `exact`, and `regex`;
2. a per-expectation list of **normalization rules**, each with a frozen definition;
3. result evidence that says which mode and which normalization produced each match or difference, without publishing output.

The project guardrails still apply: matching must be deterministic and explainable, replay must stay bounded, and nothing may be added that cannot be described in a few fixed sentences.

### Constraints that already exist

| Constraint | Source |
| --- | --- |
| Matching is deterministic and explainable; confidence scores are not used. | `AGENTS.md`, Engineering Principles |
| Technical prototype modes are exit code and substring; later modes include exact, normalized, and safely bounded regular-expression matching. | `AGENTS.md`, `packages/matcher` |
| Redaction happens before artifacts are written and before replay output is matched; redaction markers are never evidence. | `output-handling.md`; `artifact-format.md` |
| Expectation values are 1 to 8192 UTF-8 bytes and an artifact has at most 16 expectations in total. | `ARTIFACT_LIMITS`; `artifact-format.md` |
| The artifact schema is provisional; existing artifacts must keep parsing and replaying identically. | `artifact-format.md`; decision 0002, item 5 |
| Version 1 objects are closed, so a consumer that does not know a field rejects it with `schema_violation`. | `schema.ts` |
| Public results never carry expected values or output text. | `result-contract.md` |

## Options and rationale

### D1. Artifact representation

**Options.** (a) A new artifact version 2. (b) A separate `match:` section beside `expect:`. (c) Additive fields on each existing output expectation inside version 1.

**Choice: (c).** Each entry becomes:

```yaml
- mode: contains | exact | regex  # required
  normalize:                       # optional; present means compare normalized output
    - line_endings
    - ...                          # non-empty, unique, in documented order
  value: "..."                     # required, 1..8192 UTF-8 bytes
```

- `contains` without `normalize` is exactly today's behavior and serializes to the same bytes, so existing artifacts are unchanged and replay identically.
- `exact` means the whole retained redacted stream, after the listed rules if any, equals `value`.
- `regex` means the stored value is a pattern in the bounded language (D3) that matches somewhere in the stream, after the listed rules if any.
- The stored value for a normalized `contains` or `exact` entry is already normalized. A `regex` pattern is stored as typed and matched against the normalized stream. The artifact never stores a host path, so replay never needs one.

A version bump would force migration machinery for no safety gain: the schema is provisional, decision 0002 set the precedent for an additive change, and closed objects already make a consumer that predates the change reject the new content. A separate `match:` section would duplicate the per-stream lists and break the existing ordering semantics.

**How an older consumer is shown to reject the new content.** A frozen copy of the current published schema is committed and a test proves it rejects every new fixture.

### D2. Normalization rules

Each expectation lists its rules explicitly. The canonical order is also the application order, and the artifact must list rules in that order (a semantic rule, so there is one spelling per intent). Each rule name's documented definition is frozen. A changed definition gets a new name. Because the schema enumerates names, a future rule is rejected by older consumers instead of being silently ignored.

| # | Name | What it does | Token |
| --- | --- | --- | --- |
| 1 | `line_endings` | `\r\n` and then any remaining `\r` become `\n`. | none |
| 2 | `ansi_escapes` | Removes terminal escape sequences (CSI, OSC, two-character, and the single-character CSI introducer). A stray escape character is removed alone. | none |
| 3 | `trailing_whitespace` | Removes spaces and tabs at the end of every line and at the end of the text. | none |
| 4 | `paths` | Replaces exact, known directories (the project and the temporary directory, in every spelling the platform can print) and fixes separators after them. | `<project>`, `<tmp>` |
| 5 | `node_version` | `Node.js v24.15.0` becomes `Node.js <node-version>`. | `<node-version>` |
| 6 | `node_internal_locations` | The line and column of `node:` frames. | `<line>`, `<column>` |
| 7 | `process_ids` | `(node:1234)` becomes `(node:<pid>)`. | `<pid>` |
| 8 | `durations` | `duration_ms: 48.6749`, `(2.4784ms)`, `52ms`, `1.234 s`. | `<duration>` |

**Paths use exact roots, not heuristics.** The recorder knows the real project root and temporary directory. Replay always runs in `/workspace` with `TMPDIR` unset, so the temporary directory is `/tmp`. The `paths` rule replaces those literal directories, with word boundaries so `/srv/app` never matches inside `/srv/app2`, and never guesses at other absolute paths. Details are in `output-matching.md`.

**Angle-bracket tokens.** A token such as `<project>` is not a special character in the matching language, and Node already prints tokens in this style (`<anonymous>`). The known limitation is that output that literally contains `<project>` is treated as equal to the project path.

**Pipeline.** At record time: raw bytes, bounded retention, UTF-8 decoding, redaction, then normalization (only for expectations that list `normalize`) with the record-time path context. At replay time: the same order with the replay path context. Normalization never runs on raw bytes, never before redaction, and never on a stream for a raw expectation.

**Fixed point rule.** A normalized value must be unchanged by its own rules (with no path context). Otherwise it can never match, and validation rejects it. This relies on the rule chain being idempotent, which property tests check at scale. Those tests found one subtlety that is now part of the rule definitions: the tokens end in an angle bracket, so a later rule could create a word boundary (or a path root could follow a replaced number) that an earlier rule had been blocked by. A closing angle bracket is therefore treated like a name character in the left-hand boundary of the `paths`, `node_version`, `node_internal_locations`, and `durations` rules, and each pinned counterexample is a permanent regression test.

**Items for sign-off.**

- **[SIGN-OFF: rule names, tokens, and the CLI default of all rules]** The eight names, the token spellings, and the choice that every CLI option for normalized matching applies all eight rules. The artifact format supports any subset. *Assumed; awaiting maintainer sign-off.*

### D3. Regular expressions

**Choice.** An in-house, linear-time, Pike-VM engine over a documented subset of ECMAScript syntax, with deterministic step accounting. Every accepted pattern means the same as `new RegExp(pattern, 'mu').test(text)`, and differential property tests against V8 enforce that.

**Alternatives rejected.**

- **V8 `RegExp` with syntax or length limits.** Backtracking means even simple patterns such as `a*b` are quadratic over 1 MiB, and V8 regular-expression execution cannot be interrupted.
- **A worker thread with a timeout.** The outcome would depend on machine speed, which breaks determinism.
- **The `re2` npm package.** It is a native addon, which cannot go into the bundled Action.
- **`re2js` or RE2 compiled to WebAssembly.** Viable, with fuller syntax, but it adds third-party runtime code to the replay bundle and the supply chain and still needs a work bound. It is the recorded fallback if the in-house engine is judged too costly to maintain.

**Subset and limits.** Literals, `.`, multiline `^` and `$`, `\b`, `\d \w \s` and their negations, simple escapes, classes with ranges, groups, alternation, and the quantifiers `* + ? {n} {n,} {n,m}`. Backreferences, lookaround, named groups, modifiers, property escapes, and `\u`/`\x` escapes are rejected with a named reason and an offset. Patterns that can match without consuming output are rejected. The limits are fixed:

| Limit | Value |
| --- | --- |
| Pattern length | 1024 characters |
| Program size after repetition expansion | 2048 instructions |
| Repetition count | 100 |
| Group nesting | 16 |
| Steps per search | 20,000,000 instruction visits |

Exceeding the step limit is a deterministic `regex_step_limit` difference, never a match.

**Implementation.** The engine is in `packages/output-rules/src/regex`: a parser to an AST, a compiler to a Thompson/Pike program with instructions `char`, `set`, `assert`, `split`, `jump`, and `match`, and a search that advances every live thread one code point at a time. The program size is computed from the AST before anything is emitted, so `(a{100}){100}` is refused without building it. Every instruction visit counts as a step.

- **Meaning.** Accepted patterns mean what `new RegExp(pattern, 'mu')` means, with one documented exception: the match is attempted only at code point boundaries, as the specification defines it, and V8 additionally tries a pattern that begins with an assertion in the middle of a surrogate pair. The differential property tests compare against a sticky V8 match at every code point boundary for that reason, and a pinned case records the difference.
- **Evidence.** `stdout_regex` and `stderr_regex`; the differences `stdout_no_match`, `stderr_no_match`, and `regex_step_limit`; and `insufficient_output` when the stream was truncated and the pattern did not match.
- **Checked at validation.** The artifact validator compiles each pattern with the same compiler the matcher uses, rejects `REDACTED:` in a pattern, and applies the canonical order of `normalize` as for the other modes.
- **Checked at record time.** The recorder compiles the pattern before the command runs and then requires it to match the recording (normalized for the command-line options).
- **Calibration.** The full step limit takes roughly 0.4 to 0.7 seconds on the development machine, so the worst case across 16 expectations is bounded by about 10 seconds of matching before the process time limit applies.
- **A defect found on the way.** While running the differential tests, `String.prototype.codePointAt` on Node.js 24.15 returned a wrong lone surrogate (U+D83E for U+D83D) for a string it had read correctly a few hundred calls earlier, in a loop that searched the same concatenated string repeatedly, and it did so with optimizing compilers disabled as well. The engine and its parser therefore read code points with a small hand-written function over `charCodeAt`, which stayed correct over two million repeated searches. This is recorded so the workaround is not removed without a reason.

**Item for sign-off.**

- **[SIGN-OFF: in-house engine]** The choice of an in-house engine over `re2js`. *Assumed; awaiting maintainer sign-off.*

### D4. Package placement

A new pure package, **`@proofissue/output-rules`**, holds the normalization rules and path contexts and the bounded regular-expression language.

Static validation in `artifact-schema` has to use the same rule names, and later the same pattern parser, as matching, and `artifact-schema` must not depend on higher layers. New allowed edges:

- `output-rules` depends on `contracts` (for the rule-name type);
- `artifact-schema`, `matcher`, `recorder`, and `application` depend on `output-rules`.

There is no recorder-to-matcher edge. The check that a recording satisfies its own expectations runs in the application, which already depends on the matcher.

**Fallback if a new package is not wanted:** place the same modules inside `artifact-schema` and add a `matcher` → `artifact-schema` dependency edge.

`AGENTS.md` is not edited. Its structure list already omits `packages/dependencies`, so `docs/architecture.md` is where the package is documented.

**Item for sign-off.**

- **[SIGN-OFF: new package and dependency edges]** *Assumed; awaiting maintainer sign-off.*

### D5. Command line

`record` gains these options, in addition to the unchanged `--expect-stdout <literal>` and `--expect-stderr <literal>`:

| Option (both streams) | Artifact entry | Recorder derives |
| --- | --- | --- |
| `--expect-stdout-normalized <text>` / `--expect-stderr-normalized <text>` (repeatable) | `contains` with all rules | The reporter's text, normalized as printed locally; it must appear in the normalized recording |
| `--expect-stdout-exact` / `--expect-stderr-exact` (flag) | `exact`, raw | The whole redacted stream |
| `--expect-stdout-exact-normalized` / `--expect-stderr-exact-normalized` (flag) | `exact` with all rules | The whole normalized stream |

| `--expect-stdout-regex <pattern>` / `--expect-stderr-regex <pattern>` (repeatable) | `regex` with all rules | The pattern as typed; it is checked before the command runs and must match the normalized recording |

At most one `exact` expectation (raw or normalized) per stream; a repeat is a usage error with exit code 2. The regular-expression options are below. The `record` preview shows the mode and the rule list. `inspect --json` reports each expectation's mode and rules, never its value. The GitHub Action gains no inputs or outputs.

**Item for sign-off.**

- **[SIGN-OFF: public command line]** The option names, the flag form for `exact`, and the preview wording. *Assumed; awaiting maintainer sign-off.*

### D6. Result contract

Additive only. Evidence kinds `stdout_exact`, `stderr_exact`, `stdout_regex`, and `stderr_regex`; difference kinds `stdout_differs`, `stderr_differs`, `stdout_no_match`, `stderr_no_match`, and `regex_step_limit`; an optional `normalization` object on evidence and differences naming the rules the expectation asked for and how many replacements each made in the replay output; and `stdout_expectations` and `stderr_expectations` in the inspection summary. Messages are fixed sentences built from counts and positions and never contain expected values or output. Details are in `result-contract.md` and `output-matching.md`.

**Item for sign-off.**

- **[SIGN-OFF: result contract]** The new kinds, the `normalization` object, and the inspection fields. *Assumed; awaiting maintainer sign-off.*

### D7. Fix verification

Snapshot and current-checkout replay use the identical replay context (the same container paths and the same rules), so classification depends only on the redacted output and the exit code. A fix produces a missing, differing, or no-match difference.

What normalization cannot see: a change confined to a normalized token. A fix that only changes a duration, a PID, or a Node.js internal line number would go unnoticed, so the documentation recommends raw literals for numeric facts.

`insufficient_output` is "could not establish" and classifies as `not_reproduced`, as it already does for truncated literals. That means `--require-status not_reproduced` can pass on a truncated stream. This is a known limitation inherited from the prototype.

### D8. Recorder safety for the new modes

Raw `contains` is unchanged. For the new modes the recorder:

- derives the normalized value from the text as printed locally and requires it to appear in the normalized recording;
- refuses an `exact` expectation when the stream was truncated, is empty, exceeds 8192 bytes, or contains a redaction marker;
- compiles each regular-expression pattern before the command runs and requires it to match the (normalized) recording, and refuses a pattern that names the project or home directory;
- checks every stored value for a likely secret after normalization, because removing terminal escapes can join a token that redaction missed;
- refuses a stored value that still contains the project directory or the home directory in any spelling, because that value could not replay and would leak a user name.

The application then runs the matcher over the recording's own output with the record-time path context. A recording that does not satisfy its own expectations is rejected before any preview or file write.

## Decision

Adopt the design above, implemented in two changes: the first (modes `contains` and `exact`, all eight rules, the new package, the CLI options, results, fixtures, and documentation) and a second for bounded regular expressions (the `regex` mode, the engine, its options, results, fixtures, and documentation). Both are in place.

1. **Additive change inside artifact version 1, recorded here.** The schema stays provisional, existing artifacts stay valid, and a consumer that does not know the new content rejects it. This is the "new compatibility decision" that `artifact-format.md` requires. It must be revisited before the schema leaves provisional status. *(Assumed; awaiting maintainer sign-off.)*
2. **Normalization rules, names, and tokens as in D2.** *(Assumed; awaiting maintainer sign-off.)*
3. **A new `@proofissue/output-rules` package and its dependency edges as in D4.** *(Assumed; awaiting maintainer sign-off.)*
4. **The command-line options as in D5.** *(Assumed; awaiting maintainer sign-off.)*
5. **The additive result contract as in D6.** *(Assumed; awaiting maintainer sign-off.)*
6. **An in-house, linear-time engine for regular expressions rather than `re2js`.** Implemented with the recommended default: no new dependency, no native code, and no WebAssembly. *(Assumed; awaiting maintainer sign-off.)*

## Rule-versioning policy

- A normalization rule name has one frozen definition. Fixing a bug in a definition that changes outputs is a new rule name; the old name keeps its behavior.
- New rules are appended to the canonical order only when their relative order cannot change the result of earlier rules, and are enumerated in the schema so older consumers reject them.
- Renaming or removing a rule requires a documented migration, because artifacts that use it would otherwise stop validating.
- Tokens are part of a rule's definition and follow the same policy.

## Limits

| Limit | Value | Where enforced |
| --- | --- | --- |
| Rules per expectation | 8, unique, canonical order | Schema and semantic validation |
| Expectation value | 1 to 8192 UTF-8 bytes | Schema and semantic validation |
| Expectations per artifact | 16 in total | Semantic validation |
| `exact` stream size at record time | 8192 bytes | Recorder |
| Path roots considered | At most 1024 characters each, no control characters | Path context |

The regular-expression limits are in D3 and are enforced at validation, record time, and search.

## Consequences

- An older consumer rejects an artifact that uses `exact` or `normalize` with `schema_violation`. It never misreads one, which the frozen-schema test proves.
- Normalization hides changes to the things it normalizes. Each expectation names its rules, and results say which rules changed the replay output, so the hiding is visible and per expectation.
- `output-rules` is a new package, which changes the dependency graph and the bundled Action code.
- Revisit before the schema is declared stable: whether a rule subset should be exposed in the CLI, whether `normalize` should become a named profile, and whether artifact version 2 is the better home.

## Fallback

If maintainers decide not to carry an in-house regular-expression engine, the fallback is `re2js` (or RE2 compiled to WebAssembly) behind the same limits and the same step-style bound. That choice would change only the regular-expression engine, not the modes and normalization described above.
