# Standby discard: a TLA+ model

Mend keeps warm standby workspaces that a launch can claim and turn into a session's workspace (the
hot pool). Since mend#1608, `drainHotWorkspace` (`packages/sessions/src/engine.ts`) ends an
unclaimed standby with `sealant.stopWorkspace(workspace, { discardUnsaved: true })`, which tells
sealant to remove the workspace without saving its files. This directory holds a TLA+ model of every
actor that can reach that call, and TLC checks it across every order of their steps.

- **The promise:** a discard is never sent for a workspace that holds, or can still come to hold, a
  session's work.
- **The harm if it breaks:** a person's uncommitted work in a running session is deleted with its
  VM, with no capture and nothing telling them.

The agent-facing instructions (when to run it, how to update it, which code each step stands for,
the commit it was last confirmed at) are the project skill
[`.agents/skills/standby-discard/SKILL.md`](../../../.agents/skills/standby-discard/SKILL.md).

## The finding, fixed (SLNT-823)

The model found one schedule on `origin/main` at `374094f416` in which a reconcile pass discarded
the workspace a launch had just claimed and was adopting. `drainHotWorkspace` now reads the session
again once `retire` has taken the row, and sends an ordinary stop when one exists (SLNT-823,
mend#1628, commit `aa029659e3`). Row `mutant-no-reread` keeps the drain as it was, and TLC still
breaks the promise there.

The schedule, in Mend's words:

1. Standby **s1** is ready.
2. A reconcile pass lists s1 as ready and drains it. The pass could come from the owner lowering hot
   sessions, an environment or runtime change, removing the Boat key, or a dead probe.
   `drainHotWorkspace` reads `sessions.byId(s1)`: no session.
3. Before the pass reaches its next statement, a launch claims s1 (`HotWorkspacesRepo.claim`: s1 is
   now `claimed`).
4. The hot pool sweep runs (at boot and every 10 minutes). It lists s1 as claimed, finds no session
   under its id yet, and drains it.
5. The launch creates its session under id s1 (`claimHotSession` → `sessions.create`).
6. The sweep's drain sends an ordinary saving stop to s1's workspace.
7. The launch's `launchSession` reads the pool row (`hotWorkspaces.byId`): still `claimed`, so it
   will adopt the standby.
8. sealant does not confirm the end of the sweep's stop. On Boat that is the usual answer for a
   standby (SLNT-803). The sweep's drain calls `hotWorkspaces.setFailed(s1)`, an
   `UPDATE … WHERE id = ?` with no status condition, and **`claimed` becomes `failed`**.
9. The reconcile pass reaches `retire(s1)`. Its `WHERE id = ? AND status <> 'claimed'` matches a
   `failed` row, so it takes s1.
10. Before the fix, the pass then sent `stopWorkspace(s1's workspace, { discardUnsaved: true })`.
    Now it reads `sessions.byId(s1)` again, finds the launch's session, and sends an ordinary stop.
11. The launch records s1's workspace as its session's executor (`acceptExecutor`), deletes the pool
    row and replans the session's worktree into the workspace.

**Why the second read closes it.** Once `retire` has taken the row, the row is `failed`, so no claim
takes it and no launch that reads it afterwards adopts it. A launch that read it as `claimed` before
did so after creating its session, so the second read finds that session. The ordinary stop is what
the drain already sends when its first read finds a session. Leaving the workspace running instead
would be wrong whenever the session runs elsewhere: a launch that dropped an unusable claim goes
cold in a new workspace, and the standby's VM would then stay up and billed. In every state where
the second read finds a session, another drain has already sent that workspace an ordinary stop,
because only that drain's `setFailed` moves a claimed row out of `claimed`.

**What it depended on.** `retire` checks the row's status in the same statement as the update, and
mend#1608 reasoned from that. Two other steps undid it:

- The first session read and `retire` were separate statements, so the session could appear in
  between. The review of mend#1608 (SLNT-811) named this gap and judged it safe, because `retire`
  refuses a `claimed` row.
- The not-ended branch of another drain overwrites `claimed` with `failed`.

In one Mend process the schedule needed the sweep: row `mutant-no-reread-no-sweep` takes the sweep
out of the old drain and the promise holds. Row `mutant-no-reread-atomic-retire` makes `retire` one
indivisible step and the promise still breaks, so the finding did not rest on Postgres's window
inside one statement. The engine test "never discards a standby a launch is adopting, when the sweep
turned its claim failed between the pass's session read and its retire (SLNT-823)" in
`packages/sessions/test/engine-standbys.test.ts` drives this schedule through the real
`drainHotWorkspace`, sweep, claim and launch, and failed on `main` with
`expected [ 'drain', 'discard' ] to deeply equal [ 'drain', 'drain' ]`.

**How likely it was.** Rare. Every one of these had to happen at the same time:

- A reconcile pass drains the standby just as a launch claims it, and reads "no session" before the
  launch creates its session.
- The sweep's 10-minute tick lists the row and reads "no session" in the milliseconds between the
  claim and `sessions.create`.
- The reconcile's fiber pauses between `sessions.byId` and `retire` until the sweep's stop has been
  answered and its `setFailed` written: a few sealant round trips, hundreds of milliseconds.

More than one Mend API process makes it more reachable, which the model does not cover.

**What it would have cost.** The discard went out within about a second of the launch adopting the
workspace: the session lost what it made in its first moments, and its workspace ended under it.

**The other candidate, not taken.** Giving the not-ended `setFailed` a `status <> 'claimed'`
condition also kept the promise in the model. It was not taken: a claim whose launch died before
creating its session would stay `claimed`, the sweep would keep sending saving stops that sealant
keeps, and the VM would stay billed (the SLNT-803 leak, for that case).

## A second discard: a claimed standby whose re-plan never took (SLNT-1053)

Since SLNT-1053 one more call sends `discardUnsaved: true`: `discardStandbyNeverClaimed`, which a
session's drain (`runDrain`) runs once before it asks a final flush. It reaches a standby a launch
**did** adopt, so the promise is stated in two halves. `drainHotWorkspace`'s discard still never
reaches a workspace a launch adopted or that holds work. The new discard never reaches a workspace
that holds, or can still come to hold, anything a session made.

**Why the new discard cannot reach a session's work.** It is sent only for a claimed standby whose
own launch has already given it up, so that launch will start nothing there. Mend never started a
process of anyone's in it, and the drain reads that only after its intent is durable, so a join that
looks later stays out. The standby's own status must also still name its placeholder. A launch
starts nothing in a standby before its re-plan answers (e2e9 F-B). The only other writer is a join,
and the look rules a join out.

What the model adds for it:

- The launch's re-plan is answered (`AReplanOk`: the agent starts, so the workspace holds work), or
  refused or not answered (`AReplanFail`: it may have taken with its answer lost, or not; it is
  asked again or given up on).
- `AIdentify` is the launch's read of the standby's status. One that took may be read as the
  session's and adopted (the agent starts), or not read at all. Otherwise the launch gives the
  standby up, and its drain writes its durable intent (`beginCaptureDrain`) in the same step: no
  step in between reads what the intent changes.
- `GLook` is the look's two reads, `processes.existsForWorkspace` and `workspaceInUse` (a join under
  way is counted in `workspaceHolds`). They are one step because both come after the intent, so a
  join that looked before the intent shows in one of them, whichever comes first. `GIdentify` is
  `readClaimedStandby`, and `GDiscard` is the discard.
