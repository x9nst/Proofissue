# Security Model

## Security Goal

ProofIssue allows a user to inspect untrusted reproduction evidence without execution and, only when requested, run it with sharply limited access to the host and network.

An artifact is untrusted even when it was created by the official recorder. Validation is necessary but does not make its command safe; isolation and limits remain mandatory.

## Protected Assets

ProofIssue is designed to protect:

- host files outside the one temporary replay workspace;
- host environment variables, credentials, sockets, and services;
- the container engine socket and control plane;
- external networks and local network services;
- CPU, memory, process, disk, output, and elapsed-time availability;
- secrets accidentally present during recording or replay;
- the integrity and explainability of replay classifications;
- CI logs and machine-readable outputs.

## Trust Boundaries

### Artifact boundary

Artifact bytes, YAML structure, paths, commands, contents, limits, image identity, expectations, and redaction claims are untrusted. Schema validation, semantic validation, hash verification, and local policy all occur before workspace creation.

### Current-checkout boundary

Current-checkout replay treats replacement files as untrusted input. Only declared subject paths may be opened. ProofIssue does not assume that a local checkout is free of symbolic links, special files, races, or secrets.

### Container boundary

The replay command and reconstructed files are assumed malicious. The container receives only the temporary workspace, a clean environment, and the minimum runtime facilities required by the approved image.

### Host execution boundary

Recording is different from replay: the reporter explicitly authorizes the recorded command to run on the host. ProofIssue must not hide, broaden, or repeat that command. Maintainers replay received artifacts only in the isolated runner.

### Output boundary

Command output is untrusted data. It may contain credentials, huge streams, invalid Unicode, terminal control characters, or misleading text. Output is bounded, redacted, and escaped before display or logging.

## Static Safety Rules

Validation must:

- reject inputs larger than the artifact byte limit before parsing;
- accept exactly one restricted YAML document;
- reject aliases, anchors, merge keys, custom tags, duplicate mapping keys, excessive nesting, and excessive node counts;
- reject unknown fields and unsupported versions;
- reject invalid, nonportable, colliding, absolute, or traversing paths;
- verify file count, per-file size, total decoded size, and hashes;
- verify all cross-field references and aggregate expectation limits;
- reject unapproved or mutable image identities through local policy;
- perform no command execution, image pull, workspace creation, or dynamic module loading.

The parser and validator return bounded typed errors. They do not include full attacker-controlled contents in messages.

## Recording Safety

The recorder:

- runs only the displayed program and argument list authorized by the reporter;
- does not use a shell in version 1;
- reads only explicitly selected regular files beneath the chosen project root;
- does not follow symbolic links or recursively collect directories;
- collects only allowlisted runtime metadata;
- captures stdout and stderr in bounded memory;
- applies redaction before terminal display, logging, serialization, or snapshots;
- shows a redaction and collection summary before confirmation;
- writes a validated artifact atomically only after confirmation.

The recorder cannot guarantee detection of every secret. Explicit minimal collection and user review remain required controls.

## Replay Isolation Baseline

Every replay container must have all of these controls:

- an approved image pinned by cryptographic digest;
- no privileged mode;
- no host process namespace;
- no host network namespace;
- networking disabled at container creation;
- no Docker or other container-engine socket;
- no host devices;
- no added Linux capabilities and all default capabilities dropped;
- no-new-privileges enforcement;
- a non-root numeric user;
- a read-only base filesystem where the runtime permits it;
- only one explicitly created temporary workspace exposed to the container, with its host path validated before it is placed in the mount specification;
- container creation with image pulling disabled;
- no engine-side retention of container output, which is read only through the bounded attached stream;
- no core dumps and a bounded open-file limit;
- bounded writable temporary storage;
- CPU, memory, process-count, output, and wall-clock limits;
- a clean allowlisted environment with no inherited host secrets;
- a fixed working directory inside the temporary workspace;
- direct program-and-argument execution without host-shell interpolation;
- reliable stop, kill, removal, and workspace cleanup on every path.

Default engine security profiles remain enabled. Weakening a profile to make an artifact run is prohibited.

The runner never silently enables networking, privileged mode, root execution, added capabilities, writable host mounts, or larger resource limits.

## Image Policy

Version 1 accepts only a known Node.js image digest approved by runner policy. An artifact-provided digest is a request, not authorization.

The runner does not automatically pull a missing image during replay. Image acquisition is a separate, explicit environment-preparation action so validation and replay do not unexpectedly gain host network access. CI may prepare the approved image before replay. The container is also created with image pulling disabled, so an image that disappears between the presence check and container creation makes creation fail instead of fetching it.

A digest protects against tag movement but does not make image contents trustworthy. Approved images require maintainer review and periodic security updates. Updating the approved digest requires replay compatibility testing.

## Workspace Policy

Workspace paths are derived from validated portable relative paths, never string-concatenated host paths. Parent directories are created inside a newly allocated temporary root.

The implementation must defend against symbolic-link and path races while reading current-checkout files and while writing reconstructed files. Final path resolution must remain beneath the intended root at the time of access.

The one host path handed to the container engine is the runner-created temporary root. It is interpolated into a comma-separated mount specification, so the runner rejects a path that is relative or that contains a comma, double quote, or control character before building engine arguments. A rejected path is reported as `policy_rejection` without echoing the path.

