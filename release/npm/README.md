# proofissue

ProofIssue turns a failing Node.js command into a portable `.proofissue.yaml` artifact that a maintainer can replay in a locked-down Linux container, and replay again after a fix to confirm the failure is gone.

This is a preview of the initial supported Node.js workflow. It is not a stable release of every planned feature.

```text
npx proofissue --version
npx proofissue record --help
```

Requirements: Node.js 24 or newer to record and inspect. Replay needs Docker Engine 27 or newer on x86-64 Linux with the approved image already pulled; nothing is pulled for you.

Documentation, the command reference, security model, and known limits:
https://github.com/x9nst/Proofissue

Report problems at https://github.com/x9nst/Proofissue/issues and include the output of `proofissue --version`.

Licensed under the Apache License 2.0. Third-party notices for the bundled code are in `dist/third-party-licenses.txt`.
