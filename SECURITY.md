# Security Policy

## Current Status

ProofIssue is pre-release software. No artifact or CLI compatibility version is supported yet. The dependency-free technical prototype can replay validated artifacts in the documented restricted Linux container and can substitute only explicitly declared subject files from a selected current checkout. It is not yet a supported workflow for typical Node.js projects.

## Reporting a Vulnerability

Use the repository host's private security-advisory feature when available. Do not open a public issue containing an exploit, credential, private artifact, or sensitive environment detail.

Include:

- the affected document, package, or workflow;
- the trust boundary involved;
- a minimal synthetic reproduction;
- expected and observed behavior;
- potential impact;
- suggested containment, if known.

Never include real secrets. Use unmistakably synthetic values.

## Response Expectations

Maintainers will acknowledge reports when project staffing permits, assess severity and affected boundaries, develop tests that reproduce the issue safely, and publish remediation information appropriate to the project's release stage.

## Security Model

See `docs/security-model.md` and `docs/threat-model.md`. Containers reduce risk but do not protect against every container-engine or operating-system vulnerability. Highly adversarial replay requires an additional disposable machine boundary.
