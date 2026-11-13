# CI

`.github/workflows/ci.yml` is Mend's CI. Its one required check is the `checks` job. It runs on:

- `pull_request`;
- `push` to `main`;
- `workflow_dispatch`, with a `runner` input (`ubuntu-24.04` by default, or `box`);
- `schedule`, the nightly run at 02:23 UTC.

There is no merge queue: pull requests merge directly once `checks` passes. A pull request runs only
what its change affects (Turbo `--affected` against the pull request's base, with the extra jobs
picked by `scripts/ci-scope.mjs`), and never writes the remote cache. A push to `main` runs the full
CI on exactly the commit that landed, and is the trusted cache writer. The nightly run repeats it
with `--force`, reading no cache.

## Runners

Since #1047 (2026-10-17) the six x86 lanes run on GitHub's `ubuntu-24.04`, free for this public
repository. `changes` and `checks` run on `ubuntu-24.04-arm`, so neither waits for an x86 slot. The
box's self-hosted runners are used only when CI is dispatched with `runner: box`; no other event
reaches them, and `scripts/ci-workflow.test.mjs` fails if one does. Packaged acceptance, and every
job that publishes or holds a write token, runs on GitHub-hosted runners: box VMs keep state between
jobs, so code from an earlier pull request could change what a later job builds or pushes.

On hosted runners setup-node restores GitHub's pnpm cache. On the box the runners provide a
persistent store, `npm_config_store_dir=/opt/pnpm-store`, which the weekly VM snapshot reset clears.

## Jobs

`changes` classifies the change first. The other jobs then run independently, and `checks` reads
every job's result. It fails on a missing classification, a failed job or an unexpected skip; only a
literal `false` path-selection output lets an optional job be skipped.

