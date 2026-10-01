# ProofIssue Documentation

## Planning and Status

- `../MILESTONES.md` describes the long-term product roadmap.
- `../IMPLEMENTATION_PLAN.md` tracks near-term milestones, acceptance criteria, dependencies, and evidence.
- `milestone-1-evidence.md` records the foundation verification results and open completion gates.
- `milestone-2-evidence.md` records the static artifact core implementation and acceptance evidence.
- `milestone-3-evidence.md` records recorder and redaction implementation and completion evidence.
- `milestone-4-evidence.md` records locked-down replay implementation, tests, and the remaining hosted-container evidence.
- `milestone-5-evidence.md` records declared-path fix verification, security cases, result presentation, and validation evidence.
- `milestone-6-evidence.md` records the GitHub Action implementation, security analysis, dependency advisory triage, local evidence, and the hosted Linux run that completed the milestone.
- `decisions/0001-version-1-contracts.md` records the accepted version 1 product decisions.
- `decisions/0002-dependency-strategy.md` compares the options for dependency handling in the initial supported Node.js workflow and records the accepted choice: a separate explicit prepare step, then offline replay.
- `decisions/0003-output-matching-modes.md` proposes exact, normalized, and bounded regular-expression output matching; the exact and normalized parts are implemented with assumed defaults awaiting maintainer sign-off, and regular expressions are the next step.
- `product-validation.md` tracks early maintainer research, file-role usability gates, product-demand evidence, and findings.
- `maintainer-review-packet.md` provides the mock artifact workflow, task prompts, and facilitator notes used for early research.
- `maintainer-participant-packet.md` is the answer-free participant research packet.
- `product-validation-session-template.md` records packet versions, task evidence, alternatives, and pass/fail outcomes.

## Product and Technical Design

- `architecture.md` defines package responsibilities, dependency direction, data boundaries, and side-effect boundaries.
- `artifact-format.md` defines the proposed version 1 artifact fields, limits, validation order, and compatibility rules.
- `artifact-io-contract.md` defines exact parser limits, deterministic serialization, and no-overwrite atomic publication.
- `output-handling.md` defines raw-byte capture, UTF-8 decoding, truncation, whole-buffer redaction, and matching input.
- `output-matching.md` defines the `contains` and `exact` modes, the eight normalization rules, the record and replay path contexts, the explanation messages, and known limitations.
- `result-contract.md` defines neutral versioned operation results and the error taxonomy.
- `cli.md` is the command reference: syntax, options, examples, exit codes, failure behavior, and security notes for `record`, `validate`, `inspect`, `prepare`, and `replay`.
- `dependencies.md` describes npm dependency handling for the initial supported workflow and the lockfile validation rules; it grows as each step lands.
- `recording.md` defines command authorization, file selection, capture, redaction, confirmation, and recording failures.
- `replay.md` defines static inspection, snapshot replay, current-checkout replay, result states, and failure behavior.
- `github-action.md` documents Action inputs, outputs, permissions, summaries, failure behavior, and complete workflow examples.

## Security

- `security-model.md` defines protected assets, trust boundaries, replay isolation, image policy, resource policy, and security claims.
- `threat-model.md` maps concrete malicious inputs and behaviors to rejection, containment, or detection requirements.
- `testing-strategy.md` defines property-based testing, fuzzing, cleanup fault injection, hostile-output testing, compatibility evidence, and repeatability measurement.
- `supported-environments.md` defines development, recording, replay, engine, host, and CI support claims.
- `license-decision.md` records the owner's Apache License 2.0 decision and contribution terms.
- `PRE_MILESTONE_2_READINESS_REVIEW.md` records the readiness audit and the implementation response.

## Foundation and Planned Documentation

Contributor, conduct, security, support-matrix, license-decision, command-reference, and GitHub Action documents now exist, along with one runnable example in `../examples/failing-node-test`. Later implementation milestones will add schema-version migration guidance, further examples, and measured real-project results.

The canonical contributor guide is `../CONTRIBUTING.md`; vulnerability reporting is in `../SECURITY.md`; community expectations are in `../CODE_OF_CONDUCT.md`.

Documentation is updated alongside the behavior it describes. A public field or behavior is not considered implemented until its documentation and verification evidence agree.
