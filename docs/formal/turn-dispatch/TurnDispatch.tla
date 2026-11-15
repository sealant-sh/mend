---------------------------- MODULE TurnDispatch ----------------------------
(***************************************************************************)
(* Protocol-mode turn dispatch to Codex: every writer of a turn's status   *)
(* and provider turn id, checked across every order of their steps.        *)
(* README.md beside this file says what it promises and what it leaves     *)
(* out; .agents/skills/turn-dispatch maps each action to its code.         *)
(*                                                                         *)
(* One action is one SQL statement, one write to Codex's stdin, or one     *)
(* message Codex prints, as the code awaits them.                          *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
  Turns,     \* the person's messages, as agent turns of one process
  OwnTurns,  \* turns Codex starts on its own (a goal, its queue, the mailbox)
  NoId,      \* no provider turn id, no turn
  Mutants    \* a set of names: each breaks one check or order of the code (check.sh)

\* Codex names each turn it runs: a message's n-th take, or one of its own.
Ids == (Turns \cup OwnTurns) \X {1, 2}
Statuses == {"none", "queued", "running", "completed", "interrupted", "failed", "cancelled"}
Ended == {"completed", "interrupted"}
Msgs == [k: {"started"}, t: {NoId}, id: Ids, st: {"none"}]
          \cup [k: {"completed"}, t: {NoId}, id: Ids, st: Ended]
          \cup [k: {"answer"}, t: Turns, id: Ids \cup {NoId}, st: {"ok", "rejected"}]

VARIABLES
  \* agent_turns, per message
  status,     \* status
  ptid,       \* provider_turn_id
  holder,     \* dispatch_attempt_id: "cur" is the live dispatch's own attempt, "old" any other
  \* the dispatcher (dispatchOne under the process's dispatch permit) and its DispatchPhase
  pc,         \* idle | claimed | ready (Writing, before the write) | out | result | applying | end
  dt,         \* the turn it claimed
  started,    \* send.started: the first turn.started seen while Writing
  held,       \* send.held: ends that waited for the answer
  result,     \* none | ok | rejected | uncertain | notwritten
  resId,      \* the id Codex answered with
  toApply,    \* finishSend's own held ends, applied one completeTurn at a time
  \* the host and its Codex adapter
  live,       \* hosted.get(process) is this entry
  closed,     \* adapter.close() ran: nothing more is written
  inFlight,   \* the adapter's sendInFlight
  pending,    \* the turn whose turn/start call waits for its answer
  acur,       \* the adapter's currentTurnId
  rehydrated, \* the adapter was made by rehydrate (options.rehydrate, for its whole life)
  replay,     \* messages a rehydrate replay must read before dispatch (entry.gate, high water)
  \* Codex
  creq,       \* turn/start requests in Codex's stdin, in order
  ccur,       \* the turn Codex runs
  ownUsed,    \* own turns Codex has started
  intr,       \* turn/interrupt requests Codex has not acted on
  out,        \* Codex's stdout: notifications and answers, in order
  \* Stop, a retry, a restart
  sp,         \* interruptTurn per message: idle | q (read queued) | r (read running) | done
  ss,         \* session Stop: no | detached | done
  restarted,
  retried,
  \* ghosts: what the invariants read
  accepts,    \* how many times Codex took the message's input
  stopSaw,    \* a Stop read the message queued (cleared by a retry's requeue)
  badWrite    \* a message was written after a Stop saw it queued, or after the adapter closed

vars == <<status, ptid, holder, pc, dt, started, held, result, resId, toApply, live, closed,
          inFlight, pending, acur, rehydrated, replay, creq, ccur, ownUsed, intr, out, sp, ss, restarted, retried,
          accepts, stopSaw, badWrite>>
turnVars == <<status, ptid, holder>>
dispVars == <<pc, dt, started, held, result, resId, toApply>>
hostVars == <<live, closed, inFlight, pending, acur, rehydrated, replay>>
codexVars == <<creq, ccur, ownUsed, intr, out>>
otherVars == <<sp, ss, restarted, retried>>
ghostVars == <<accepts, stopSaw, badWrite>>

M(m) == m \in Mutants

TypeOK ==
  /\ status \in [Turns -> Statuses]
  /\ ptid \in [Turns -> Ids \cup {NoId}]
  /\ holder \in [Turns -> {"none", "cur", "old"}]
  /\ pc \in {"idle", "claimed", "ready", "out", "result", "applying", "end"}
  /\ dt \in Turns \cup {NoId}
  /\ started \in Ids \cup {NoId}
  /\ held \subseteq [id: Ids, st: Ended]
  /\ result \in {"none", "ok", "rejected", "uncertain", "notwritten"}
  /\ resId \in Ids \cup {NoId}
  /\ toApply \subseteq [id: Ids, st: Ended]
  /\ live \in BOOLEAN /\ closed \in BOOLEAN /\ inFlight \in BOOLEAN
  /\ pending \in Turns \cup {NoId}
  /\ acur \in Ids \cup {NoId}
  /\ rehydrated \in BOOLEAN /\ replay \in Nat
  /\ creq \in Seq(Turns)
  /\ ccur \in Ids \cup {NoId}
  /\ ownUsed \subseteq OwnTurns
  /\ intr \subseteq Ids
  /\ out \in Seq(Msgs)
  /\ sp \in [Turns -> {"idle", "q", "r", "done"}]
  /\ ss \in {"no", "detached", "done"}
  /\ restarted \in BOOLEAN /\ retried \in [Turns -> BOOLEAN]
  /\ accepts \in [Turns -> 0..2] /\ stopSaw \in [Turns -> BOOLEAN] /\ badWrite \in BOOLEAN

Init ==
  /\ status = [t \in Turns |-> "none"]
  /\ ptid = [t \in Turns |-> NoId]
  /\ holder = [t \in Turns |-> "none"]
  /\ pc = "idle" /\ dt = NoId /\ started = NoId /\ held = {} /\ result = "none"
  /\ resId = NoId /\ toApply = {}
  /\ live = TRUE /\ closed = FALSE /\ inFlight = FALSE /\ pending = NoId /\ acur = NoId
  /\ rehydrated = FALSE /\ replay = 0
  /\ creq = <<>> /\ ccur = NoId /\ ownUsed = {} /\ intr = {} /\ out = <<>>
  /\ sp = [t \in Turns |-> "idle"] /\ ss = "no" /\ restarted = FALSE
  /\ retried = [t \in Turns |-> FALSE]
  /\ accepts = [t \in Turns |-> 0] /\ stopSaw = [t \in Turns |-> FALSE] /\ badWrite = FALSE

-----------------------------------------------------------------------------
(* The repo's statements.                                                  *)

\* releaseOwn's WHERE: heldBy(claim), status = 'running', unsentOrBoundTo(bound).
Releasable(t, bound) ==
  /\ holder[t] = "cur" /\ status[t] = "running"
  /\ (ptid[t] = NoId \/ (bound /= NoId /\ ptid[t] = bound))

\* putBackOwn / failOwn: one compare-and-set; providerTurnId is cleared either way.
Release(st, bound) ==
  IF Releasable(dt, bound)
    THEN /\ status' = [status EXCEPT ![dt] = st]
         /\ ptid' = [ptid EXCEPT ![dt] = NoId]
    ELSE UNCHANGED <<status, ptid>>

\* bindOwnSend's WHERE: heldBy(claim) AND (providerTurnId = id
\*   OR (status = 'running' AND unsentOrBoundTo(replacing))). No status check on the first branch.
Bindable(t, id, replacing) ==
  /\ holder[t] = "cur"
  /\ \/ ptid[t] = id
     \/ /\ status[t] = "running"
        /\ (ptid[t] = NoId \/ (replacing /= NoId /\ ptid[t] = replacing))

\* completeTurn: WHERE providerTurnId = id. No status condition.
Matches(id) == \E u \in Turns : ptid[u] = id
CompleteTurn(id, st) == status' = [u \in Turns |-> IF ptid[u] = id THEN st ELSE status[u]]

Writing == pc \in {"ready", "out", "result"}

-----------------------------------------------------------------------------
(* The person's send: submitTurn, refused once the conversation is stopped *)
(* (lockOpenConversation).                                                 *)
Submit(t) ==
  /\ status[t] = "none" /\ ss = "no"
  /\ status' = [status EXCEPT ![t] = "queued"]
  /\ UNCHANGED <<ptid, holder, dispVars, hostVars, codexVars, otherVars, ghostVars>>

(* A retry: submitTurn again with the same launchCorrelationId requeues a  *)
(* failed or cancelled row with no provider turn id (same process).        *)
Retry(t) ==
  /\ \A u \in Turns : ~retried[u]   \* bound: one retry per behaviour
  /\ ss = "no"
  /\ ptid[t] = NoId /\ status[t] \in {"failed", "cancelled"}
  /\ status' = [status EXCEPT ![t] = "queued"]
  /\ retried' = [retried EXCEPT ![t] = TRUE]
  /\ sp' = [sp EXCEPT ![t] = "idle"]
  /\ stopSaw' = [stopSaw EXCEPT ![t] = FALSE]
  /\ UNCHANGED <<ptid, holder, dispVars, hostVars, codexVars, ss, restarted, accepts, badWrite>>

-----------------------------------------------------------------------------
(* The dispatcher: dispatchOne.                                            *)

\* claimNextTurn: no running turn on the process, then a queued one becomes running.
DClaim ==
  /\ pc = "idle" /\ live
  /\ replay = 0   \* dispatchNext awaits entry.gate: the replay reached its high water
  /\ ~\E u \in Turns : status[u] = "running"
  /\ \E t \in Turns :
       /\ status[t] = "queued"
       /\ status' = [status EXCEPT ![t] = "running"]
       /\ holder' = [holder EXCEPT ![t] = "cur"]
       /\ pc' = "claimed" /\ dt' = t
  /\ UNCHANGED <<ptid, started, held, result, resId, toApply, hostVars, codexVars, otherVars,
                 ghostVars>>

\* "A stop that began meanwhile puts back what was claimed": the host check, then Writing.
DCheck ==
  /\ pc = "claimed"
  /\ IF live
       THEN pc' = "ready" /\ UNCHANGED <<status, ptid>>
       ELSE Release("queued", NoId) /\ pc' = "end"
  /\ UNCHANGED <<holder, dt, started, held, result, resId, toApply, hostVars, codexVars,
                 otherVars, ghostVars>>

\* adapter.sendTurn: nothing is written once the adapter closed (not-written); else turn/start.
DWrite ==
  /\ pc = "ready"
  /\ IF closed /\ ~M("write-after-close")
       THEN /\ result' = "notwritten" /\ pc' = "result"
            /\ UNCHANGED <<creq, inFlight, pending, badWrite>>
       ELSE /\ creq' = Append(creq, dt)
            /\ inFlight' = TRUE /\ pending' = dt /\ pc' = "out"
            /\ badWrite' = (badWrite \/ closed \/ stopSaw[dt])
            /\ UNCHANGED result
  /\ UNCHANGED <<turnVars, dt, started, held, resId, toApply, live, closed, acur, rehydrated, replay,
                 ccur, ownUsed, intr, out, otherVars, accepts, stopSaw>>

\* The call fails uncertain: no answer within 60 s, or the output ended or the adapter closed.
DTimeout ==
  /\ pc = "out"
  /\ result' = "uncertain" /\ pc' = "result" /\ inFlight' = FALSE /\ pending' = NoId
  /\ UNCHANGED <<turnVars, dt, started, held, resId, toApply, live, closed, acur, rehydrated, replay,
                 codexVars, otherVars, ghostVars>>

\* finishSend's bind (retried until it lands, so one step), then the interrupt when it bound
\* nothing and held no end of its own; the own held ends are applied after.
FinishBind(id) ==
  LET replacing == IF started /= NoId /\ started /= id THEN started ELSE NoId
      ok == Bindable(dt, id, replacing)
      own == {e \in held : e.id = id}
  IN /\ ptid' = IF ok THEN [ptid EXCEPT ![dt] = id] ELSE ptid
     /\ intr' = IF ~ok /\ own = {} /\ ~closed /\ acur /= NoId THEN intr \cup {acur} ELSE intr
     /\ toApply' = own /\ held' = {} /\ pc' = "applying"
     /\ UNCHANGED status

\* What dispatchOne does with the send's outcome.
DSettle ==
  /\ pc = "result"
  /\ CASE result = "ok" -> FinishBind(resId)
       [] result = "rejected" ->
            Release("failed", started) /\ pc' = "end" /\ UNCHANGED <<held, toApply, intr>>
       [] result = "uncertain" /\ started /= NoId /\ ~M("answer-binds-only") ->
            \* "The answer was lost, and the harness said meanwhile that the turn started"
            FinishBind(started)
       [] result = "notwritten" ->
            Release("queued", started) /\ pc' = "end" /\ UNCHANGED <<held, toApply, intr>>
       [] OTHER ->
            \* uncertain with nothing started: failed TURN_DELIVERY_UNCONFIRMED
            /\ IF M("putback-uncertain") THEN Release("queued", NoId) ELSE Release("failed", NoId)
            /\ pc' = "end" /\ UNCHANGED <<held, toApply, intr>>
  /\ UNCHANGED <<holder, dt, started, result, resId, hostVars, creq, ccur, ownUsed, out,
                 otherVars, ghostVars>>

\* finishSend: applyCompletion of each own held end.
DApply ==
  /\ pc = "applying"
  /\ IF toApply = {}
       THEN pc' = "end" /\ UNCHANGED <<status, toApply>>
       ELSE \E e \in toApply : CompleteTurn(e.id, e.st) /\ toApply' = toApply \ {e}
                               /\ UNCHANGED pc
  /\ UNCHANGED <<ptid, holder, dt, started, held, result, resId, hostVars, codexVars, otherVars,
                 ghostVars>>

\* Effect.ensuring: the phase goes Idle and the attempt leaves liveAttempts.
DEnd ==
  /\ pc = "end"
  /\ holder' = [u \in Turns |-> IF holder[u] = "cur" THEN "old" ELSE holder[u]]
  /\ pc' = "idle" /\ dt' = NoId /\ started' = NoId /\ held' = {} /\ result' = "none"
  /\ resId' = NoId /\ toApply' = {}
  /\ UNCHANGED <<status, ptid, hostVars, codexVars, otherVars, ghostVars>>

-----------------------------------------------------------------------------
(* The host reads Codex's output, one message at a time, in order: the     *)
(* adapter's handleNotification and its call answers, then the host's      *)
(* handler (turn.started's bind, settleCompletion).                        *)
Read ==
  /\ live /\ out /= <<>>
  /\ LET m == Head(out) IN
     /\ out' = Tail(out)
     /\ CASE m.k = "started" ->
               \* ownTurn = !sendInFlight && currentTurnId === null && rehydrate === undefined:
               \* a harness turn, whose row the model leaves out. Otherwise turn.started, bound
               \* while a send is Writing.
               LET own == ~inFlight /\ acur = NoId /\ ~rehydrated
                   bindNow == ~own /\ Writing /\ started = NoId
               IN /\ acur' = m.id
                  /\ started' = IF bindNow THEN m.id ELSE started
                  /\ ptid' = IF bindNow /\ ~M("answer-binds-only") /\ Bindable(dt, m.id, NoId)
                               THEN [ptid EXCEPT ![dt] = m.id] ELSE ptid
                  /\ UNCHANGED <<status, held, pc, result, resId, inFlight, pending>>
          [] m.k = "completed" ->
               /\ acur' = NoId
               /\ IF Writing /\ started = m.id
                    THEN held' = held \cup {[id |-> m.id, st |-> m.st]} /\ UNCHANGED status
                  ELSE IF Matches(m.id)
                    THEN CompleteTurn(m.id, m.st) /\ UNCHANGED held
                  ELSE IF Writing /\ M("end-to-claim")
                    THEN status' = [status EXCEPT ![dt] = m.st] /\ UNCHANGED held
                  ELSE IF Writing
                    THEN held' = held \cup {[id |-> m.id, st |-> m.st]} /\ UNCHANGED status
                  ELSE UNCHANGED <<status, held>>
               /\ UNCHANGED <<ptid, started, pc, result, resId, inFlight, pending>>
          [] m.k = "answer" ->
               \* A late answer, after the call failed, is dropped.
               IF pc = "out" /\ pending = m.t
                 THEN /\ result' = m.st /\ resId' = m.id /\ pc' = "result"
                      /\ inFlight' = FALSE /\ pending' = NoId
                      /\ acur' = IF m.st = "ok" THEN m.id ELSE acur
                      /\ UNCHANGED <<status, ptid, started, held>>
                 ELSE UNCHANGED <<status, ptid, started, held, pc, result, resId, inFlight,
                                  pending, acur>>
  /\ replay' = IF replay > 0 THEN replay - 1 ELSE 0
  /\ UNCHANGED <<holder, dt, toApply, live, closed, rehydrated, creq, ccur, ownUsed, intr,
                 otherVars, ghostVars>>

-----------------------------------------------------------------------------
(* Codex. It acts until Mend closes its stdin.                             *)

\* Codex takes a turn/start while it runs no turn: turn/started and the answer, in either order.
CAccept ==
  /\ ~closed /\ creq /= <<>> /\ ccur = NoId
  /\ LET t == Head(creq)
         id == <<t, accepts[t] + 1>>
         s == [k |-> "started", t |-> NoId, id |-> id, st |-> "none"]
         a == [k |-> "answer", t |-> t, id |-> id, st |-> "ok"]
     IN /\ accepts[t] < 2
        /\ creq' = Tail(creq) /\ ccur' = id
        /\ accepts' = [accepts EXCEPT ![t] = @ + 1]
        /\ \/ out' = out \o <<s, a>>
           \/ out' = out \o <<a, s>>
  /\ UNCHANGED <<turnVars, dispVars, hostVars, ownUsed, intr, otherVars, stopSaw, badWrite>>

\* Codex refuses a turn/start.
CReject ==
  /\ ~closed /\ creq /= <<>>
  /\ creq' = Tail(creq)
  /\ out' = Append(out, [k |-> "answer", t |-> Head(creq), id |-> NoId, st |-> "rejected"])
  /\ UNCHANGED <<turnVars, dispVars, hostVars, ccur, ownUsed, intr, otherVars, ghostVars>>

\* Codex starts a turn of its own.
COwn ==
  /\ ~closed /\ ccur = NoId
  /\ \E o \in OwnTurns \ ownUsed :
       /\ ownUsed' = ownUsed \cup {o}
       /\ ccur' = <<o, 1>>
       /\ out' = Append(out, [k |-> "started", t |-> NoId, id |-> <<o, 1>>, st |-> "none"])
  /\ UNCHANGED <<turnVars, dispVars, hostVars, creq, intr, otherVars, ghostVars>>

\* Codex's turn ends, by itself or on a turn/interrupt for it.
CEnd ==
  /\ ~closed /\ ccur /= NoId
  /\ \/ /\ out' = Append(out, [k |-> "completed", t |-> NoId, id |-> ccur, st |-> "completed"])
        /\ UNCHANGED intr
     \/ /\ ccur \in intr
        /\ out' = Append(out, [k |-> "completed", t |-> NoId, id |-> ccur, st |-> "interrupted"])
        /\ intr' = intr \ {ccur}
  /\ ccur' = NoId
  /\ UNCHANGED <<turnVars, dispVars, hostVars, creq, ownUsed, otherVars, ghostVars>>

-----------------------------------------------------------------------------
(* Stop on one message: interruptTurn reads the row, then acts on what it  *)
(* read. With "stop-atomic" the read and the cancel are one statement.     *)
SRead(t) ==
  /\ sp[t] = "idle" /\ live /\ status[t] /= "none"
  /\ \A u \in Turns \ {t} : sp[u] = "idle"   \* bound: one message's Stop per behaviour
  /\ IF status[t] = "queued" /\ M("stop-atomic")
       THEN /\ status' = [status EXCEPT ![t] = "cancelled"]
            /\ sp' = [sp EXCEPT ![t] = "done"]
       ELSE /\ sp' = [sp EXCEPT ![t] = CASE status[t] = "queued" -> "q"
                                         [] status[t] = "running" -> "r"
                                         [] OTHER -> "done"]
            /\ UNCHANGED status
  /\ stopSaw' = [stopSaw EXCEPT ![t] = (status[t] = "queued")]
  /\ UNCHANGED <<ptid, holder, dispVars, hostVars, codexVars, ss, restarted, retried, accepts,
                 badWrite>>

\* queued: cancelOpenForTurn (WHERE status = 'queued'). running: adapter.interrupt(), which asks
\* Codex to interrupt the adapter's currentTurnId and does nothing when there is none.
SAct(t) ==
  /\ sp[t] \in {"q", "r"}
  /\ IF sp[t] = "q"
       THEN /\ status' = [status EXCEPT ![t] = IF @ = "queued" THEN "cancelled" ELSE @]
            /\ UNCHANGED intr
       ELSE /\ intr' = IF live /\ acur /= NoId THEN intr \cup {acur} ELSE intr
            /\ UNCHANGED status
  /\ sp' = [sp EXCEPT ![t] = "done"]
  /\ UNCHANGED <<ptid, holder, dispVars, hostVars, creq, ccur, ownUsed, out, ss, restarted,
                 retried, ghostVars>>

(* Session Stop: detach (the entry leaves hosted, the adapter closes), then *)
(* cancelOpenForProcess (WHERE status IN ('queued', 'running')).            *)
StopDetach ==
  /\ ss = "no" /\ live
  /\ ss' = "detached" /\ live' = FALSE /\ closed' = TRUE
  /\ UNCHANGED <<turnVars, dispVars, inFlight, pending, acur, rehydrated, replay, codexVars, sp,
                 restarted, retried, ghostVars>>

StopCancel ==
  /\ ss = "detached"
  /\ ss' = "done"
  /\ status' = [u \in Turns |-> IF status[u] \in {"queued", "running"} THEN "cancelled"
                                 ELSE status[u]]
  /\ UNCHANGED <<ptid, holder, dispVars, hostVars, codexVars, sp, restarted, retried, ghostVars>>

(* A Mend restart with Codex's pipe surviving: the dispatch, its held ends *)
(* and in-flight Stops are gone; rehydrate fails each running turn with no *)
(* provider turn id (failUnconfirmedTurn), the replayed output tells the   *)
(* new adapter Codex's current turn, and that adapter is a rehydrate one.  *)
Restart ==
  /\ ~restarted /\ live /\ ss = "no"
  /\ restarted' = TRUE
  /\ status' = [u \in Turns |-> IF status[u] = "running" /\ ptid[u] = NoId THEN "failed"
                                 ELSE status[u]]
  /\ holder' = [u \in Turns |-> IF holder[u] = "cur" THEN "old" ELSE holder[u]]
  /\ pc' = "idle" /\ dt' = NoId /\ started' = NoId /\ held' = {} /\ result' = "none"
  /\ resId' = NoId /\ toApply' = {}
  /\ inFlight' = FALSE /\ pending' = NoId /\ acur' = ccur /\ rehydrated' = TRUE
  /\ replay' = Len(out)
  /\ sp' = [u \in Turns |-> IF sp[u] \in {"q", "r"} THEN "done" ELSE sp[u]]
  /\ UNCHANGED <<ptid, live, closed, codexVars, ss, retried, ghostVars>>

-----------------------------------------------------------------------------
Next ==
  \/ \E t \in Turns : Submit(t) \/ Retry(t) \/ SRead(t) \/ SAct(t)
  \/ DClaim \/ DCheck \/ DWrite \/ DTimeout \/ DSettle \/ DApply \/ DEnd
  \/ Read
  \/ CAccept \/ CReject \/ COwn \/ CEnd
  \/ StopDetach \/ StopCancel \/ Restart

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* The promises.                                                           *)

\* At most once: Codex takes a message's input at most once.
AtMostOnce == \A t \in Turns : accepts[t] <= 1

\* A stopped turn does not start: nothing is written for a message after a Stop read it queued,
\* nor once the session's Stop closed the adapter.
StoppedNeverStarts == ~badWrite

\* A rejected message never reads completed: a message reads completed only if Codex took it.
CompletedOnlyIfTaken == \A t \in Turns : status[t] = "completed" => accepts[t] >= 1

=============================================================================