| Job               | What it runs                                                                                                                                                                                   |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `changes`         | The path classifier (`scripts/ci-scope.mjs`): which optional jobs a pull request runs.                                                                                                         |
| `static`          | Frozen install, CI regression tests, shard inventory, lockfile policy, build, typecheck, lint, formatting and Helm lint.                                                                       |
| `test-engines`    | PostgreSQL 17, the zsh fixture, sessions shard 1/2, API, database, jobs, store and the other backend packages. Sessions starts alongside the other packages.                                   |
| `test-engines-b`  | Sessions shard 2/2 with the same PostgreSQL, zsh fixture, worker limits and evidence uploads as `test-engines`.                                                                                |
| `test-clients-a`  | The first CLI shard and one lane of client packages; locked Chromium for desktop, marketing's installer copy; the AWS shell checks and the Garage and MinIO contracts.                         |
| `test-clients-b`  | The second CLI shard and the remaining client packages. Docs builds its pages through its test script.                                                                                         |
| `packaging`       | The Node packaging, acceptance and verify command, with Docker, Caddy, OpenTofu and locked Chromium.                                                                                           |
| `mobile-web`      | The mobile web export, rendered-page and browser checks.                                                                                                                                       |
| `store-image-git` | The store's handoff admission tests under the server image's git (Debian bookworm's 2.39), through `scripts/store-image-git.sh`. Runners carry a newer git that refuses a hostile tree itself. |
| `checks`          | The required aggregate. It reads only `needs`: no checkout or setup.                                                                                                                           |

Run `node scripts/ci-shards.mjs --check` after adding or renaming a workspace package. It reads
`pnpm-workspace.yaml` and rejects missing, duplicate or unknown lane assignments, including any
missing or repeated native shard index. The CLI and sessions are each split with Vitest's
`--shard=1/2` and `--shard=2/2`; every other test script runs once, through Turbo and the package's
own script.

## Concurrency

A pull request and a dispatched branch keep only their newest run: the concurrency group is the pull
request number, or the ref for a `workflow_dispatch`, and both cancel a run in progress. Pushes to
`main` and the nightly run are grouped by run id and never cancelled, so every landed commit keeps
its own result.

The Version Packages pull request is authored by `github-actions[bot]`, so its `pull_request` runs
stop at the repository's contributor approval policy before any job starts. The release dispatches
`ci.yml` on it (`docs/operations/next-channel.md`, step 8).

## The nightly run

The nightly run passes `--force` and tests the full graph from scratch. The nightly build input
probe (`build-input-probe.yml`) proves the hashes affected selection relies on. A red or missing
nightly reaches no pull request, so `nightly-watch.yml`, on a GitHub-hosted runner so a box outage
cannot silence it, keeps one open `nightly-failure` issue. It comments on that issue, or opens it,
when a scheduled run of either workflow does not succeed, when CI fails on a push to `main`, and
when either has had no successful scheduled run on `main` for 30 hours. GitHub can start a schedule
hours late.

## Task selection and cache

Test lanes and static checks use Turbo's `--affected`, with the pull request's base SHA in
`TURBO_SCM_BASE` and complete Git history. Turbo is pinned in the root `package.json`
([turbo.md](turbo.md)). `affectedUsingTaskInputs` and `filterUsingTasks` include out-of-package
inputs in selection and intersect the result with each lane's filters. Turbo follows the package
graph, so a changed package also runs every package that depends on it. Packaging, image and mobile
path filters work as before. The standalone S3, shell and CI regression checks always run.

`checks` requires every test lane and static check to succeed, including a lane with no affected
tasks. A classification failure cannot turn missing evidence into success.

`scripts/ci-turbo.mjs configure` records the Node version, OS and architecture as `MEND_CI_RUNTIME`.
What a run reads and writes:

- **Hosted runners** (every run today): `--cache=local:rw`, which starts cold in each job. The
  nightly run uses `--force` alone. Turbo rejects `--force` together with `--cache`. No remote
  endpoint is configured.
- **Box runners** (`runner: box` only): the wrapper also configures the box proxy at
  `http://10.0.1.1:8941`, team `mend`, token `box`, a non-secret placeholder. Untrusted events read
  it (`remote:r`); trusted ones ask for `remote:rw`. Since 2026-10-16 the proxy refuses every write,
  because a job on a box VM that ran a pull request's code cannot vouch for what it writes. Turbo
  treats a refused write as a cache warning, not a task failure.

So in practice CI is `local:rw` plus the forced nightly, and the remote cache applies only to a run
dispatched with `runner: box`.

Local Turbo commands do not set `MEND_CI_RUNTIME`, so their cache keys differ from CI's. Before
every push, run the forced typecheck and lint `AGENTS.md` requires. For a local cache experiment,
export `MEND_CI_RUNTIME` from the actual Node, platform and architecture as CI does.

## Task inputs

Every package keeps `$TURBO_DEFAULT$` inputs: its tests, source, fixtures, manifest and
configuration. Workspace dependency hashes flow through the `^build`, `^lint` and `^typecheck`
edges, including source-only packages whose build node is a transit node. The build node leaves out
the package's own test files (`*.test.*`, `*.spec.*`) and Vitest configurations, so a test-only
change does not select every dependent's tests through `^build`. Everything else under `test/` stays
in, because db, sessions and store export `./testing` entries from there that other packages' tests
import. Three builds keep their own test files, because they read them: desktop's and web's Tailwind
scans every file of the app, and the VS Code build typechecks `src/**`, tests included, as the
publish workflow's type gate. The root manifest is a built-in Turbo input. The lockfile, the
workspace catalog, `.node-version` and `.npmrc` are explicit global inputs.

`scripts/ci-build-input-probe.mjs` proves every build task hashes each test file it reads. For each
build task, Turbo names every file that can change its hash: its own inputs and those of every task
it depends on. Every other test, spec and Vitest configuration file gets a unique import, string,
Tailwind class and type error appended, and the build must then produce exactly what it produced
unchanged, exit 0, and carry no marker. Two unchanged builds come first: each must exit 0, and their
outputs must match byte for byte once three named volatile fields are normalised (Nitro's build
date, its public-asset mtimes and order, and the marketing page's router render times). Any other
difference between unchanged builds fails the probe rather than hiding a change. Its builds run with
every cache off. Its own tests mutation-test it in small real-Turbo workspaces, one per flaw it must
catch, and it runs nightly and on any `turbo.json` change. Deleting test files cannot prove this: a
deleted file loses the diagnostics and class names a mutation adds.

All tasks hash `CI`, `MEND_CI_RUNTIME`, `NODE_ENV`, `TZ`, `LANG` and `LC_ALL`. Behavioural
configuration is hashed rather than passed through without a hash. Turbo's standard OS passthrough
variables such as `PATH` and `HOME` stay available. The native-tool and service suites below are
uncached because those paths do not identify their implementations.

| Task                                 | Additional inputs and environment                                                                                                                                                         | Outputs restored on a hit                                                                                   |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Every lint task                      | Root `.oxlintrc.json`; inherited package source and dependencies                                                                                                                          | None                                                                                                        |
| Every typecheck task                 | Shared `@mend/typescript` configuration through workspace dependencies; each package's own tsconfig                                                                                       | None                                                                                                        |
| Every build task                     | `tooling/scripts/**`, package `.env*`; `BUNDLE_*`, `MEND_*`, `APP_URL`, `ALLOWED_ORIGINS`, `VITE_*`, `NITRO_*`, `NODE_OPTIONS`                                                            | `dist`, `build`, `.output`, `out`, CLI `man`, Astro `.astro`, generated route trees and marketing installer |
| Every test task                      | `deploy/**`, `.agents/skills/verify/**`, package `.env*`; `MEND_*`, `SEALANT_*`, `DATABASE_URL`, `APP_URL`, `ALLOWED_ORIGINS`, `VITEST_*`, `VITE_*`, `NODE_OPTIONS`, `DOCKER_*`, `TEST_*` | None; the real-service exceptions below do not cache                                                        |
| Marketing build and test             | Root `install.sh`; the build excludes its generated copy from inputs                                                                                                                      | Build restores `public/install.sh`; test checks both copies                                                 |
| CLI test                             | Root `install.sh`, `Dockerfile`, `scripts/mend-migrations.mjs` and `packages/db/src/migrations.ts`; `$TURBO_EXTENDS$` keeps every inherited input                                         | Uncached                                                                                                    |
| Sessions test                        | Provider-login documentation under `apps/docs`, and `.oxlintrc.json` for its guarded-import checks                                                                                        | Uncached                                                                                                    |
| Web, marketing and desktop typecheck | An explicit dependency on their own build, to restore ignored generated route trees before checking                                                                                       | Their build's outputs                                                                                       |
| Web test                             | An explicit dependency on its own build, to restore the ignored generated route tree its router tests import                                                                              | Its build's outputs                                                                                         |

Shared native scripts and deployment fixtures invalidate every test task. That covers the CLI's
compose, mirror and migration contracts, the web native reporter and the sessions benchmark
compatibility test. The verify skill's scripts are covered even though most verification contracts
run in the separate, uncached packaging command. Dockerfiles, image tags, migrations and SQL schemas
inside packages are package source inputs. Root deployment image definitions are test inputs too.
Native packaging and image jobs do not use Turbo's result cache. Root `scripts/` is not a shared
test input: a script reaches a test's hash only where that test reads it, which the audit below
enforces.

These package test tasks have `cache: false`, and run whenever selected:

| Packages                                                    | External implementation exercised                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `apps/api`, `packages/auth`, `packages/db`, `packages/jobs` | Migrated PostgreSQL repositories and jobs; the API also exercises Git              |
| `packages/sessions`                                         | Real Git, filesystem and process supervision, and the Docker shell-profile fixture |
| `packages/store`, `packages/landing`, `packages/slack`      | Real Git repositories, transport or diff behaviour                                 |
| `apps/cli`                                                  | System processes, Git and native server lifecycle adapters; both Vitest shards     |
| `apps/t3-gateway`, `packages/t3-contracts`                  | Git and native process integrations                                                |
| `packages/workspace-ssh`, `apps/vscode`                     | OpenSSH configuration, key generation and a real ssh-agent                         |
| `apps/desktop`                                              | Installed Chromium font and browser integration                                    |

The other test tasks cache. Their inputs are workspace source, owned Node and HTTP fixtures, locked
dependencies and hashed configuration. S3 tests start real Garage and MinIO containers in an
uncached standalone command, so PostgreSQL and Docker service versions cannot hide behind a cached
integration result.

`scripts/ci-test-inputs.mjs`, exercised by `ci-cache.test.mjs` in the static checks, resolves
literals, local constants, `import.meta`, `fileURLToPath`, parent-directory joins, `process.cwd()`
and URL and template paths. It compares the tracked files it finds with the installed Turbo's
resolved test inputs, uncached tasks included: `cache: false` alone does not fix affected selection.
A native-binary consumer must itself resolve to `cache: false`, which catches a new direct OpenSSH,
Git or Docker call, or a browser launch, in an otherwise cached package. This is a bounded syntax
check, not program analysis. Dynamic command arrays, aliases, workspace-package imports and source
embedded in strings still need review.

`scripts/ci-cache.test.mjs` runs the installed Turbo against an isolated Git workspace with the
repository's real root configuration. It fills a local cache, restores a deleted build artifact,
proves misses for shared inputs and environment changes, proves source-only dependency propagation,
and checks that affected selection intersects lanes. `scripts/ci-turbo.test.mjs` runs the command
wrapper across pull request, main, nightly, merge-group and untrusted event and ref combinations for
both runner types.

## Measuring CI time

Run the timing report on a downloaded GitHub job log:

```sh
node scripts/ci-timings.mjs /path/to/checks.log > /tmp/checks-timing.json
node --test scripts/ci-timings.test.mjs
```

The command reads the local file and writes JSON. It makes no network requests. Keep the original
log, its run and job IDs, head revision, runner and conclusion beside the report. Logs and reports
may hold command text and local paths; review them before sharing. With `--source-ref <head>`, its
runtime report uses `ci-runtime-timings.mjs` and tells current execution from cached replay. Each
static and test lane archives Turbo summaries for 14 days for this analysis.

The report includes intervals between `Run` groups, package durations Vitest reports, file
durations, Node spec test durations, cache markers and unadvanced TestClock warnings. It accepts
timestamped logs with or without ANSI colour. A missing summary stays `null`; a failed run stays a
failed run. It is a timing report, not a test verdict.

Do not subtract the timestamps of Turbo's package log groups to measure package execution: Turbo
buffers a group until its task finishes. Do not add parallel file or package durations to estimate a
job's duration either. `Run` intervals include the overhead between them, and the last interval ends
at the last log line, which may be incomplete. Node's spec reporter does not attach a file to each
case, so those rows have `file: null`.

`CI measurement` (`ci-measure.yml`) is a manual-only workflow derived from `ci.yml`. Regenerate it
with `node scripts/ci-measure-workflow.mjs` after changing production jobs; the workflow regression
suite rejects drift. It checks out an exact scenario head and compares it with an explicit ancestor
base. `cold` uses only the job's empty local cache; `warm` uses `local:rw,remote:r` and runs only on
the box, since other runners cannot reach the box's cache. Neither mode writes to the remote cache.

```sh
gh workflow run ci-measure.yml --ref main -f runner=box \
  -f scenario=web -f cache=cold -f base_sha=<40-character-base> -f head_sha=<40-character-head>
gh workflow run ci-measure.yml --ref main -f runner=box \
  -f scenario=web -f cache=warm -f base_sha=<same-base> -f head_sha=<same-head>
```

Run one observation at a time. Archive the run JSON, all jobs including skipped ones, job logs and
Turbo summaries; use the jobs API with `filter=all` and pagination. For each job report
`started_at - created_at` as queue wait and `completed_at - started_at` as run time, and keep the
timestamps. Skipped jobs have no runner time; a missing timestamp is unknown, not zero. Report wall
time from run creation to the last job's completion, the slowest job, and task hits and misses from
Turbo summaries, telling uncached tasks from misses.

Turbo reference: [configuration](https://turborepo.dev/docs/reference/configuration),
[run flags](https://turborepo.dev/docs/reference/run),
[environment variables](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables).
