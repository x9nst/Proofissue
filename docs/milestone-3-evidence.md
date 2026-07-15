# Milestone 3 Evidence

## Status

Milestone 3 — Recorder and Redaction is in progress. The technical recording path is implemented and verified. The milestone cannot be marked complete until Gate B in `product-validation.md` is run with external Node.js maintainers, so the command-line file-role labels remain provisional.

## Implemented workflow

A reporter can now provide one explicit Node.js command, one or more reproduction files, one or more subject files, expected output text, a digest-pinned replay-image request, and a new output path. ProofIssue then:

1. checks the project and each selected path;
2. reads only explicitly named regular UTF-8 files under strict size limits;
3. runs Node directly without a shell and with a minimal environment;
4. captures standard output and standard error separately while draining excess bytes;
5. replaces representative credentials in complete captured buffers and selected files;
6. validates the proposed artifact;
7. shows a content-safe preview with the two file groups and the consequences of misclassification;
8. requires confirmation of both groups and the final write, or an explicit `--yes` for automation;
9. writes a new artifact atomically without overwriting an existing file.

## Acceptance evidence

| Criterion | Evidence |
| --- | --- |
| Separate output and exit capture | Recorder integration tests assert independent stdout, stderr, exit code, truncation, and runtime metadata. |
| Minimal file collection | Tests prove that undeclared files are absent and reject traversal, absolute paths, directories, oversized files, and symbolic links. |
| Secret replacement | Redactor tests cover API keys, authorization headers, passwords, sensitive environment assignments, and private keys. Recorder tests check both output and selected files. |
| Chunk-boundary safety | The complete secret is split at every possible byte-chunk boundary, decoded after bounded collection, and still replaced. |
| No host-environment leakage | A recorder integration test places a synthetic secret in the parent environment and confirms the child sees none of it. |
| No shell interpretation | A metacharacter-rich argument remains one literal argument and does not create the shell redirection target. |
| Confirmation before writing | Application tests decline each of the three confirmations in turn and prove that no artifact appears. |
| Valid emitted artifacts | Application and CLI integration tests create artifacts and pass them through the Milestone 2 validator. |
| Explicit automation approval | A CLI integration test uses `--yes`, verifies that no prompt occurs, and validates the created artifact. |

## Security and compatibility impact

Recording executes a command on the reporter's host only after that command is explicitly supplied. It does not use a shell, install dependencies, scan directories, collect environment variables, overwrite artifacts, or authorize the requested replay image. Whole-buffer redaction prevents process-read boundaries from bypassing detection, but redaction remains defense in depth; users must still review the selected files and summary before sharing.

The artifact schema did not change. Milestone 2 fixtures and deterministic serialization remain the compatibility authority. The new CLI wording is provisional and has no stability claim until Gate B passes.

## Remaining completion gate

Run Gate B with at least five Node.js maintainers across three projects and record the results in `product-validation.md`. Repeated terminology problems must change the preview and help text before the interface is declared stable.
