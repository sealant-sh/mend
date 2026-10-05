# Mend's words for Core's planned stop before a runtime's time limit

- **Release:** 0.36
- **Status:** designed. No PR yet. ROADMAP 0.36 "Already open, ships with it" and mend#530 "Carried
  from the 2026-10-01 scope, no pull request yet".
- **PRs:** none for this change. Background: sealant#286 (durable drain ownership, pre-deadline
  preservation), sealant#306 (an idle interval's throughput never stops a MicroVM early),
  sealant#312 (a stop is recorded once the executor has ended); mend#451 (AWS MicroVM sessions get
  the platform's 8 hours by default).
- **Decision records:** docs/adr/0002-session-capture-store.md (decision log 41 "A `failed` executor
  whose drain ended is gone (F-A)", 42 "A stop that follows the executor's own FINAL reads as that
  end (run 9 D9)"). This spec adds a decision; it belongs in ADR 0002's log when built.
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`.

## Why it exists

**Terms used here.**

- **Time limit** (code: deadline). The instant a runtime itself ends an executor, whatever anyone
  asks: an AWS Lambda MicroVM's maximum duration from its start (8 h by default, mend#451). Docker
  and Kubernetes executors have none. Core reports it as `runtime.deadline` (null where there is
  none); the SDK as `workspace.runtimeDeadline()`.
- **Core's planned stop.** Core's deadline sweep (`preserveBeforeDeadline`) starts a FINAL drain and
  a stop on its own at `preservationStartsAt = deadline − lead − estimate` (lead
  `WORKSPACE_CAPTURE_DEADLINE_LEAD_MS`, 15 min by default; estimate = what is still to upload at the
  observed or an assumed 1 MiB/s rate, × 1.5). Not to be confused with cf-bridge's "planned" stop
  mode (SIGTERM rather than fence) or Mend's own `why: 'planned stop'` flush.
- **Mend's planned replacement.** Mend's own drain-terminate-relaunch ahead of the time limit
  (`planExecutorCap`, `replaceExecutor`), due
  `drain estimate (300 s, or the measured one) + margin (300 s)` before the deadline. The session
  keeps running on a new executor.

**The problem.** On a MicroVM, Core's planned stop starts at least 15 minutes before the time limit,
Mend's planned replacement at least 10 minutes before it; Core's normally fires first. Mend then
sees the executor run a final flush it did not ask for, stops the session, and once saved the
session reads:

```
stopped · stopped outside Mend · saved at 11:44:02 UTC · capture 21
```

"Outside Mend" reads as something went wrong behind Mend's back: someone ran `docker stop`, a node
died, an operator intervened. Here the platform did what it does before every executor's time limit:
it drained the executor, then stopped it. The person cannot tell the two apart, and the owner asked
for the planned stop to read as what it is (ROADMAP 0.36, carried since 2026-10-01). Seen on alpha
in end-to-end run 9: ten deadline-preserved sessions, read as stopped outside Mend (one read a bare
`stopped`, fixed by decision 42).

Who hits it: anyone whose session runs on an AWS MicroVM past about 7 h 45 min. The box runs Docker
and never hits it; alpha (AWS) was torn down 2026-10-03, so today no deployment does. Cost:
confusion and a support question per long session, not lost work.

## What it does

When a session's executor ends because of Core's planned stop, every surface that shows the
session's line says so, in place of `stopped outside Mend`:

| The executor's end, as Mend observes it today               | Today                                                                               | Intended                                                                                                                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Core's drain under way (session `stopping`)                 | summary unchanged; capture line `saving · 12 MB left`                               | summary `stopping before the platform's time limit at 12:00:00 UTC`; capture line unchanged                                  |
| saved (`ExecutorEnd.kind = saved`)                          | `stopped outside Mend · saved at 11:44:02 UTC · capture 21`                         | `stopped before the platform's time limit · saved at 11:44:02 UTC · capture 21`                                              |
| its own final capture registered, not confirmed             | `stopped outside Mend · last capture 21 at 11:44:02 UTC · not confirmed`            | `stopped before the platform's time limit · last capture 21 at 11:44:02 UTC · not confirmed`                                 |
| a confirmed save left undecided                             | `stopped outside Mend · last saved capture 21 at 11:44:02 UTC · completion unknown` | `stopped before the platform's time limit · last saved capture 21 at 11:44:02 UTC · completion unknown`                      |
| lost (Core's drain kept, the runtime ended it at the limit) | `executor lost · last saved capture 21 at … · changes after that were not saved`    | `executor lost · at the platform's time limit 12:00:00 UTC · last saved capture 21 at … · changes after that were not saved` |

- The time shown is the deadline Core reported (`runtimeDeadline()`), in UTC, as every capture line
  names times (`utcTime`).
- Status words do not change: `stopping`, `stopped`, `failed` as today. Only the summary's words
  change. Every `executor lost` line still starts with `executor lost`.
- Everything after the first part (`saved at …`, `· capture n`, `· not confirmed`, pending words) is
  exactly what `executorEndWords` says today.
- Any other end that Mend did not ask for keeps `stopped outside Mend`: a `docker stop`, a
  Kubernetes eviction, an operator's `stop()` through Core, an executor without a time limit.
- The owner's Stop keeps its bare `stopped`.
- A resume or a new launch clears the line, as it clears `stopped outside Mend` today.

**Defaults.** No setting. A Mend talking to a Core or SDK that does not report the signal below
keeps today's words.

**In scope.**

- Recognising Core's planned stop from what the public SDK reports.
- The words on the session line (summary) on every surface, during and after.
- Keeping that recognition across a Mend restart.
- The restatement rules (`restatedSummary`, `STALE_ON_START_PREFIXES`) for the new prefix.

**Out of scope.**

- Whether Mend should relaunch (replace) the session's executor when Core's planned stop comes
  first, the way its own planned replacement would. Today the session stops; this spec keeps that
  and only changes the words (see Divergences).
- Changing Core's or Mend's lead times.
- Any new Core API: the SDK already reports what is needed.
- The co-located store (no executors with a time limit).

## How it works

Intended behaviour; none of this is built. Code pointers name where each part goes.

### The signal, from the public SDK only

1. `workspace.runtimeDeadline()` (SDK `packages/sdk/src/types.ts:917`; Mend
   `packages/sealant/src/client.ts:254` `runtimeDeadlineOf`): the time limit, or null.
2. `workspace.captureDrain()` (SDK `types.ts:979`; Core maps it in
   `apps/api/src/routes/workspaces/workspaces.module.ts:2131`): `preservationStartsAt` is set once
   Core's sweep planned this run's preservation, and visible once the drain has a recorded state
   (Core hides a drain row whose `state` is null). Mend's `captureDrainOf`
   (`packages/sealant/src/client.ts:333`) reads only `state` and `retained` today; it must also
   return `preservationStartsAt` (a `Date`, null when absent or unreadable).
3. **Rule.** An executor's end is Core's planned stop when, at the moment Mend first observes the
   executor ending on its own:
   - the runtime reports a time limit (`runtimeDeadline()` non-null), and
   - `captureDrain().preservationStartsAt` is present and not after that moment (Mend's clock is not
     compared with the executor's; this compares Core's recorded instant with the time Mend read it,
     both from Core's answer and Mend's receipt; a small slack, one status interval, is allowed).
     Anything else, including an SDK without either method, a read that fails, or a
     `preservationStartsAt` still in the future, is "outside Mend".
4. "Mend first observes the executor ending on its own" is either of today's two moments:
   - a status read finds a final flush Mend did not ask for (`reading.complete === false` and
     `incompleteReason === "in-progress"`, `packages/sessions/src/engine.ts:2796-2818`), where Mend
     adds the workspace to `endedOutsideMend` and forks a stop;
   - a lookup finds the executor already ended (`lookupWorkspace`, `engine.ts:2908`, `gone`), and
     the end is read from evidence (`executorEndOfSession`, `engine.ts:7834`), including for a
     joined session's agent (`executorLostOnEnd`, `engine.ts:7978`). At a `gone` lookup whose status
     is `stopped`, `lookupWorkspace` does not read the drain today; the planned-stop check must read
     it there too.
5. **Recorded durably.** The cause (`outside` or `platform-time-limit`, with the deadline) is
   recorded on the session row with the workspace id it is about, not only in the in-memory
   `endedOutsideMend` set (`engine.ts:2727`), so a Mend restart between the start of Core's drain
   and the saved end keeps it.

### The words

6. `executorEndWords` (`packages/domain/src/workbench/capture-drain.ts:994`) takes the cause. With
   `platform-time-limit`, the first part `stopped outside Mend` becomes
   `stopped before the platform's time limit`, and an `executor lost` line gains
   `at the platform's time limit <HH:MM:SS> UTC` as its second part. Nothing else in the line
   changes.
7. The saved-end sites that prefix `stopped outside Mend · ` by hand (`engine.ts:4516-4520`,
   `4691-4695`, through `sayEndedOutsideMend`, `engine.ts:4302`) use the same choice.
8. While Core's drain runs and the session reads `stopping`, its summary is
   `stopping before the platform's time limit at <HH:MM:SS> UTC`; the capture line beside it
   (`captureStatusLine`) is unchanged.
9. `EXECUTOR_VERDICTS` (`capture-drain.ts:1045`) and `STALE_ON_START_PREFIXES` (`engine.ts:880`)
   gain `stopped before the platform's time limit` and `stopping before the platform's time limit`,
   so a later observation restates the line and a launch that starts clears it.

### Where it shows

10. The words live in the session's `summary`, which the web session page and lists, the CLI
    (`mend sessions`, the dashboard), the desktop, the phone and VS Code show as they show any
    summary. Slack (`packages/jobs/src/slack-reporter.ts:442`, `packages/slack/src/format.ts:192`)
    and the t3 gateway (`apps/t3-gateway/src/hub.ts:1093`) carry the summary where they already do.
    No client builds this text; none needs a change.

### Ordering and restart

- Core's planned stop and Mend's planned replacement can both be due: whichever Mend sees first
  decides. If Mend's own replacement drain is already running (`replacing`), the executor's final
  flush is Mend's, and nothing here applies.
- The owner pressing Stop during Core's drain: the session stops as today; once saved it reads the
  planned-stop words if Core's drain started first (preservation start before the owner's Stop),
  else the bare `stopped`.
- A discard during Core's drain: `unsaved work discarded by <name> at …` as today.
- Mend restarts during Core's drain: the recorded cause (step 5) is read back with the session.

## Happy path

Capture mode on AWS MicroVMs (8 h limit). Alice starts `mend codex "refactor the parser"` at
04:00:00 UTC; the executor's limit is 12:00:00 UTC.

1. At 11:42:30 Core's sweep starts the preservation (15 min lead plus an estimate for 40 MB
   pending). The executor runs its final flush.
