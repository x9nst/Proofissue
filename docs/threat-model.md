# Threat Model

## Scope

This threat model covers version 1 artifact creation, static inspection, validation, snapshot replay, current-checkout replay, and GitHub Actions replay for the technical prototype and initial supported Node.js workflow.

The primary assumption is hostile input: an artifact, its embedded files, its command, its output, and current-checkout replacement files may be deliberately malicious.

## Actors

### Reporter

May be well intentioned, careless, or malicious. A reporter controls artifact contents and may attempt to hide data collection, consume resources, access networks, or misrepresent a different failure as the reported one.

### Maintainer

Chooses whether to inspect or replay an artifact. A maintainer may accidentally run unsafe commands outside ProofIssue or approve a misleading artifact. ProofIssue must make static inspection safe and replay controls visible.

### Current checkout contributor

May control subject files, symbolic links, project paths, or code executed during fix verification. Current-checkout content receives the same container treatment as artifact content.

### CI environment

Provides the container engine and may hold repository tokens or other credentials. Replay must not inherit CI secrets or access the engine socket from inside the container.

### Dependency and image supplier

Could provide compromised runtime content. Digest pinning prevents silent tag movement but does not establish that content is benign. Local allowlisting is required.

## Assets and Security Properties

| Asset | Required property |
| --- | --- |
| Host filesystem | No read or write outside the temporary replay workspace |
| Host and CI credentials | Not collected, inherited, mounted, displayed, or logged |
| Container engine | Socket and control API unavailable to replayed code |
| Network | No replay access to internet, local services, or metadata endpoints |
| Host availability | CPU, memory, processes, output, storage, and time remain bounded |
| Artifact interpretation | Parsing is bounded, deterministic, and non-executing |
| Replay classification | Results follow explicit evidence and cannot be reduced to a misleading boolean |
| Compatibility | Unknown fields and versions are rejected rather than misinterpreted |
| User terminal and CI logs | Attacker-controlled output is bounded, redacted, and escaped |

## Threats and Required Responses

