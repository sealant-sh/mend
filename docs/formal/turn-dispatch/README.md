# Turn dispatch: a TLA+ model

A message sent to a protocol-mode Codex session becomes an agent turn: queued, claimed by the
protocol host's dispatcher, written to Codex as `turn/start`, then bound to the provider turn Codex
names and ended by Codex's `turn/completed`. Several writers move the same row: the person's send,
the dispatcher, Codex's notifications, a Stop on one message, the session's Stop, a retry with the
same launch correlation id, and recovery after a Mend restart. This directory holds a TLA+ model of
all of them, and TLC checks every order of their steps within the bounds below.

The agent-facing instructions (when to run it, how to update it, which code each step stands for,
the commit it was last confirmed at) are the project skill
[`.agents/skills/turn-dispatch/SKILL.md`](../../../.agents/skills/turn-dispatch/SKILL.md).

## The promises

| Invariant              | In plain words                                                                                                                                    | The harm when it breaks                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `AtMostOnce`           | Codex takes a message's input at most once.                                                                                                       | The agent does the work twice: two commits, two pushes, two replies. |
| `StoppedNeverStarts`   | Once a Stop has found a message queued, the message is never written to Codex. Nothing is written once the session's Stop has closed the adapter. | The agent acts on a message the person stopped.                      |
| `CompletedOnlyIfTaken` | A message reads completed only if Codex took it. A rejected or lost message never reads completed.                                                | The person reads "completed" for words the agent never saw.          |

The code and its tests claim all three: the dispatcher puts a turn back only when it is certain
nothing was written; a Stop cancels a queued turn; and the tests "never completes a rejected message
with another turn's end seen during the send" and "fails a message Codex rejected while a turn of
its own started during the send" (`packages/sessions/test/protocol-host.test.ts`) pin the third.

## What the model found

All three break on `main` at `163a84a967`. None is fixed here. Each is pinned in `check.sh` as a row
expected to be violated. Each property also has a row where it holds, with the schedule it needs
taken away or with the fix its ticket suggests, and a mutant row that shows the property can fail.

### `StoppedNeverStarts`: a Stop on a queued message can be lost (SLNT-1021)

1. A message is queued.
2. The person stops it. `interruptTurn` reads the row: `queued`.
3. The dispatcher's `claimNextTurn` takes it: `running`.
4. Stop's `cancelOpenForTurn` runs `… WHERE status = 'queued'`, which matches nothing, and returns.
5. The dispatcher writes `turn/start`. The agent works on the stopped message, and nothing
   interrupts it.

The window is one database round trip, and it opens whenever the turn before ends just as the person
stops the next. Row `fix-sketch-atomic-stop`, where the read and the cancel are one step, holds.

### `CompletedOnlyIfTaken`: a message can take the end of a turn Codex started itself (SLNT-466)

Row `code-timeout-slnt-466` is the schedule SLNT-466 names. It allows no restart and no retry.

1. The dispatcher claims the message and writes `turn/start`. The adapter's `sendInFlight` is true.
2. Codex starts a turn of its own (a goal continuing, its queue, the mailbox). Because a send is
   out, the adapter publishes its `turn/started` as `turn.started`. The host binds it to the message
   (`bindOwnSend`, the provisional bind).
3. Codex never answers `turn/start` within 60 s. The send fails _uncertain_, and `dispatchOne` takes
   the provisional bind as proof the message was written (`finishSend(started)`).
4. Codex's own turn ends. `completeTurn` matches the message by that id, and the message reads
   completed though Codex never took it. The request may still be waiting in Codex's stdin.

The model also finds a wider window than the ticket states, through the same bind:

- Codex can start its own turn _just before_ the write. Its `turn/started` is read after it, while
  `sendInFlight` is true.
- After a Mend restart, a bound turn stays running and the replayed output ends it
  (`code-completed-only-if-taken`'s shortest trace).
- An adapter made by `rehydrate` reports every turn as `turn.started` (`ownTurn` needs
  `rehydrate === undefined`). So any turn Codex starts on its own that is read while a dispatch is
  Writing binds to the message, even with no send in flight.
- The other turn need not be Codex's own. An earlier message whose send timed out with nothing bound
  fails "unconfirmed", and the next message is sent. If Codex then takes the earlier message late,
  its `turn/started` binds to the next message, which reads completed with the earlier message's
  turn.

Row `code-no-other-turn-seen-in-send` takes away every such read (while a dispatch is Writing, no
`turn/started` is read except the one for its own message) and holds. Row `fix-sketch-slnt-466` is
the ticket's fix (only Codex's answer binds, and an uncertain send fails) and holds.

### `AtMostOnce`: a retry after a restart can resend a message Codex took (SLNT-1022)

1. A review follow-up queues its turn under `follow-up:<id>`. The dispatcher writes `turn/start`.
   Codex takes it.
2. Mend restarts before it reads Codex's answer. `rehydrate` fails the turn "unconfirmed", because
   it is running with no provider turn id. The follow-up's delivery lease runs out: "Retry with the
   same key."
3. The retry calls `submitTurn` with the same correlation id. It requeues a failed turn with no
   provider turn id, and the dispatcher sends the message to Codex again.

Without the retry (`code-at-most-once-no-retry`) the property holds: the dispatcher puts a turn back
only when the send was certainly not written.

## Run it