2. Mend's next status read sees a final flush it did not ask for, reads `runtimeDeadline()` =
   12:00:00 and `captureDrain().preservationStartsAt` = 11:42:30, records the cause, and stops the
   session. Alice's phone row reads `stopping` with
   `stopping before the platform's time limit at 12:00:00 UTC` and `saving · 40 MB left`.
3. At 11:44:02 the seal stands. The session reads
   `stopped · stopped before the platform's time limit · saved at 11:44:02 UTC · capture 21` on the
   web, the phone and `mend sessions`.
4. Alice presses Resume. A new executor materialises capture 21; the line clears and reads
   `codex is starting on the new machine`.
5. Bob, the same day, stops his Docker-based session's container by hand with `docker stop`. His
   session reads `stopped outside Mend · saved at …` as before.

## Invariants

1. A session reads `… before the platform's time limit …` only if the runtime reported a time limit
   and Core reported a preservation start no later than Mend's first observation of the executor
   ending on its own.
2. Every other end Mend did not ask for reads exactly as today (`stopped outside Mend …`,
   `executor lost …`).
3. The owner's Stop never reads as a planned stop unless Core's preservation had started first.
4. No status word changes; `saved` is never said without the evidence `executorEndOf` requires
   today. The new wording never upgrades `not confirmed`, `completion unknown` or `lost`.
