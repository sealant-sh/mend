# Standby discard: a TLA+ model

Mend keeps warm standby workspaces that a launch can claim and turn into a session's workspace (the
hot pool). Since mend#1608, `drainHotWorkspace` (`packages/sessions/src/engine.ts`) ends an
unclaimed standby with `sealant.stopWorkspace(workspace, { discardUnsaved: true })`, which tells
Sealant to remove the workspace without saving its files. This directory holds a TLA+ model of every
actor that can reach that call, and TLC checks it across every order of their steps.

- **The promise:** a discard is never sent for a workspace that holds, or can still come to hold, a
  session's work.
- **The harm if it breaks:** a person's uncommitted work in a running session is deleted with its
  VM, with no capture and nothing telling them.

The agent-facing instructions (when to run it, how to update it, which code each step stands for,
the commit it was last confirmed at) are the project skill
[`.agents/skills/standby-discard/SKILL.md`](../../../../.agents/skills/standby-discard/SKILL.md).

## The finding: the code as it is can send the discard to a session's workspace

TLC finds a schedule on `origin/main` (`374094f416`) in which a reconcile pass discards the
workspace a launch has just claimed and is adopting. It is the row `code-promise-atomic-retire`.
That row treats `retire` as one indivisible statement, so the schedule does not depend on Postgres's
window inside a single statement. In Mend's words:

1. Standby **s1** is ready.
2. A reconcile pass lists s1 as ready and drains it. The pass could come from the owner lowering hot
   sessions, an environment or runtime change, removing the Boat key, or a dead probe.
   `drainHotWorkspace` reads `sessions.byId(s1)`: no session, so `adopted = false`.
3. Before the pass reaches its next statement, a launch claims s1 (`HotWorkspacesRepo.claim`: s1 is
   now `claimed`).
4. The hot pool sweep runs (at boot and every 10 minutes). It lists s1 as claimed, finds no session
   under its id yet, and drains it.
5. The launch creates its session under id s1 (`claimHotSession` → `sessions.create`).
6. The sweep's drain reads `sessions.byId(s1)`, finds the session, and sends an ordinary saving stop
   to s1's workspace.
7. The launch's `launchSession` reads the pool row (`hotWorkspaces.byId`): still `claimed`, so it
   will adopt the standby.
8. sealant does not confirm the end of the sweep's stop. On Boat that is the usual answer for a
   standby (SLNT-803). The sweep's drain calls `hotWorkspaces.setFailed(s1)`, an
   `UPDATE … WHERE id = ?` with no status condition, and **`claimed` becomes `failed`**.
9. The reconcile pass reaches `retire(s1)`. Its `WHERE id = ? AND status <> 'claimed'` matches a
   `failed` row, so it takes s1 and `discard` becomes true.
10. The reconcile pass sends `stopWorkspace(s1's workspace, { discardUnsaved: true })`.
11. The launch records s1's workspace as its session's executor (`acceptExecutor`), deletes the pool
    row and replans the session's worktree into the workspace Sealant was just told to discard.

The default row, `code-promise`, prints a trace of the same length in which `retire`'s snapshot
comes before the claim. That is the same break, reached through the window inside one statement.

**What it depends on.** `retire` checks the row's status in the same statement as the update, and
the PR reasoned from that. Two other steps undo it:

- `adopted` is read in one statement and `retire` runs in the next, so the session can appear in
  between. The review of mend#1608 (SLNT-811) named this gap and judged it safe, because `retire`
  refuses a `claimed` row.
- The not-ended branch of another drain overwrites `claimed` with `failed`. The PR's own "to file"
  list notes this write and calls it safe "because a session's row is never discarded". Together
  they are not safe.

The engine itself already takes the first half of this schedule in a test. In
`packages/sessions/test/engine-standbys.test.ts`, "never discards a claimed standby, which is a
session, even when a pass listed it before the claim" ends with the claimed row's error reading
`draining · stop draining…`: the pass's not-ended `setFailed` wrote `failed` over `claimed`. The
test's fake `setFailed` has no status condition, as the real one has none. The rest of the schedule,
with the sweep and a pause before `retire`, has not been run against the engine.

