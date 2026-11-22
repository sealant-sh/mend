---
name: turn-dispatch
description:
  "Model-check, with TLA+, that a protocol-mode turn reaches Codex at most once, never starts once
  stopped, and reads completed only if Codex took it. Use when a change touches the protocol host's
  dispatch (dispatchOne, finishSend, settleCompletion, the turn.started bind, interruptTurn,
  rehydrate), AgentConversationRepo's turn writes (claimNextTurn, bindOwnSend, putBackOwn, failOwn,
  completeTurn, cancel*, failUnconfirmedTurn, submitTurn's correlation requeue), or the Codex
  adapter's sendTurn, turn notifications or interrupt."
---

# Turn dispatch model

`docs/formal/turn-dispatch/` holds a TLA+ model of every writer of an agent turn's status and
provider turn id, checked by tlx across every order of their steps. Its `README.md` states the three
promises, what the model found (SLNT-466, SLNT-1021, SLNT-1022), the bounds and what is left out.
This skill is the procedure: decide whether your change touches the model, run it, read what it
says, and keep it true to the code.

## 1. Decide whether the change touches the model

Diff the covered code from the sync commit to your tree:

```sh
git diff --stat 5e97ae3e2e -- packages/sessions/src/protocol-host.ts packages/db/src/repos/agent-conversation.ts packages/agent-protocol/src/codex.ts packages/agent-protocol/src/antigravity.ts
git diff 5e97ae3e2e -- packages/sessions/src/protocol-host.ts packages/db/src/repos/agent-conversation.ts packages/agent-protocol/src/codex.ts packages/agent-protocol/src/antigravity.ts | grep -nE '^[-+].*(claimNextTurn|bindOwnSend|putBackOwn|failOwn|releaseOwn|completeTurn|failTurn|failUnconfirmedTurn|cancelOpenFor|withdrawUntakenTurn|requeueQueuedTurns|takeWaitingTurns|endWaitingTurns|queueOpeningTurn|launchCorrelationId|dispatchOne|finishSend|settleCompletion|applyCompletion|turn\.started|interruptTurn|rehydrate|sendInFlight|currentTurnId|ownTurn|turn/start|turn/interrupt|certainty|detach)'
```

Then check `packages/sessions/src/engine.ts` by name, since it is not in `COVERAGE`. Look for a
change to the session Stop's order (`protocolHost.detach`, then
`conversations.cancelOpenForProcess`) or to a caller of `submitTurn` with a correlation id
(`launchFollowUp`, the opening prompt), to `launchProtocol`'s opening turn (`queueOpeningTurn`), and
to the waiting turns' ends (`stop`, `endWaitingOfSettled`, the terminal `launch`).

Done when you can name, for each hunk inside a function the coverage record lists, the model action
it changes, or say why it changes none.

## 2. Run the check

```sh
docs/formal/turn-dispatch/check.sh --quick                # one message, seconds: what pull requests run
docs/formal/turn-dispatch/check.sh                        # full bounds (two messages), before handing off
MEND_FORMAL_WORKERS=4 docs/formal/turn-dispatch/check.sh  # the same on a shared machine
```

The full bounds take about a minute on 4 cores. Pull requests run only `--quick`; the nightly run
checks the full bounds on CI's four cores within this model's `budget-full` (`COVERAGE`), and a
dispatched CI run with `formal: full` does the same on a branch. When a change grows the full count,
write the new count and the full run's time on the ticket before it merges.

The checker is tlx, built at the commit `docs/formal/tlx.sh` pins, as in the standby-discard skill;
`--engine tlc` runs the same rows with TLC for a cross-check by hand. Each row prints `as expected`
or `NOT AS EXPECTED`, and the script exits 0 only when every row's verdict and distinct-state count
match `ROWS` in `check.sh`.

The rows:

- `code-*` rows are the code. Three are expected to be **violated**, and each is a ticketed finding
  (README, "What the model found"): `code-at-most-once` (SLNT-1022), `code-stopped-never-starts`
  (SLNT-1021), and `code-completed-only-if-taken` with `code-timeout-slnt-466` (SLNT-466).
- `code-at-most-once-no-retry` and `code-no-other-turn-seen-in-send` take one schedule away with an
  action constraint from `MCTurnDispatch.tla`, and hold.
- `fix-sketch-*` rows change the code the way the ticket suggests, and hold.
- `mutant-*` rows each break one check or one order of the code, and are expected to be violated.
- `start-*` rows (SLNT-1237) start the conversation with no process hosted (`Starts = TRUE`), so a
  message waits on the server; they and `mutant-no-own-take` / `mutant-attach-no-take` check
  `NeverStranded`.

Done when the full run exits 0, or every `NOT AS EXPECTED` row is classified by step 3.

## 3. Classify a row that is not as expected

Print the row's trace one step per line:

```sh
docs/formal/turn-dispatch/check.sh <row> | python3 -I docs/formal/standby-discard/trace.py
```

Walk every step against the code its action names (the record below). A step is **real** when the
code can take it in that state: one SQL statement or one stdin write or one printed message there,
the code's guards allow it, and the value it acts on was read where and when the code reads it.

- **Every step real: a finding.** Tell the trace as numbered steps in Mend's words, with how often a
  person could meet that schedule. File it (project "CI follow-ups", label `mend`). Keep the
  property and the model as they are, and leave the product fix to its own ticket.
- **Some step the code cannot take: a modelling error.** Fix the action, say in its comment which
  code it stands for, and rerun. Building this model, a restart that let dispatch run before the
  replay reached its high water was one (`replay` now gates `DClaim`, as `entry.gate` does).
- **A `code-*` row expected violated that now holds.** The finding was fixed. Confirm the fix is in
  the diff, move the row to `holds` with the count the checker reached, and say so on its ticket.
- **A mutant that holds.** Either the code now catches that break another way (pick a mutant that
  still bites and say why in `check.sh`), or the model lost the behaviour.
- **`error`.** The checker did not finish: a parse error, `TypeOK` violated, or memory. Its output
  is printed above the row.

## 4. Update the model for an intended change

- Change the action that stands for the code you changed. One action is one statement, one stdin
  write or one printed message; a read whose value a later step uses is its own action.
- A new writer of `status` or `provider_turn_id` is a new action, added to `Next` and to the record
  below.
- Run the full check, update the counts in `ROWS` (full and `--quick`), then move the sync line in
  `COVERAGE` and the commit in step 1 to the commit you checked.

## Coverage record