The container may modify its temporary workspace because tests can create files, but no other host path is mounted. Version 1 uses a fixed 64 MiB writable-workspace ceiling enforced by runner-controlled container storage rather than an artifact setting. Validated host input is exposed read-only when it must be mounted. The entire temporary root is removed after container removal.

## Resource Policy

Artifact limits may request only values inside version 1 ranges. Local policy may reduce those values. The effective values are reported before execution and in structured results.

Timeout enforcement is host-controlled. It does not depend on cooperation by the replayed process. Process-count limits contain fork attempts; output is drained safely up to bounded retention; memory and CPU are enforced by the container engine; temporary storage also has a configured bound.

Resource-limit termination is `execution_failed`, not evidence that the original failure reproduced.

## Secret and Log Policy

ProofIssue never intentionally logs raw selected file contents, command output, environment values, authorization headers, or redaction inputs.

Recorder and replay output passes through redaction before human or structured presentation. Control characters and terminal escape sequences are escaped. Error messages use bounded path and category information rather than attacker-controlled content dumps.

Tests use synthetic credentials that are unmistakably fake. Snapshots contain replacement markers only.

Redaction findings record category, target, and replacement marker. They never record the original value or a reversible derivative of it.

### Redaction coverage

Detection is rule-based and deterministic. Every rule maps onto one of the five version 1 categories, so the artifact schema does not change.

| Category | Detected |
| --- | --- |
| `private_key` | PEM private-key blocks, including encrypted keys and PGP private-key blocks. A block with no end line, such as output cut off at a byte limit, is redacted to the end of the text. |
| `authorization_header` | `Authorization` with Bearer, Basic, Token, Negotiate, NTLM, ApiKey, Digest, Hawk, or AWS4 schemes, including the JSON-quoted form; `Cookie`, `Set-Cookie`, `X-Api-Key`, `X-Auth-Token`, and `X-Amz-Security-Token` headers. |
| `password` | `password`, `passwd`, and `pwd` settings including prefixed names such as `db_password`, with unquoted, quoted, JSON, and unterminated-quote values; the password part of `scheme://user:password@host` URLs. |
| `sensitive_environment` | A fixed list of well-known variables (for example `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `GITHUB_TOKEN`, `DATABASE_URL`); upper-case variable names ending in `TOKEN`, `SECRET`, `PASSWORD`, `API_KEY`, `PRIVATE_KEY`, `ACCESS_KEY`, or `CREDENTIALS`; `api_key`, `access_token`, `auth_token`, `client_secret`, `secret_key`, `private_key`, and `session_token` settings; npm `_authToken`, `_auth`, and `_password`. |
| `api_key` | AWS access key ids (`AKIA`, `ASIA`), GitHub classic and fine-grained tokens, OpenAI-style `sk-` keys, GitLab `glpat-`, Slack `xox` tokens, Stripe `sk_`/`rk_` keys, Google `AIza` keys, npm `npm_` tokens, and JSON web tokens. |

Properties the rules keep, each covered by tests:

- Redacting already-redacted text changes nothing and adds no findings.
- Matching time is linear in the input; adversarial inputs have a time budget in the test suite.
- A value that is truncated or has an unterminated quote is redacted to the end of the line, or of the text for a private key, rather than left behind.

Known limits. Variable-name rules are case-sensitive for the generic upper-case form on purpose, so ordinary lowercase program output such as `token: 5` or `max_tokens=5` is left alone. Header rules can over-redact prose that starts with `Cookie:`. URL credentials are recognized only when the user name has no raw `[` or `]`, which RFC 3986 forbids there and which keeps a redaction marker from being read as `user:password`. A secret with no recognizable shape or label, such as a bare random string, is not detected. Redaction reduces accidental exposure; it is not a guarantee, and the reviewed preview remains a required control.

The GitHub Action writes the stable replay result to the runner-provided output
file with randomized multiline delimiters. Its workflow summary is derived only
from typed states, fixed check labels, and numeric counts. It does not include
raw output, selected file content, expected text, paths, environment values, or
application messages.

The Action does not use `GITHUB_TOKEN` or call the GitHub API. Example workflows
grant only `contents: read` for checkout and disable persisted checkout
credentials. The host Action process may control the local Docker Engine, but
the replay container never receives the engine socket or credentials.

## Local Policy Wins

An artifact cannot request weaker protection. If local policy is stricter than artifact limits, the stricter limit applies and is reported. If a difference could change the meaning of replay, the runner stops before execution unless the user explicitly chooses the stricter run.

Policy exceptions are not embedded in shared artifacts. Any future override must be local, explicit, narrowly scoped, and visible in results.

## Security Claims and Non-Claims

ProofIssue aims to prevent ordinary containerized commands from accessing undeclared host resources and to bound common denial-of-service techniques.

Version 1 does not claim:

- protection against a container-engine or operating-system kernel vulnerability;
- safe hostile multi-tenant execution on a shared machine;
- proof that an artifact author is who they claim to be;
- proof that an approved image is free of vulnerabilities;
- perfect secret detection;
- protection when users manually weaken runner controls.

Highly adversarial artifacts should be replayed inside an additional disposable virtual machine or isolated CI worker. Docker Desktop or a local Docker daemon is a meaningful host trust dependency, not a complete security boundary by itself.

## Required Security Evidence

Implementation work that touches artifacts, paths, recording, redaction, execution, images, output, or cleanup must include:

- the trust boundary changed;
- the abuse cases considered;
- tests demonstrating rejection or containment;
- compatibility impact;
- any residual risk.

The pull-request description must include this analysis before such a change is considered complete.