In one Mend process the schedule needs the sweep. Row `code-promise-no-sweep` takes the sweep out
and the promise holds over all 293,226 states. Without the sweep, the second drain of a claimed row
would have to be a second reconcile pass of the same project, and one process runs those one at a
time.

**How likely.** Rare. Every one of these must happen at the same time:

- A reconcile pass drains the standby just as a launch claims it, and reads "no session" before the
  launch creates its session.
- The sweep's 10-minute tick lists the row and reads "no session" in the milliseconds between the
  claim and `sessions.create`.
- The reconcile's fiber pauses between two consecutive statements, `sessions.byId` and `retire`,
  until the sweep's stop has been answered and its `setFailed` written: a few Sealant round trips,
  hundreds of milliseconds. Meanwhile the sweep and the launch, in the same Node process, keep
  going.

A database pool that serves waiting queries in order would run the reconcile's `retire` before the
sweep's later `setFailed`, so an ordinary wait for a connection does not give that order. The
schedule is more reachable with more than one Mend API process, which mend#1608 names as possible. A
reconcile in one process and a sweep or a second reconcile in another then pause independently. The
model does not cover that case.

**What it would cost.** The discard is sent with the reconcile pass's next two Sealant calls, within
about a second of the launch adopting the workspace. A later pass reads the session first and sends
an ordinary stop. So what is lost is what the session made in its first moments, and its workspace
ends under it. The worktree it started from is in saved captures. By the repository's Fix Now or
File rule this is a rare trigger and goes to the issue list. It is still a break of Mend's first
rule, so it is reported first.

**Candidate fixes, modelled, not chosen.** Both remove the break, and both keep the reviewer's first
property, in rows that check every state at the full bounds:

- `fix-reread-session`: decide the discard after `retire`, from a session read made after it. When
  `retire` takes a row whose id has a session by then, send an ordinary stop.
- `fix-setfailed-unless-claimed`: give the not-ended `setFailed` a `status <> 'claimed'` condition,
  so a claimed row never turns `failed`. This one has a cost the model does not measure. A claim
  whose launch died before creating its session would stay `claimed`. The sweep would then keep
  sending saving stops that sealant keeps, and the VM stays billed: the SLNT-803 leak, for that
  case.

## Run it

```sh
docs/specs/formal/standby-discard/check.sh           # every row, full bounds, about 4 minutes on 32 cores
docs/specs/formal/standby-discard/check.sh --quick   # one launch instead of two, about 15 seconds
docs/specs/formal/standby-discard/check.sh <row>     # one row with TLC's whole output and trace
```

A run ends with exit 0 only when every row of the table in `check.sh` ends as the table expects. TLC
is tla2tools 1.7.4 (TLC 2.19), from the repository's pinned nixpkgs (`flake.lock`) when Nix is
installed. Otherwise it is the GitHub release, checked against its sha256; that path needs `java`
and `curl`. To tell a counterexample as one line per step, pipe it through `trace.py`:

```sh
docs/specs/formal/standby-discard/check.sh code-promise-atomic-retire | python3 -I docs/specs/formal/standby-discard/trace.py
```

## Files

| File                         | What it is                                                      |
| ---------------------------- | --------------------------------------------------------------- |
| `StandbyDiscard.tla`         | The model: state, one action per code step, the two properties. |
| `MCStandbyDiscard.tla`       | The model plus two restrictions used by the diagnostic rows.    |
| `check.sh`                   | The runner and the table of rows with their expected outcomes.  |
| `trace.py`                   | Prints a TLC trace as one line per step.                        |
| `postgres-read-committed.sh` | The throwaway-Postgres observations below, rerunnable.          |

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
- **Adoption.** A launch may adopt a workspace a discard was already sent for, because Sealant's
  second or so to end it is not modelled. A launch that finds the workspace dead is `ADrop`.
- **Ids.** Pool ids are fresh `crypto.randomUUID()` values, and Sealant never reuses a workspace id.
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
property here.

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

- `NoDiscardOfSessionWork` (the promise): no discard is ever sent for a workspace that a session has
  taken as its executor (`acceptExecutor`) or laid its worktree down in (the replan). TLC checks it
  in every state, so a discard sent first and an adoption afterwards break it too. That is the "can
  still come to hold" half. On the code it fails: that is the finding.
