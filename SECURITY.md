# Security Policy

## Supported Versions

ProofIssue 0.1.0 is a preview release of the initial supported Node.js workflow. Security fixes are made for the latest 0.1.x release only; older versions are not patched, so upgrade to the latest 0.1.x before reporting. Until the first release is published, only the `main` branch is supported.

| Version | Supported |
| --- | --- |
| 0.1.x (latest) | Yes |
| earlier than 0.1.0 | No |

The preview supports the documented environment only: replay on a local, rootful Docker Engine 27 or newer on x86-64 Linux, npm lockfile version 3 dependencies from the public registry, and pure-JavaScript test runners. See `docs/supported-environments.md`. Roadmap Phase 1 is not complete.

Release artifacts carry a build-provenance attestation, which `gh attestation verify` checks; see `docs/release.md`.

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