| Model action                         | Code it stands for                                                                                                                                                                                                                                                           |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Submit`                             | `AgentConversationRepo.submitTurn`, new row; refused by `lockOpenConversation` once the conversation is stopped                                                                                                                                                              |
| `WRead`, `WAdmit`, `WTake`           | `ProtocolHost.sendTurnMessage` with `starting` (the engine's `conversationStartsFor`): no hosted process read, then `admitTurnMessage(input, null)` under `readsStarting`, then `waitForStart`'s hand-over (`takeWaitingTurns`, dispatch)                                    |
| `Attach`, `ATake`                    | `attachInternal`: `hosted.set`, then `takeWaitingTurns` before anything dispatches                                                                                                                                                                                           |
| `LaunchFails`                        | a launch that fails before its process is hosted: the settle ends waiting turns `failed` (`endWaitingOfSettled`, the API's `settleUnlaunched`)                                                                                                                               |
| `StopAsk`, `Settle`                  | the session Stop's entry (`endWaitingTurns` cancelled) and its settle (`endWaitingOfSettled`)                                                                                                                                                                                |
| `Retry`                              | `submitTurn` with an existing `launchCorrelationId`: requeues a failed or cancelled row with no provider turn id (callers: `launchFollowUp`, the opening prompt)                                                                                                             |
| `DClaim`                             | `dispatchNext`'s `entry.gate`, then `dispatchOne`: `claimNextTurn` (no running turn on the process, a queued one becomes running with the attempt)                                                                                                                           |
| `DCheck`                             | `dispatchOne`: `hosted.get(…) !== entry \|\| entry.stopping` puts back, else the `Writing` phase                                                                                                                                                                             |
| `DWrite`                             | `CodexAdapter.sendTurn`: not-written once closed, else `sendInFlight = true` and the `turn/start` call                                                                                                                                                                       |
| `DWrite` (Antigravity)               | `AntigravityAdapter.sendTurn`: not-written once closed, with a turn open, or when a `session/set_config_option` before it fails; else the `session/prompt` write, `uncertain` when the write fails; its answer is the turn's end (`turn.completed`), so it has no `DTimeout` |
| `DTimeout`                           | the call's 60 s timeout, output ended or close: `AgentTurnDeliveryError` with certainty `uncertain`                                                                                                                                                                          |
| `DSettle`, `FinishBind`, `DApply`    | `dispatchOne`'s outcome branches; `finishSend` (`bindOwnSend` with `replacing`, `adapter.interrupt()` when nothing bound, then the held own ends)                                                                                                                            |
| `DEnd`                               | `dispatchOne`'s `Effect.ensuring`: phase `Idle`, attempt out of `liveAttempts`                                                                                                                                                                                               |
| `Release`                            | `putBackOwn` / `failOwn` (`releaseOwn`: `heldBy`, `status = 'running'`, `unsentOrBoundTo(bound)`, providerTurnId cleared)                                                                                                                                                    |
| `Bindable`                           | `bindOwnSend`'s WHERE                                                                                                                                                                                                                                                        |
| `CompleteTurn`                       | `completeTurn` (WHERE provider turn id only), from `applyCompletion`                                                                                                                                                                                                         |
| `Read`                               | the Codex adapter's `handleNotification` (`turn/started`'s `ownTurn`, `turn/completed`) and call answers; the host's `turn.started` bind and `settleCompletion`                                                                                                              |
| `CAccept`, `CReject`, `COwn`, `CEnd` | Codex app-server: takes, refuses or ignores `turn/start`; starts its own turn; ends a turn, or on `turn/interrupt`                                                                                                                                                           |
| `SRead`, `SAct`                      | `ProtocolHost.interruptTurn`: `byTurnId`, then `cancelOpenForTurn` (WHERE status = 'queued') or `adapter.interrupt()`                                                                                                                                                        |
| `StopDetach`, `StopCancel`           | the session Stop in `engine.ts`: `protocolHost.detach`, then `conversations.cancelOpenForProcess` (the process's own rows)                                                                                                                                                   |
| `Restart`                            | a Mend restart; `ProtocolHost.rehydrate` (`failUnconfirmedTurn` on running turns with no provider turn id) and the adapter's `options.rehydrate`                                                                                                                             |

**Sync commit: `5e97ae3e2e`** (2026-11-21, SLNT-1237: the start and its waiting turns; full tlx run
at its first commit, `4681d853dc`, every row as expected). Before it `6c5c39774e` (2026-11-16,
SLNT-895). Written at `163a84a967` for SLNT-1017. The model was confirmed to describe the recorded
code at this commit by a full TLC run. Move it forward only after step 1 finds every change to that
code since then accounted for in the model, and a full `check.sh` run ends with every row as
expected. The sync line in `COVERAGE` is where it moves.

## In CI and `verify formal`

`docs/formal/turn-dispatch/COVERAGE` is what CI reads. `pnpm verify formal` runs `check.sh --quick`
when your diff touches a covered file or the model (`--full` for the full bounds), and reports
drift. CI's `formal` job does the same on each pull request, with the guard: a change to covered
code fails unless the same pull request changes the model or moves `COVERAGE`'s `sync` line. The
nightly run checks the full bounds.