| Threat example | Boundary | Required response | Type |
| --- | --- | --- | --- |
| YAML alias expansion or deeply nested input | Artifact parser | Reject under byte, alias, node-count, and depth limits before canonical conversion | Rejection |
| Duplicate YAML keys used to confuse validation | Artifact parser | Reject duplicate keys; never accept last-value-wins behavior | Rejection |
| Custom YAML tag attempts object construction | Artifact parser | Reject all custom tags and non-JSON-compatible values | Rejection |
| Oversized artifact or embedded file | Artifact parser | Reject before large allocation or workspace creation | Rejection |
| `../../secret`, absolute, drive, UNC, or backslash path | Artifact path | Reject during static semantic validation | Rejection |
| Unicode or case variant collides with another path | Artifact path | Apply the documented portable-path and collision rules; reject collisions | Rejection |
| Symlink or junction selected during recording | Host filesystem | Refuse collection and write no artifact | Rejection |
| Directory swapped for a link to elsewhere between the link check and the read | Host filesystem | Resolve the opened file's real location and require it to remain inside the project root | Rejection |
| Host variables such as tokens reach the recorded command | Recorder | Pass no host variables on Linux and macOS and only `SystemRoot` on Windows; a test checks the exact names the command receives | Containment |
| Windows process creation adds the user name, profile and temporary paths, domain or computer name, and logon server to the recorded command's environment | Recorder | Cannot be turned off without breaking ordinary programs; the added names are documented, and none of the command's output is written to the artifact | Containment |
| Recorded output carries a user name or local path into a shared artifact | Recorder | Use output only to check expected literals; write only those literals, which the reporter typed and the preview shows; a test shows that printing the whole environment leaves the artifact unchanged | Containment |
| A recorded command prints terminal control sequences, bidirectional text controls, or lines shaped like another listing entry or a prompt, to hijack the guided output listing | Recorder and CLI | Show only redacted output; bound each line to 200 characters and escape control, C1, and bidirectional characters; never echo a line that holds a local path or a likely secret; accept only listed ids; apply a suggestion only on an explicit Enter and never under `--yes`, `--json`, or without a terminal; show the stored value in full in the preview before confirmation | Containment |
| Current subject changes into a symlink between checks | Current checkout | Use no-follow access and final root verification; stop before container execution | Rejection |
| Hash does not match embedded content | Artifact integrity | Reject as `invalid_artifact` | Rejection |
| Lockfile points a package at another host, a git or file source, or a look-alike registry address | Dependency lockfile | Accept only the exact registry tarball address implied by name and version | Rejection |
| Lockfile has a missing, weak, or multiple integrity hash | Dependency lockfile | Require exactly one well-formed SHA-512 hash on every entry | Rejection |
| Lockfile location escapes `node_modules` (`../`, backslashes, absolute paths, `__proto__`) | Dependency lockfile | Accept only chains of `node_modules/<valid name>` | Rejection |
| Recording captures a lockfile that names a private registry or carries credentials | Recorder | Validate the lockfile before the command runs; any non-public-registry source is rejected | Rejection |
| A secret in package.json or the lockfile is redacted, silently breaking the lockfile's hashes | Recorder | Refuse to record instead of editing a dependency file | Rejection |
| Registry, or anything in its path, serves bytes that differ from the lockfile's hash | Package download | Hash every download and keep it only if it matches; a mismatch leaves nothing in the store | Rejection |
| Registry redirects a download to another host | Package download | Never follow redirects | Rejection |
| Server sends a compressed or transformed body | Package download | Request identity encoding and refuse anything else, because hashes cover exact bytes | Rejection |
| Endless, enormous, or stalled download | Package download | Per-package and total byte limits, a declared-length check, and per-download and overall time limits | Containment |
| Lockfile names thousands of downloads or many at once | Package download | Entry-count limit at validation and a hard concurrency cap | Containment |
| One failure leaves other downloads running or partial files behind | Package download | The first failure stops all work and removes temporary files | Containment |
| Store entry is corrupted, replaced by a link, or replaced by a directory | Package store | Hash again before trusting; never follow a link; never delete a directory | Rejection |
| A directory inside the store is replaced by a link to somewhere else | Package store | Resolve every entry's real path and trust it only if it is the expected one inside the store | Rejection |
| A package declares install scripts, or the project does | Dependency install | Run npm with `--ignore-scripts`; a test shows the same script running without the flag | Containment |
| A package archive has entries that leave its directory (`../`, absolute paths, symbolic or hard links) | Dependency install | npm's own extraction contains them; tests show nothing is written outside the package directory, on the host and in the Linux container | Containment |
| npm reaches for a registry during install | Dependency install | `--offline`, a store that is complete before install starts, and a test with an unreachable registry | Containment |
| npm writes into the store while installing | Dependency install | Log directory and update check redirected, so the store can be mounted read-only; a test shows nothing in the store changes | Containment |
| A machine's npm configuration changes install behavior | Dependency install | Empty user and global configuration files are passed explicitly | Containment |
| A package archive expands to far more data than it holds (decompression bomb) | Dependency install | The install runs in the in-memory workspace, which has a fixed size; exceeding it fails the install and affects nothing outside the container | Containment |
| A failed install is mistaken for the artifact's command failing | Replay | A reserved exit status for any failure before the command starts, translated by the runner into `dependency_install_failed`; the command never runs after a failed install | Rejection |
| An artifact's command exits with the reserved status to disguise itself | Replay | Reported as a failed install, which is an execution failure and never a match | Containment |
| The command or a package writes to the prepared store | Replay | The store is mounted read-only; a container test shows a write fails | Containment |
| Install output carries package-controlled text into a result | Replay | Only one npm error code matching a strict pattern is read from the output and repeated | Rejection |
| A store is incomplete or damaged when replay starts | Replay | Check the whole store read-only first and report what is missing before any container starts | Rejection |
| Two preparations write the same entry at once | Package store | Write under a temporary name and move into place; keep a valid entry rather than replacing it | Containment |
| Platform fields in a lockfile try to steer what is downloaded | Dependency lockfile | Accept only short lists of plain platform words | Rejection |
| Lockfile repeats a key so two readers see different entries | Dependency lockfile | Reject duplicate keys after decoding escapes | Rejection |
| Lockfile of enormous size, entry count, or nesting | Dependency lockfile | Bound bytes and entries, scan iteratively, and test the time budget | Rejection |
| A hostile artifact is given to `prepare` | Dependency preparation | Validate the artifact and then its lockfile before any request or any directory is created; rejected input leaves the store untouched | Rejection |
| An artifact tries to choose where the store is written | Dependency preparation | No artifact field influences the path; it comes only from the command line or workflow input and is never defaulted | Containment |
| The replay Action accidentally gains download code | Action bundle | Prepare is a separate Action and bundle; a test fails if the replay bundle contains download code, and a second test shows the prepare bundle does, so the first cannot pass vacuously | Containment |
| A failed preparation is mistaken for a replay result | Dependency preparation | Preparation is its own operation; replay without a prepared store reports `dependencies_not_prepared`, an execution failure | Rejection |
| An untrusted pull request triggers downloads in CI | Dependency preparation | Public registry only, hash-pinned tarballs, nothing executed or extracted, store kept under the runner's temporary directory, no token needed | Containment |
| Artifact requests arbitrary or mutable image | Image policy | Reject before image acquisition or container creation | Rejection |
| Approved image is absent | Image policy | Return `execution_failed`; never auto-pull during replay | Rejection |
| Approved image disappears between the presence check and container creation | Image policy | Create the container with image pulling disabled so creation fails instead of fetching | Rejection |
| Host temporary directory path contains commas or quotes that add or redirect mount options | Container engine | Reject relative paths and paths containing commas, quotes, or control characters before building engine arguments | Rejection |
| Argument contains shell syntax or command substitution | Command | Pass as a literal argument without a shell; syntax has no host-shell meaning | Containment |
| Command directly attempts malicious behavior | Container | Execute only within the complete isolation baseline and resource limits | Containment |
| Command tries to mount files or change privileges | Container | Non-root user, dropped capabilities, no-new-privileges, no devices, no privileged mode | Containment |
| Command tries to control Docker | Container engine | Never mount or expose the Docker socket or engine credentials | Containment |
| Command reads `/etc`, host home, or repository files | Filesystem | Read-only container base plus only the temporary workspace; no other host mount | Containment |
| Command scans internet, localhost, LAN, or cloud metadata | Network | Create container with no network namespace connectivity | Containment |
| Fork bomb | Availability | Enforce process-count and wall-clock limits, then kill and clean up | Containment |
| Infinite loop or CPU burn | Availability | Enforce CPU and wall-clock limits, then kill and clean up | Containment |
| Memory exhaustion | Availability | Enforce memory limit and classify resource termination as execution failure | Containment |
| Output flood | Output/availability | Drain safely, retain only bounded data, mark truncation, and prevent discarded output from matching | Containment |
| Output flood fills the container engine's log storage | Host availability | Disable engine-side container logging; read output only through the bounded attached stream | Containment |
| Core dump or file-descriptor exhaustion | Availability | Set the core-dump size to zero and bound open files | Containment |
| Disk-filling writes | Workspace | Use bounded temporary storage and unconditional cleanup | Containment |
| Process ignores termination | Cleanup | Escalate from stop to host-controlled kill, remove container, then workspace | Containment |
| Output contains API key or private key | Secret/log | Redact before presentation or serialization and record only safe finding metadata | Containment |
| Output cut off inside a private key or quoted secret | Secret/log | Redact to the end of the line, or of the text for a key block, instead of leaving the remainder | Containment |
| Crafted output makes a redaction pattern run for a long time | Availability | Linear-time rules with a time budget enforced by tests | Containment |
| Output contains terminal escape sequences | User terminal | Escape control characters before human display | Containment |
| Artifact uses redacted marker as expected evidence | Matcher | Reject the expectation during semantic validation | Rejection |
| Same exit code comes from a different error | Matcher | Require literal output evidence and report every difference | Detection |
| Crafted output slows a normalization rule | Availability | Linear scanners or anchored patterns with no nested repetition; time-budget tests on 1 MiB adversarial inputs | Containment |
| Normalization joins escape-split text into a secret that is then stored | Recorder | Redaction check on every stored value after normalization; refuse the recording | Rejection |
| Host paths or the user name leak through an exact or normalized value | Recorder / privacy | Exact path replacement; refuse a stored value that still contains the project or home directory | Rejection |
| Host paths or the user name leak through a command argument, which is stored as typed | Recorder / privacy | Before the command runs, refuse an argument that holds the project or home directory; on Windows also refuse a backslash path to a project file, which cannot replay on Linux; the message never repeats the argument | Rejection |
| Host context influences replay classification | Replay | Replay normalizes with only the fixed `/workspace` and `/tmp`; a container test proves the replayed command sees exactly those | Containment |
| Catastrophic-backtracking pattern | Matcher | A linear-time Pike-VM engine instead of V8 `RegExp`; 1 MiB adversarial time-budget tests | Containment |
| Pattern that expands into a huge automaton | Artifact validation | Length, repetition, nesting, and compiled-size limits; `semantic_violation` before any execution | Rejection |
| Backreferences, lookaround, property escapes, or modifiers | Artifact validation | `semantic_violation` naming the feature and offset | Rejection |
| Pattern and output combination too costly even in linear time | Matcher | Deterministic step limit; `regex_step_limit`, never a match | Containment / Detection |
| Vacuous pattern (`a*`, `^`) used to make any failure "reproduce" | Artifact validation | Reject patterns that can match without consuming output | Rejection |
| Pattern aimed at redaction markers | Artifact validation | Reject `REDACTED:` in a pattern | Rejection |
| Normalization hides a meaningful difference | Matcher | Explicit per-expectation rules shown in every result; exact exit code; limits documented | Detection (residual) |
| New expectation content is misread by an older consumer | Compatibility | Closed schema that enumerates modes and rule names; a frozen-schema test proves an older consumer rejects it | Rejection |
| Exact expectation satisfied by a truncated stream | Matcher | An exact comparison is `insufficient_output` for a truncated stream, never a match | Detection |
| Output needed for matching was truncated | Matcher | Report insufficient bounded evidence; never infer a match from discarded bytes | Detection |
| Unknown future field changes meaning | Compatibility | Reject unknown fields and unsupported versions | Rejection |
| CI artifact tries to read job secrets | CI/container | Provide a clean environment and mount no credentials; use minimal Action permissions | Containment |
| Hostile result text tries to create a workflow command or misleading summary | CI presentation | Use environment files, randomized output delimiters, and summaries made only from fixed labels and counts | Containment |
| Action bundle differs from reviewed source | Build supply chain | Pin the bundler, commit the generated entry point, and fail CI when rebuilding changes tracked files | Detection |
| Cleanup partially fails | Host | Report `execution_failed`, identify residual resource safely, and retry bounded cleanup | Detection and containment |

