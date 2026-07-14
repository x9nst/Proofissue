# Fuzz Regression Corpus

This directory retains minimized parser, path, redaction, and presentation inputs that exposed a crash, timeout, excessive allocation, or security-relevant discrepancy.

Corpus files must be bounded, deterministic, and safe to publish. They may contain synthetic secret markers but never real credentials, private repository content, usernames, hostnames, or absolute local paths.

The initial subdirectories are placeholders. Milestone 2 will add seeded restricted-YAML inputs after the parser and exact validation limits exist.
