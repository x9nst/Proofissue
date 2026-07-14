# ProofIssue Documentation

## Planning and Status

- `../MILESTONES.md` describes the long-term product roadmap.
- `../IMPLEMENTATION_PLAN.md` tracks near-term milestones, acceptance criteria, dependencies, and evidence.
- `milestone-1-evidence.md` records the foundation verification results and open completion gates.
- `milestone-2-evidence.md` records the static artifact core implementation and acceptance evidence.
- `decisions/0001-version-1-contracts.md` records the accepted version 1 product decisions.
- `product-validation.md` tracks early maintainer research, file-role usability gates, product-demand evidence, and findings.
- `maintainer-review-packet.md` provides the mock artifact workflow, task prompts, and facilitator notes used for early research.
- `maintainer-participant-packet.md` is the answer-free participant research packet.
- `product-validation-session-template.md` records packet versions, task evidence, alternatives, and pass/fail outcomes.

## Product and Technical Design

- `architecture.md` defines package responsibilities, dependency direction, data boundaries, and side-effect boundaries.
- `artifact-format.md` defines the proposed version 1 artifact fields, limits, validation order, and compatibility rules.
- `artifact-io-contract.md` defines exact parser limits, deterministic serialization, and no-overwrite atomic publication.
- `output-handling.md` defines raw-byte capture, UTF-8 decoding, truncation, whole-buffer redaction, and matching input.
- `result-contract.md` defines neutral versioned operation results and the error taxonomy.
- `recording.md` defines command authorization, file selection, capture, redaction, confirmation, and recording failures.
- `replay.md` defines static inspection, snapshot replay, current-checkout replay, result states, and failure behavior.

## Security

- `security-model.md` defines protected assets, trust boundaries, replay isolation, image policy, resource policy, and security claims.
- `threat-model.md` maps concrete malicious inputs and behaviors to rejection, containment, or detection requirements.
- `testing-strategy.md` defines property-based testing, fuzzing, cleanup fault injection, hostile-output testing, compatibility evidence, and repeatability measurement.
- `supported-environments.md` defines development, recording, replay, engine, host, and CI support claims.
- `license-decision.md` records the owner's Apache License 2.0 decision and contribution terms.
- `PRE_MILESTONE_2_READINESS_REVIEW.md` records the readiness audit and the implementation response.

## Foundation and Planned Documentation

Contributor, conduct, security, support-matrix, and license-decision documents now exist. Later implementation milestones will add command reference material, schema-version migration guidance, GitHub Action usage documentation, executable examples, and measured real-project results.

The canonical contributor guide is `../CONTRIBUTING.md`; vulnerability reporting is in `../SECURITY.md`; community expectations are in `../CODE_OF_CONDUCT.md`.

Documentation is updated alongside the behavior it describes. A public field or behavior is not considered implemented until its documentation and verification evidence agree.