## Portable Path Policy

The technical prototype accepts only nonempty relative paths composed of ASCII letters, digits, `_`, `-`, `.`, and `/`. Segments may not be empty, `.` or `..`, and the full path may not begin or end with `/`.

This narrow rule deliberately avoids Unicode normalization, case-folding, drive, separator, and display ambiguities. Broader filename support requires a separate compatibility and threat review.

Path collision checks use ASCII case-insensitive comparison as well as exact comparison so an artifact can be recorded on a case-insensitive host and replayed consistently on Linux.

## Abuse-Case Verification Plan

Static fixtures must cover malformed YAML, duplicate keys, aliases, excessive depth, excessive nodes, unknown fields, unsupported versions, every invalid path class, duplicate and case-colliding paths, invalid hashes, excessive counts and sizes, mutable images, and redacted expectations. Property-based tests must generate bounded canonical models and paths to verify round-trip, collision, size, and rejection invariants. Parser fuzzing must retain crashing or slow inputs as regression cases.

Filesystem tests must cover symbolic links, Windows junction-equivalent behavior where applicable, replacement races as far as controlled tests permit, special files, and root escape attempts.

Container integration tests must demonstrate disabled networking, clean environment, inaccessible Docker socket, no undeclared host file access, non-root identity, dropped capabilities, read-only base filesystem, bounded temporary storage, CPU/memory/process/output/time enforcement, termination escalation, and cleanup. Fault injection must exercise failures before and after container creation, during start, stop, kill, removal, workspace creation, result collection, and workspace removal.

