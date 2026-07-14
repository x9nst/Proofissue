# ProofIssue Maintainer Review — Participant Packet

**Packet version:** 1  
**Research material:** This is a mock workflow, not working ProofIssue software.

## Scenario

You maintain a small Node.js calculation library. A reporter says that doubling `2` returns `3` rather than `4`. They attach a `.proofissue` artifact containing a failing reproduction and the relevant implementation file.

The reporter expects exit code `1` and stderr containing `Expected 4 from calculate(2)` when running `node test/reproduction.mjs` with networking disabled and a 60-second timeout.

## Task 1 — Review Proposed File Roles

**INTENTIONALLY INCORRECT CLASSIFICATION — RESEARCH TASK ONLY**

```text
Files that may be replaced when checking current code
  test/reproduction.mjs

Files kept exactly as recorded
  src/calculate.mjs
```

1. Is either file in the wrong group?
2. What do you expect each group to do during fix verification?
3. What words would make the distinction clearer?

## Task 2 — Decide Whether to Replay

```text
ProofIssue artifact version 1

Runtime
  Node.js 24 in an approved digest-pinned Linux image

Command
  node test/reproduction.mjs

Recorded files
  reproduction: test/reproduction.mjs
  subject:      src/calculate.mjs

Expected failure
  exit code: 1
  stderr contains: Expected 4 from calculate(2)

Limits
  network: disabled
  timeout: 60 seconds
  memory: 512 MiB
  CPUs: 1
  processes: 64

Redaction
  enabled; no findings

No command was executed during inspection.
```

1. Is this enough information to decide whether you would replay the artifact?
2. What is missing?
3. Which information feels unnecessary?
4. What would make you refuse replay?

## Task 3 — Interpret Snapshot Replay

```text
Result: reproduced

Matched evidence
  exit code was 1
  stderr contained: Expected 4 from calculate(2)

Execution controls
  approved image digest used
  network disabled
  resource limits applied
  temporary workspace removed
```

1. What does this result prove?
2. What does it not prove?
3. What would you do next?

## Task 4 — Choose a Fix-Verification Mode

You change `src/calculate.mjs` so the calculation is correct. You want to keep the reporter's test unchanged while using your corrected implementation.

1. Would you use snapshot replay or replay against the current checkout?
2. Which files should come from the artifact?
3. Which files should come from your checkout?

```text
Result: not_reproduced

Differences
  expected exit code 1; actual exit code 0
  expected stderr text was absent

Current-checkout scope
  substituted: src/calculate.mjs
  undeclared checkout files were not read
  this result covers only the listed substitution
```

How would you describe this result in your own words?

## Task 5 — Structural-Fix Limitation

Consider three fixes:

1. `src/calculate.mjs` starts importing a newly added `src/double.mjs`.
2. `src/calculate.mjs` is deleted and replaced by `src/arithmetic.mjs`.
3. Only `src/calculate.mjs` changes internally.

1. Which fixes can declared-path substitution represent?
2. What should ProofIssue do for the others?
3. Would this limitation still leave the feature useful?

## Demand and Alternatives

1. Tell us about the last Node.js bug report that was difficult to reproduce.
2. Would you have preferred a ProofIssue artifact, minimal repository, failing pull request, Dockerfile, or standalone script?
3. Which option would require less reporter effort and less maintainer effort?
4. Which would be easiest to inspect before execution?
5. Which would you trust more?
6. Which would you retain as a regression check?
7. Would you ask the reporter to create a ProofIssue artifact? Why or why not?
8. Would you run it locally, in CI, in a disposable machine, or nowhere?
