# Measuring CI time

Run the timing report on a downloaded GitHub job log:

```sh
node scripts/ci-timings.mjs /path/to/checks.log > /tmp/checks-timing.json
node --test scripts/ci-timings.test.mjs
```

The command reads the local file and writes JSON. It makes no network requests. Keep the original
log, its run and job IDs, head revision, runner, and conclusion beside the report. Logs and reports
may contain command text and local paths; review them before sharing.

The report includes intervals between `Run` groups, package durations reported by Vitest, file
durations, Node spec test durations, cache markers, and unadvanced TestClock warnings. It accepts
timestamped logs with or without ANSI color. A missing summary remains `null`; a failed run remains
a failed run. This command is a timing report, not a test verdict.

Do not subtract the timestamps of Turbo's package log groups to measure package execution. Turbo
buffers those groups until a task finishes. Do not add parallel file or package durations to
estimate job duration either. `Run` intervals include intervening overhead and the last interval
ends at the last available log line, which may be incomplete. Node's spec reporter does not attach a
file identity to each case, so those rows deliberately have `file: null`.

## Baseline, 2026-10-13

The downloaded evidence lives outside the repositories at
`~/Developer/OSS/Sealant/ci-timing-2026-10-13/`. Its README records provenance. The successful
Blacksmith baseline is Mend `checks`, run `38368102922`, job `115198024315`, main head `727f57a17`,
on `blacksmith-8vcpu-ubuntu-2404`. The following values were reproduced from `logs/bs-mend.log`.

| Measurement                        |    Before | After step 0        |
| ---------------------------------- | --------: | ------------------- |
| Observed whole job log span        | 921.505 s | No execution change |
| Turbo test step interval           | 540.506 s | No execution change |
| Packaging and verify step interval | 278.986 s | No execution change |
| Engine file, 530 tests             | 441.701 s | No execution change |
| CLI lifecycle file, 120 tests      | 432.680 s | No execution change |
| CLI run commands file, 46 tests    |  64.521 s | No execution change |
| CLI main file, 84 tests            |  52.625 s | No execution change |
| Sessions package, Vitest duration  | 448.650 s | No execution change |
| CLI package, Vitest duration       | 436.790 s | No execution change |
| Build step interval                |  20.718 s | No execution change |
| Typecheck step interval            |  19.159 s | No execution change |
| Lint step interval                 |   2.848 s | No execution change |
| Format step interval               |   1.831 s | No execution change |

Step 0 adds measurement only. There is no claimed speedup and no new CI scheduling, cache policy,
test deadline, runner label, or production clock behavior. Three files exceed the proposed 60-second
file budget on this successful baseline, including `run-commands.test.ts`.

The box comparison, `logs/mend-checks6.log`, is a failed run on eight vCPUs. Its Turbo step interval
is 619.597 s, the engine file reports 458.728 s, and the sessions package reports 468.830 s. Its
Chromium installation interval alone is 598.398 s. Treat these as observed timings, not a passing
comparison or a stable estimate of runner capacity. In particular, a cancelled package with no
duration summary cannot contribute a fabricated zero to a comparison.

## Ranked causes

The local JSON and TAP reports were recorded on nix-pc, 32 threads, head `3383dbc5f`. The engine,
CLI lifecycle, packaging sources and their fixtures are unchanged between that head and the
Blacksmith baseline. Local timing is useful for ranking; it is not substituted for CI timing.

| Case                                               | Blacksmith |     Local | Source-confirmed cost                                                                             |
| -------------------------------------------------- | ---------: | --------: | ------------------------------------------------------------------------------------------------- |
| Verify-stack late claim after killed serve, N5     |  131.559 s | 130.983 s | A 65-second fake create delay remains in force for both the killed serve and the subsequent start |
| Verify-stack teardown/start race, N4               |   66.140 s |  66.152 s | Fake hanging build sleeps 60 seconds; the test also waits 3 seconds                               |
| Docker mirror cache guard                          |   46.049 s |   See TAP | Real guard loop and process termination deadlines                                                 |
| Engine launch behind a saving executor             |   10.051 s |  10.031 s | Background capture lease reaper's 10-second cadence                                               |
| Engine answer in flight must not attest its seal   |   10.052 s |  10.030 s | Kept-drain retry waits 10 seconds before processing the next observation                          |
| Engine refused discard retains workspace           |    7.545 s |   7.560 s | Three capture checkpoint waits, plus stall/discard polling                                        |
| Engine joiner's refused Stop preserves both people |    7.065 s |   6.990 s | Two explicit 3-second settlement waits, plus real fixture setup                                   |
| Engine landing with unreported snapshot health     |    6.237 s |   6.254 s | Landing checkpoint retries have three 2-second pauses                                             |

The engine file's 530 local tests sum to 416.061 seconds. Many modest waits accumulate; eliminating
only its slowest test would save about ten seconds. `withEngine` repeatedly starts scoped engine
layers with a filesystem store and a real loopback Git origin. Its platform client is a test
implementation, so Docker-shaped commands in this file do not prove real Docker execution.

The CLI lifecycle file's 120 local tests sum to 343.684 seconds. The fixture already supplies a
no-op `sleep` at `apps/cli/src/server-lifecycle.test.ts:226`. It runs real child processes through a
Docker command fixture and uses a real local HTTP listener and files. Its slowest case, turning
mirrors off and back on across generations, takes 7.278 seconds locally and repeats setup, upgrade,
status and rerender operations. Short deadlines help the cases that exercise process timeouts;
splitting and reducing repeated process setup address the rest. Do not describe this fixture as
starting real Docker servers.

Node 26.4 runs these test files concurrently by default; the workflow does not override that.
Top-level tests inside `scripts/verify-stack/lifecycle.e2e.test.mjs` are sequential. Their local
durations sum to 253.240 seconds, almost the entire packaging step's 253.552 seconds. N5 and N4
alone account for 197.135 seconds, 77.84% of that file's summed test time. The sum of top-level
durations across all packaging files is 459.860 seconds, which is aggregate work, not elapsed time.
Making the packaging step parallel with Turbo can help, but the packaging files themselves are
already parallel.

The local packaging run passed 740 of 741 tests and exited 1. The failure is
`scripts/aws-tofu.test.mjs:139`, `spawnSync tofu ENOENT`, so the local machine lacked the
executable. The successful Blacksmith baseline installed OpenTofu and passed this case. Preserve the
local failure in comparisons; do not count it as a successful full-suite baseline.

