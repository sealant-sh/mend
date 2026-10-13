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

Shared caching, affected-only PR testing, and merge-queue topology remain pending owner decisions.
Do not infer cache correctness from the database URL alone: the report must identify whether a
result actually ran, and required capabilities must fail clearly when absent.
