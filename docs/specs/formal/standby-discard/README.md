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
[`.agents/skills/standby-discard/SKILL.md`](../../../../.agents/skills/standby-discard/SKILL.md).

## The finding, fixed (SLNT-823)

The model found one schedule on `origin/main` at `374094f416` in which a reconcile pass discarded
the workspace a launch had just claimed and was adopting. `drainHotWorkspace` now reads the session
again once `retire` has taken the row, and sends an ordinary stop when one exists (SLNT-823,
mend#PR_NUMBER, commit `aa029659e3`). Row `mutant-no-reread` keeps the drain as it was, and TLC
still breaks the promise there.

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
docs/specs/formal/standby-discard/check.sh mutant-no-reread | python3 -I docs/specs/formal/standby-discard/trace.py
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

- `NoDiscardOfSessionWork` (the promise): no discard is ever sent for a workspace that a session has
  taken as its executor (`acceptExecutor`) or laid its worktree down in (the replan). TLC checks it
  in every state, so a discard sent first and an adoption afterwards break it too. That is the "can
  still come to hold" half. On the code it holds; without the second session read
  (`mutant-no-reread`) it fails, which was the finding.
- `NoClaimableRowWithSession`, the reviewer's first property: a row is `ready` only while no session
  has its id, has taken its workspace, or holds work in it. On the code it holds (row
  `code-claimable`).
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

At `aa029659e3` (the SLNT-823 fix), Standbys = {s1, s2}, Launches = {l1, l2}, on 32 cores:

| Row                              | Expected                             | Observed                             | Distinct states | Time |
| -------------------------------- | ------------------------------------ | ------------------------------------ | --------------: | ---: |
| `code-promise`                   | holds                                | holds                                |      18,141,305 |  69s |
| `code-promise-atomic-retire`     | holds                                | holds                                |      13,959,504 |  55s |
| `code-claimable`                 | holds                                | holds                                |      18,141,305 |  74s |
| `mutant-no-reread`               | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         113,052 |   4s |
| `mutant-no-reread-atomic-retire` | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         104,484 |   4s |
| `mutant-no-reread-no-sweep`      | holds                                | holds                                |         293,226 |   3s |
| `mutant-reread-before-retire`    | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |         166,239 |   5s |
| `mutant-discard-before-retire`   | violated `NoDiscardOfSessionWork`    | violated `NoDiscardOfSessionWork`    |           4,509 |   1s |
| `mutant-claim-leaves-ready`      | violated `NoClaimableRowWithSession` | violated `NoClaimableRowWithSession` |             188 |   0s |
| `mutant-reused-id`               | violated `NoClaimableRowWithSession` | violated `NoClaimableRowWithSession` |           9,408 |   1s |

The whole run exited 0. The `mutant-no-reread` rows reach exactly the state counts the code rows
reached at `374094f416`, and `code-promise` reaches exactly the count the candidate row
`fix-reread-session` reached there: the mutant is the old code and the code is the fix the model
checked.

Once, at the same commit, with three standbys and one launch (`Standbys = {s1, s2, s3}`,
`Launches = {l1}`, a one-off configuration, not a row of `check.sh`): the code holds
`NoDiscardOfSessionWork` and `NoClaimableRowWithSession` over 4,481,934 distinct states, in 19s.
