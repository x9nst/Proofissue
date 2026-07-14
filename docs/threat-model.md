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
| Current subject changes into a symlink between checks | Current checkout | Use no-follow access and final root verification; stop before container execution | Rejection |
| Hash does not match embedded content | Artifact integrity | Reject as `invalid_artifact` | Rejection |
| Artifact requests arbitrary or mutable image | Image policy | Reject before image acquisition or container creation | Rejection |
| Approved image is absent | Image policy | Return `execution_failed`; never auto-pull during replay | Rejection |
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
| Disk-filling writes | Workspace | Use bounded temporary storage and unconditional cleanup | Containment |
| Process ignores termination | Cleanup | Escalate from stop to host-controlled kill, remove container, then workspace | Containment |
| Output contains API key or private key | Secret/log | Redact before presentation or serialization and record only safe finding metadata | Containment |
| Output contains terminal escape sequences | User terminal | Escape control characters before human display | Containment |
| Artifact uses redacted marker as expected evidence | Matcher | Reject the expectation during semantic validation | Rejection |
| Same exit code comes from a different error | Matcher | Require literal output evidence and report every difference | Detection |
| Output needed for matching was truncated | Matcher | Report insufficient bounded evidence; never infer a match from discarded bytes | Detection |
| Unknown future field changes meaning | Compatibility | Reject unknown fields and unsupported versions | Rejection |
| CI artifact tries to read job secrets | CI/container | Provide a clean environment and mount no credentials; use minimal Action permissions | Containment |
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

## Residual Risks

- A container or kernel escape can cross the intended boundary.
- Docker Desktop and the container daemon are trusted dependencies.
- Secret detection can miss unknown formats or redact benign values.
- A malicious approved runtime image can act before the replay command.
- Local administrators can inspect host memory or temporary resources.
- Resource enforcement differs by container engine and operating-system host.
- Literal matching can still mistake two similar failures for one another.
- Digest pinning gives integrity, not provenance or vulnerability-free content.

These risks are documented, not silently accepted. Highly adversarial replay requires an additional disposable machine boundary. Structured failure matching in Phase 2 will reduce, but not eliminate, mistaken classifications.

## Review Triggers

This threat model must be reviewed when adding archives, binary files, directory collection, shell execution, dependency installation, network access, custom images, new runtimes, additional mounts, regular expressions, artifact signing, hosted execution, or automatic issue comments.