Redaction tests must cover property-generated stream chunk boundaries, secrets split across chunks, multiple findings, overlapping patterns, false-positive examples, output control characters, and the absence of raw synthetic credentials from artifacts, logs, errors, and snapshots.

Matcher tests must show that an unrelated failure with the same exit code is not reproduced and that truncated evidence cannot create a match. Property-based tests must preserve basic invariants such as order-independent evaluation of independent expectations and stable explanations for the same bounded inputs.

Terminal and CI presentation tests must include ANSI escapes, carriage returns, backspaces, bidirectional text controls, very long unbroken strings, GitHub workflow command syntax, and invalid Unicode byte sequences. Human output must remain visibly escaped and structured output must remain valid.

Action adapter tests must additionally prove that:

- invalid inputs never invoke replay;
- both required classifications can pass and mismatches do not alter the result;
- structured outputs remain valid JSON for later steps;
- summaries omit application messages and raw execution data;
- environment-file output does not use deprecated workflow-command syntax.

## Residual Risks

- A container or kernel escape can cross the intended boundary.
- Docker Desktop and the container daemon are trusted dependencies.
- Secret detection can miss unknown formats or redact benign values.
- Redaction does not recognize user names, computer names, or local paths, so an expected literal that contains one puts it into the artifact. On Windows the recorded command also receives these values through its environment.
- A malicious approved runtime image can act before the replay command.
- Local administrators can inspect host memory or temporary resources.
- Resource enforcement differs by container engine and operating-system host.
- Literal matching can still mistake two similar failures for one another.
- A pattern can widen what counts as the same failure, and can match a redaction marker through a character set; validation refuses only the spelled-out marker.
- `regex_step_limit` and `insufficient_output` classify as `not_reproduced`, so they satisfy `--require-status not_reproduced`.
- Normalization can hide a change confined to a normalized token (a duration, a process ID, a Node.js internal line number, the Node.js version, or a path root); each result names the rules that were applied.
- Digest pinning gives integrity, not provenance or vulnerability-free content.

These risks are documented, not silently accepted. Highly adversarial replay requires an additional disposable machine boundary. Structured failure matching in Phase 2 will reduce, but not eliminate, mistaken classifications.

## Review Triggers

This threat model must be reviewed when adding archives, binary files, directory collection, shell execution, dependency installation, network access, custom images, new runtimes, additional mounts, artifact signing, hosted execution, or automatic issue comments. The review for regular expressions is done: the rows above and decision 0003 record it, and it must be repeated before the pattern language is extended (for example with lookaround, flags, or captures).
