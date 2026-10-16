# Parallel CI jobs

`CI` keeps one required aggregate named `checks`. The path classifier runs first; static checks,
three test jobs, packaging and mobile web can then run independently. `checks` examines every job
result and fails on missing classification, failed jobs or unexpected skips. Only a literal `false`
path-selection output permits packaging or mobile web to be skipped.

| Job              | Evidence and preparation                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`         | Frozen install, CI regression tests, shard inventory, lockfile policy, build, typecheck, lint, formatting and unconditional Helm lint.                                                   |
| `test-engines`   | Required PostgreSQL 17, zsh fixture, sessions, API, database, jobs, store and other backend packages. Sessions has its own lane so shorter package tasks cannot delay its start.         |
| `test-clients-a` | First native CLI shard and one lane of client packages; install locked Chromium for desktop and synchronize marketing's installer before its test; AWS shell and Garage/MinIO contracts. |
| `test-clients-b` | Second native CLI shard and the remaining client packages. Docs builds its pages through its existing test script.                                                                       |
| `packaging`      | The complete existing Node packaging/acceptance/verify command; Docker, declared Caddy, OpenTofu and locked Chromium preparation.                                                        |
| `mobile-web`     | Existing export, rendered-page and browser checks, including its own Chromium preparation.                                                                                               |

Tests retain forced execution. Each test runner has at most two active package tasks, each with
three Vitest workers. Both Vitest 3 and 5 worker variables remain in Turbo's environment hash. No
job relies on another runner's build directory. Workspace test dependencies export source; static
checks do need generated route trees, so their build is forced until those outputs are correctly
represented by the build cache. This step adds neither affected-only tests nor a shared cache or
merge-queue trigger.

Run `node scripts/ci-shards.mjs --check` after adding or renaming a workspace package. It discovers
packages from `pnpm-workspace.yaml` and rejects missing, duplicate or unknown assignments. CLI is
explicitly split with Vitest's native `--shard=1/2` and `--shard=2/2`; every other test script runs
once. The runner invokes the existing package scripts through Turbo. It does not replace those
scripts with a separate list of test files.

## Measurement

Keep downloaded job logs and job start/end metadata beside the report. Run `ci-timings.mjs` on each
log separately; Turbo buffers package output, so group timestamps do not reveal package start times.
Report these three quantities separately:

- **Unlimited-runner critical path:** the classifier duration, plus the slowest selected execution
  job including setup, plus the aggregate duration. This assumes no queue between jobs.
- **Runner-minutes:** sum every job's start-to-finish duration, including classifier and aggregate,
  then divide by 60. A skipped job contributes no execution time. Queue time is not runner use.
- **Observed push-to-green:** actual run wall time, retaining queue time. Also show an explicitly
  labelled queue-adjusted comparison when investigating execution improvements.

Today's box has two runners. Independent jobs compete for those runners with other pull requests;
the unlimited-runner critical path is a capacity-planning number, not the observed wall time.

The last serial baseline is #975, head `55abb2018`, run `38487768516`. Its `checks` job
`115605677045` ran on box-151 from `2026-10-14T00:05:42Z` to `00:18:50Z`.

| Baseline measurement              |      Time |
| --------------------------------- | --------: |
| `checks` job                      |     788 s |
| Turbo test step                   | 468.825 s |
| Packaging step                    | 117.965 s |
| CLI package, Vitest duration      | 400.760 s |
| Sessions package, Vitest duration | 211.040 s |
| API package, Vitest duration      |  81.380 s |
| Classifier job                    |      11 s |
| Mobile web job                    |     161 s |
| Unlimited-runner critical path    |     799 s |
| Total runner-minutes              |     16.00 |

# Parallel CI jobs

`CI` keeps one required aggregate named `checks`. The path classifier runs first; static checks,
three test jobs, packaging and mobile web can then run independently. `checks` examines every job
result and fails on missing classification, failed jobs or unexpected skips. Only a literal `false`
path-selection output permits packaging or mobile web to be skipped.

| Job              | Evidence and preparation                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `static`         | Frozen install, CI regression tests, shard inventory, lockfile policy, build, typecheck, lint, formatting and unconditional Helm lint.                                                   |
| `test-engines`   | Required PostgreSQL 17, zsh fixture, sessions, API, database, jobs, store and other backend packages. Sessions has its own lane so shorter package tasks cannot delay its start.         |
| `test-clients-a` | First native CLI shard and one lane of client packages; install locked Chromium for desktop and synchronize marketing's installer before its test; AWS shell and Garage/MinIO contracts. |
| `test-clients-b` | Second native CLI shard and the remaining client packages. Docs builds its pages through its existing test script.                                                                       |
| `packaging`      | The complete existing Node packaging/acceptance/verify command; Docker, declared Caddy, OpenTofu and locked Chromium preparation.                                                        |
| `mobile-web`     | Existing export, rendered-page and browser checks, including its own Chromium preparation.                                                                                               |

Tests retain forced execution. Each test runner has at most two active package tasks, each with
three Vitest workers. Both Vitest 3 and 5 worker variables remain in Turbo's environment hash. No
job relies on another runner's build directory. Workspace test dependencies export source; static
checks do need generated route trees, so their build is forced until those outputs are correctly
represented by the build cache. This step adds neither affected-only tests nor a shared cache or
merge-queue trigger.

Run `node scripts/ci-shards.mjs --check` after adding or renaming a workspace package. It discovers
packages from `pnpm-workspace.yaml` and rejects missing, duplicate or unknown assignments. CLI is
explicitly split with Vitest's native `--shard=1/2` and `--shard=2/2`; every other test script runs
once. The runner invokes the existing package scripts through Turbo. It does not replace those
scripts with a separate list of test files.

## Measurement

Keep downloaded job logs and job start/end metadata beside the report. Run `ci-timings.mjs` on each
log separately; Turbo buffers package output, so group timestamps do not reveal package start times.
Report these three quantities separately:

- **Unlimited-runner critical path:** the classifier duration, plus the slowest selected execution
  job including setup, plus the aggregate duration. This assumes no queue between jobs.
- **Runner-minutes:** sum every job's start-to-finish duration, including classifier and aggregate,
  then divide by 60. A skipped job contributes no execution time. Queue time is not runner use.
- **Observed push-to-green:** actual run wall time, retaining queue time. Also show an explicitly
  labelled queue-adjusted comparison when investigating execution improvements.

Today's box has two runners. Independent jobs compete for those runners with other pull requests;
the unlimited-runner critical path is a capacity-planning number, not the observed wall time.

The last serial baseline is #975, head `55abb2018`, run `38487768516`. Its `checks` job
`115605677045` ran on box-151 from `2026-10-14T00:05:42Z` to `00:18:50Z`.

| Baseline measurement              |      Time |
| --------------------------------- | --------: |
| `checks` job                      |     788 s |
| Turbo test step                   | 468.825 s |
| Packaging step                    | 117.965 s |
| CLI package, Vitest duration      | 400.760 s |
| Sessions package, Vitest duration | 211.040 s |
| API package, Vitest duration      |  81.380 s |
| Classifier job                    |      11 s |
| Mobile web job                    |     161 s |
| Unlimited-runner critical path    |     799 s |
| Total runner-minutes              |     16.00 |

The reported 190-second wait before `checks` is queue time.

## First green parallel run

PR #976 merged as ede2ecb5b. Successful run 38493475082, head
a682c39bd9578694b9fb81bcc40b79aabd621657. Downloaded job metadata and logs are preserved here; the
summaries are computed offline.

| Job            | Runtime including setup | Queue from job creation | Runner             |
| -------------- | ----------------------: | ----------------------: | ------------------ |
| changes        |                    11 s |                     2 s | box-150-1791939618 |
| test-clients-b |                   305 s |                    30 s | box-150-1791939737 |
| packaging      |                   193 s |                    30 s | box-151-1791939702 |
| test-engines   |                   308 s |                   239 s | box-151-1791939965 |
| test-clients-a |                   300 s |                   350 s | box-150-1791940076 |
| mobile-web     |                   168 s |                   565 s | box-151-1791940291 |
| static         |                   150 s |                   666 s | box-150-1791940392 |
| checks         |                     9 s |                    25 s | box-151-1791940479 |

| Capacity measure                       | Before, #975 |                                                             After, #976 |
| -------------------------------------- | -----------: | ----------------------------------------------------------------------: |
| Slowest execution job, including setup |        788 s |                                                                   308 s |
| Unlimited-runner dependency path       |        799 s |                                                                   328 s |
| Total runner-minutes                   |        16.00 |                                                                   24.07 |
| Turbo test step                        |    468.825 s | Parallel test commands: engines 237 s, clients-a 188 s, clients-b 238 s |
| Packaging test step                    |    117.965 s |                                                                   120 s |
| CLI Vitest                             |    400.760 s |                               186.660 s + 236.470 s on separate runners |
| Sessions Vitest                        |    211.040 s |                                                               232.510 s |

The critical path is 11 + 308 + 9 = 328 seconds, 5 minutes 28 seconds, under an unlimited-runner
assumption. Runner cost is 1,444 seconds, 24.067 minutes, a 50.4% increase over the baseline. This
is one green run, not a p50 or p95 measurement. Three test jobs took 300–308 seconds; the
five-minute job goal has little or no margin.

Exact observed wall endpoints differ slightly from the coordinator's rounded 865-second figure.
GitHub run creation was 01:01:56 UTC; required checks completed at 01:16:22, giving 866 seconds. Run
updated_at was 01:16:23, giving 867 seconds. First executing job to checks completion was 863
seconds. Push-to-GitHub-receipt latency is not measured, so creation-to-checks is the available
push-to-green proxy. These spans include queue and orchestration delays. They are not the 328-second
capacity-planning path. With only two runners, queued jobs also wait while other required jobs
perform useful work; summing job queues would double-count overlapping waits.

The edge-removal split passed at 26.501 and 19.628 seconds. Largest observed Vitest files were CLI
main.test.ts at 56.897 seconds and sessions engine-provision.test.ts at 56.358 seconds. All observed
Vitest file lines were below 60 seconds; only CLI and sessions enforce the cap today.

The analyzer identified two exact-static individual cases above half their effective timeout:
server-lifecycle-backup-retention healthy newest-two case at 15.984 / 30 seconds, and upgrade-url
incomplete response-body case at 5.003 / 10 seconds. This is not a complete case census: default
reporters omit many durations, and dynamic suite budgets require runtime metadata. Those remain
measurement gaps.

All required job evidence passed, including PostgreSQL, both CLI shards, Garage/MinIO, desktop and
verification Chromium, packaging, mobile, static and aggregate checks. The optional integration gaps
documented in the PR remain unchanged.

Setup-node spent 41–48 seconds per execution job restoring the pnpm store; the static log shows a
782,407,567-byte cache download. This repeated setup contributes to runner-minutes. Step 4 remains
held for the owner's cache and affected-only decision. Next permitted work is timeout headroom and
uniform file-cap enforcement, with no cache or affected-selection change in that work.

## Persistent pnpm store on box runners

Box runner administrators provide `npm_config_store_dir=/opt/pnpm-store`. The workflow leaves that
setting intact and uses `pnpm install --frozen-lockfile`. The store survives jobs and is cleared by
the weekly VM snapshot reset. The first job after a reset fills it; later jobs link from local disk.
Fixed box jobs no longer request setup-node's GitHub pnpm cache. Packaged acceptance, like every job
that publishes or holds a write token, runs on GitHub-hosted runners since 2026-10-16 and requests
no pnpm cache: other jobs, running unowned code, write that cache. Box VMs keep state between jobs,
so code from an earlier pull request could change what a later job on the same VM builds, accepts or
pushes.

This changes dependency-store restoration only. Turbo caching and affected-only test selection
remain held for the owner's decision. Existing integrity checking and frozen lockfiles remain.
Measure setup-node plus install together so a cold network fill is not mistaken for saved work.

| Job            | #976 setup-node | #976 frozen install | Combined baseline | Persistent-store box result |
| -------------- | --------------: | ------------------: | ----------------: | --------------------------- |
| static         |            44 s |                 6 s |              50 s | 1 + 6 = 7 s                 |
| test-engines   |            43 s |                 7 s |              50 s | 0 + 6 = 6 s                 |
| test-clients-a |            41 s |                 7 s |              48 s | 0 + 7 = 7 s                 |
| test-clients-b |            48 s |                 7 s |              55 s | 0 + 8 = 8 s                 |
| packaging      |            47 s |                 7 s |              54 s | 1 + 5 = 6 s                 |
| mobile-web     |            43 s |                 7 s |              50 s | 1 + 6 = 7 s                 |

The six baseline setup-node steps total 266 seconds; setup plus install totals 307 seconds. The
comparison below uses observed runner logs and distinguishes warm stores from cold fills.

PR #977, run 38496512998 on head 2b28f09e1, passed all eight jobs. Setup plus install fell from 307
to 41 seconds. API step timestamps have one-second resolution. All six frozen installs reused 2,043
packages and downloaded zero, so this measures warm stores. It does not measure the first cold fill
after the VM refresh. Box logs show no setup-node pnpm cache restore.

The hosted probe, run 38496879699 on head 7a811fa2, passed on `ubuntu-latest` with the
mixed-workflow cache expression. It reported `runner.environment=github-hosted` and
`cache-hit=true`, restored 782,407,567 bytes and passed frozen install. Setup-node took 20 seconds
and install 10 seconds. This verifies cache selection on hosted runners; it is not a
packaged-acceptance run on ARM.

| Capacity measure                           |  #976 |  #977 |
| ------------------------------------------ | ----: | ----: |
| Slowest execution job                      | 308 s | 262 s |
| Unlimited-runner dependency path           | 328 s | 283 s |
| Total runner-minutes                       | 24.07 | 19.55 |
| Run creation to required checks completion | 866 s | 836 s |

The #977 wall endpoints are 01:35:02 to 01:48:58 UTC. First job start to checks completion is 755
seconds. Queue and execution overlap; do not sum queue durations to explain the wall time. This is
one observed run, not p50 or p95. Raw evidence and analyzer reports are archived outside the
repository under `ci-timing-2026-10-13/reports/headroom-pnpm-store/green-box-run/`.