Full per-test/source mappings and the generated reports are retained in the evidence folder under
`reports/step0/`. Engine JSON/TSV covers all 530 cases; CLI JSON covers all 120; packaging JSON
preserves all 741 result records, including nested cases and the local failure. Source feature
categories overlap. They identify code reached by a case, not exclusive milliseconds spent in each
operation.

## Evidence requirements for later steps

Keep required PostgreSQL failures, Garage and MinIO contracts, and the audit's behavioral
assertions. Record each replacement test by name and show mutation failures for risky lifecycle
paths. Each converted file must pass 20 consecutive runs. Existing full-suite elapsed time and newly
measured shard wall time are different quantities; show both when splitting files.

First remove unnecessary task dependencies and gate unrelated work by paths. Then route engine time
through Effect's clock before converting tests. Distinguish current-time reads from parsing stored
dates and distinguish actual Docker adapters from recording implementations that contain
Docker-shaped commands. Preserve a CI tier for real adapters. Shorten non-Effect fixture deadlines
through their existing options instead of converting those programs to Effect.

After the long-pole work, step 3b splits static checks and build, test shards, packaging and verify,
and mobile-web into parallel jobs. This step is approved independently of the merge queue. Preserve
required PostgreSQL, Garage/MinIO and Chromium evidence and measure push-to-green wall time.

Step 5, the merge queue, is prepared in the workflow and awaits the separately owned ruleset
activation. `merge_group` runs the full suite on the proposed merge. The full post-merge main run
remains until queue activation because direct merges are still possible and main must keep
refreshing the trusted cache. The activation contract and pending administrator-bypass decision are
recorded in [merge-queue.md](merge-queue.md). The CI orchestrator owns ruleset `20201151` and starts
with merge groups of one after the owner decides bypass policy.

Step 4, shared Garage-backed Turbo caching and affected-only PR testing, still needs the owner's
decision. Do not infer cache correctness from the database URL alone: the report must identify
whether a result actually ran, and required capabilities must fail clearly when absent.

## Step 2: track test timeout headroom

Alongside clock conversion, collect per-test CI durations and each test's effective timeout. Flag
cases at or above 50% of that budget. Resolve the timeout from per-test or suite overrides, then the
owning project's configuration and framework default. Missing durations or unresolved budgets must
remain unknown, never an assumed healthy result. Ordinary Vitest logs omit some per-test durations;
use per-test reporter artifacts when needed. Keep runner, head and run identity with the result, and
distinguish cached observations from fresh execution.

For each flagged case, record the cause and remedy. Reduce repeated work or input size only when the
same defect remains detectable, synchronize on an observable event when waiting for work, or set a
deliberate per-test timeout justified by the amount of real adapter/CPU work. Never raise the global
default to hide these cases. Recheck headroom after the change and retain the required repeat runs
and mutation evidence.

The initial investigation list is:

| Case                                                                 | Observed problem                                                                 | Effective bound and next action                                                                                                                                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store `capture-raw-names.test.ts`, generated byte views property     | Timed out on box run 38417626659, measurement-only PR #969                       | Default 5 s. Inspect 1,000 deterministic generated cases, two byte arrays up to 256 bytes, and the independent canonical/raw-field checks before choosing less work or a justified per-test budget. The runner thread reran the failed job; a rerun alone is not a remedy. |
| Sessions `harness-layout.test.ts`, made-people and many-people cases | Local diagnostic load pushed synchronous shell fixtures to 8.049 s and 8.256 s   | Default 5 s. Clean full graph passed unchanged. Keep flagged for process/setup work and CI headroom; do not infer that the clean pass removes sensitivity.                                                                                                                 |
| Gateway `replay.test.ts`, oversized UTF-8 replay                     | Expected snapshot but got a live event on #970, run 38420545269                  | Gateway test budget is 30 s; the fixture instead assumed publication after a 500 ms sleep. Replace that readiness assumption with actual publication acknowledgment. This is an ordering failure, not an exhausted test budget.                                            |
| Store runner-cache landing                                           | Run 38440817203 took 6.209 s against the default 5 s                             | Two cold cache generations, five landing commits, two pushes and bundle verification exercise real Git. Retain every phase and assertion; give this one adapter test a 15 s budget. No runtime improvement claimed.                                                        |
| Database upgrade to 0108, pin retained versions                      | Run 38440817203 exceeded 5 s at 5.106 s; Blacksmith baseline was 0.898 s         | Creates a real database and replays the migration history before and after seeding an old version. Retain the DDL and exact pinned-row assertion with a local 15 s budget.                                                                                                 |
| Gateway shell late pointer                                           | Run 38440817203 saw a completed initial snapshot where the test expected running | The fixture assumes the first read has started after 300 ms and holds its response for 800 ms. Replace elapsed-time assumptions with request capture and release, preserving running snapshot followed by completed update.                                                |
| Core strace integration                                              | Runner thread reports a CPU/process-budget failure resolved in Core #366         | Explicit 30 s per-test budget, reported by the runner thread. Preserve its separate repository evidence.                                                                                                                                                                   |

## Step 1: remove serial dependencies and select extra jobs

PR pushes cancel the previous CI run for the same pull request. Runs on main use their own run ID,
so a newer merge does not cancel evidence for an earlier merge.

Turbo tests depend on upstream builds instead of upstream tests. No test consumes a file generated
by another package's tests. Shared testing exports point to checked-in TypeScript. The build step
still precedes checks because generated routes must exist for typechecking. The dry task graph has
27 test nodes, 25 with executable commands, and no test-to-test dependency edges. Packages without a
build command contribute dependency traversal, not another command to execute.

### Bound concurrency at both levels

The box runners have eight vCPUs and 7 GiB of RAM, including the PostgreSQL service. Removing
test-to-test dependencies widened the runnable task set without bounding each package's Vitest pool.
Run 38444968220 failed while opening the auth fixture's admin connection, before executing
`CREATE DATABASE`. Auth reported 77.80 s of collection and 17.83 s of transformation across two
files. These reporter totals overlap across workers; they are not extra wall time to add to the
67.28 s package duration. Host telemetry reported 6.6 GiB in use and 7.5 active vCPUs near failure.
This supports oversubscription, rather than a new auth assertion failure. The log contains no
PostgreSQL connection-limit or server-crash report. Turbo's subsequent `SIGSEGV` has no backtrace in
the job log, so its cause remains unestablished.

