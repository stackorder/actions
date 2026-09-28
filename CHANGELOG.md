# Changelog

All notable changes to this repository are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/). Each `vX.Y.Z` release also moves the `vX` tag.

## [Unreleased]

### Added

- `setup` JavaScript action (`node24`): installs the `stackorder` CLI for linux, darwin and windows on amd64 and arm64, resolves `latest` through the GitHub releases API, verifies the archive's SHA-256 against the release checksums file, caches it with `@actions/tool-cache` and adds it to `PATH`; outputs `version` and `path`.
- `resolve` composite action: runs `stackorder resolve` and exposes `matrix`, `waves`, `affected`, `count`, `run-id` and `unconfirmed`.
- `plan` composite action: runs `stackorder plan` for one stack and uploads the plan file as the `stackorder-plan-<key>-<sha>` artifact.
- `apply` composite action: downloads the plan artifact from the plan run and runs `stackorder apply` with it.
- `drift` composite action: runs `stackorder drift`, treating exit code 2 as drift found rather than a failure.
- Reusable `plan.yml` workflow for pull requests: resolve, one plan job per affected stack, and a job summary instead of plans for fork pull requests.
- Reusable `run.yml` workflow for server dispatches: plan, apply or drift per stack under the stack's GitHub environment, serialized per stack.
- CI with lint, type checks, tests, a `setup/dist` freshness check, actionlint, a `setup` failure smoke test, a composite action test against a stub CLI and a `drift` exit code check; a release workflow that publishes release notes and moves the major tag when the release is the newest of its major.
