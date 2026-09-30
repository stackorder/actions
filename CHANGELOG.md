# Changelog

All notable changes to this repository are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/). Each `vX.Y.Z` release also moves the `vX` tag.

## [1.0.0] - 2026-09-30

The first release. It requires [stackorder/stackorder](https://github.com/stackorder/stackorder) v0.1.0 or later, for the server and for the `stackorder` CLI that `setup` installs.

### Added

- `setup` JavaScript action (`node24`): installs the `stackorder` CLI for linux, darwin and windows on amd64 and arm64, resolves `latest` through the GitHub releases API (sending `github.token` only on github.com), verifies the archive's SHA-256 against the release checksums file, caches it with `@actions/tool-cache` and adds it to `PATH`; outputs `version` and `path`.
- `resolve` composite action: runs `stackorder resolve` and exposes `matrix`, `waves`, `affected`, `count`, `run-id` and `unconfirmed`.
- `plan` composite action: runs `stackorder plan` for one stack, keyed `path` or `path:instance`, and uploads the plan file as the `stackorder-plan-<slug>-<sha>` artifact, the slug being the stack key made path-safe plus 8 hex characters of its SHA-256.
- `apply` composite action: downloads the plan artifact from the plan run and runs `stackorder apply` with it.
- `drift` composite action: runs `stackorder drift`, treating exit code 2 as drift found rather than a failure.
- Reusable `plan.yml` workflow for pull requests: a resolve job that scans the pull request head and resolves the `stackorder` version once, one plan job per affected stack checking out the entry's `sha`, and a job summary instead of plans for fork pull requests. `pull_request_target` is not supported.
- Reusable `run.yml` workflow for server dispatches: plan, apply or drift per stack under the environment the server assigned, serialized per stack in the concurrency group `stackorder-stack-<key>`. Applies assume the role `aws-role-arn-map` selects; plan and drift dispatches assume `aws-plan-role-arn`, falling back to `aws-role-arn`.
- `aws-role-arn-map` on `plan.yml` and `run.yml`: keys are path prefixes, matched on whole path segments, `path:instance` keys (an exact stack key) and `:instance` keys (that instance in any directory). An exact key wins, then `:instance`, then the longest matching prefix, then `aws-role-arn`.
- `aws-role-session-name` input on `plan.yml` and `run.yml`: a role session name, or a JSON object with `plan`, `apply` and `drift` keys (drift falls back to plan), passed to `configure-aws-credentials` as `role-session-name` after replacing characters outside `[\w+=,.@-]` with `-` and cutting it to 64 characters. Empty keeps the action's default; a one-character name fails the job with an error naming the input, since AWS needs 2 to 64 characters.
- README section on AWS roles for stack instances: one OIDC role per instance through `aws-role-arn-map`, or one bootstrap role per mode with the provider assuming the instance's role. Each apply role's trust policy pins its GitHub environment, and `plan.yml` gets a read-only plan role or a map of plan-only roles, never the apply-role map, since pull request plans run the pull request's code with no environment.
- Marketplace branding on every action: the `layers` icon on `orange`, the closest colour GitHub allows to the brand's accent.
- README header with the Stackorder logo, which follows the reader's light or dark theme, and links to stackorder.io, docs.stackorder.io and `stackorder/stackorder`; the README links to the design document and the Stack instances page on docs.stackorder.io. The logo files and the repository's social preview image are in `.github/assets/`.
- CI with lint, type checks, tests, a `setup/dist` freshness check, actionlint, a `setup` failure smoke test, a composite action test against a stub CLI and a `drift` exit code check; a release workflow that publishes release notes and moves the major tag when the release is the newest of its major.

[1.0.0]: https://github.com/stackorder/actions/releases/tag/v1.0.0