CI now uses `turbo test --force --concurrency=2` and three Vitest workers per package. At most six
Vitest workers run together, leaving CPU and memory room for their controllers, PostgreSQL and
fixture subprocesses. The two long packages dominate the baseline, sessions at 448.650 s and CLI at
436.790 s; starting more package pools does not shorten their serial long files. This cap is a
starting allocation to measure, not a guarantee of a 6 GiB memory peak or a five-minute test step.

Vitest 3.2.7 reads `VITEST_MAX_THREADS` and `VITEST_MAX_FORKS`; Vitest 5.0.1 reads
`VITEST_MAX_WORKERS`. Set all three to `3` on the CI test step and include them in Turbo's test
environment hash so strict environment filtering cannot silently discard the limits. Resolved
configuration checks cover both installed versions. Local commands retain their defaults unless
these variables are supplied. The web lifecycle integration check forwards the same controls through
its isolated environment to its nested Vitest process. PostgreSQL connection deadlines, test
deadlines, assertions and required-suite failure behavior are unchanged by the cap.

Compare the next successful box run with the old dependency graph's 743 s test step from
run 38389236935. That older run's one-off 1,368 s Chromium download is setup, not test time. Keep
the Blacksmith 540.506 s baseline separate. Match the capped job's runner and start/end timestamps
with the runner thread's ten-second memory, swap and load samples. Report minimum available memory,
peak swap use, run-window swap-in/out deltas and peak load beside durations. Cumulative swap since
boot cannot establish the amount swapped during this run. If the cap does not beat the old graph,
report that; step 3b distributes shards across runners instead of oversubscribing one machine.

### Select extra jobs by changed paths

The dependency-free `scripts/ci-scope.mjs` compares the PR's merge base with its head. It emits the
two extra-job flags below. Main always runs both. Paths use NUL separators and rename detection is
disabled so deleting or moving an input cannot hide its original path.

| Changed paths                                                                          | mobile-web | Packaging and verify |
| -------------------------------------------------------------------------------------- | ---------- | -------------------- |
| Only `docs/` files, excluding package manifests                                        | Skip       | Skip                 |
| A package's `test/` files or `*.test.*` / `*.spec.*` files, excluding manifests        | Skip       | Skip                 |
| Other known apps or `deploy/`                                                          | Skip       | Run                  |
| Mobile, any shared package, tooling, scripts, workflows or agent configuration         | Run        | Run                  |
| Root files, any package manifest, unknown paths, empty diff or unavailable Git history | Run        | Run                  |

Mixed changes take the union. Including every shared package deliberately favors extra execution
when dependencies change. A package's tests are the one exception, for `packages/` only: a change
confined to a package's `test/` directory or its `*.test.*` / `*.spec.*` source files runs neither
extra job.

The two jobs enforce that at run time. Right after checkout and install, each runs
`scripts/remove-package-tests.mjs`, which deletes every file that `testOnly` in
`scripts/ci-scope.mjs` lets them skip. So a lane that reads a package test fails rather than
depending on a file a skipped change could alter. It prints what it deleted per package and fails if
it deleted nothing, so a moved test layout cannot make it a silent no-op. Neither job runs Turbo,
and both set `TURBO_CACHE=local:r,remote:r`: a tree without its tests no longer matches its commit
and must not write a cache. `scripts/ci-workflow.test.mjs` pins the step's place and the read-only
cache.

