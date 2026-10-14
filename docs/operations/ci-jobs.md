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

The reported 190-second wait before `checks` is queue time. Parallel-job box measurements remain
pending until the new workflow runs; local measurements do not replace them.
