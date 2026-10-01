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

From the repository root, after `npm ci && npm run build`:

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

The recorder shows exactly what it will capture and asks you to confirm. Add `--yes` to approve without prompting once you have reviewed it.

```text
node packages/cli/dist/bin.js validate failure.proofissue
node packages/cli/dist/bin.js inspect failure.proofissue --json
```

## Replay and verify a fix (Linux with Docker)

Replay needs Docker Engine 27 or newer on x86-64 Linux, with the approved image already pulled. See `docs/replay.md`.

```text
node packages/cli/dist/bin.js replay failure.proofissue --require-status reproduced
```

Now fix the bug by changing `value + 1` to `value * 2` in `src/calculate.mjs`, and replay against your checkout:

```text
node packages/cli/dist/bin.js replay failure.proofissue \
  --against examples/failing-node-test --require-status not_reproduced
```

`not_reproduced` means the failure no longer occurs under the declared subject substitution. Revert the change to run the example again.

## A ready-made artifact

`tests/fixtures/action/reproduced.proofissue` is an artifact for this same failure, and the GitHub Action integration workflow replays it on every change. `tests/fixtures/action/current-checkout/calculate.mjs` is the corrected subject.

A test in `packages/application/src/example.test.ts` records this project with the exact arguments above, so this example is checked on every change to the repository.
