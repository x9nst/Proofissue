# Fuzz Regression Corpus

This directory retains minimized parser, path, redaction, and presentation inputs that exposed a crash, timeout, excessive allocation, or security-relevant discrepancy.

Corpus files must be bounded, deterministic, and safe to publish. They may contain synthetic secret markers but never real credentials, private repository content, usernames, hostnames, or absolute local paths.

`yaml/` contains the retained Milestone 2 seeds for the restricted parser: a minimal valid document and deliberately malformed, duplicate-key, alias, multi-document, and traversal inputs. Generated parser tests run raw bounded byte arrays in addition to these reviewable seeds. Any distinct parser crash, timeout, allocation issue, or unsafe conversion found later must be reduced and retained here.