5. The words say what was observed: the platform's time limit and its time, the save and its time.
   Nothing says the stop was "expected", "safe" or "normal".
6. A Mend restart never changes which words a session's end reads.
7. A launch that starts clears the planned-stop line; a later observation of the same executor
   restates it, never stacks a second verdict.
8. Every session whose process ran in that executor (the holder's and any joined one) reads the same
   cause.
9. Mend reads the signal only through the public SDK.

## Edge cases and failure behaviour

- **SDK or Core without `runtimeDeadline()` or `captureDrain()`** (SDK 0.37.2): outside Mend, as
  today.
- **`captureDrain()` fails or times out at the observation:** read once more at the end observation;
  still unknown → outside Mend. Never guessed from the clock alone.
- **A time limit is known but no preservation start is reported** (Core's sweep never planned it, or
  the drain row has no state yet): outside Mend.
- **An operator stops the workspace through Core inside the watch window but before
  `preservationStartsAt`:** `preservationStartsAt` is in the future at observation → outside Mend.
- **An operator stops it after `preservationStartsAt`:** indistinguishable from the planned stop
  through the SDK; reads as the planned stop. Accepted.
- **Core's drain keeps the executor** (not saved, `retained`): the session reads `stopping` with
  `not saved · … · executor kept for recovery` as today; if the runtime then ends it at its limit,
  the lost line names the time limit.
- **Mend's own replacement already draining:** the final flush is Mend's; no planned-stop words.
- **Joined sessions** (capture mode, another session's agent running in the executor): their ends
  read the same cause (invariant 8).
- **Mend restart** during Core's drain, or between the saved end and the restatement: the recorded
  cause stands.
- **Older data:** sessions that already read `stopped outside Mend …` keep their words; nothing is
  backfilled.
- **Permissions:** the line is part of the session; whoever can see the session sees it.
- **Clients:** all show the summary verbatim; truncation on narrow rows (phone, dashboard) cuts the
  end of the line, so the cause comes first.

## Known limits

- An operator's stop through Core after the preservation start reads as the planned stop (no SDK
  field says who asked).
- The rule depends on Core recording `preservationStartsAt`; a Core that drains ahead of the limit
  without recording it reads as outside Mend.
- Only MicroVM runtimes have a time limit today; Docker (the box) and Kubernetes never show these
  words.

## How to verify

**Tests to add.**

- `packages/domain/test/capture-drain.test.ts`: `executorEndWords` with the planned cause for each
  end kind, and `restatedSummary` replacing the new prefix.
- `packages/sealant` client: `captureDrainOf` reads `preservationStartsAt` (present, absent,
  unreadable).
- `packages/sessions/test/engine.test.ts`, beside "D9" (`:20335`) and "e2e9 F-A" (`:15731`): an
  executor running its own final flush with a preservation start in the past and a deadline reads
  `stopped before the platform's time limit · saved at … · capture n`; with no preservation start,
  `stopped outside Mend …`; the owner's Stop still bare `stopped`; a restart between the observation
  and the end keeps the cause; a resume clears it.

**By hand.** Needs a MicroVM runtime, or a Core whose fake runtime reports a deadline. Set
`WORKSPACE_CAPTURE_DEADLINE_LEAD_MS` large enough that the preservation is due a few minutes after
launch, start a session, wait, and read `mend sessions` and the web line.

**Signals.** Logs
`session engine: capture mode · the executor is running a final flush Mend did not ask for · stopping`
(extend it with the cause and the deadline),
`session engine: capture mode · the platform's deadline · observed`; Core's worker log
`Workspace stop (deadline preservation): …`.

## Divergences found while writing

- `packages/domain/src/workbench/capture-drain.ts:994-1016` and
  `packages/sessions/src/engine.ts:4519`, `4694`: every end Mend did not ask for reads
  `stopped outside Mend`, Core's planned stop included. The subject of this spec.
- `packages/sealant/src/client.ts:333-348`: `captureDrainOf` drops `preservationStartsAt`, which the
  SDK reports.
- `packages/sessions/src/engine.ts:2908-2935`: a `stopped` status is `gone` without reading the
  drain, so the planned stop cannot be recognised from a lookup alone today.
- `packages/sessions/src/engine.ts:2727`: `endedOutsideMend` is process memory. A Mend restart while
  the executor's own final flush runs loses it, and the saved end then reads a bare `stopped`, the
  owner's Stop wording (the run 9 D9 case decision 42 fixed, back under a restart).
- `packages/sessions/src/engine.ts:5670-5697` with Core
  `packages/workspaces/src/worker/preserve-before-deadline.ts:121-127`: Mend's planned replacement
  (lead ≥ 10 min) loses to Core's planned stop (lead ≥ 15 min plus 1.5 × the upload estimate) on
  every MicroVM, so a long session stops at the limit instead of moving to a new executor. Mend's
  replacement path, built for exactly this, never runs there. Owner decision needed: align the
  leads, or relaunch after Core's planned stop.
- `docs/adr/0002-session-capture-store.md` decision 42 and `apps/cli/CHANGELOG.md:511-514` describe
  a platform deadline stop as "stopped outside Mend" on purpose; both need the new decision when
  this is built.
