# ProofIssue

ProofIssue turns a failing Node.js command into a portable, inspectable bug report that a maintainer can replay and, after a fix, re-run as a regression check.

## Status

The initial supported Node.js workflow is released as a **preview** (version 0.1.0). It records one failing Node.js command, writes a validated `.proofissue.yaml` artifact, and replays it in a locked-down Linux container. It supports a deliberately narrow environment (see [Known limits](#known-limits)), and it has not completed roadmap Phase 1: see `MILESTONES.md` and `IMPLEMENTATION_PLAN.md`, where the Milestone 8 criterion of external preview users is still open.

## Install

Install the 0.1.0 preview from its GitHub release:

```text
npm install --global https://github.com/x9nst/Proofissue/releases/download/v0.1.0/proofissue-0.1.0.tgz
proofissue --version
```

Once the package is also published on npm, the shorter forms work too. Until then, `npx proofissue` returns a 404; use the installed `proofissue` command instead wherever this README writes `npx proofissue`.

```text
npx proofissue@0.1.0 --version
npm install --global proofissue
```

The GitHub release also lists the tarball's SHA-256 checksum and a build-provenance attestation, which you can check with `gh attestation verify proofissue-0.1.0.tgz --repo x9nst/Proofissue`.

It is a single file for Node.js 24 or newer with no runtime dependencies. Recording works on Windows, macOS, and Linux; replay needs the host in [Known limits](#known-limits).

From source, for contributors or before the release is published:

```text
git clone https://github.com/x9nst/Proofissue.git
cd Proofissue
npm ci
npm run build
node packages/cli/dist/bin.js --version
```

Wherever this README writes `npx proofissue`, `node packages/cli/dist/bin.js` is the from-source equivalent.

## Try it in 5 minutes

The example is a script with one bug. Create two files in an empty directory.

`src/calculate.mjs`:

```js
export function calculate(value) {
  return value + 1;
}
```

`test/reproduction.mjs`:

```js
import { calculate } from '../src/calculate.mjs';

if (calculate(2) !== 4) {
  console.error('Expected 4 from calculate(2)');
  process.exitCode = 1;
}
```

Running `node test/reproduction.mjs` prints `Expected 4 from calculate(2)` and exits `1`. That is the failure to report.

### 1. Record it (reporter)

```text
npx proofissue record -- node test/reproduction.mjs
```

In a terminal this is guided. ProofIssue suggests `test/reproduction.mjs` and `src/calculate.mjs` with the reason for each; answer `y` to `Use these files?`. It then runs the command once and lists what it printed; press Enter to take the suggested line `Expected 4 from calculate(2)`. It shows exactly what it will store, asks you to confirm the file roles and the write, and writes `reproduction.proofissue.yaml` in the current directory. Nothing is chosen for you without a prompt. The full session is in `docs/cli.md`.

Without a terminal (a script, or `--yes`), nothing is suggested, so name the files and the expected text yourself:

```text
npx proofissue record --yes \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  -- node test/reproduction.mjs
```

Recording is not sandboxed: it runs your command on your machine. Read the preview before confirming.

### 2. Share it

Drag `reproduction.proofissue.yaml` into the GitHub issue. GitHub accepts the `.yaml` extension; it does not accept `.proofissue`. The file is YAML. You can check it yourself without running anything:

```text
npx proofissue validate reproduction.proofissue.yaml
npx proofissue inspect reproduction.proofissue.yaml
```

### 3. Replay it (maintainer)

Replay needs the host described in [Known limits](#known-limits). `doctor` checks it, changes nothing, and prints the exact `docker pull` command if the approved image is missing:

```text
npx proofissue doctor
npx proofissue replay reproduction.proofissue.yaml
```

`replay` says whether the failure `reproduced`, and why. A downloaded artifact is untrusted; replay validates it and runs it only inside the container.

### 4. Check a fix

Change `value + 1` to `value * 2` in `src/calculate.mjs`, then replay against your checkout. Only the declared subject files are substituted:

```text
npx proofissue replay reproduction.proofissue.yaml --against . --require-status not_reproduced
```

The command exits `0` when the failure is gone and `1` otherwise, so it also works as a CI step.

## Projects with dependencies

If the failing project has a `package.json` and a `package-lock.json`, `record` asks whether to record them so replay can install the locked packages (pass `--dependencies` to say yes, `--no-dependencies` to say no). Replay never uses the network, so a maintainer fetches the packages first with one explicit step:

```text
npx proofissue replay reproduction.proofissue.yaml --prepare --dependency-store .proofissue-store
```

`--prepare` downloads and verifies the locked packages into the store, then replays offline from it. See `docs/dependencies.md`.

## GitHub Action

The replay Action calls the same code as the command line. Replay never pulls an image, so pull the approved one first (`npx proofissue doctor` prints the exact reference):

```yaml
- uses: actions/checkout@v7
  with:
    persist-credentials: false
- name: Prepare the approved image
  env:
    PROOFISSUE_IMAGE: node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6
  run: docker pull "$PROOFISSUE_IMAGE"
- uses: x9nst/Proofissue/action@v0.1.0
  with:
    artifact-path: failures/reproduction.proofissue.yaml
    required-status: reproduced
```

For an artifact with dependencies, run `x9nst/Proofissue/action/prepare@v0.1.0` first and give both steps the same `dependency-store`. Tags move only by deliberate release, but for a security-sensitive workflow pin the full commit SHA of the release instead, as `docs/github-action.md` recommends.

## Known limits

This preview is narrow on purpose. These are support boundaries, not evidence about any particular failure.

- **Dependencies:** npm lockfile version 3 and the public npm registry only. Install scripts never run, so packages with native addons do not work.
- **Test runners:** pure-JavaScript runners only. Commands run as `node <script>`; `npm test`, `npx`, and package scripts are not run. vitest and tsx are unsupported, and jest is untested.
- **Replay host:** a local, rootful Docker Engine 27 or newer on x86-64 Linux, with the approved image already pulled. Docker Desktop, rootless Docker, ARM, and Podman are unsupported. Windows and macOS can record but not replay; use the GitHub Action on a hosted Linux runner.
- **Fixed limits:** 60 seconds (including dependency installation), 512 MB of memory, 1 CPU, 64 processes, and 1 MiB per output stream. They cannot be changed.
- **Runtime:** replay always uses the Node.js 24 image, whatever version recorded the failure.
- **Network:** none during replay. Only `--prepare` and the prepare Action use it, to download locked packages.
- **Recording is not sandboxed.** It runs your command with your user's access.
- **Only the files you select are collected.** A file your runner reads but you did not select, such as `.mocharc.json`, is missing at replay.
- **Fix checks** substitute only the declared subject files. New, removed, or renamed files are not evaluated.

See `docs/supported-environments.md` and `docs/security-model.md`.

## Feedback

- A `.proofissue.yaml` did not replay: open an issue with the **Artifact did not replay** template. It asks for `npx proofissue --version`, the `doctor` output, and the `replay --json` result, which contains no output text.
- You tried the preview: use the **Preview feedback** template. It asks what you attempted, where you got stuck, how long the first artifact took, and whether you would use it again.
- Maintainers who want to review the workflow can start from `docs/maintainer-participant-packet.md`.
- Security problems: see `SECURITY.md`.

## Documentation

`docs/README.md` is the documentation map. `docs/cli.md` is the command reference, and `examples/failing-node-test` holds the example above with its tests.

## Development

Requirements: Node.js 24, npm 11, Git, and, for container tests, Docker Engine 27 or newer on x86-64 Linux.

```text
npm ci
npm run check
```

The root check runs formatting, linting, dependency-boundary validation, strict type checking, tests, builds, and repository-hygiene checks. See `CONTRIBUTING.md`.

## Security

Artifacts and replay commands are untrusted input. Do not run a received artifact outside the ProofIssue runner. See `SECURITY.md`, `docs/security-model.md`, and `docs/threat-model.md`.

## License

ProofIssue is licensed under the Apache License 2.0. See `LICENSE` and `docs/license-decision.md`.
