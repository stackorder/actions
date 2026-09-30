# Changelog

All notable changes to this repository are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow [Semantic Versioning](https://semver.org/). Each `vX.Y.Z` release also moves the `vX` tag.

## [Unreleased]

### Added

- `aws-role-arn-map` in `plan.yml` and `run.yml` accepts `path:instance` keys (an exact stack key) and `:instance` keys (that instance in any directory) next to path prefixes. An exact key wins, then `:instance`, then the longest matching prefix, then `aws-role-arn`; `run.yml` plan and drift dispatches still assume the single plan role.
- `aws-role-session-name` input on `plan.yml` and `run.yml`: a role session name, or a JSON object with `plan`, `apply` and `drift` keys (drift falls back to plan), passed to `configure-aws-credentials` as `role-session-name` after replacing characters outside `[\w+=,.@-]` with `-` and cutting it to 64 characters. Empty keeps the action's default; a one-character name fails the job with an error naming the input, since AWS needs 2 to 64 characters.
- README section on AWS roles for stack instances: one OIDC role per instance through `aws-role-arn-map`, or one bootstrap role per mode with the provider assuming the instance's role.

### Changed

- The `plan`, `apply` and `drift` actions and the README describe stack keys as `path` or `path:instance`.
- The README requires each apply role's trust policy to pin its GitHub environment, and says never to pass the apply-role `aws-role-arn-map` to `plan.yml`: pull request plans run the pull request's code with no environment, so `plan.yml` gets a read-only plan role or a map of plan-only roles.
- The README lists every variable a hook receives: `STACKORDER_STACK`, `STACKORDER_STACK_PATH`, `STACKORDER_INSTANCE`, `STACKORDER_RUN_ID`, `STACKORDER_PLAN_JSON`, `STACKORDER_PLAN_FILE` and the stack's configured `env` for the mode.

### Fixed

- The provider plugin cache key hashes the stack's `.terraform.lock.hcl` under `working-directory`; it hashed a path relative to the repository root, so a `working-directory` other than `.` never keyed the cache on the lock file.
- The README links to the Stack instances page without the `#env` and `#aws-roles` anchors, which GitHub does not resolve.

## [1.0.0] - 2026-09-29

The first release. It requires [stackorder/stackorder](https://github.com/stackorder/stackorder) v0.1.0 or later, for the server and for the `stackorder` CLI that `setup` installs.

### Added

- `setup` JavaScript action (`node24`): installs the `stackorder` CLI for linux, darwin and windows on amd64 and arm64, resolves `latest` through the GitHub releases API (sending `github.token` only on github.com), verifies the archive's SHA-256 against the release checksums file, caches it with `@actions/tool-cache` and adds it to `PATH`; outputs `version` and `path`.
- `resolve` composite action: runs `stackorder resolve` and exposes `matrix`, `waves`, `affected`, `count`, `run-id` and `unconfirmed`.
- `plan` composite action: runs `stackorder plan` for one stack and uploads the plan file as the `stackorder-plan-<slug>-<sha>` artifact, the slug being the stack key made path-safe plus 8 hex characters of its SHA-256.
- `apply` composite action: downloads the plan artifact from the plan run and runs `stackorder apply` with it.
- `drift` composite action: runs `stackorder drift`, treating exit code 2 as drift found rather than a failure.
- Reusable `plan.yml` workflow for pull requests: a resolve job that scans the pull request head and resolves the `stackorder` version once, one plan job per affected stack checking out the entry's `sha`, and a job summary instead of plans for fork pull requests. `pull_request_target` is not supported.
- Reusable `run.yml` workflow for server dispatches: plan, apply or drift per stack under the environment the server assigned, serialized per stack in the concurrency group `stackorder-stack-<key>`. Applies assume the role of the longest `aws-role-arn-map` prefix, matched on whole path segments; plan and drift dispatches assume `aws-plan-role-arn`, falling back to `aws-role-arn`.
- CI with lint, type checks, tests, a `setup/dist` freshness check, actionlint, a `setup` failure smoke test, a composite action test against a stub CLI and a `drift` exit code check; a release workflow that publishes release notes and moves the major tag when the release is the newest of its major.

[Unreleased]: https://github.com/stackorder/actions/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/stackorder/actions/releases/tag/v1.0.0