- `KeptRetry` is the capture reaper taking a kept drain up again. Its intent outlives a restart, so
  a session already kept this way is looked at again.
- `JEnter` and `JLook` are one join into a standby's executor: counted, then a look at its holder's
  intent, then its process row.
- `Stop` is its owner's Stop while the launch is still asking (`stoppedDuringLaunch`, then the
  Stop's own drain, which writes the intent and looks). A stopped launch asks nothing more, gives
  the standby up without a drain of its own, and starts no agent (`AgentStarts`, the code's
  `refuseIfStoppedDuringLaunch`).
- A run has one join or one Stop, into either standby, not both: each break they show needs only
  itself, and the look sees a join's process row whoever wrote the intent. At most one standby in a
  run goes down the failed path (`OnlyFailedReplan`). Two standbys share no workspace, session or
  join, so a break needs only one of them, and the other still runs every other action. Without
  these restrictions the code rows reached 292 million states with tlx; TLC would take hours.

`holdsWork` now means that something a session made may be on the workspace: its agent started
there, or a join ran there. A re-plan by itself lays down only the worktree's saved head
(`onWorktree`). A re-plan that times out and lands in sealantd later is not modelled: it lays down
the same saved head, and in the model it could only turn a discard into a drain.

Three mutants show what keeps the new half. Two are about the look. `no-look` discards without it,
and `look-live-only` sees what holds the workspace now but not a join that ran and ended. Both fail
the same way: a join runs in the standby during its failed re-plan, then the drain discards it. The
third, `agent-ignores-stop`, starts the agent of a launch its owner stopped: the Stop's drain reads
the placeholder while the re-plan is still unanswered, the re-plan then answers, the agent starts,
and the discard goes out (17 steps). The identity read is not what keeps the promise; it is what
tells an adoption from an end and makes the session's words true. A discard of a standby whose
re-plan took but which nobody can read would lose only its saved head, so the code takes the
cautious path there and drains it as before.