```sh
docs/formal/turn-dispatch/check.sh                # every row, full bounds (two messages)
docs/formal/turn-dispatch/check.sh --quick        # one message: seconds; what pull requests run
docs/formal/turn-dispatch/check.sh <row>          # one row with the checker's whole output and trace
docs/formal/turn-dispatch/check.sh --engine tlx   # any of these with tlx, about ten times faster
docs/formal/turn-dispatch/check.sh <row> | python3 -I docs/formal/standby-discard/trace.py   # a trace, one step per line
```

`check.sh` works as the standby-discard one does, and the same TLC (tla2tools 1.7.4, pinned by
sha256) and tlx notes apply: see [`../standby-discard/README.md`](../standby-discard/README.md),
"Run it" and "TLC and tlx". A run exits 0 only when every row ends with the verdict and the
distinct-state count `ROWS` pins. A row expected to hold uses every core; `MEND_FORMAL_WORKERS` caps
that on a shared machine.

### Last full run

TLC (tla2tools 1.7.4) at `163a84a967`, 4 workers, 2026-11-15. Every row was as expected. The full
bounds took about 4½ minutes, the largest row being `fix-sketch-slnt-466` (24,417,284 distinct
states, 99 s). `--quick` took about 20 seconds. tlx reached the same verdict and the same count on
every row.

## The rows

| Row                               | Breaks or restricts                                       | Expected                        |
| --------------------------------- | --------------------------------------------------------- | ------------------------------- |
| `code-at-most-once`               | the code                                                  | violated (SLNT-1022)            |
| `code-at-most-once-no-retry`      | no retry                                                  | holds                           |
| `mutant-putback-uncertain`        | an uncertain send is put back instead of failed; no retry | violated                        |
| `code-stopped-never-starts`       | the code                                                  | violated (SLNT-1021)            |
| `fix-sketch-atomic-stop`          | Stop's read and cancel are one statement                  | holds                           |
| `mutant-write-after-close`        | that, and `sendTurn` writes after `close()`               | violated                        |
| `code-completed-only-if-taken`    | the code                                                  | violated (SLNT-466)             |
| `code-timeout-slnt-466`           | no restart, no retry: the ticket's schedule               | violated (SLNT-466)             |
| `code-no-other-turn-seen-in-send` | no other turn's `turn/started` read while Writing         | holds                           |
| `fix-sketch-slnt-466`             | only Codex's answer binds; an uncertain send fails        | holds                           |
| `mutant-end-to-claim`             | an end that matches no row is applied to the claim        | violated, under the restriction |

When one of the findings is fixed, its `code-*` row should start to hold. Change its expected
outcome and count in `ROWS` in the same pull request as the fix.

## What the model is

**Steps.** One action is one SQL statement, one write to Codex's stdin, or one message Codex prints,
as the code awaits them. Every repo statement the dispatcher uses is one transaction under the
process's advisory lock, so it is one step. The comments in `TurnDispatch.tla` name the code for
each action, and the skill's coverage record maps them.

**Actors:**

- the person's send;
- the dispatcher, which runs `dispatchOne` under the process's dispatch permit, so one at a time;
- the host reading Codex's output in order;
- Codex: it takes, refuses or never answers a `turn/start`, starts turns of its own, and ends turns
  by itself or on `turn/interrupt`;
- a Stop on one message;
- the session's Stop;
- a retry with the same correlation id;
- a Mend restart with Codex's pipe surviving.

**Bounds.** Full: two messages (`Turns = {t1, t2}`) and one turn of Codex's own. Each behaviour has
at most one message's Stop, one retry, one restart and one session Stop. Every order of the steps is
explored, with symmetry over the messages. `--quick` uses one message.

**Assumptions**, each either matching the code or only adding behaviours:

- Codex takes a `turn/start` only while it runs no turn. It can refuse one or leave it unanswered at
  any time. The 60 s timeout can fire at any moment while the answer is out, and an answer that
  arrives after it is dropped.
- A Mend restart forgets the dispatch, its held ends and any Stop in flight. `rehydrate` fails
  running turns with no provider turn id before anything is dispatched. Dispatch waits until the
  output Codex printed before the restart has been read (`entry.gate`). The new adapter knows
  Codex's current turn from the replay.
- The claim takes any queued message. The code takes the lowest ordinal; ordering is not part of any
  property here.

**Left out:**

- the rows of turns Codex opens by itself (`openHarnessTurn`, parking); the model keeps only their
  effect on Codex being busy;
- shared steering's hand-over (`stopping`, `failWaiting`);
- the history-rollback fence;
- Claude;
- several processes per session, and the relaunch requeue to a new process;
- a defect mid-dispatch (`leaveNothingStuck`);
- the budget-refusal retry, which comes before anything is written.

`engine.ts` holds the session Stop's order (`detach`, then `cancelOpenForProcess`) and the callers
of the correlation requeue. It is not in `COVERAGE`, because nearly every pull request changes it;
the skill names the functions to recheck.

## Files

| File                 | What it is                                                        |
| -------------------- | ----------------------------------------------------------------- |
| `TurnDispatch.tla`   | The model: state, one action per code step, the three properties. |
| `MCTurnDispatch.tla` | The model plus the restrictions the diagnostic rows use.          |
| `check.sh`           | The runner, and the rows with their expected outcomes and counts. |
| `COVERAGE`           | The covered code and the sync commit `verify formal` guards.      |
