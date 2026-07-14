# Early Product Validation

## Purpose

ProofIssue must test whether maintainers value and understand the workflow while the implementation is still narrow. This work does not add version 1 features. It tests the demand, language, trust signals, and review flow around the planned artifact.

## Scope Terms Used in Research

- **Technical prototype slice:** the dependency-free proof that one command can be recorded, inspected, replayed under limits, matched, and checked against declared replacement files.
- **Initial supported Node.js workflow:** the first documented workflow suitable for real supported Node.js projects, including an accepted dependency strategy, GitHub Actions, security tests, and measured real-project evidence.
- **Roadmap Phase 1 product:** the broader “Minimum Replayable Bug Report” phase in `../MILESTONES.md`, including its full matcher, redaction, Action, documentation, and success-metric commitments.

Research materials must use these exact labels. A successful technical prototype is not presented as stable Node.js project support or as completion of roadmap Phase 1.

## Questions to Test

1. Do maintainers have recent bugs for which executable reproduction evidence would have saved meaningful time?
2. Would they ask reporters to create or attach this artifact?
3. Does static inspection provide enough information to decide whether replay is worth the risk?
4. Can they correctly distinguish a reproduction file from a subject file without coaching?
5. Can they choose between snapshot replay and current-checkout replay?
6. Do they understand that current-checkout replay substitutes only declared existing paths?
7. Are the four result states understandable and actionable?
8. Is the recording effort acceptable relative to the expected maintenance benefit?

The research should ask about actual recent behavior and tradeoffs, not rely on general expressions of enthusiasm.

## Early Validation Gates

### Gate A — Before schema and inspection presentation are frozen

Show the mock artifact in `artifact-format.md` and run the inspection and replay tasks in `maintainer-participant-packet.md` with at least three Node.js maintainers from at least two projects. Facilitators use the separate answer key in `maintainer-review-packet.md` and record both packet versions.

Pass conditions:

- at least two can explain what the artifact contains and what validation does without prompting;
- at least two identify a recent real failure where the artifact would have been useful;
- major trust or inspection information gaps are recorded before Milestone 2 interfaces are finalized.

### Gate B — Before the recorder CLI interface is frozen

Run task-based walkthroughs with at least five Node.js maintainers across at least three projects.

Tasks:

1. classify example files as reproduction or subject;
2. review a proposed recording preview and find an intentionally misplaced file;
3. choose snapshot or current-checkout replay for a stated goal;
4. explain what `not_reproduced` does and does not prove;
5. identify the limitation when a fix adds, removes, or renames a file.

Pass conditions:

- at least four of five classify the example files correctly without coaching;
- at least four of five choose the correct replay mode;
- at least four of five explain the declared-path limitation;
- at least three of five say they would request or use the workflow for a specific recent bug;
- any repeated terminology failure changes the preview and documentation before CLI spelling is declared stable.

The terms `reproduction` and `subject` remain provisional user-interface language until this gate passes. The underlying two-role artifact concept may proceed, but the CLI labels and help text must remain changeable.

### Gate C — During the technical prototype

Give at least two maintainers a guided prototype rather than only static mockups. Observe where they hesitate, what they inspect before replay, and whether the result explanation answers their next question.

This gate measures usability and product value. It does not count the prototype as real-project compatibility evidence.

### Gate D — Before the initial supported Node.js workflow

Begin real-project trials as soon as the dependency and replay capabilities permit them. Do not wait until all hardening work is complete.

The final support claim still requires the Milestone 7 counts and repeatability targets, but interim results must be reviewed after every two external failures so unsupported assumptions can be corrected early.

## File-Role Preview Requirements

The recording preview must group files by role and explain the consequence of a mistake:

- marking a test or fixture as `subject` may replace the reproduction during fix verification;
- marking implementation code as `reproduction` freezes the original broken code and may make a real fix appear ineffective.

The preview asks for confirmation of both groups separately. ProofIssue may provide examples or warnings, but version 1 does not silently guess or change a role.

## Session Method

- Use a recent real bug from the participant when possible.
- Ask the participant to think aloud and complete tasks before explaining the intended model.
- Record errors, hesitation, questions, and rejected value propositions as evidence.
- Avoid collecting repository secrets or copying proprietary artifacts into this repository.
- Store anonymized summaries unless the participant explicitly agrees to attribution.
- Separate “would use” statements from evidence that the workflow fits an actual past bug.
- Record each session with `product-validation-session-template.md`, including participant and facilitator packet versions.
- Do not count a task as successful when the participant saw the facilitator answer key first.

## Failure and Pause Criteria

Trigger a documented product review when any condition occurs:

- fewer than two of five maintainers identify a recent bug where the workflow would have saved meaningful effort;
- fewer than two of five would ask a reporter to use the workflow;
- most participants refuse local, CI, and disposable-machine replay even after inspection;
- role classification remains below Gate B after two terminology revisions;
- participants consistently judge artifact creation harder than preparing a minimal repository;
- maintainers understand the workflow but cannot identify a practical adoption path;
- trust information requested by multiple participants cannot be presented clearly without excessive complexity.

The review may adjust terminology, narrow the audience, change the reporter workflow, reposition around CI or maintainer-created artifacts, reorder milestones, pause hardening, or stop the project if the core workflow shows insufficient value. Each gate records pass, fail, or inconclusive rather than only pass evidence.

## Alternatives Comparison

For each recent bug, compare ProofIssue with a minimal repository, failing test pull request, Dockerfile or image, standalone reproduction script, hosted sandbox when relevant, and a detailed issue with logs.

Record preparation time, inspection time, successful reproduction time, follow-up questions, willingness to replay, likelihood of regression reuse, and repeat use by the same maintainer when evidence is available. Product claims require comparative evidence, not enthusiasm alone.

## Findings Log

| Date | Gate | Participant context | Evidence | Decision or follow-up |
| --- | --- | --- | --- | --- |
| Not started | A | — | No sessions completed yet | Recruit Node.js maintainers before Milestone 2 interface freeze |

## Status

`In Progress`

The research plan and mock material exist. No maintainer sessions have been completed, so no product-demand or terminology claim has yet been validated.
