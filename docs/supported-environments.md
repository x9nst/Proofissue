# Supported Environments

## Foundation Development

Milestone 1 supports development and non-container checks with:

- Node.js 24.x;
- npm 11.x;
- Ubuntu 24.04 x86-64 in CI;
- Windows Server 2025 x86-64 in CI;
- local Windows, macOS, or Linux development where the same Node.js and npm versions are available.

The lockfile is authoritative. Other Node.js or npm major versions are unsupported until tested and documented.

## Recording Claim

The technical prototype intends to support recording on Windows, macOS, and Linux with Node.js 24. That claim remains provisional until recorder integration tests pass on each operating system.

## Replay Claim

The technical prototype's first supported replay environment is deliberately narrow:

- Docker Engine 27.0 or newer;
- Docker command-line invocation, not a direct engine library;
- local, rootful Docker Engine;
- x86-64 Linux host;
- approved x86-64 Linux image pinned by digest.

Rootless Docker, remote Docker contexts, ARM64, Docker Desktop, Podman, and other engines are experimental and carry no support claim until their security controls and cleanup behavior are separately tested.

Before creating a container, the runner will check engine availability, version, local context, architecture, and every mandatory isolation control. A missing control produces a typed failure. ProofIssue never retries with weaker isolation.

Replay never pulls an image automatically. Image preparation is a separate explicit action that displays and verifies the requested registry and digest. Artifact input alone cannot approve an image.

## CI Images

Foundation checks use fixed GitHub-hosted runner labels rather than moving `latest` labels:

- `ubuntu-24.04` for Linux;
- `windows-2025` for Windows.

Later replay integration runs on `ubuntu-24.04` x86-64 and records the runner image, Docker Engine version, and architecture as test evidence.
