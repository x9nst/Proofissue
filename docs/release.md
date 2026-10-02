# Release Runbook

This is the maintainer procedure for publishing the `proofissue` npm package and its GitHub Release. Contributors do not need it. For building and testing the package locally, see `contributing.md`.

ProofIssue 0.1.0 is a preview release of the initial supported Node.js workflow. It is published to the `latest` npm tag so that `npx proofissue` resolves, and it is labelled "preview" in the GitHub Release title and in the documentation. The GitHub Release is marked as a prerelease.

## How a release works

Pushing a tag named `vX.Y.Z` starts `.github/workflows/release.yml`. The jobs run in this order, and each needs the one before it:

| Job | Permissions | What it does |
| --- | --- | --- |
| `verify` | `contents: read` | Requires the tag commit to be an ancestor of `origin/main` and the tag to equal `v` plus the version in `release/npm/package.json` and `PROOFISSUE_VERSION`. Runs `npm ci`, `npm run check`, and `git diff --exit-code`. Packs the CLI, checks the tarball and its reproducibility, extracts the release notes from `CHANGELOG.md`, and writes `SHA256SUMS`. |
| `smoke` | `contents: read` | Installs the tarball on Ubuntu 24.04 and Windows Server 2025 and runs the packed CLI on the example. Ubuntu also pulls the approved image and replays. |
| `github-release` | `contents: write`, `id-token: write`, `attestations: write` | Attests the build provenance of the tarball and creates the prerelease with the tarball, `SHA256SUMS`, and `third-party-licenses.txt`. |
| `npm-publish` | `id-token: write` only | Runs only when the repository variable `NPM_TRUSTED_PUBLISHING` is `true`, in the `npm-publish` environment. Publishes the verified tarball with npm trusted publishing and provenance. |
| `move-major-tag` | `contents: write` | Creates or moves the `v0` tag (the major version of the release) to the release commit when the release is the highest of its major version. |

No npm token, OTP, or other npm credential exists in the repository, in its secrets, or in the workflow. Third-party actions are pinned to full commit SHAs; the comment beside each pin names its version.

Running the workflow manually (Actions, Release, Run workflow) is a dry run. It performs `verify` and `smoke` on the selected ref and skips every job that publishes, because those jobs require a push event on a tag. The dry run reads the `Unreleased` changelog section instead of a dated one and skips the tag checks. The manual trigger works once the workflow file exists on the default branch.

### Why the first publish is manual

npm trusted publishing cannot publish a package that does not exist yet ([npm/cli#8544](https://github.com/npm/cli/issues/8544)): the package must exist before a trusted publisher can be configured for it. Version 0.1.0 is therefore published by hand by the maintainer, from the exact tarball that CI built and attested. Automatic publishing with provenance starts at 0.1.1.

## Maintainer manual steps

Complete the steps in order.

1. **Confirm npm account security.** The npm account that will own `proofissue` has security-key two-factor authentication. Optionally create the npm organization `proofissue` to reserve the scope.
2. **Prepare GitHub, once.**
   - Create the environment `npm-publish`. Add the maintainer as a required reviewer and limit deployment to `v*` tags.
   - Set the repository variable `NPM_TRUSTED_PUBLISHING` to `false`.
   - Add a tag ruleset that protects `v*.*.*`: restrict creation, updates, and deletion to maintainers. The `v0` major tag does not match this pattern because the release workflow moves it.
   - Optionally turn on immutable releases.
3. **Cut the release commit.** Merge the release pull request that sets `PROOFISSUE_VERSION` and `release/npm/package.json` to the release version and dates the changelog section as `## [X.Y.Z] - YYYY-MM-DD`. Then tag the merge commit and push the tag:

   ```text
   git tag vX.Y.Z <merge-commit-sha>
   git push origin vX.Y.Z
   ```

4. **Watch `release.yml`.** All of `verify`, `smoke`, `github-release`, and `move-major-tag` must succeed. `npm-publish` is skipped while `NPM_TRUSTED_PUBLISHING` is `false`. Download the tarball and `SHA256SUMS` from the GitHub Release, then verify both the checksum and the attestation:

   ```text
   gh release download vX.Y.Z --repo x9nst/Proofissue --pattern "proofissue-*.tgz" --pattern SHA256SUMS
   sha256sum --check SHA256SUMS
   gh attestation verify proofissue-X.Y.Z.tgz --repo x9nst/Proofissue
   ```

5. **First publish, by hand (0.1.0 only).** From the directory holding the verified tarball, with your own two-factor authentication:

   ```text
   npm publish ./proofissue-0.1.0.tgz --access public
   ```

   Never paste an npm token or one-time password into an issue, a commit, a workflow, or an assistant session.

6. **Configure trusted publishing.** On npmjs.com, open the `proofissue` package settings and add a trusted publisher of type GitHub Actions: owner `x9nst`, repository `Proofissue`, workflow `release.yml`, environment `npm-publish`. Set the publishing access to "Require two-factor authentication and disallow tokens". Then set the repository variable `NPM_TRUSTED_PUBLISHING` to `true`, so that CI publishes from 0.1.1 onward.
7. **Verify the release.**
   - `npx proofissue@0.1.0 --version` prints `0.1.0` on Windows and on Linux.
   - The README five-minute flow works from a clean directory.
   - The `v0` tag points at the release commit.
   - A workflow in a scratch repository using `x9nst/Proofissue/action@v0.1.0` runs.
8. **Invite feedback.** Open and pin a "Preview feedback" issue, and invite maintainers using `maintainer-participant-packet.md`.

## Releases after the first

Repeat steps 3, 4, and 7. With `NPM_TRUSTED_PUBLISHING` set to `true`, the `npm-publish` job waits for the required reviewer on the `npm-publish` environment, then publishes the attested tarball from CI. If it fails, do not publish by hand from a different build: fix the cause and publish a new patch version.

## If something goes wrong

- **`verify` rejects the tag.** The tag is not on `main`, or it differs from the package versions. Delete the tag, correct the release commit, and tag again.
- **A published version must not be used.** Deprecate it with `npm deprecate` and release a patch version. Do not unpublish.
- **A secret was exposed.** Rotate it at its source first, then follow `../SECURITY.md`.
