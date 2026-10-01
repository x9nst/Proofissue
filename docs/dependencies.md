# Dependencies

**Status:** In progress. Lockfile validation, recording the manifest and lockfile, and preparing packages into a local store are implemented as a library. No command runs preparation yet, and installing from the store inside the replay container is not implemented, so an artifact with dependency files cannot be replayed yet.

This document describes how ProofIssue will handle a project's npm dependencies, following [decision 0002](decisions/0002-dependency-strategy.md): a separate, explicit `prepare` step downloads and verifies the packages a lockfile names, and replay then runs offline. It is extended as each step lands.

## Scope of the first supported workflow

- npm only, with `package-lock.json` at the project root.
- Lockfile version 3 only.
- Packages from the public npm registry only.
- Lifecycle scripts are never run. A package that needs an install script, a compiled addon, or an install-time download is outside the supported boundary.
- The lockfile must fit the 1 MiB per-file artifact limit.
- A single package, not an npm workspace. Workspace and linked packages are rejected, so a monorepo's own lockfile does not validate; this repository's is an example.

## Recording

`proofissue record --dependencies` records `package.json` and `package-lock.json` from the project root with the `dependency` artifact role. It is opt-in, validates the lockfile before running the command, shows the reporter the file names and package counts, and refuses to record if redaction would alter either file. See `recording.md`.

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

## Preparation

`prepareDependencies` turns a lockfile into verified tarballs in a local store. It is the one step that uses the network, it runs outside the sandbox on the machine that will replay, and it is separate from replay on purpose: replay never has a network.

In order, it:

1. validates the lockfile, and stops with the lockfile errors if it is unusable, before any request or any change to the store;
2. drops the packages whose `os`, `cpu`, or `libc` restrictions exclude the replay platform, Linux on x86-64 with glibc, so a lockfile that lists a binary for every operating system downloads one;
3. downloads each distinct tarball once, however many places in the tree install it;
4. checks every download against its SHA-512 integrity hash, and keeps it only if it matches.

Nothing is extracted or executed, and install scripts are never run.

### What a download may do

| Control | Behavior |
| --- | --- |
| Address | Exactly the registry tarball address the lockfile validation accepted, checked again immediately before the request. Any other address is refused without a request. |
| Redirects | Never followed. A redirect fails the download. |
| Encoding | Compression is not requested, and an encoded response is refused, because hashes cover the exact bytes. |
| Credentials | None are sent. The only headers are fixed. |
| Size | A single package is limited to 64 MiB, and the total downloaded in one run to 512 MiB. Stored entries do not count toward the total. A declared length over the limit fails before any body is read, and a body that runs over the limit stops as soon as it does. |
| Time | One minute per download and ten minutes in all. |
| Concurrency | Four downloads at once by default, never more than eight. |
| Failure | The first failure stops every other download. Nothing partial is kept. |

### The store

The store is a directory of tarballs named only by their digest, so nothing a lockfile says can influence a path. A download is written under a temporary name and moved into place only after its hash matches, so a partial or wrong download never becomes an entry. An entry already present is hashed again before it is trusted, a corrupt one is replaced, and a link or directory planted in its place is never followed or deleted. Entries are readable by the unprivileged user the replay container runs as. Several preparations can share a store at once.

### Results

The result is one of `prepared`, `invalid_lockfile`, or `failed`. A prepared result lists each package with its store file, size, and whether it was downloaded or reused, and counts the packages skipped for the platform. A failed result lists typed errors (`integrity_mismatch`, `http_status` with the status code, `redirect_refused`, `content_encoding_refused`, `size_limit_exceeded`, `total_size_limit_exceeded`, `timeout`, `cancelled`, `network_error`, `url_refused`, `store_unsafe`, `store_write_failed`). Errors never include response bodies.

### What preparation does not do

- It does not decide a package is safe. A package with a correct hash can still be malicious or compromised.
- It does not extract tarballs. Unpacking untrusted archives belongs inside the replay sandbox.
- It does not run install scripts or build native addons.
- It is not yet reachable from a command, the GitHub Action, or the application layer.

## Early observations

These are a first look, not the real-project evaluation, and they are not a coverage claim. Lockfiles generated by npm for four common package sets validated: Express (68 packages), TypeScript with ESLint (129), esbuild with Vite (58), and Jest (268), from 29 KB to 127 KB. Two of them contained packages that declare install scripts (`esbuild` and `fsevents`), which are accepted with a warning and never run. The lockfile for esbuild and Vite lists a platform-specific binary package for every operating system; preparation fetches only the ones that match the Linux x86-64 replay image, using each entry's `os`, `cpu`, and `libc` fields. This repository's own lockfile is rejected, because it describes an npm workspace with linked packages.

## Limits and boundaries

Real lockfiles can exceed the 1 MiB limit, and such projects are not representable yet. The share of real projects excluded by the size limit, by install scripts, and by native addons is measured in the real-project evaluation before the workflow is described as supported.
