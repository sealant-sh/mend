---
name: standby-discard
description:
  "Model-check, with TLA+, that Mend's standby discard (stopWorkspace with discardUnsaved) never
  reaches a workspace a session holds or can still take. Use when a change touches
  drainHotWorkspace, the hot pool (reconcileHotPoolOnce, hotPoolSweep, provisionHotWorkspace,
  changingBoatKey), claimHotSession, launchSession's adoption of a claimed standby, or
  HotWorkspacesRepo."
---

# Standby discard model

`docs/formal/standby-discard/` holds a TLA+ model of every actor that can reach
`drainHotWorkspace`'s `stopWorkspace(…, { discardUnsaved: true })`, checked by TLC across every
order of their steps. Its `README.md` explains the promise, the finding it made and how the code
fixed it (SLNT-823), the bounds and the Postgres behaviour it rests on. This skill is the procedure:
decide whether your change touches the model, run it, read what it says, and keep it true to the
code.

## 1. Decide whether the change touches the model

The model stands for the code in the coverage record below. Diff that code from the sync commit to
your tree:

```sh
git diff --stat aa029659e3 -- packages/db/src/repos/hot-workspaces.ts packages/sessions/src/engine.ts packages/sessions/src/capture-channel.ts
git diff aa029659e3 -- packages/sessions/src/engine.ts packages/db/src/repos/hot-workspaces.ts | grep -nE '^[-+].*(hotWorkspaces\.|drainHotWorkspace|reconcileHotPoolOnce|hotPoolSweep|provisionHotWorkspace|claimHotSession|claimedEntry|adoptClaimedWorkspace|acceptExecutor|replanClaimedStandby|changingBoatKey|leavingBoatAccounts|discardUnsaved|retire|setFailed|setReady|sessions\.create)'
```

`engine.ts` changes often. Read every hunk inside a function the record lists. The step is done when
you can name, for each such hunk, the model action it changes, or say why it changes none. If no
covered function changed, the model still describes the code and you are done.

## 2. Run the check

```sh
docs/formal/standby-discard/check.sh --quick   # while iterating: one launch, ~15 s
docs/formal/standby-discard/check.sh           # before handing off: full bounds, ~4 min on 32 cores
```

Each row prints `as expected` or `NOT AS EXPECTED`, and the script exits 0 only when every row is
`as expected`. The rows and their expected outcomes are the `ROWS` table in `check.sh`:

- `code-promise`, `code-promise-atomic-retire` and `code-claimable` are the code, expected to hold.
- `mutant-no-reread` is the drain as it was before SLNT-823, with no session read after `retire`. It
  is expected to be **violated**: the finding (README, "The finding, fixed"). Its `-atomic-retire`
  row is expected violated and its `-no-sweep` row to hold; together they say what the finding
  needed.
- The other `mutant-*` rows each break one check or one order of the code, and are expected to be
  violated. A mutant that holds means either the model lost the behaviour that break needs, or the
  code now catches that break another way. When the reread went in, `retire-ignores-status` started
  to hold (11,263,702 states at full bounds) and was replaced by `reread-before-retire`.

Done when the full run exits 0, or every `NOT AS EXPECTED` row is classified by step 3.

## 3. Classify a row that is not as expected

Print the row's trace one step per line:

```sh
docs/formal/standby-discard/check.sh <row> | python3 -I docs/formal/standby-discard/trace.py
```

Walk every step against the code its action names (the record below). A step is **real** when the
code can take it in that state: it is one SQL statement or one platform call there, the code's
guards allow it, and the value it acts on was read where and when the code reads it.

- **Every step real: a finding.** Tell the trace as numbered steps in Mend's words, with how often a
  person could meet that schedule, and report it. Keep the property and the model as they are, and
  leave product code to whoever owns the fix.
- **Some step the code cannot take: a modelling error.** Typical causes are a guard the code has and
  the action lacks, two statements merged into one action, a snapshot read at the wrong moment, or
  Postgres behaving otherwise than modelled (`postgres-read-committed.sh` reruns the observations).
  Fix the action, say in its comment which code it stands for, and rerun.
- **A mutant that holds.** Either the code changed so that break is caught some other way (pick a
  mutant that still matters and say why in `check.sh`), or the model lost behaviour (a modelling
  error).
- **`error`.** TLC did not finish: a parse error, `TypeOK` violated, or memory. Its output is
  printed above the row.

## 4. Update the model for an intended change

- Change the action that stands for the code you changed. One action is one statement or one
  platform call; a read whose value a later step uses is its own action. When the change fixes a
  break, keep the old behaviour as a mutant expected to fail, so the property is still shown to
  bite.
- A new caller of `drainHotWorkspace`, `claim`, `retire`, `setFailed`, `setReady` or `remove` is a
  new action (and a new drain slot for a new caller), added to `Next` and to the record below.
- Run the full check, update README's "Last full run" table, then move the sync commit.

## Coverage record