- `NoClaimableRowWithSession`, the reviewer's first property: a row is `ready` only while no session
  has its id, has taken its workspace, or holds work in it. On the code it holds over 18,300,697
  states.
- The reviewer's second property is an **assumption** here, not a checked result: a workspace id
  that was a standby's is never reused by a different workspace while a discard for it can still be
  retried. The model gives each standby its own id and never reuses one (see "Assumptions"). What
  the model shows about retries: a retried discard comes from a later pass, which reads the session
  first. So the retry never reaches a session's workspace. The finding is a first discard, not a
  retry.

## Each property can fail

The mutants run on the base `fix-setfailed-unless-claimed`, because that base passes everything.
Each one fails only because of its own break. Each counterexample below is TLC's shortest, from
`check.sh <row>`.

- **`retire-ignores-status`**: `retire` without `status <> 'claimed'`. It breaks
  `NoDiscardOfSessionWork` in 17 steps:
  1. s1 is ready, and a reconcile pass drains it and reads no session.
  2. A launch claims s1, creates its session and reads the row as claimed.
  3. The pass's `retire` takes the claimed row and the discard goes out.
  4. The launch takes the workspace as its executor.
- **`discard-before-retire`**: the stop is sent before `retire`, and `retire`'s answer goes unused.
  It breaks `NoDiscardOfSessionWork` in 15 steps:
  1. s1 is ready, and a reconcile pass drains it, reads no session and sends the discard at once.
  2. A launch claims s1, which is still `ready` because `retire` has not run, and creates its
     session.
  3. The launch reads the row as claimed and takes the workspace as its executor.
- **`claim-leaves-ready`**: `claim` locks the row but never sets `claimed`. It breaks
  `NoClaimableRowWithSession` in 9 steps: s1 is ready, a launch claims it, and creates session s1.
  The row is still `ready`, so it can be claimed again while a session holds its id.
- **`reused-id`**: a new standby may take the id of one that was drained. It breaks
  `NoClaimableRowWithSession` in 16 steps:
  1. A launch claims s1, adopts its workspace and deletes the row.
  2. The next provision reuses id s1.
  3. Row s1 is `ready` again while session s1 runs.

## Last full run

At `374094f416`, Standbys = {s1, s2}, Launches = {l1, l2}, on 32 cores:

| Row                            | Expected                             | Observed                             | Distinct states | Time |
| ------------------------------ | ------------------------------------ | ------------------------------------ | --------------: | ---: |
| `code-promise`                 | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         113,052 |   6s |
| `code-promise-atomic-retire`   | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         104,484 |   6s |
| `code-promise-no-sweep`        | holds                                | holds                                |         293,226 |   5s |
| `code-claimable`               | holds                                | holds                                |      18,300,697 | 116s |
| `fix-reread-session`           | holds                                | holds                                |      18,141,305 |  72s |
| `fix-setfailed-unless-claimed` | holds                                | holds                                |       4,163,265 |  19s |
| `mutant-retire-ignores-status` | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |          12,470 |   1s |
| `mutant-discard-before-retire` | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |           4,507 |   1s |
| `mutant-claim-leaves-ready`    | violated `NoClaimableRowWithSession` | violated `NoClaimableRowWithSession` |             188 |   0s |
| `mutant-reused-id`             | violated `NoClaimableRowWithSession` | violated `NoClaimableRowWithSession` |           9,424 |   2s |

The whole run took 3 min 48 s and exited 0.

Once, at the same commit, with three standbys and one launch (`Standbys = {s1, s2, s3}`,
`Launches = {l1}`, one-off configurations, not rows of `check.sh`):

| Base                           | Properties                                            | Observed | Distinct states | Time |
| ------------------------------ | ----------------------------------------------------- | -------- | --------------: | ---: |
| `code`                         | `NoClaimableRowWithSession`                           | holds    |       4,143,223 |  33s |
| `fix-reread-session`           | `NoDiscardOfSessionWork`, `NoClaimableRowWithSession` | holds    |       4,481,934 |  44s |
| `fix-setfailed-unless-claimed` | `NoDiscardOfSessionWork`, `NoClaimableRowWithSession` | holds    |       1,617,291 |  15s |
