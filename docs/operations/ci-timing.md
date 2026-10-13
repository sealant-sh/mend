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

Step 5, the merge queue, is approved after steps 2–3 and 3b establish fast, stable CI on the box.
Add `merge_group` to required workflows and run the full suite on the proposed merge. Remove the
duplicate full post-merge main run while preserving main-only Version, next and release jobs. Start
with batch size one. Prepare that PR after 3b; the runner thread owns branch-rule activation.

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
| Other known apps or `deploy/`                                                          | Skip       | Run                  |
| Mobile, any shared package, tooling, scripts, workflows or agent configuration         | Run        | Run                  |
| Root files, any package manifest, unknown paths, empty diff or unavailable Git history | Run        | Run                  |

Mixed changes take the union. Including every shared package deliberately favors extra execution
when dependencies change. The selection job tests both CI helper scripts before publishing outputs.
Missing outputs run both extras, and the required checks job runs even if selection fails. Turbo,
required PostgreSQL tests, S3 contracts and existing forced execution remain enabled for every PR.
Helm and AWS shell checks also remain unconditional.

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
