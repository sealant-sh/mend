# CI task selection and cache inputs

PR test lanes and static checks use Turbo's `--affected`, with the PR base SHA in `TURBO_SCM_BASE`
and complete Git history. Turbo 2.10.3 is locked in `pnpm-lock.yaml`. `affectedUsingTaskInputs` and
`filterUsingTasks` include out-of-package inputs in selection and intersect the result with each
existing lane's filters. Main pushes and merge groups select the full graph. The nightly run at
02:23 UTC also passes `--force`, which disables reads and still refreshes the remote cache.
Packaging, image and mobile job path filters retain their existing behavior. Required standalone S3,
shell and CI regression checks remain.

The `checks` job requires all three test lanes and static checks to succeed, including when a lane
has no affected tasks. Classification failures cannot turn missing evidence into success. The merge
queue's ruleset is managed separately by the CI orchestrator, with batch size one. Adding
`merge_group: checks_requested` prepares CI; it does not activate the queue.

## Cache boundary

`scripts/ci-turbo.mjs configure` records the executing Node version, OS and architecture as
`MEND_CI_RUNTIME`. On self-hosted runners only, it also configures the box proxy at
`http://10.0.1.1:8941`, team `mend`, token `box`. That token is a non-secret placeholder. PR
commands use `--cache=local:rw,remote:r`. Main pushes, scheduled main runs and the main merge queue
use `local:rw,remote:rw`. Hosted runners use only `local:rw` and receive no remote endpoint. The
proxy independently enforces write authorization. A write refused before its job poll catches up is
handled by Turbo as a cache warning, not a task failure.

Local direct Turbo commands do not set `MEND_CI_RUNTIME`; their cache keys differ from CI. Before
every push, run forced typecheck and lint as required by `AGENTS.md`. For local cache experiments,
export `MEND_CI_RUNTIME` from the actual Node/platform/architecture just as CI does.

## Task audit

Every package keeps `$TURBO_DEFAULT$` inputs, including its tests, source, fixtures, manifest and
configuration. Workspace dependency hashes flow through the existing `^build`, `^lint` and
`^typecheck` edges, including source-only packages whose build node is a transit node. The root
manifest is a built-in Turbo input. The complete lockfile, workspace catalog, `.node-version` and
`.npmrc` are explicit global inputs, so changes cannot reuse an old result.

All tasks hash `CI`, `MEND_CI_RUNTIME`, `NODE_ENV`, `TZ`, `LANG` and `LC_ALL`. Behavioral
configuration is hashed rather than passed through without a hash. Turbo's standard OS passthrough
variables such as `PATH` and `HOME` remain available. Native-tool and service suites listed below
are uncached because those paths do not identify their implementations.

| Task                                 | Additional inputs and environment                                                                                                                                                                       | Outputs restored on a hit                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| All 28 lint tasks                    | Root `.oxlintrc.json`; inherited package source and dependencies                                                                                                                                        | None                                                                                                        |
| All 28 typecheck tasks               | Shared `@mend/typescript` configuration through workspace dependencies; each package's own tsconfig                                                                                                     | None                                                                                                        |
| All 8 build tasks                    | `tooling/scripts/**`, package `.env*`; `BUNDLE_*`, `MEND_*`, `APP_URL`, `ALLOWED_ORIGINS`, `VITE_*`, `NITRO_*`, `NODE_OPTIONS`                                                                          | `dist`, `build`, `.output`, `out`, CLI `man`, Astro `.astro`, generated route trees and marketing installer |
| All 25 test tasks                    | `scripts/**`, `deploy/**`, `.claude/skills/verify/**`, package `.env*`; `MEND_*`, `SEALANT_*`, `DATABASE_URL`, `APP_URL`, `ALLOWED_ORIGINS`, `VITEST_*`, `VITE_*`, `NODE_OPTIONS`, `DOCKER_*`, `TEST_*` | None; real-service exceptions below do not cache                                                            |
| Marketing build and test             | Root `install.sh`; build excludes its generated copy from inputs                                                                                                                                        | Build restores `public/install.sh`; test checks both copies                                                 |
| Sessions test                        | Provider-login documentation under `apps/docs`, plus `.oxlintrc.json` used by its guarded-import checks                                                                                                 | Uncached                                                                                                    |
| Web, marketing and desktop typecheck | An explicit dependency on their own build, to restore ignored generated route trees before checking                                                                                                     | Their build's outputs                                                                                       |