## Run it

```sh
docs/formal/standby-discard/check.sh                # every row, full bounds, about 12 minutes on 32 cores
docs/formal/standby-discard/check.sh --quick        # one launch instead of two, about 30 seconds
docs/formal/standby-discard/check.sh <row>          # one row with the checker's whole output and trace
docs/formal/standby-discard/check.sh --engine tlx   # any of these with tlx: about 3.5 minutes, 5 seconds with --quick
```

A run ends with exit 0 only when every row of the table in `check.sh` ends with the verdict the
table expects and reaches the number of distinct states it pins, at the full bounds or at
`--quick`'s. `MEND_FORMAL_WORKERS` caps the workers a row expected to hold uses (default: every
core). The pinned count is what makes a second checker safe to use: a checker that says "holds" over
a different state space fails the run. A row that holds explores every reachable state, and a row
expected to fail runs on one worker and stops at the same shortest trace, so both counts are the
same on every run. TLC is tla2tools 1.7.4 (TLC 2.19), from the repository's pinned nixpkgs
(`flake.lock`) when Nix is installed. Otherwise it is the GitHub release, checked against its
sha256; that path needs `java` and `curl`. To tell a counterexample as one line per step, pipe it
through `trace.py`, which reads either checker's trace:

```sh
docs/formal/standby-discard/check.sh mutant-no-reread | python3 -I docs/formal/standby-discard/trace.py
```

### TLC and tlx

TLC is the reference. The run that goes with a change to the model, or to the code it models, is a
TLC run, and a pinned count is only ever moved to what TLC reached. tlx is for iterating: a TLA+
checker written in Rust that reads the same `.tla` and `.cfg` files, about twelve times faster here.
`check.sh` runs it with `-tlc`, its mode that promises TLC's verdicts, counts, depth and shortest
traces.

