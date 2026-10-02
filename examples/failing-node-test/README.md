# Example: a failing Node.js script

A tiny, dependency-free project with one bug. `calculate(2)` should return `4`, but the implementation adds one.

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

In a terminal, from this directory, the command alone is enough (`proofissue` stands for `node <checkout>/packages/cli/dist/bin.js`):

```text
proofissue record -- node test/reproduction.mjs
```

It suggests `test/reproduction.mjs` and `src/calculate.mjs` with the reason for each, asks `Use these files? [y/N]`, runs the command once, and lists what it printed so that you can press Enter to take the suggested line `Expected 4 from calculate(2)`. Nothing is chosen for you under `--yes`, with `--json`, or without a terminal; there, name the files and the expected text as below.

From the repository root, after `npm ci && npm run build`:

```text
node packages/cli/dist/bin.js record \
  --project examples/failing-node-test \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  -- node test/reproduction.mjs
```

The image and the artifact name are defaults: the approved Node.js 24 image, and `reproduction.proofissue.yaml` in the current directory (the `.yaml` extension lets you attach the file to a GitHub issue). The recorder shows exactly what it will capture and asks you to confirm. Add `--yes` to approve without prompting once you have reviewed it. After it writes the file, it prints the path, a digest prefix, how to attach the file, and the commands to replay it.

The long form, with every default written out, records the same artifact:

```text
node packages/cli/dist/bin.js record \
  --project examples/failing-node-test \
  --output failure.proofissue \
  --image node@sha256:d45d78e7929b46875bbd4e29bea672d5bc48186c6c3588306521c815e78352d6 \
  --reproduction test/reproduction.mjs \
  --subject src/calculate.mjs \
  --expect-stderr "Expected 4 from calculate(2)" \
  -- node test/reproduction.mjs
```

The commands below use the default name:

```text
node packages/cli/dist/bin.js validate reproduction.proofissue.yaml
node packages/cli/dist/bin.js inspect reproduction.proofissue.yaml --json
```

## Replay and verify a fix (Linux with Docker)

Replay needs Docker Engine 27 or newer on x86-64 Linux, with the approved image already pulled. See `docs/replay.md`.

```text
node packages/cli/dist/bin.js replay reproduction.proofissue.yaml --require-status reproduced
```

Now fix the bug by changing `value + 1` to `value * 2` in `src/calculate.mjs`, and replay against your checkout:

```text
node packages/cli/dist/bin.js replay reproduction.proofissue.yaml \
  --against examples/failing-node-test --require-status not_reproduced
```

`not_reproduced` means the failure no longer occurs under the declared subject substitution. Revert the change to run the example again.

## A ready-made artifact

`tests/fixtures/action/reproduced.proofissue` is an artifact for this same failure, and the GitHub Action integration workflow replays it on every change. `tests/fixtures/action/current-checkout/calculate.mjs` is the corrected subject.

Tests in `packages/application/src/example.test.ts` and `packages/cli/src/index.test.ts` record this project with the arguments above, in both forms, so this example is checked on every change to the repository.