Shared native scripts and deployment fixtures conservatively invalidate every test task. This
includes CLI compose/mirror/migration contracts, the web native reporter and sessions benchmark
compatibility. The verify skill's scripts are covered even though most verification contracts run in
the separate, uncached packaging command. Dockerfiles, image tags, migrations and SQL schemas inside
packages remain package source inputs. Root deployment image definitions are also test inputs.
Native packaging and image jobs do not use Turbo result caching.

The following complete package test tasks have `cache: false`. Their ordinary assertions and
real-adapter tests remain together and execute whenever selected. No test was removed, skipped,
renamed or moved between required-evidence categories for caching.

| Packages                                                    | External implementation exercised                                                            |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `apps/api`, `packages/auth`, `packages/db`, `packages/jobs` | Migrated PostgreSQL repositories and jobs; API also exercises Git                            |
| `packages/sessions`                                         | Real Git, filesystem/process supervision and the Docker shell-profile fixture                |
| `packages/store`, `packages/landing`, `packages/slack`      | Real Git repositories, transport or diff behavior                                            |
| `apps/cli`                                                  | System processes, Git and native server lifecycle adapters; both native Vitest shards remain |
| `apps/t3-gateway`, `packages/t3-contracts`                  | Git and native process integrations                                                          |
| `packages/workspace-ssh`                                    | OpenSSH configuration, key generation and a real ssh-agent                                   |
| `apps/desktop`                                              | Installed Chromium font/browser integration                                                  |

The remaining 12 test tasks cache: agent-conversation, agent-protocol, api-contracts, domain,
inference, network, sealant, docs, marketing, mobile, web and the VS Code extension (`mend`). Their
test inputs are workspace source, owned Node/HTTP fixtures, locked dependencies and hashed
configuration. Published/remote-service acceptance commands remain outside these tasks. S3 tests
start real Garage/MinIO containers in an uncached standalone command. PostgreSQL and Docker service
versions therefore cannot be hidden by a cached integration result.

## Proofs and measurements

`scripts/ci-cache.test.mjs` runs the installed Turbo binary against an isolated Git workspace using
the repository's real root configuration. It fills a local cache, restores a deleted build artifact,
proves misses for shared inputs and environment changes, proves source-only dependency propagation,
and checks that affected selection intersects lanes. Restoring inputs restores cache hits.
`scripts/ci-turbo.test.mjs` executes the actual command wrapper across PR, main, nightly,
merge-group and untrusted event/ref combinations for both runner types.

Scratch-branch proofs against the full repository passed at `1b321cf17`: 16 input/environment
mutations changed warm hits to misses, restoring inputs restored hits, and all 13 real-adapter test
tasks resolved with caching disabled. The mutated files included the Node pin, root lint config,
shared TypeScript/Vitest config, shared bundler, Postgres schema and migrations, Docker compose
image, an external fixture, verify helper, installer and a lockfile generated by pnpm. File
mutations also selected the consumer through `--affected`. Raw commands, dry-run records and logs
are under `reports/affected-cache/repository-proofs/` in the CI timing evidence directory.

A second proof built all eight real apps, deleted their declared output directories and generated
route trees, then restored all eight builds from cache. All 1,661 artifact files and symlinks
matched their original bytes or targets, including CLI man pages, Astro state, the installer,
desktop bundles and web server output. Each CI static/test lane archives Turbo summaries for 14 days
for analysis with `scripts/ci-timings.mjs` and `scripts/ci-runtime-timings.mjs`.

Exact cold/warm box sizing remains a post-merge step. A cold sizing run uses `--force` or disables
the remote cache. A warm sizing run starts in a fresh job workspace and reads entries populated by a
trusted main push, using `remote:r`. Runner cleanup removes local Turbo caches between jobs, so
repeating inside one job is only a cache-correctness proof, not a warm PR measurement. The pnpm
store persists in both cases. After confirmed main-cache writes, measure one-line web, docs-only,
sessions and lockfile scenario PRs cold and remote-warm. Report wall time, runner-minutes, slowest
job and hit/miss counts for each pair, separating queue wait from active time on the two-runner box.
Any dedicated measurement workflow must be `workflow_dispatch` only.

After the implementation merges, the orchestrator observes the first main push on the host:
`/run/ci-runners/cache-writers.json` must allow that VM and the proxy journal must show writes. This
is post-merge evidence and cannot be claimed from the PR's read-only cache run.

Turbo reference: [configuration](https://turborepo.dev/docs/reference/configuration),
[run flags](https://turborepo.dev/docs/reference/run),
[environment variables](https://turborepo.dev/docs/crafting-your-repository/using-environment-variables).