| Model action                                                       | Code it stands for                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DAdopt`                                                           | `drainHotWorkspace` (`packages/sessions/src/engine.ts`): `adoptedBefore = keepWorktree \|\| sessions.byId(entry.id)` and `retired = capture && entry.sealantWorkspaceId && !adoptedBefore && retire`                              |
| `DReread`                                                          | `drainHotWorkspace`: `adopted = adoptedBefore \|\| (retired && sessions.byId(entry.id))`, `discard = retired && !adopted` (SLNT-823)                                                                                              |
| `DRetireScan`, `DRetireApply`                                      | `HotWorkspacesRepo.retire` (`packages/db/src/repos/hot-workspaces.ts`)                                                                                                                                                            |
| `DStop`                                                            | `drainHotWorkspace`: `sealant.getWorkspace` then `sealant.stopWorkspace(workspace, discard ? { discardUnsaved: true } : undefined)`                                                                                               |
| `DNotEnded`                                                        | `drainHotWorkspace`'s `if (!ended)` branch: `hotWorkspaces.setFailed` (`HotWorkspacesRepo.setFailed`, no status condition)                                                                                                        |
| `DEnded`                                                           | `drainHotWorkspace`'s end: tokens, socket, `hotWorkspaces.remove`                                                                                                                                                                 |
| `RStart`, `RSkip`, `RDrain`, `RDrainDone`, `RListDone`, `RPassEnd` | `reconcileHotPoolOnce` (`listForProject`, the entries loop, the survivors' probe), serialized per project by `scheduleHotReconcile`; `changingBoatKey`'s drain reaches it through `settledHotReconcile` and `leavingBoatAccounts` |
| `RProvCreate`, `RProvReady`, `RProvFailed`                         | `provisionHotWorkspace`: `hotWorkspaces.create`, `setReady`, `setFailed`; `HotWorkspacesRepo.create`, `setReady`, `setFailed`                                                                                                     |
| `WStart`, `WCheck`, `WDrainDone`, `WEnd`                           | `hotPoolSweep` (forked at boot after `resume()`, repeated every 10 minutes)                                                                                                                                                       |
| `CScan`, `CTake`, `CNone`                                          | `HotWorkspacesRepo.claim`, called by `claimHotSession`                                                                                                                                                                            |
| `CCaptureOk`, `CCaptureFail`, `CDrainDone`                         | `claimHotSession`: `ensureCaptureZero` and `capture.repo.claim`; a refusal drains the entry                                                                                                                                       |
| `CCreate`                                                          | `claimHotSession`: `requestHotReconcile`, then `sessions.create({ id: entry.id, … })`                                                                                                                                             |
| `AById`                                                            | `launchSession`: `claimedEntry = hotWorkspaces.byId(sessionId)`, adopted only when `status === "claimed"`                                                                                                                         |
| `ADrop`, `ADropDone`                                               | `launchSession`: the `refuseWorkspaceRepositories` refusal, `adoptClaimedWorkspace`'s `unusable()`, and the `standbyMismatch` drain, each `drainHotWorkspace(…, { keepWorktree: true })`                                          |
| `AAccept`                                                          | `launchSession`: `acceptExecutor(provisioned.workspace, standbyLaunch)`                                                                                                                                                           |
| `ARemove`                                                          | `launchSession`: `hotWorkspaces.remove(claimedEntry.id)` before `replanClaimedStandby`                                                                                                                                            |
| `AReplan`                                                          | `replanClaimedStandby`                                                                                                                                                                                                            |
| `Settle`, `Resume`, `Restart`                                      | `settleSession`; a person's resume or wake running `launchSession`; a process restart (`resume()`, then the boot sweep)                                                                                                           |
| (relied on, not modelled)                                          | `standbyApiFor` and `captureApiFor` (`packages/sessions/src/capture-channel.ts`, `engine.ts`): a workspace with no session under its id uploads nothing, which is why discarding an unclaimed standby loses nothing               |

**Sync commit: `aa029659e3`** (2026-11-13), the SLNT-823 fix on the branch of mend#1628, on top of
`origin/main` at `a37a2600f0`. Once that pull request merges, its squash commit on `main` stands for
it: use that commit in step 1, or fetch this one with `git fetch origin pull/1628/head`. Between
`374094f416` and `a37a2600f0` the covered code changed only in ways no action models:
`reconcileHotPoolOnce` finds each owner's Boat key with `boatKeys.launchKey` and drains a person's
own key's standbys (SLNT-797), which `RDrain` already covers, and `setReady` stamps the standby's
`boatKey`. The model was last confirmed to describe the recorded code at this commit. Move it
forward only after step 1 finds every change to that code since it accounted for in the model, and a
full `check.sh` run ends with every row as expected.

## Running it in CI (not set up)

GitHub-hosted `ubuntu-latest` runners have Java, and `check.sh` downloads tla2tools 1.7.4 and checks
its sha256 when Nix is absent. A job filtered on the files in the coverage record could run
`check.sh --quick` on each pull request and the full run nightly.
