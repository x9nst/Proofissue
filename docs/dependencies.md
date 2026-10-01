# Dependencies

**Status:** In progress. Lockfile validation is implemented. Recording the lockfile, preparing packages, and offline installation are not.

This document describes how ProofIssue will handle a project's npm dependencies, following [decision 0002](decisions/0002-dependency-strategy.md): a separate, explicit `prepare` step downloads and verifies the packages a lockfile names, and replay then runs offline. It is extended as each step lands.

## Scope of the first supported workflow

- npm only, with `package-lock.json` at the project root.
- Lockfile version 3 only.
- Packages from the public npm registry only.
- Lifecycle scripts are never run. A package that needs an install script, a compiled addon, or an install-time download is outside the supported boundary.
- The lockfile must fit the 1 MiB per-file artifact limit.

## Lockfile validation

`@proofissue/dependencies` validates a lockfile before anything is fetched from it. The lockfile comes from an artifact, so it is treated as hostile. Validation is a pure function: it reads a string and returns either the packages that may be fetched or a list of errors. It performs no I/O and never contacts the registry.

A lockfile is accepted only if all of these hold:

| Rule | Error code |
| --- | --- |
| The text is at most 1 MiB and is valid JSON | `too_large`, `malformed_json` |
| No JSON object repeats a key, compared after decoding escapes | `duplicate_key` |
| The top level is an object with `lockfileVersion` exactly `3` | `invalid_structure`, `unsupported_lockfile_version` |
| `packages` is an object with at most 2000 entries | `invalid_structure`, `too_many_packages` |
| Every key is a chain of `node_modules/<name>` steps whose names are valid package names, so no key can name a path outside `node_modules` | `unsafe_package_path` |
| Every version is a plain semantic version, without build metadata | `invalid_structure` |
| `resolved` equals exactly the registry tarball address implied by the package's name and version, `https://registry.npmjs.org/<name>/-/<file>-<version>.tgz`; any other host, scheme, port, credentials, query, fragment, git or file source is rejected | `unsupported_source`, `inconsistent_entry` |
| `integrity` is exactly one well-formed SHA-512 hash | `missing_integrity`, `weak_integrity` |
| The entry is not linked or bundled | `unsupported_entry` |

Comparing `resolved` against one exact expected string, and not parsing the URL, removes the whole class of host-confusion and parsing tricks. An aliased package is checked against its real name, so an entry cannot point at a different package's tarball.

A package that declares install scripts is accepted with an `install_script_not_run` warning, because the scripts are never run. The evaluation report counts these.

On success the packages are returned sorted by location, so the result does not depend on key order. On any error no package list is returned, up to 50 errors are reported, and a rejected location is truncated to 200 characters in the message.

### What validation does not do

- It does not check that a package's content matches its integrity hash. That is done when the package is downloaded.
- It does not check that the lockfile agrees with `package.json`.
- It does not decide whether a package is safe. A package on the public registry with a correct hash can still be malicious or compromised; see the supplier risk in `threat-model.md`.

## Limits and boundaries

Real lockfiles can exceed the 1 MiB limit, and such projects are not representable yet. The share of real projects excluded by the size limit, by install scripts, and by native addons is measured in the real-project evaluation before the workflow is described as supported.