tlx is version 0.1, about a month old, with no releases. It comes from
[tlaplus-x/tlx](https://github.com/tlaplus-x/tlx) and was measured at commit
`8d5f082b0f0d922bf5999d9a8db00c70a4c1d261`. Build it with Rust and a C compiler, then point
`check.sh` at it (it is not in the Nix flake or CI):

```sh
git clone https://github.com/tlaplus-x/tlx && cd tlx && git checkout 8d5f082b0f
nix shell nixpkgs#cargo nixpkgs#rustc nixpkgs#gcc -c cargo build --release   # or plain cargo
MEND_TLX=$PWD/target/release/tlx docs/formal/standby-discard/check.sh --engine tlx
```

Without `MEND_TLX`, `check.sh --engine tlx` runs `tlx` from `PATH`, and stops with exit 2 when there
is none. `MEND_FORMAL_ENGINE=tlx` picks tlx as `--engine tlx` does.

Measured on 2026-11-13 on a 32-core machine, both checkers on the same model at full bounds: each
row alone with its time and peak memory, then whole `check.sh` runs. Every verdict, violated
invariant, state count and depth matched:

| Row                                      | TLC           | tlx          | Distinct states (both) |
| ---------------------------------------- | ------------- | ------------ | ---------------------: |
| `code-promise`                           | 142 s, 7.3 GB | 11 s, 1.5 GB |             18,141,305 |
| `code-claimable`                         | 167 s         | 12 s         |             18,141,305 |
| `mutant-no-reread` (one worker)          | 6.1 s         | 0.8 s        |                113,052 |
| `mutant-reused-id` (one worker)          | 1.6 s         | 0.2 s        |                  9,408 |
| `mutant-no-reread-no-sweep`              | 5.0 s         | 0.6 s        |                293,226 |
| whole `check.sh` (all ten rows, wall)    | 214 s         | 22 s         |                        |
| whole `check.sh --quick` (all ten, wall) | 16 s          | 2 s          |                        |

On 2026-11-16, with SLNT-1053's actions and thirteen rows, the whole `check.sh` took about 30
minutes with TLC; `--quick` took about 40 s with TLC.

### How long the full bounds take, and on CI

Pull requests run `--quick`. The nightly run (and a dispatched CI run with `formal: full`) runs the
full bounds on GitHub's four-core runner, in a job of this model's own, which `formal.mjs` stops
after `budget-full` minutes (`COVERAGE`) with a message naming this model. SLNT-1053 grew the full
state space 7.1 times, from 18,141,305 to 129,386,795 distinct states: the one join, the one Stop
and the failed re-plan each multiply it, and each with the second launch. On CI one row of that size
took 61 minutes, so the three rows that explored it then (`code-promise`, `code-claimable` and
`code-promise-atomic-retire`) ran the nightly job into its 90-minute limit (SLNT-1065). Two changes
cut that without giving up any state: `code` checks both promises in one run, since they are
invariants of the same state space, and `code-promise-atomic-retire` runs at `--quick` only, since
its action constraint only removes transitions and so `code` holding at the full bounds proves it.

Java's default heap, a quarter of the runner's 16 GB, left TLC spilling its fingerprint set to disk
at this size: `code` did not finish in 75 minutes. `check.sh` lets the heap take three quarters of
the machine, and on CI the whole full check then took 57 minutes (`code`: 129,386,795 states in
3,312 s, about 18 million states generated a minute throughout), at `b192d2e2`, run
[43887573641](https://github.com/sealant-sh/mend/actions/runs/43887573641). With
`MEND_FORMAL_PROGRESS` set, as CI sets it, TLC's memory and progress lines go to the job log as they
come.

GitHub's four-core runner is not one speed. The first nightly after that,
[44068746119](https://github.com/sealant-sh/mend/actions/runs/44068746119) at `43927c51`, ran the
same model on a slower host: Azure in westus where the passing run had AWS in us-east-1, with the
same heap. TLC generated about 12 million states a minute from its first minute to its last, so
`code` needed about 82 minutes for the same 1,005 million states generated, and the whole check
about 85. The 75-minute budget stopped it with 118.6 million distinct states found (SLNT-1065).
`budget-full` is now 110 minutes, about 30% over that slow host, and CI's `formal` job allows 120.
When the budget stops it again, read the checker's last progress line first. Distinct states short
of the pinned count at about 12 or 18 million generated a minute means a slow host. A higher count
than pinned, or a rate that falls late in the run, means the model or the memory changed.

A change that grows the full count should say on its ticket what the full run took, on four cores
too (`MEND_FORMAL_WORKERS=4`), before it merges, so the budget is not found out at night.

## Files

| File                         | What it is                                                        |
| ---------------------------- | ----------------------------------------------------------------- |
| `StandbyDiscard.tla`         | The model: state, one action per code step, the two properties.   |
| `MCStandbyDiscard.tla`       | The model plus two restrictions used by the diagnostic rows.      |
| `check.sh`                   | The runner, and the rows with their expected outcomes and counts. |
| `trace.py`                   | Prints a TLC or tlx trace as one line per step.                   |
| `postgres-read-committed.sh` | The throwaway-Postgres observations below, rerunnable.            |

## What the model is

**Actors** (each runs concurrently with the others):

- The reconcile pass (`reconcileHotPoolOnce`, one at a time per project). It covers hot-sessions
  changes, fingerprint changes, `changingBoatKey`'s drain and the retry of a discard sealant did not
  confirm.
- The hot pool sweep (`hotPoolSweep`).
- Two launches (`claimHotSession`, then `launchSession`'s adoption).
- Provisioning (`provisionHotWorkspace`, inside the pass).
- People settling and resuming sessions.
- A process restart between any two steps.

Every call to `drainHotWorkspace` runs as its own sequence of steps for its caller.

**Steps.** One action is one SQL statement or one platform call. A read that a later decision rests
on is its own step, and so is the write that follows. Each action's comment in `StandbyDiscard.tla`
names its code, and the skill's coverage record maps them.

**Bounds:**

- Two pool ids (`Standbys = {s1, s2}`), each provisioned at most once, so at most two standbys in a
  run.
- Two launches (`Launches = {l1, l2}`).
- One project and one Mend process.
- Unbounded reconcile passes, so a discard is retried without bound.
- Unbounded sweep passes, restarts, settles and resumes.

TLC explores every reachable state within those bounds, with symmetry over ids and launches. The
`--quick` mode uses one launch. On top of the routine runs, one run with three standbys and one
launch was made at the sync commit (see "Last full run").

**Assumptions.** Each one either matches the code or only adds behaviours:

- **Capture mode.** Outside it `drainHotWorkspace` never discards (`capture !== null`).
- **Statements.** Each `HotWorkspacesRepo` and `SessionsRepo` call is one autocommit statement at
  Read Committed: nothing in `engine.ts` wraps them in `withTransaction`. The SQL drizzle generates
  for `claim`, `retire` and `setFailed` is the SQL in `postgres-read-committed.sh`.
- **Stop answers.** Every stop can be answered ended or not ended. A discard counts as sent even
  when `getWorkspace` fails before it.
- **Claims.** A claim may take any `ready` row. That covers `SKIP LOCKED` and the owner,
  fingerprint, layout and oldest-first conditions.
- **Reconcile drains.** A pass may drain any entry that was not `claimed` in its list. That covers
  every reason it drains.
- **Adoption.** A launch may adopt a workspace a discard was already sent for, because sealant's
  second or so to end it is not modelled. A launch that finds the workspace dead is `ADrop`.
- **Ids.** Pool ids are fresh `crypto.randomUUID()` values, and sealant never reuses a workspace id.
  The mutant `reused-id` shows what breaks without that.
- **Session rows.** They are not deleted in the model. `SessionsRepo.remove` runs only once the
  session's workspace has gone, and after that no discard can reach its work.

**Not covered:**

- More than one Mend API process.
- A project's removal, whose pool rows cascade away.
- sealant's handling of a discard, taken to do what it says.
- Whether VMs end and the pool rewarms (liveness).
- The web and CLI.

The finding's trace also shows a leftover the review of mend#1608 listed: an ordinary stop reaching
a standby a launch has just claimed, sent here by the sweep. That stop saves, so it is not a
property here. The fix adds a second ordinary stop to the same workspace in that schedule.

## Postgres's Read Committed, for the two statements that race

The model splits `claim` and `retire` each into the statement's snapshot read and the locked
re-check of the row's newest version. Other statements can commit between the two. This is the
behaviour PostgreSQL's documentation gives for `UPDATE` and `SELECT … FOR UPDATE` at Read Committed
(chapter "Transaction Isolation", section "Read Committed Isolation Level"):

- A statement finds its target rows as of its own start.
- A target row that a concurrent transaction updated is re-checked against the `WHERE` clause on its
  newest version once that transaction commits.
- A row whose version at the start did not match is not a target.
- `SKIP LOCKED` passes over a row another transaction holds (the `SELECT` page, "The Locking
  Clause").

`postgres-read-committed.sh` checks each fact on a throwaway PostgreSQL 18.4. The output at the sync
commit:

```
E1  retire meets the row locked by a claim still running; it waits, then re-checks its WHERE on the version the claim committed
    retire: 0 row(s) · row: claimed
E2  claim meets the row locked by a retire still running; SKIP LOCKED passes it by
    claim: 0 row(s) · row: failed
E3  claim's snapshot has the row ready; a retire commits before the claim locks it; the claim re-checks and takes nothing
    retire: 1 row(s) · claim: 0 row(s) · row: failed
E4  retire's snapshot has the row ready; a claim commits before the retire locks it; the retire re-checks and takes nothing
    claim: 1 row(s) · retire: 0 row(s) · row: claimed
E5  retire's snapshot has the row claimed; setFailed commits before the retire reaches it; the retire takes nothing
    retire: 0 row(s) · row: failed
E6  retire's snapshot has the row ready; a claim, then setFailed, commit before the retire locks it; the retire takes the row
    claim: 1 row(s) · retire: 1 row(s) · row: failed
E7  one statement after another: claim, setFailed (no status condition), retire
    claim: 1 row(s) · retire: 1 row(s) · row: failed
```

E6 and E7 are the database half of the finding. Once the unconditional `setFailed` has overwritten
`claimed`, `retire` takes the row, whether its snapshot came before the claim or after.

## The properties, and the reviewer's claims

- `NoDiscardOfSessionWork` (the promise): no discard from `drainHotWorkspace` is ever sent for a
  workspace that a session has taken as its executor (`acceptExecutor`) or holds work in, and no
  discard from `discardStandbyNeverClaimed` for one that holds work (SLNT-1053). TLC checks it in
  every state, so a discard sent first and an adoption afterwards break it too. That is the "can
  still come to hold" half. On the code it holds; without the second session read
  (`mutant-no-reread`) it fails, which was the finding.
- `NoClaimableRowWithSession`, the reviewer's first property: a row is `ready` only while no session
  has its id, has taken its workspace, or holds work in it. On the code it holds (row `code`, which
  checks it with the promise).
- The reviewer's second property is an **assumption** here, not a checked result: a workspace id
  that was a standby's is never reused by a different workspace while a discard for it can still be
  retried. The model gives each standby its own id and never reuses one (see "Assumptions"). What
  the model shows about retries: a retried discard comes from a later pass, which reads the session
  first. So the retry never reaches a session's workspace. The finding was a first discard, not a
  retry.

## Each property can fail

The mutants run on the code. Each one fails only because of its own break. Each counterexample below
is TLC's shortest, from `check.sh <row>`.

- **`no-reread`**: the drain as it was before SLNT-823, deciding the discard from `retire` alone. It
  breaks `NoDiscardOfSessionWork` in 22 steps: the schedule in "The finding, fixed".
- **`reread-before-retire`**: the second session read made before `retire` instead of after. It
  breaks `NoDiscardOfSessionWork` in 23 steps:
  1. s1 is ready, and a reconcile pass drains it and reads no session twice.
  2. A launch claims s1, the sweep starts draining it, and the launch creates its session.
  3. The sweep's stop is not confirmed, after the launch read the row as claimed, so `setFailed`
     writes failed over claimed.
  4. The pass's `retire` takes the failed row and the discard goes out.
  5. The launch takes the workspace as its executor.
- **`discard-before-retire`**: the stop is sent before `retire`, and `retire`'s answer goes unused.
  It breaks `NoDiscardOfSessionWork` in 15 steps:
  1. s1 is ready, and a reconcile pass drains it, reads no session and sends the discard at once.
  2. A launch claims s1, which is still `ready` because `retire` has not run, and creates its
     session.
  3. The launch reads the row as claimed and takes the workspace as its executor.
- **`claim-leaves-ready`**: `claim` locks the row but never sets `claimed`. It breaks
  `NoClaimableRowWithSession` in 9 steps: s1 is ready, a launch claims it, and creates session s1.
  The row is still `ready`, so it can be claimed again while a session holds its id.
- **`no-look`** and **`look-live-only`** (SLNT-1053): the never-took discard without looking for
  what ran in the standby, or looking only at what holds it now. Each breaks
  `NoDiscardOfSessionWork` in 18 and 19 steps: a launch claims s1, adopts it and its re-plan fails;
  it gives the standby up. A join counts itself, looks before the drain's intent is written, runs
  and ends. The drain writes its intent, does not see the join, reads the placeholder and discards.
- **`reused-id`**: a new standby may take the id of one that was drained. It breaks
  `NoClaimableRowWithSession` in 16 steps:
  1. A launch claims s1, adopts its workspace and deletes the row.
  2. The next provision reuses id s1.
  3. Row s1 is `ready` again while session s1 runs.

Before the fix a mutant `retire-ignores-status` dropped `status <> 'claimed'` from `retire`, and it
broke the promise. With the second read it holds (11,263,702 states at full bounds): a `retire` that
takes a claimed row either comes before the launch's session exists, so the launch then reads the
row as failed and goes cold, or after it, so the second read finds the session. The status check
stays in the code; the promise no longer rests on it alone.

## Last full run

At SLNT-1053's second round (on `fbcb560cb1`), with TLC (tla2tools 1.7.4), Standbys = {s1, s2},
Launches = {l1, l2}, on 32 cores:

| Row                              | Expected                             | Observed                             | Distinct states | `--quick` | Time |
| -------------------------------- | ------------------------------------ | ------------------------------------ | --------------: | --------: | ---: |
| `code-promise`                   | holds                                | holds                                |     129,386,795 | 1,632,702 | 570s |
| `code-promise-atomic-retire`     | holds                                | holds                                |     101,431,308 | 1,401,689 | 526s |
| `code-claimable`                 | holds                                | holds                                |     129,386,795 | 1,632,702 | 603s |
| `mutant-no-reread`               | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         183,199 |    58,131 |   7s |
| `mutant-no-reread-atomic-retire` | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         172,787 |    54,647 |   6s |
| `mutant-no-reread-no-sweep`      | holds                                | holds                                |       1,938,517 |    76,260 |  11s |
| `mutant-reread-before-retire`    | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         297,173 |    89,958 |  10s |
| `mutant-discard-before-retire`   | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |           4,630 |     2,226 |   1s |
| `mutant-claim-leaves-ready`      | violated `NoClaimableRowWithSession` | violated `NoClaimableRowWithSession` |             188 |       125 |   1s |
| `mutant-reused-id`               | violated `NoClaimableRowWithSession` | violated `NoClaimableRowWithSession` |          10,343 |     4,466 |   1s |
| `mutant-no-look`                 | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |          32,926 |    12,610 |   2s |
| `mutant-look-live-only`          | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |          54,740 |    20,019 |   2s |
| `mutant-agent-ignores-stop`      | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |          19,346 |     7,906 |   2s |

Every verdict is the one `check.sh` expects, and tlx reached the same counts at both bounds. The
mutants of SLNT-823 keep their shortest traces (22, 22, 23, 15 and 16 steps). Their counts and the
code rows' grew with the new actions; before SLNT-1053 they were, in the same order, 18,141,305,
13,959,504, 18,141,305, 113,052, 104,484, 293,226, 166,239, 4,509, 188 and 9,408, as reached at
`aa029659e3`.

The whole run exited 0. `check.sh` pins these counts, and a TLC run at `16abbc19c0` reached each of
them again. The `mutant-no-reread` rows reach exactly the state counts the code rows reached at
`374094f416`, and `code-promise` reaches exactly the count the candidate row `fix-reread-session`
reached there: the mutant is the old code and the code is the fix the model checked.

Once, at the same commit, with three standbys and one launch (`Standbys = {s1, s2, s3}`,
`Launches = {l1}`, a one-off configuration, not a row of `check.sh`): the code holds
`NoDiscardOfSessionWork` and `NoClaimableRowWithSession` over 4,481,934 distinct states, in 19s.