`scripts/test-only-imports.test.mjs` is an early warning in the static job, not the enforcement. It
flags an import of a test-only package export (found from every package's `exports` map) and a
literal `packages/<pkg>/test/…` or test or spec path in non-test code, the lanes' own test files,
package manifests and the lane jobs. It misses paths assembled from variables or from separate
literals, paths relative to another directory (a package script's `cat test/x`, a step's
`working-directory`) and files a lane reaches indirectly, through a package script or a script that
calls another. The deletion step catches all of those.

The selection job tests both CI helper scripts before publishing outputs. Missing outputs run both
extras, and the required checks job runs even if selection fails. Turbo, required PostgreSQL tests,
S3 contracts and existing forced execution remain enabled for every PR. Helm and AWS shell checks
also remain unconditional.

Validation includes real Git fixtures for deletion, renaming, independently advancing main,
malformed references and filenames with newlines. The nine CI-helper tests passed 20 consecutive
runs. Actionlint passed with `box` declared as a custom runner label and ShellCheck disabled.

The first full run with the new task graph exposed a blob-upload test fixture race. Connecting a
pipe did not mean its destination file had opened. The fixture could replace the temporary directory
while that open was still creating a file, throwing `ENOTEMPTY` before it established the cleanup
failure it intended to test. The fixture now waits for a native zero-byte write acknowledgment
before inducing source failure or interruption. The exact Cause counts, original failure or
interruption, cleanup error, closed streams and absence of publication are still asserted. The
separate interruption-before-open case is unchanged. The owning file passed 20 consecutive runs; a
mutation that discards cleanup errors still fails both targeted cases. Production code is unchanged.

Timing comparisons must distinguish a failed run from a speed improvement and local timing from CI.
Step 1 does not shorten the three long test files or the packaging race cases. Those remain the next
work, and a measured CI result is required before claiming a whole-job improvement.

## Step 1 measured box result

The capped graph passed in run 38449851462 (`6d12a7e1a`, checks job 115477847898,
`box-151-1791916257`, 2026-10-13 18:50:08–19:11:28 UTC). Tests took 754 s versus 743 s for the old
box graph; packaging took 305 s and the whole checks job 1,280 s. This establishes a passing bounded
baseline, not a speedup. Run creation to checks completion took 1,331 s; the push itself was not
separately timestamped. Release acceptance was label-gated and skipped.

Matched VM 151 samples (121 samples, ten-second intervals) showed approximately 5.0 of 7 GiB in use
at peak, with 2.03 GiB minimum available. Swap was 0.06 GiB at start, 0.09 GiB peak and 0.08 GiB at
end; the window added 8,892 pages swapped out and 5,589 in (about 0.03 and 0.02 GiB). Peak
one-minute load was 12.2 on eight vCPUs. The cap removed the observed memory thrashing. The CLI
lifecycle file took 706.431 s, engine 460.367 s and run-commands 58.111 s. Load alone does not
establish how much of CLI time was CPU contention versus subprocess work.

## Step 2a: sessions clock ownership

The sessions engine, capture channel and service host acquire Effect's Clock when their layers are
built. Their synchronous callbacks read that same service. Epoch milliseconds remain epoch
milliseconds for persisted records, leases, filesystem comparisons and signed URL authority.
Existing monotonic waits and identity-answer expiry use Clock nanoseconds; they must not switch to
wall time, where a system-clock adjustment could stretch a deadline. Date parsing and conversion of
existing timestamps are unchanged.

Provide TestClock around both layer acquisition and every operation for the lifetime of an engine.
Providing it only to a method after constructing a live-clock engine would mix clocks: shared caches
and callbacks use the construction clock, while existing Effect sleeps and timeouts use the
executing fiber's clock. Real git, sockets, subprocesses and generated workspace scripts still
require the real-adapter test tier; routing clocks does not make their I/O instantaneous.

Pickup expiry and identity-answer eviction now use scope-owned clock sleeps. Closing the engine
clears retained ticket and answer bytes as well as cancelling timers. Service polling retains its
20-second first delay, fixed cadence and overlapping passes; stopping a service cancels future
triggers, and closing the layer also interrupts unfinished passes. These Effect timers are
referenced while their scope is open, so shutdown must close the scope. Standalone synchronous
pickup callers retain the native unreferenced scheduler unless they supply an owner.

PTY output collection retains its three-second cooperative abort: a stream that ends normally on
abort can still return its collected tail; a rejected read still yields an empty tail. Scope exit
cancels the timer. A stream that ignores abort can still hang, as it could before; this change does
not silently replace that contract with a hard timeout that discards partial output.

Remaining native clock uses are explicit boundaries: generated JavaScript runs inside another
process, and standalone synchronous helper defaults have no Effect context. Effect materializers and
engine callers pass clock-derived values to those helpers. This phase leaves the existing test cases
and their deadlines intact. File splitting, TestClock-driven test conversion and timeout headroom
reporting follow in step 2b; this source change alone makes no speedup claim.

Before adding clock regressions, the source-only change passed the full unchanged local graph: 25
tasks, zero cache hits, PostgreSQL required, 484.387 s wall time. Engine took 421.171 s, CLI
lifecycle 392.862 s and run-commands 43.501 s. All 530 original engine cases passed. Separate live
checks ran all three opt-in Garage capture cases, plus 16 store contract cases on Garage and 16 on
strict MinIO. These are local validation measurements; box results must be recorded separately.

Five additional regressions cover the first Clock-driven service probe, cancellation after stop,
overlapping probes, interruption on layer shutdown, and held/spent ticket cleanup. The two owning
files passed 20 consecutive runs, 35 cases per run and 700 passes, without retries or TestClock
warnings. Existing test bodies are unchanged. Six isolated mutations failed their intended behavior
assertions: native probe timing, probes surviving stop, serialized probes, detached in-flight
probes, retained ticket maps, and uncancelled ticket expiry callbacks.

Independent review found that Effect's `Schedule.fixed` uses epoch milliseconds for interval
boundaries. The service supervisor now calculates those boundaries from Clock nanoseconds while
retaining its first delay, overlapping passes and scope ownership. Two regressions independently
step epoch time backward by 70 seconds and forward by 60 seconds, and require probes at monotonic
20, 40, 60 and 80 seconds. Both failed against the previous schedule and pass with the correction.

Two further regressions deliver the 60-second wake at 65 or 85 seconds. They require one pass then,
followed by the next at 85 or 105 seconds respectively. The next boundary uses each pass's actual
monotonic start, matching native interval rearming after both short and long event-loop stalls.
Neither catch-up bursts nor shorter intervals compensating for a late wake are allowed.

## Step 2a measured box result

The corrected Clock change passed run 38459923130 on `73de7254f`, checks job 115515951220,
`box-151-1791922353`, 2026-10-13 20:13:27–20:34:34 UTC. The test step took 749 s, packaging 304 s,
and checks 1,267 s. Engine took 461.109 s, CLI lifecycle 700.369 s and run-commands 57.878 s. All 25
Turbo test tasks ran without cache hits; the downloaded log had no unadvanced-TestClock warning.
Changes and mobile-web also passed; label-gated release acceptance was skipped.

Run creation to checks completion was 1,799 s, including 532 s before checks started. The runner
owner attributed 432 s to demand detection omitting GitHub's pending workflow state and fixed the
runner service. Excluding that incident gives 1,367 s, reported separately from the raw result.
Actual push time was not independently measured. These numbers establish a comparable baseline, not
a speed improvement from routing clocks.

Matched host samples for this window showed approximately 4.3 of 7 GiB peak memory use, 2.72 GiB
minimum available, swap 0.07 GiB initially, 0.11 GiB peak and 0.09 GiB at the end. The window added
10,699 pages swapped out and 4,498 in, about 0.04 and 0.02 GiB. Peak one-minute load was 11.0 on
eight vCPUs. Memory fits under the cap; peak CPU demand remains above the runner's vCPU count.

## Step 2b timeout headroom

Use a downloaded job log and its exact local Git revision to compare observed leaf durations with
source budgets:

```sh
node scripts/ci-timings.mjs downloaded-job.log --source-ref <job-head> --repo <checkout>
```

The analyzer reports cases at or above half their effective timeout, alongside the source location,
resolved revision, budget origin and raw reporter line. It reads Git blobs locally and never runs
config or test code. Missing durations, ambiguous names, dynamic configuration and cached output
remain unknown. File durations are never used as test durations. Reporter logs omit many fast cases;
the report includes the number not observed rather than treating them as healthy.

On the step 2a box run, 797 leaf durations were visible, 554 had resolvable budgets and seven were
at or above half their timeout. The sessions config added in step 2b installs a plugin, so static
analysis deliberately leaves its default budgets unknown on later revisions. Explicit case and suite
budgets can still resolve. Capturing effective budgets from the live runner is the next way to
remove that uncertainty; trusting arbitrary plugin code during historical log analysis is not.

The sessions runner also fails on a file exceeding 60 seconds in CI and on an unadvanced TestClock
warning. The guard remains installed when a caller selects JSON output. Vitest 3 can report JSON
`success: true` while an unhandled reporter error makes the process exit nonzero; consumers must
check the exit status. Subprocess regressions cover both failure conditions and passing controls.

The source-budget analyzer uses the workspace's TypeScript parser and YAML reader. Its regression
tests therefore run in `checks` immediately after the existing frozen install. The dependency-free
path-selection tests stay in `changes`, before installation. Both still run unconditionally.

## Step 2b engine test organization

The original 530 engine cases are divided by concern. Names, suite ancestry, table expansion and all
original assertions are retained. A mechanical split was run before any Clock conversion, with all
530 passing. The private `test/engine/` modules hold the existing repository, platform and capture
fixtures; individual cases still own their engine scopes and temporary files.

| File under `packages/sessions/test/` | Original cases |
| ------------------------------------ | -------------: |
| `engine-provision.test.ts`           |            123 |
| `engine-launch-recovery.test.ts`     |             53 |
| `engine-capture-launch.test.ts`      |             52 |
| `engine-standbys.test.ts`            |             34 |
| `engine-drain-lifecycle.test.ts`     |             42 |
| `engine-capture-settlement.test.ts`  |             41 |
| `engine-capture-evidence.test.ts`    |             36 |
| `engine-person-context.test.ts`      |             50 |
| `engine-person-runtime.test.ts`      |             74 |
| `engine-person-joins.test.ts`        |             25 |

Seventeen cases now build their engine inside the caller's TestClock. These cover a saving holder's
ten-second lease reaper, landing retries at two-second intervals, the in-flight evidence fence,
three-second joiner settle windows, refused-close retries, real checkpoint registration deadlines,
and completion of the agent in the live-edit scenario. Deadline values and original case budgets are
unchanged. Tests acknowledge the actual operation before moving time, assert where applicable
immediately before the boundary, and retain the final state assertions.

The memory capture store and world-owned repository timestamps follow the same construction Clock.
Explicit store/engine clock skew remains available for the existing expiry scenarios. Two engine
fixture regressions exercise clock propagation and temporary-directory cleanup, including failure
before layer construction. A capture-store regression checks the exact lease-expiry boundary.

Real Git, filesystem, socket and generated-helper operations remain live. The Promise fixture
adapter preserves the existing integration cases; narrow `TestClock.withLive` sections observe
native I/O readiness without constructing the engine under a different Clock. This change does not
claim to convert every engine case or remove every remaining live wait. Additional conversion and
further file splits should follow measured box results, with the 60-second guard enforcing the file
limit.

The six historical sessions timeout-headroom flags have specific remedies. The live-edit case waits
for the actual agent-ended hook instead of exhausting a poll that also waited for its intentionally
open shell. Three standby cases advance the real two-second registration waits. The saving-holder
case advances its actual ten-second reaper. The session-channel subprocess case retains two
mandatory two-second generated-helper polls and four process launches; it has an explicit 15-second
case budget instead of the five-second default, with those costs documented at the test. The CLI
health-discovery flag belongs to step 3. The capture raw-name property case keeps all 1,000 runs and
its fixed seed; its earlier overloaded-runner timeout remains on the box watch list, rather than
being hidden by a global timeout or reduced property coverage.

At the first submitted head, all nine engine concern files, the two fixture files, the reporter
regression file and the session-channel file passed 20 consecutive fresh-process runs each. That is
260 file runs and 11,060 test passes, without retries or source changes during the run. The local
32-thread machine ran at most nine independent file loops at once; each file's rounds were
sequential with one worker. This is reliability evidence, not a simulation of the eight-vCPU box.
Each invocation was:

```sh
CI=true VITEST_MAX_THREADS=3 VITEST_MAX_FORKS=3 VITEST_MAX_WORKERS=3 \
  pnpm exec vitest run test/<file> --maxWorkers=1 --reporter=json --outputFile=<round>.json
```

The timing analyzer separately passed 20 runs of `node --test scripts/ci-timings.test.mjs`, 360 test
passes on unchanged source. Final per-file timing comparisons use three workers separately from the
reliability loops.

Four isolated mutations failed behavioral assertions: a landing retry at one rather than two
seconds, ignoring the evidence fence, reaping another session's agent, and completing the real
registration timeout at one millisecond. The first and fourth fail boundary assertions; the second
and third fail the original attestation and holder-state assertions. Production files were restored
byte-for-byte. Changing only the outer lease guard left a backup production check intact; that
experiment exposed a synchronization flaw in the converted test, which was corrected before the
frozen repeats. A test timing out while waiting for its preferred outcome is not counted as proof
that its state assertions catch the defect.

### Local comparison before box CI

These are same-machine, three-worker runs. The before column is the mechanical split before Clock
conversion; the after column is the first submitted head, `4210b4b`, before the review split. They
are not Blacksmith or box estimates.

| Engine file                         | Cases | Mechanical split | After conversion |
| ----------------------------------- | ----: | ---------------: | ---------------: |
| `engine-capture-evidence.test.ts`   |    36 |         56.478 s |         46.207 s |
| `engine-capture-launch.test.ts`     |    52 |         44.550 s |         43.083 s |
| `engine-capture-settlement.test.ts` |    41 |         53.164 s |         31.621 s |
| `engine-drain-lifecycle.test.ts`    |    42 |         60.761 s |         44.937 s |
| `engine-launch-recovery.test.ts`    |    53 |         24.343 s |         22.282 s |
| `engine-person-context.test.ts`     |   124 |         49.488 s |         47.532 s |
| `engine-person-joins.test.ts`       |    25 |         47.330 s |         18.708 s |
| `engine-provision.test.ts`          |   123 |         39.051 s |         35.088 s |
| `engine-standbys.test.ts`           |    34 |         49.077 s |         37.990 s |

All 530 cases passed in the final comparison. The 17 converted cases took a combined 92.879 s before
and 5.135 s after, summing their individual durations, not parallel wall time. The final nine-file
invocation took 115.686 s wall time. Whole-job box measurements remain pending.

The final local full graph passed all 25 tasks without cache hits in 381.830 s, with PostgreSQL
required and the same two-package/three-worker cap as CI. Sessions took 142.93 s: 1,512 passed,
three opt-in Garage cases and one existing optional local-corpus case skipped. The three Garage
capture cases then ran and passed against a disposable live bucket. Store interoperability also
passed all 16 cases on Garage and all 16 on strict MinIO. The optional corpus case remains a known
local omission. Forced typecheck and lint each passed all 27 tasks with zero cache hits; formatting
passed. These local results do not fill the pending box job-duration or push-to-green measurements.

### First step 2b box run and review fixes

Run `38474408548`, checks job `115561606013`, used `box-150-1791926284`. Sessions finished in 187.44
seconds, against 468.8 seconds in the step 2a box run. Its only failure was the guard's own
default-reporter assertion: ANSI colour codes separated the expected summary words. The assertion
now forces coloured child output, strips VT control characters, and retains the same summary check.
The test step aborted after that failure, so this run supplies no comparable whole-test-step or
whole-job improvement.

The downloaded log includes per-file lines. `gh run view --log` rendered escape bytes as literal
`^[[`; normalize these and remove its job/step prefix before passing the timestamped log to
`ci-timings.mjs`. All nine engine concern files were below the 60-second limit:

| Engine concern                       | First box duration |
| ------------------------------------ | -----------------: |
| Person context, before further split |           57.089 s |
| Provision                            |           49.022 s |
| Capture evidence                     |           48.316 s |
| Capture launch                       |           48.193 s |
| Drain lifecycle                      |           47.931 s |
| Standbys                             |           40.494 s |
| Capture settlement                   |           33.987 s |
| Launch recovery                      |           27.990 s |
| Person joins                         |           20.178 s |

Person context is now split into 50 context/identity cases and 74 runtime/conversation cases. All
124 expanded names, 122 registration bodies with their suite ancestry, and 1,186 expect-rooted
expressions survive the split. No body, deadline or assertion changed.

Independent review also found that the host-console reporter missed real TestClock warnings held by
TestConsole or a private fixture logger. `test/effect-vitest.ts` now decorates the provided clock's
sleep operation with a diagnostic logger, preserving the existing loggers. The warning child
inherits that logger even beneath a replacing private Logger layer. Shared-layer construction uses
the decorated clock too. Other clock operations are forwarded unchanged, and live tests retain their
original entrypoint. Lint requires sessions tests to use this guarded Effect entrypoint.

The guard's subprocess regressions use real unadvanced sleepers, including default TestConsole, a
private logger, and a clock captured during shared/nested-layer construction. The first two
reproduced a successful runner exit before the fix and a failing exit afterward, with their inner
assertions passing. A positive control checks virtual-time boundaries, nanosecond units, scoped
cancellation and the live-clock escape. These diagnostic tests deliberately wait for TestClock's own
one-second live warning threshold; they are not engine deadline tests.

The working guard exposed an additional sequencing problem in the dotfile standby case. Eight cold
provisions preceded its first virtual registration deadline. It now claims an unchanged baseline
immediately after initial readiness, checks that it used the ready standby, then warms a replacement
before applying those eight changes. This drives the actual 1,999 + 1 millisecond boundary early and
adds a positive control; the existing eight mutations and final claim remain. No warning threshold
or production timeout was changed.

A further compatibility regression uses a shared layer with `excludeTestServices: true`. The live
Clock defines its unsafe readers on its prototype, so the decorator delegates every Clock member
explicitly instead of relying on object spread. The real child process failed before that fix and
passes afterward. Final repeat validation uses this corrected entrypoint.

The final local sessions run with three workers passed 1,517 cases across 68 files and retained the
same four conditional skips. Its observed run span was 144.86 seconds. The process exited
successfully with no Clock warning or file-budget failure. Person context and runtime took 19.513
and 26.769 seconds; the slowest file was capture evidence at 46.224 seconds. These local figures do
not replace the pending repaired box job or push-to-green measurement.

Final review-fix reliability validation repeated each of the ten engine files, the engine fixture,
the memory-store fixture and the nine-case guard suite 20 times in fresh processes. All 260 file
runs passed, totaling 10,860 test passes with no retries and unchanged source hashes. The local
32-thread machine ran at most nine file loops concurrently; each file's rounds were sequential. The
command and worker environment are the same as the reliability invocation above.

| File                                | Maximum across 20 local runs |
| ----------------------------------- | ---------------------------: |
| `engine-capture-evidence.test.ts`   |                     46.215 s |
| `engine-drain-lifecycle.test.ts`    |                     44.879 s |
| `engine-capture-launch.test.ts`     |                     43.289 s |
| `engine-standbys.test.ts`           |                     38.273 s |
| `engine-provision.test.ts`          |                     34.979 s |
| `engine-capture-settlement.test.ts` |                     31.705 s |
| `engine-person-runtime.test.ts`     |                     27.287 s |
| `engine-launch-recovery.test.ts`    |                     22.461 s |
| `engine-person-context.test.ts`     |                     19.697 s |
| `engine-person-joins.test.ts`       |                     18.754 s |
| `ci-reporter.test.ts`               |                      7.235 s |
| `engine-fixture.test.ts`            |                      0.272 s |
| `capture-store-memory.test.ts`      |                      0.005 s |

## Uniform file guards and runtime timeout evidence

All 24 workspace Vitest test scripts load `@mend/test-ci/vitest` through their existing or new
configuration. It appends a reporter after CLI reporter resolution, so the default output and
explicit JSON reports remain available. The shared reporter fails CI when a completed file's
execution duration exceeds 60,000 ms, including hooks but excluding transform and collection. This
is a completed-file guard, not an interrupting 60-second process timeout. Existing individual test
and hook deadlines are unchanged. The sessions Clock warning guard remains independent.

Vitest 3 and 5 emit `CI_TIMING` JSON lines on stderr for every case, file and completed run. These
include a per-invocation ID, package, file, resolved runtime timeout, duration, state and
retry/repeat counts. Vitest 3 exposes its resolved timeout through the public collection callback;
Vitest 5 exposes it on each case. Dynamic and inherited budgets therefore need no source-code
inference. The reporter uses no runtime Vitest dependency, and its compatibility tests execute both
installed major versions through real child processes.

Both reporters escape Unicode line separators so pnpm preserves one JSON record per line, including
test names containing control characters. The decoded names remain unchanged.

The native Node reporter accompanies `spec` output in CI's selection, static, shard and packaging
test commands, the guard compatibility tests, and the web package's Node integration command. It
uses public per-file summaries to measure file execution, including hooks. Native process startup is
excluded. A leaf whose name looks like a file is still a leaf. Missing file summaries remain
incomplete; interrupted runs never become a zero-duration pass. Its 60-second file budget is
enforced in CI. Node does not expose the effective case timeout, so those timeout fields remain
explicitly unknown.

`ci-timings.mjs` keeps this evidence in `runtimeTimings`, separate from its older default-reporter
and static-source estimates. Each run needs matching file/test counts and a final summary to be
complete. Cached replays, skips, unavailable/disabled budgets and retry/repeat aggregate durations
are not assessed for timeout headroom. Current executed cases at or above half their runtime timeout
are flagged for investigation. The headroom flag does not fail CI or raise a timeout. Invalid
records are listed; they cannot manufacture a healthy case.

The guards do not cover non-test commands such as docs builds, shell scripts, browser acceptance
commands or benchmarks with separate opt-in configs. Those keep their existing contracts and job
deadlines. They are not silently counted as guarded test files. Required PostgreSQL, Garage/MinIO,
Chromium checks and existing test skips are unchanged. Turbo caching and affected-only selection
remain held.

## Uniform-guard follow-up on #979

The first box run of #979 at `a5c1542e3` passed all 46 lifecycle integration cases, but
`scripts/verify-stack/lifecycle.e2e.test.mjs` took 74.067 seconds and the new native file guard
correctly failed packaging. The cases now run in three files: process lifecycle and locking,
resource ownership, and ledger recording. Their shared fake-daemon helpers retain per-worker process
cleanup. Test bodies, assertions and deadlines are preserved. CI explicitly includes all three
files.

`scripts/bench/live-cleanup.test.mjs` was also split, into cleanup and refusal cases. It took 57.758
seconds on the box and 56.907 seconds in the reviewer's local run. The real public CLI's 10-second
reconciliation grace periods and retry delays remain unchanged. The existing bench glob includes
both files; the shared helper contains no test registrations.

The next split candidates from that box run were sessions `capture-launch` at 52.6 seconds and
`capture-evidence` at 50.9 seconds, and CLI `lifecycle-versions` at 54.5 seconds and
`backup-retention` at 54.0 seconds. Those packages already enforced the 60-second file cap.

The split passed locally on Node 26.4.0 with `CI=true` and the native reporter enabled. All 50
integration cases match the failed box run's names, and the seven workflow checks pass. An AST
comparison preserves every non-import/export statement, all test registrations, and all 257
lifecycle plus 54 cleanup assertions. The local file durations were:

| File                               | Cases | Seconds |
| ---------------------------------- | ----: | ------: |
| `lifecycle.e2e.test.mjs`           |    17 |  28.451 |
| `lifecycle.resources.e2e.test.mjs` |    17 |   7.579 |
| `lifecycle.recording.e2e.test.mjs` |    12 |  10.112 |
| `live-cleanup.test.mjs`            |     2 |  25.175 |
| `live-cleanup-refusals.test.mjs`   |     2 |  31.806 |

These local timings are not box measurements. Raw logs, the AST proof and runtime case inventory are
archived in `reports/uniform-guards/packaging-split/` under the evidence directory.

## File headroom after the cache rollout

Main's first push after #980, run `38594113403` at `d1b83fc6e`, exceeded the unchanged 60-second cap
in CLI `server-lifecycle-backup-retention.test.ts`: 62.214 seconds. The other three previously
identified candidates took 52.222 seconds for CLI versions, 52.708 seconds for sessions capture
launch and 50.240 seconds for capture evidence in that same attempt.

Each file is now split into three. CLI backup tests separate the default backup/retention sequence,
explicit keep options and invalid options. Version ordering keeps all six parameter rows across two
files, with the online-latest case in a third. Capture launch separates OpenCode harvesting and
joined-executor behavior. Capture evidence separates observation ordering and recovery. The shared
restore helper and seal stamp retain their original definitions. CLI files each instantiate the
existing fixture factory and retain the identical afterEach cleanup hook.

The AST proof compares the complete expanded cases, including each parameter row, titles, suite
context, options and callbacks. All 101 cases and 587 expanded assertion calls are preserved. All 14
helper declarations are identical after moving them. No deadlines, file budgets, retries, production
behavior or required-evidence rules changed. Existing Vitest discovery and native CLI sharding
include every new file; the shard inventory check still covers 25 test packages.

The local run used Node 26.4.0, `CI=true` and three workers per package, with both packages
executing concurrently. Every case passed, with no skipped tests or unhandled errors:

| Package  | Resulting file                                    | Cases | Local file seconds |
| -------- | ------------------------------------------------- | ----: | -----------------: |
| cli      | `server-lifecycle-backup-invalid-options.test.ts` |     3 |              5.410 |
| cli      | `server-lifecycle-backup-keep-options.test.ts`    |     1 |              6.429 |
| cli      | `server-lifecycle-backup-retention.test.ts`       |     2 |              8.553 |
| cli      | `server-lifecycle-version-latest.test.ts`         |     1 |              2.934 |
| cli      | `server-lifecycle-version-releases.test.ts`       |     3 |              9.205 |
| cli      | `server-lifecycle-versions.test.ts`               |     3 |              9.223 |
| sessions | `engine-capture-evidence-ordering.test.ts`        |     8 |             18.017 |
| sessions | `engine-capture-evidence-recovery.test.ts`        |    18 |             17.725 |
| sessions | `engine-capture-evidence.test.ts`                 |    10 |             10.705 |
| sessions | `engine-capture-joining.test.ts`                  |    27 |             15.883 |
| sessions | `engine-capture-launch.test.ts`                   |    21 |             11.129 |
| sessions | `engine-capture-opencode.test.ts`                 |     4 |             16.660 |

These are local timings, not box measurements. Box timings for every resulting file remain the
acceptance check, targeting less than about 35 seconds per file. Raw pre-split box logs, local
post-split records, original sources and the AST comparison script are archived under
`reports/file-headroom/` in `~/Developer/OSS/Sealant/ci-timing-2026-10-13/`.

The orchestrator confirmed trusted remote writes from main after #980: 7 writes in 17:53–18:03 CEST
and 68 in 18:03–18:13, with zero denied and about 30 MB stored. Scenario PRs remain held until this
split merges and its main push refreshes the CLI and sessions cache entries.

## Merge-group headroom on the box runners

Merge group `38972508081` for #1036 failed the unchanged 60-second cap. CLI
`server-lifecycle-uninstall-discovery.test.ts` took 60.024 seconds, and all 850 tests in its lane
passed. Twelve files took more than 45 seconds in merge groups `38972508081`, `38967699849`,
`38963654971` and `38961259120`.

The CLI lifecycle files spend their time starting the Docker stand-in,
`apps/cli/test-fixtures/lifecycle-docker.mjs`. One case makes about 97 calls, and each call is a new
Node process. Stripping the types of `docker-protocol.ts` took half of each start's wall time and
60% of its CPU: 103 ms of CPU per call before, 41 ms after. The stand-in now enables Node's compile
cache in its fixture directory, so only a fixture's first call strips types. Every lifecycle file
now takes about 48% of its former time. Files that do not use the stand-in did not change.

The root files:

- `scripts/verify-stack/lifecycle.e2e.test.mjs`: N2 waited out the watchdog's real supervisor poll
  and retry delays, 2 + 1 + 2 + 5 seconds. N2 now runs on the watchdog clock that N5 uses. The clock
  fixture holds the watchdog process alive while a virtual timer is pending, as a native timer does.
  Before, it held the process only until the claim. The lock and admission cases moved to
  `lifecycle.locking.e2e.test.mjs`.
- `.claude/skills/verify/scripts/leaks.test.mjs`: the closed-root and rasterization cases moved to
  `leaks.closed-roots.test.mjs`, and the frame cases to `leaks.frames.test.mjs`. The shared prelude
  is in `leaks.helpers.mjs`.
- `scripts/next-version.test.mjs`: the generated-history property moved to
  `next-version.histories.test.mjs`. Its fixtures are in `next-version.helpers.mjs`.
- `scripts/aws-tofu.test.mjs` did not change. Its one slow case runs `tofu init`, which downloads
  the 816 MB AWS provider again on every runner because the runners are ephemeral. A provider cache
  on the runner image would remove that download; a test change cannot.

Each split moves its code line for line, in the original order. Test names and counts are the same.
The local times were measured on Node 26.1 with `CI=true`. The CLI times come from both native
shards running at once, three workers each, pinned to eight cores, averaged over two runs. The root
times come from each file run alone. These are local timings, not box measurements. The CI estimate
scales each file's slowest merge-group time by its local after/before ratio.

| File                                            | CI max (s) | Local before | Local after | CI estimate |
| ----------------------------------------------- | ---------: | -----------: | ----------: | ----------: |
| CLI `server-lifecycle-uninstall-discovery`      |       60.0 |         20.5 |         9.6 |          28 |
| CLI `server-lifecycle-controls`                 |       55.5 |         20.4 |         9.5 |          26 |
| CLI `server-lifecycle-uninstall-plans`          |       54.8 |         20.0 |         9.7 |          27 |
| CLI `server-lifecycle-upgrade-recovery`         |       53.2 |         17.9 |         8.9 |          27 |
| CLI `server-lifecycle-ownership`                |       53.0 |         19.6 |         9.0 |          24 |
| CLI `server-lifecycle-backup-failures`          |       49.8 |         17.2 |         8.5 |          25 |
| CLI `server-lifecycle-edge-overlays`            |       45.9 |         16.0 |         8.0 |          23 |
| CLI `server-lifecycle-versions`                 |       45.0 |         20.5 |        10.0 |          22 |
| `leaks.test.mjs`                                |       58.3 |         17.7 |         7.2 |          24 |
| `leaks.closed-roots.test.mjs`                   |          — |            — |         6.6 |          22 |
| `leaks.frames.test.mjs`                         |          — |            — |         3.0 |          10 |
| `lifecycle.e2e.test.mjs`                        |       49.3 |         26.9 |         8.6 |          16 |
| `lifecycle.locking.e2e.test.mjs`                |          — |            — |         8.7 |          16 |
| `next-version.test.mjs`                         |       45.5 |          8.3 |         4.0 |          22 |
| `next-version.histories.test.mjs`               |          — |            — |         4.3 |          24 |
| `aws-tofu.test.mjs` (with OpenTofu 1.13.1 here) |       45.4 |          9.7 |         8.5 |          45 |

The new files' CI estimates use the CI/local ratio of the file they came from. The box ran 2.2 to
3.0 times slower than this machine for the CLI lifecycle files, not the 1.9 times measured for
#1033. For the packaging files the ratio was 1.8 to 5.5. The next CLI candidate is
`server-runtime.test.ts`, at 40.2 seconds on the box. Its default-deadline case waits out the real
30-second process deadline.

## Step 6: Core and sealantd

Step 6 applies the same work to Core (`sealant-sh/sealant`) and sealantd. Both run on the box
runners beside Mend, so a minute saved there is a runner freed for Mend.

| Change                                                                                 | Outcome                                    |
| -------------------------------------------------------------------------------------- | ------------------------------------------ |
| Core: cancel a pull request's previous run; no `cache: pnpm` on box jobs               | Core #367, merged                          |
| sealantd: cargo-nextest instead of `cargo test`                                        | sealantd #163, merged                      |
| sealantd: tests that fail when starved of CPU                                          | Filed as sealantd #167; next: paused clock |
| sealantd: a persistent `CARGO_TARGET_DIR` on the box runners instead of rust-cache     | Rejected, see below                        |
| Core: the Kubernetes e2e runs the sealantd image Core pins, not one built from `main`  | Core #368                                  |
| sealantd: documentation-only pull requests skip the Rust and Node jobs (sealantd #158) | sealantd #168                              |

### Rejected: a persistent Cargo target directory

A target directory that survives between jobs on the box runners would save about 15 to 30 seconds
per sealantd run. Since sealantd #163, `Swatinem/rust-cache` already hits there: its restore takes
about 15 seconds, its save 0 seconds, and a warm `cargo clippy` about 11 seconds.

It is rejected because sealantd's `next.yml` and `release.yml` also run on the box runners. A target
directory shared between pull request jobs and those workflows would let a pull request write build
artifacts that a published binary then links. That is a cache-poisoning path into what ships, and 15
to 30 seconds does not justify it. A target per trust level (pull requests apart from `main` and
releases) would close the path, but it costs disk and upkeep for the same small gain. Do not propose
it again without a new reason.

The caches that remain do not open that path, checked 2026-10-15:

- rust-cache runs only in sealantd's `ci.yml`. `next.yml` and `release.yml` do not use rust-cache or
  `actions/cache`, so nothing a pull request saves there reaches them. GitHub's cache is also scoped
  per branch, falling back only to the base branch.
- Both publishing workflows build `docker/Dockerfile` in a fresh buildx builder that
  `docker/setup-buildx-action` creates for the job. That builder is where the Dockerfile's Cargo
  cache mounts live, so a release never builds from a cache another job wrote. The Docker daemon's
  own build cache, which the box runners keep between jobs, is not read by those builds.
