# Example: a failing Node.js script

A tiny, dependency-free project with one bug. `calculate(2)` should return `4`, but the implementation adds one. The root `README.md` walks through this example in five minutes.

```text
src/calculate.mjs        the implementation under test (the "subject")
test/reproduction.mjs    prints "Expected 4 from calculate(2)" and exits 1 (the "reproduction")
```

Run it directly to see the failure:

```text
node test/reproduction.mjs
Expected 4 from calculate(2)
```

## Turn it into a replayable report

From this directory, with the CLI installed (`npm install --global proofissue`, or `npx proofissue@0.1.0` in its place; the npm package appears with the 0.1.0 release, and `node <checkout>/packages/cli/dist/bin.js` is the from-source equivalent after `npm ci && npm run build`):

```text
proofissue record -- node test/reproduction.mjs
```

In a terminal this suggests `test/reproduction.mjs` and `src/calculate.mjs` with the reason for each, asks `Use these files? [y/N]`, runs the command once, and lists what it printed so that you can press Enter to take the suggested line `Expected 4 from calculate(2)`. Nothing is chosen for you under `--yes`, with `--json`, or without a terminal; there, name the files and the expected text:

```text
proofissue record --yes \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  -- node test/reproduction.mjs
```

The image and the artifact name are defaults: the approved Node.js 24 image, and `reproduction.proofissue.yaml` in the current directory (the `.yaml` extension lets you attach the file to a GitHub issue). The recorder shows exactly what it will capture and asks you to confirm; `--yes` approves without prompting once you have reviewed it. After it writes the file, it prints the path, a digest prefix, how to attach the file, and the commands to replay it.

From the repository root, the same recording selects this directory with `--project`:

```text
node packages/cli/dist/bin.js record --yes \
  --project examples/failing-node-test \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  -- node test/reproduction.mjs
```

The long form, with every default written out, records the same artifact:

```text
proofissue record \
  --project . \
  --output failure.proofissue \
  --image node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  -- node test/reproduction.mjs
```

Check the artifact without running it (these use the default name):

```text
proofissue validate reproduction.proofissue.yaml
proofissue inspect reproduction.proofissue.yaml
```

## Replay and verify a fix (Linux with Docker)

Replay needs Docker Engine 27 or newer on x86-64 Linux, with the approved image already pulled. `proofissue doctor` checks this and prints the pull command if the image is missing. See `docs/replay.md`.

```text
proofissue replay reproduction.proofissue.yaml --require-status reproduced
```

Now fix the bug by changing `value + 1` to `value * 2` in `src/calculate.mjs`, and replay against your checkout:

```text
proofissue replay reproduction.proofissue.yaml --against . --require-status not_reproduced
```

`not_reproduced` means the failure no longer occurs under the declared subject substitution. Revert the change to run the example again.

## A ready-made artifact

`tests/fixtures/action/reproduced.proofissue` is an artifact for this same failure, and the GitHub Action integration workflow replays it on every change. `tests/fixtures/action/current-checkout/calculate.mjs` is the corrected subject.

Tests in `packages/application/src/example.test.ts`, `packages/cli/src/index.test.ts`, `packages/cli/src/record-suggestions.test.ts`, and `packages/cli/src/readme.test.ts` record this project with the arguments above, so this example is checked on every change to the repository.
