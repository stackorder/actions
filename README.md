# Stackorder Actions

GitHub Actions and reusable workflows for [Stackorder](https://github.com/stackorder/stackorder), the lightweight Terraform and OpenTofu orchestrator on GitHub Actions.

All runner-side logic lives in the `stackorder` CLI. This repository installs it and wraps it: one JavaScript action that downloads and verifies the binary, four composite actions that only pass arguments to it, and two reusable workflows that your repository calls from two short workflow files. Nothing here uses Docker, so self-hosted runners without a Docker socket work unchanged.

| Path | Kind | What it does |
| --- | --- | --- |
| [`setup`](#setup) | JavaScript action (`node24`) | Downloads the `stackorder` release for the runner, verifies its SHA-256, caches it and adds it to `PATH` |
| [`resolve`](#resolve) | Composite action | `stackorder resolve`: scans the repository, posts the graph, exposes the plan matrix |
| [`plan`](#plan) | Composite action | `stackorder plan` for one stack, then uploads the plan file as an artifact |
| [`apply`](#apply) | Composite action | Downloads a stack's plan artifact from the plan run, then `stackorder apply` |
| [`drift`](#drift) | Composite action | `stackorder drift` for one stack; drift found is an output, not a failure |
| [`.github/workflows/plan.yml`](#planyml) | Reusable workflow | Pull request plans: resolve, then one plan job per affected stack |
| [`.github/workflows/run.yml`](#runyml) | Reusable workflow | Server-dispatched plan, apply or drift for one wave of stacks |

## Using the reusable workflows

A repository needs a `stackorder.yaml` and two workflow files. The [design document](https://claude.ai/artifact/W3gQnvGu5Fw9DSXApYE766) gives the two files as:

**`.github/workflows/stackorder-plan.yml`**

```yaml
name: stackorder plan
on:
  pull_request:
    types: [opened, synchronize, reopened]
concurrency:
  group: stackorder-plan-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  plan:
    uses: stackorder/actions/.github/workflows/plan.yml@v1
    with:
      aws-role-arn: arn:aws:iam::123456789012:role/stackorder-plan
      tool: tofu
    secrets: inherit
```

**`.github/workflows/stackorder-run.yml`**

```yaml
name: stackorder run
on:
  workflow_dispatch:
    inputs:
      run_id:  { type: string, required: true }
      mode:    { type: string, required: true }   # resolve | apply | drift
      wave:    { type: string, required: false }
      stacks:  { type: string, required: false }  # JSON array; each entry carries its environment
jobs:
  run:
    uses: stackorder/actions/.github/workflows/run.yml@v1
    with:
      run-id: ${{ inputs.run_id }}
      mode: ${{ inputs.mode }}
      wave: ${{ inputs.wave }}
      stacks: ${{ inputs.stacks }}
      aws-role-arn-map: '{"stacks/prod/": "arn:aws:iam::123456789012:role/stackorder-apply-prod", "stacks/staging/": "arn:aws:iam::123456789012:role/stackorder-apply-staging"}'
    secrets: inherit
    # each apply job runs under the GitHub environment from stackorder.yaml,
    # so the environment's protection rules gate it
```

Those two files show the shape, but they do not run as written. Three additions are required:

- **`server-url`**. Both reusable workflows require the base URL of your Stackorder server.
- **`permissions`**. A called workflow can only lower the `GITHUB_TOKEN` permissions its caller grants, never raise them, and `id-token: write` is never granted by default. The calling job must grant everything the called jobs use (see [Permissions](#permissions)).
- **`sha`**. The server dispatches `stackorder-run.yml` with a `sha` input, the commit each job checks out, and `mode` is `plan`, `apply` or `drift`.

The complete files:

```yaml
name: stackorder plan
on:
  pull_request:
    types: [opened, synchronize, reopened]
concurrency:
  group: stackorder-plan-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  plan:
    uses: stackorder/actions/.github/workflows/plan.yml@v1
    permissions:
      id-token: write
      contents: read
      checks: write
      pull-requests: read
      actions: read
    with:
      server-url: https://stackorder.example.com
      aws-role-arn: arn:aws:iam::123456789012:role/stackorder-plan
      tool: tofu
    secrets: inherit
```

```yaml
name: stackorder run
on:
  workflow_dispatch:
    inputs:
      run_id:  { type: string, required: true }
      mode:    { type: string, required: true }   # plan | apply | drift
      wave:    { type: string, required: false }
      sha:     { type: string, required: false }
      stacks:  { type: string, required: true }   # JSON array; each entry carries its environment
jobs:
  run:
    uses: stackorder/actions/.github/workflows/run.yml@v1
    permissions:
      id-token: write
      contents: read
      actions: read
      checks: write
    with:
      server-url: https://stackorder.example.com
      run-id: ${{ inputs.run_id }}
      mode: ${{ inputs.mode }}
      wave: ${{ inputs.wave }}
      sha: ${{ inputs.sha }}
      stacks: ${{ inputs.stacks }}
      aws-role-arn-map: '{"stacks/prod/": "arn:aws:iam::123456789012:role/stackorder-apply-prod", "stacks/staging/": "arn:aws:iam::123456789012:role/stackorder-apply-staging"}'
    secrets: inherit
```

Branch protection on the default branch should require the `stackorder/plan` and `stackorder/apply` checks.

## Permissions

Every job declares the minimum it needs, and the workflow-level default is `permissions: {}`.

| Workflow | Job | `id-token` | `contents` | `checks` | `pull-requests` | `actions` | Why |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `plan.yml` | `resolve` | write | read | write | read | | OIDC to the server; checkout; fallback check when the server is unreachable; pull request base and head |
| `plan.yml` | `plan` | write | read | write | | read | OIDC to AWS and the server; checkout; fallback check; reading workflow run and job metadata |
| `plan.yml` | `fork-notice` | | | | | | Writes only the job summary |
| `run.yml` | `run` | write | read | write | | read | OIDC to AWS and the server; checkout; fallback check; download of the plan artifact from the plan run |

The caller grants the union: for `stackorder-plan.yml` that is `id-token: write`, `contents: read`, `checks: write`, `pull-requests: read` and `actions: read`; for `stackorder-run.yml` it is `id-token: write`, `contents: read`, `actions: read` and `checks: write`.

## Reusable workflows

### plan.yml

Called from `stackorder-plan.yml` on `pull_request`. Three jobs:

- **`resolve`** checks out with full history, installs `stackorder`, runs the [`resolve`](#resolve) action and exposes `matrix`, `count`, `run-id`, `unconfirmed` and the installed `stackorder-version`, which every plan job installs in turn, so `latest` is resolved once per run. It runs only when the head repository is not a fork.
- **`plan`** runs once per affected stack from the resolve matrix, with `fail-fast: false` and `max-parallel`, and only when `count` is above zero. Each job checks out the entry's `sha`, the commit the resolve step scanned (the event's commit when the entry has none), installs Terraform (`hashicorp/setup-terraform@v3`) or OpenTofu (`opentofu/setup-opentofu@v1`) with the wrapper disabled, installs `stackorder`, selects the AWS role, assumes it with `aws-actions/configure-aws-credentials@v4`, restores the provider plugin cache keyed on the stack's `.terraform.lock.hcl`, and runs the [`plan`](#plan) action. Plan jobs never declare an `environment`, so planning is never held behind an environment's reviewers.
- **`fork-notice`** runs instead when the head repository is a fork and explains in the job summary why nothing was planned (see [Fork pull requests](#fork-pull-requests)).

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `server-url` | string | required | Base URL of the Stackorder server |
| `aws-role-arn` | string | `''` | IAM role for every stack that matches no prefix in `aws-role-arn-map` |
| `aws-role-arn-map` | string | `''` | JSON object from stack path prefix to IAM role ARN; the longest matching prefix wins |
| `aws-region` | string | `us-east-1` | AWS region for the credentials |
| `tool` | string | `terraform` | `terraform` or `tofu`, used when a stack's matrix entry names no tool |
| `tool-version` | string | `latest` | Tool version, used when a stack's matrix entry pins none |
| `stackorder-version` | string | `latest` | `stackorder` release to install: `1.2.3`, `v1.2.3` or `latest` |
| `runner` | string | `ubuntu-latest` | Runner label, or a JSON array or object passed to `runs-on` |
| `max-parallel` | number | `6` | Maximum number of stacks planned at the same time |
| `working-directory` | string | `.` | Directory `stackorder` runs in, relative to the repository root |
| `base-ref` | string | `''` | Git ref to diff against; empty uses the pull request base |
| `stacks` | string | `''` | Comma separated stack keys to restrict the plan to; empty plans every affected stack |

### run.yml

Called from `stackorder-run.yml`, which the server dispatches once per wave and GitHub environment. One job, `run`, fans out over the `stacks` input with `fail-fast: false` and `max-parallel`:

- `environment: ${{ matrix.environment }}` puts each stack under the GitHub environment the server assigned it (`default` when no prefix matches, never empty), so the environment's required reviewers, deployment protection rules and the AWS trust policy's `environment` condition gate the job.
- `concurrency: stackorder-stack-<stack key>` without `cancel-in-progress` keeps two jobs from running on the same stack at once. The `stack-` prefix keeps the group apart from the caller's `stackorder-plan-<pull request>` group, since concurrency groups are shared by every workflow and job in the repository. GitHub keeps at most one pending job per concurrency group, so a third job queued for the same stack replaces the pending one.
- The job checks out `sha`, installs the stack's tool (the entry's `tool` and `tool_version` when set, otherwise the `tool` and `tool-version` inputs), installs `stackorder`, selects and assumes the AWS role, restores the plugin cache, then runs exactly one of the [`plan`](#plan), [`apply`](#apply) or [`drift`](#drift) actions according to `mode`. Any other `mode` fails the job before checkout.

| Input | Type | Default | Description |
| --- | --- | --- | --- |
| `run-id` | string | required | Stackorder run id from the dispatch |
| `mode` | string | required | `plan`, `apply` or `drift` |
| `wave` | string | `''` | Wave index of this dispatch, shown in job names |
| `sha` | string | `''` | Commit to check out; empty falls back to each entry's `sha`, then to the dispatched ref |
| `stacks` | string | required | JSON array of `v1.MatrixEntry` objects, each carrying its GitHub environment; for applies also `plan_run_id` and `artifact` |
| `server-url` | string | required | Base URL of the Stackorder server |
| `aws-role-arn-map` | string | `''` | JSON object from stack path prefix to IAM role ARN; the longest matching prefix wins |
| `aws-role-arn` | string | `''` | IAM role for every stack that matches no prefix in `aws-role-arn-map` |
| `aws-region` | string | `us-east-1` | AWS region for the credentials |
| `tool` | string | `terraform` | `terraform` or `tofu`, used when an entry names no tool |
| `tool-version` | string | `latest` | Tool version, used when an entry pins none |
| `stackorder-version` | string | `latest` | `stackorder` release to install |
| `runner` | string | `ubuntu-latest` | Runner label, or a JSON array or object passed to `runs-on` |
| `max-parallel` | number | `6` | Maximum number of stacks run at the same time |
| `working-directory` | string | `.` | Directory `stackorder` runs in, relative to the repository root |

A `stacks` entry looks like this (the shape of `v1.MatrixEntry`):

```json
{
  "stack": "stacks/prod/vpc",
  "key": "stacks/prod/vpc",
  "workspace": "",
  "environment": "production",
  "wave": 0,
  "tool": "tofu",
  "tool_version": "1.9.0",
  "plan_output": "full",
  "sha": "4f1c0de2b9a8e7d6c5b4a3928170f6e5d4c3b2a1",
  "plan_run_id": 16123456789,
  "artifact": "stackorder-plan-stacks-prod-vpc-4f1c0de2b9a8e7d6c5b4a3928170f6e5d4c3b2a1"
}
```

### Shared behaviour

- **AWS role selection.** A small step picks the role for `matrix.stack`: the value of the longest key in `aws-role-arn-map` that the stack path starts with, otherwise `aws-role-arn`. When neither yields a role the job logs a notice and skips `configure-aws-credentials`, which suits self-hosted runners with an instance role. Reading `aws-role-arn-map` needs `jq` on the runner; GitHub-hosted runners have it, self-hosted runners may need it installed.
- **Tool selection.** The job sets `STACKORDER_TOOL` to the tool it installed, so the CLI always calls the binary that is on `PATH`.
- **Plugin cache.** `TF_PLUGIN_CACHE_DIR` points at `$RUNNER_TEMP/terraform-plugin-cache`, cached with `actions/cache@v4` under a key built from the runner OS and architecture, the tool and the hash of the stack's `.terraform.lock.hcl`.
- **Hooks.** `.stackorder/hooks/pre-plan.sh`, `post-plan.sh`, `pre-apply.sh` and `post-apply.sh` are run by the CLI itself, with `STACKORDER_STACK`, `STACKORDER_RUN_ID`, `STACKORDER_PLAN_JSON` and `STACKORDER_PLAN_FILE` set, so they behave the same in CI and on a laptop and need no workflow step.
- **Internal action references.** The reusable workflows use `stackorder/actions/setup@v1` and the other actions at `@v1`. A reusable workflow cannot refer to actions in its own repository by relative path when another repository calls it, so it names them in full; this repository's CI runs the same actions from their local paths.

## Actions

The composite actions contain no logic beyond passing inputs to the CLI, so any of them can be replaced by a direct `run: stackorder …` step. They expect `stackorder` on `PATH` (from [`setup`](#setup)); inputs are passed through environment variables, never interpolated into scripts.

### setup

```yaml
- uses: stackorder/actions/setup@v1
  with:
    version: 1.2.3
```

Maps the runner to `linux`, `darwin` or `windows` and `amd64` or `arm64`, downloads `stackorder_<version>_<os>_<arch>.tar.gz` (`.zip` on Windows) from `https://github.com/stackorder/stackorder/releases/download/v<version>/`, checks it against the `sha256` line for that file in `stackorder_<version>_checksums.txt`, extracts it, caches it with `@actions/tool-cache` under the tool name `stackorder`, and adds it to `PATH`. A version already in the runner's tool cache is used without downloading. Any failure (unsupported runner, unknown version, missing asset, checksum mismatch, archive without the binary) fails the step with a message naming the version, platform and URL.

| Input | Default | Description |
| --- | --- | --- |
| `version` | `latest` | Release to install, as `1.2.3` or `v1.2.3`; `latest` resolves the newest release through `GET https://api.github.com/repos/stackorder/stackorder/releases/latest` |
| `token` | `${{ github.token }}` on github.com, empty elsewhere | github.com token sent to the GitHub API when resolving `latest`. A GitHub Enterprise Server token is never sent to github.com; there, `latest` is resolved anonymously unless you pass a github.com token, or pin `version` |
| `checksum` | `true` | Verify the archive against the release checksums file: `true` or `false`, and any other value fails the step |

| Output | Description |
| --- | --- |
| `version` | Installed version, without the leading `v` |
| `path` | Absolute path to the installed `stackorder` binary |

### resolve

Runs `stackorder resolve --server <server-url> [--base <base-ref>] [--stacks <stacks>]`.

| Input | Default | Description |
| --- | --- | --- |
| `base-ref` | `''` | Git ref to diff against; empty lets the CLI use the pull request base |
| `stacks` | `''` | Comma separated stack keys to restrict the run to |
| `server-url` | required | Base URL of the Stackorder server |
| `working-directory` | `.` | Directory to run `stackorder` in |

| Output | Description |
| --- | --- |
| `matrix` | JSON object `{"include": [...]}` of `v1.MatrixEntry`, for `strategy.matrix` |
| `waves` | JSON array of stack keys per wave |
| `affected` | JSON array of affected stacks and why each is affected |
| `count` | Number of affected stacks |
| `run-id` | Stackorder run id |
| `unconfirmed` | `true` when the server was unreachable and the CLI resolved locally |

### plan

Runs `stackorder plan --stack <stack> --run-id <run-id> --server <server-url>` with `STACKORDER_PLAN_DIR` set to `$GITHUB_WORKSPACE/.stackorder/plans`, then uploads the plan file with `actions/upload-artifact@v4` under the name the CLI reports (`stackorder-plan-<key>-<sha>`), failing if the file is missing.

| Input | Default | Description |
| --- | --- | --- |
| `stack` | required | Stack key, as `path` or `path:workspace` |
| `run-id` | required | Stackorder run id |
| `server-url` | required | Base URL of the Stackorder server |
| `working-directory` | `.` | Directory to run `stackorder` in |
| `upload-artifact` | `true` | Upload the plan file; only `true` uploads |
| `retention-days` | `5` | Days to keep the plan artifact |

| Output | Description |
| --- | --- |
| `has-changes` | `true` when the plan changes resources or outputs |
| `artifact` | Name of the plan artifact |
| `plan-file` | Path of the binary plan file |
| `summary` | JSON plan summary |
| `unconfirmed` | `true` when the result could not be confirmed by the server |

### apply

Downloads the artifact `artifact` from workflow run `plan-run-id` with `actions/download-artifact@v4` into `$GITHUB_WORKSPACE/.stackorder/plans`, then runs `stackorder apply --stack <stack> --run-id <run-id> --server <server-url> --plan-file $GITHUB_WORKSPACE/.stackorder/plans/<artifact>.tfplan`. `.stackorder/plans` is the CLI's default `STACKORDER_PLAN_DIR`, anchored at the workspace so `working-directory` does not move it. The download step continues on error: when the artifact has expired the CLI finds no plan file, re-plans, and refuses to apply unless the new plan's resource addresses match the recorded plan.

| Input | Default | Description |
| --- | --- | --- |
| `stack` | required | Stack key, as `path` or `path:workspace` |
| `run-id` | required | Stackorder run id |
| `server-url` | required | Base URL of the Stackorder server |
| `plan-run-id` | required | Actions workflow run id that uploaded the plan artifact |
| `artifact` | required | Plan artifact name; the file inside is `<artifact>.tfplan` |
| `working-directory` | `.` | Directory to run `stackorder` in |
| `token` | `${{ github.token }}` | Token for the artifact download; needs `actions: read` |

| Output | Description |
| --- | --- |
| `summary` | JSON summary of the applied changes |

### drift

Runs `stackorder drift --stack <stack> --run-id <run-id> --server <server-url>`. Exit code 2 means drift was found: the step records it and succeeds. Any other non-zero exit code fails the step.

| Input | Default | Description |
| --- | --- | --- |
| `stack` | required | Stack key, as `path` or `path:workspace` |
| `run-id` | required | Stackorder run id |
| `server-url` | required | Base URL of the Stackorder server |
| `working-directory` | `.` | Directory to run `stackorder` in |

| Output | Description |
| --- | --- |
| `drifted` | `true` when real infrastructure differs from the configuration |
| `summary` | JSON summary of the drift |
| `exit-code` | Exit code of `stackorder drift`: `0` no drift, `2` drift found |

## Fork pull requests

A `pull_request` run from a fork gets a read-only `GITHUB_TOKEN` and no `id-token: write`, so it can reach neither the AWS role nor the Stackorder server. `plan.yml` therefore skips `resolve` and `plan` for forks and runs only `fork-notice`, which writes an explanation to the job summary. To get plans, a maintainer can push the branch to the repository itself. Switching the caller to `pull_request_target` does not produce fork plans with these workflows: `plan.yml` skips `resolve` and `plan` whenever the head repository is a fork, whatever the event, and the server accepts plan results only from `pull_request` tokens.

## Versions and pinning

| Reference | Moves | Use it for |
| --- | --- | --- |
| `@v1` | Yes, to every `v1.x.y` release | Receiving fixes and features without breaking changes |
| `@v1.2.3` | No | A fixed release of the workflow or action file you reference |
| `@<commit sha>` | No | Immutable pinning, for example with Dependabot or Renovate updates |

The reusable workflows call this repository's actions at `@v1` and install the `stackorder` CLI given by `stackorder-version` (`latest` by default). Pinning `plan.yml@v1.2.3` pins the workflow file, not the actions it calls; set `stackorder-version` to pin the CLI. If AWS trust policies or `STACKORDER_REQUIRED_WORKFLOW_REF` pin `job_workflow_ref` to `stackorder/actions/.github/workflows/*.yml@refs/tags/v1*`, call the workflows by a `v1` tag, not by a branch or commit.

### How the v1 tag is maintained

Releases are cut by pushing a `vX.Y.Z` tag on `main`. The [release workflow](.github/workflows/release.yml) then:

1. runs the tests and checks that `setup/dist/index.js` matches a fresh build of the source;
2. force-moves the major tag (`v1` for `v1.4.2`) to the tagged commit and pushes it, but only when the tag is the newest stable release of that major, so a patch on an older line (`v1.3.5` after `v1.4.2`) leaves `v1` where it is;
3. creates a GitHub release for the tag with generated notes.

Tags with a pre-release suffix (`v1.5.0-rc.1`) get a pre-release and leave the major tag where it is. A new major version (`v2.0.0`) starts a new major tag and leaves `v1` on the last `v1` release.

## Development

Node 24 and npm. `setup` is TypeScript in `setup/src`, bundled by esbuild into `setup/dist/index.js`, which is committed because the runner executes it directly.

```sh
npm ci
npm run lint        # ESLint with typescript-eslint
npm run typecheck   # tsc --noEmit
npm test            # Vitest
npm run build       # bundle setup/dist/index.js
npm run check-dist  # build, then fail if setup/dist differs from the commit
```

Rebuild and commit `setup/dist` with every change to `setup/src` or the dependencies. CI runs the checks above, `actionlint` over the workflows (including copies of the reusable workflows pointed at the local actions, so their inputs are checked against the metadata in this repository), a smoke test that `./setup` fails clearly for a release that does not exist, a run of the composite actions against a stub CLI in [`test/stackorder-stub.sh`](test/stackorder-stub.sh), and a check that `drift` passes on exit codes 0 and 2 and fails on 1 and 3.

## License

[Apache License 2.0](LICENSE)
