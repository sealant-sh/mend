--------------------------- MODULE StandbyDiscard ---------------------------
(***************************************************************************)
(* Mend's standby workspaces (the hot pool) and the one call that removes   *)
(* a workspace without saving its files: `drainHotWorkspace`'s stop with    *)
(* `discardUnsaved: true` (packages/sessions/src/engine.ts).                *)
(*                                                                          *)
(* The promise checked: a discard is never sent for a workspace that holds, *)
(* or can still come to hold, a session's work.                             *)
(*                                                                          *)
(* One step of this model is one SQL statement or one platform call in the  *)
(* code, and every action names the code it stands for. Each statement is  *)
(* its own autocommit transaction (no `withTransaction` around any of them) *)
(* under Postgres's default Read Committed level. The two statements that   *)
(* race, `claim` and `retire`, are each split into the read of the          *)
(* statement's snapshot and the locked re-check of the row's newest         *)
(* version, so another statement can commit between the two, as it can in  *)
(* Postgres. README.md beside this file gives the Postgres reasoning and    *)
(* the throwaway-database observations behind it.                           *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS
  Standbys,  \* hot_workspaces ids. Each is also its standby's Sealant workspace
             \* and the id a claiming session takes (claimHotSession creates the
             \* session under the pool row's id).
  Launches,  \* launches that may claim a standby (claimHotSession).
  NoId,      \* a model value: no row.
  Base,      \* "code" is the code as it is; see Bases.
  Mutant     \* "none", or one deliberate break; see Mutants.

(* The two "fix-" bases model candidate fixes for the finding in README.md;  *)
(* they are not the code. A mutant breaks one check or one order of the code *)
(* to show that a property can fail; check.sh expects each one to fail.      *)
Bases == {"code",
          "fix-reread-session",           \* the drain reads the session again once retire took the row
          "fix-setfailed-unless-claimed"} \* the not-ended setFailed leaves a claimed row claimed
Mutants == {"none",
            "retire-ignores-status",      \* retire: WHERE id = ?, without status <> 'claimed'
            "discard-before-retire",      \* the stop is sent before retire, whose answer goes unused
            "claim-leaves-ready",         \* claim selects FOR UPDATE but never sets 'claimed'
            "reused-id"}                  \* a new standby may take the id of one that was drained

ASSUME Base \in Bases /\ Mutant \in Mutants
ASSUME NoId \notin Standbys

\* A hot_workspaces row's status. "unborn": the id was never inserted.
\* "gone": the row was deleted. The other four are HotWorkspaceStatus
\* (packages/domain/src/workbench/hot-workspace.ts).
Statuses == {"unborn", "warming", "ready", "claimed", "failed", "gone"}
Exists(st) == st \in {"warming", "ready", "claimed", "failed"}

\* Who runs drainHotWorkspace. One drain at a time per caller; callers run
\* concurrently with each other.
Slots == {<<"reconcile">>, <<"sweep">>}
           \cup {<<"claim", l>> : l \in Launches}
           \cup {<<"launch", s>> : s \in Standbys}
R == <<"reconcile">>
W == <<"sweep">>
C(l) == <<"claim", l>>
A(s) == <<"launch", s>>

VARIABLES
  \* Postgres: hot_workspaces and agent_sessions.
  status,      \* hot_workspaces.status, or "unborn"/"gone"
  wsid,        \* hot_workspaces.sealant_workspace_id is set (setReady)
  session,     \* the agent_sessions row under the standby's id: "none", "live", "settled"
  \* What happened to each standby's Sealant workspace.
  adopted,     \* a launch recorded it as its session's executor (acceptExecutor)
  holdsWork,   \* the session's worktree was laid down in it (replan)
  discardSent, \* stopWorkspace(…, { discardUnsaved: true }) was sent for it
  \* reconcileHotPoolOnce: one pass per project at a time (scheduleHotReconcile).
  rpc, rWs, rTodo, rProv,
  \* hotPoolSweep: at boot and every 10 minutes.
  wpc, wWs, wTodo,
  \* claimHotSession, one per launch.
  cpc, cCand, cOf,
  \* launchSession's adoption of a claimed standby, one per session id.
  apc, aWs,
  \* drainHotWorkspace, one per caller.
  dpc, dEntry, dWs, dKeep, dAdopted, dMatch, dDiscard

db       == <<status, wsid, session>>
platform == <<adopted, holdsWork, discardSent>>
recon    == <<rpc, rWs, rTodo, rProv>>
sweep    == <<wpc, wWs, wTodo>>
claims   == <<cpc, cCand, cOf>>
launches == <<apc, aWs>>
drains   == <<dpc, dEntry, dWs, dKeep, dAdopted, dMatch, dDiscard>>
vars == <<db, platform, recon, sweep, claims, launches, drains>>

NoWs == [s \in Standbys |-> FALSE]

TypeOK ==
  /\ status \in [Standbys -> Statuses]
  /\ wsid \in [Standbys -> BOOLEAN]
  /\ session \in [Standbys -> {"none", "live", "settled"}]
  /\ adopted \in [Standbys -> BOOLEAN]
  /\ holdsWork \in [Standbys -> BOOLEAN]
  /\ discardSent \subseteq Standbys
  /\ rpc \in {"idle", "loop", "wait", "prov", "provDone"}
  /\ rWs \in [Standbys -> BOOLEAN]
  /\ rTodo \subseteq Standbys
  /\ rProv \in Standbys \cup {NoId}
  /\ wpc \in {"idle", "loop", "wait"}
  /\ wWs \in [Standbys -> BOOLEAN]
  /\ wTodo \subseteq Standbys
  /\ cpc \in [Launches -> {"idle", "lock", "capture", "create", "wait", "done"}]
  /\ cCand \in [Launches -> SUBSET Standbys]
  /\ cOf \in [Launches -> Standbys \cup {NoId}]
  /\ apc \in [Standbys -> {"idle", "byId", "check", "wait", "remove", "replan"}]
  /\ aWs \in [Standbys -> BOOLEAN]
  /\ dpc \in [Slots -> {"idle", "adopt", "rscan", "rapply", "reread", "stop", "answered", "end"}]
  /\ dEntry \in [Slots -> Standbys \cup {NoId}]
  /\ dWs \in [Slots -> BOOLEAN]
  /\ dKeep \in [Slots -> BOOLEAN]
  /\ dAdopted \in [Slots -> BOOLEAN]
  /\ dMatch \in [Slots -> BOOLEAN]
  /\ dDiscard \in [Slots -> BOOLEAN]

Init ==
  /\ status = [s \in Standbys |-> "unborn"]
  /\ wsid = NoWs
  /\ session = [s \in Standbys |-> "none"]
  /\ adopted = NoWs
  /\ holdsWork = NoWs
  /\ discardSent = {}
  /\ rpc = "idle" /\ rWs = NoWs /\ rTodo = {} /\ rProv = NoId
  /\ wpc = "idle" /\ wWs = NoWs /\ wTodo = {}
  /\ cpc = [l \in Launches |-> "idle"]
  /\ cCand = [l \in Launches |-> {}]
  /\ cOf = [l \in Launches |-> NoId]
  /\ apc = [s \in Standbys |-> "idle"]
  /\ aWs = NoWs
  /\ dpc = [d \in Slots |-> "idle"]
  /\ dEntry = [d \in Slots |-> NoId]
  /\ dWs = [d \in Slots |-> FALSE]
  /\ dKeep = [d \in Slots |-> FALSE]
  /\ dAdopted = [d \in Slots |-> FALSE]
  /\ dMatch = [d \in Slots |-> FALSE]
  /\ dDiscard = [d \in Slots |-> FALSE]

-----------------------------------------------------------------------------
(* drainHotWorkspace(entry, { keepWorktree })                               *)
(* `entry` is the caller's copy of the row, read earlier; only its id and   *)
(* its sealantWorkspaceId matter here.                                      *)

StartDrain(d, e, ws, keep) ==
  /\ dpc' = [dpc EXCEPT ![d] = "adopt"]
  /\ dEntry' = [dEntry EXCEPT ![d] = e]
  /\ dWs' = [dWs EXCEPT ![d] = ws]
  /\ dKeep' = [dKeep EXCEPT ![d] = keep]
  /\ UNCHANGED <<dAdopted, dMatch, dDiscard>>

\* The drain returned to its caller: its fields go back to their idle values.
EndDrain(d) ==
  /\ dpc' = [dpc EXCEPT ![d] = "idle"]
  /\ dEntry' = [dEntry EXCEPT ![d] = NoId]
  /\ dWs' = [dWs EXCEPT ![d] = FALSE]
  /\ dKeep' = [dKeep EXCEPT ![d] = FALSE]
  /\ dAdopted' = [dAdopted EXCEPT ![d] = FALSE]
  /\ dMatch' = [dMatch EXCEPT ![d] = FALSE]
  /\ dDiscard' = [dDiscard EXCEPT ![d] = FALSE]

\* `const adopted = keepWorktree || sessions.byId(entry.id) found`, then
\* `discard = capture && entry.sealantWorkspaceId !== null && !adopted && retire(…)`.
DAdopt(d) ==
  /\ dpc[d] = "adopt"
  /\ LET e == dEntry[d]
         isAdopted == dKeep[d] \/ session[e] # "none"
     IN /\ dAdopted' = [dAdopted EXCEPT ![d] = isAdopted]
        /\ IF Mutant = "discard-before-retire"
             THEN /\ dDiscard' = [dDiscard EXCEPT ![d] = dWs[d] /\ ~isAdopted]
                  /\ dpc' = [dpc EXCEPT ![d] = IF dWs[d] THEN "stop" ELSE "end"]
           ELSE IF dWs[d] /\ ~isAdopted
             THEN /\ dpc' = [dpc EXCEPT ![d] = "rscan"]
                  /\ UNCHANGED dDiscard
           ELSE /\ dDiscard' = [dDiscard EXCEPT ![d] = FALSE]
                /\ dpc' = [dpc EXCEPT ![d] = IF dWs[d] THEN "stop" ELSE "end"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dMatch>>

\* HotWorkspacesRepo.retire: UPDATE hot_workspaces SET status = 'failed'
\* WHERE id = ? AND status <> 'claimed' RETURNING id
\* (packages/db/src/repos/hot-workspaces.ts). Read Committed: the statement
\* finds its target in its snapshot (this step) ...
RetireWhere(e) ==
  IF Mutant = "retire-ignores-status"
    THEN Exists(status[e])
    ELSE Exists(status[e]) /\ status[e] # "claimed"

DRetireScan(d) ==
  /\ dpc[d] = "rscan"
  /\ dMatch' = [dMatch EXCEPT ![d] = RetireWhere(dEntry[d])]
  /\ dpc' = [dpc EXCEPT ![d] = "rapply"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dAdopted, dDiscard>>

\* ... then locks the row, waiting for any writer, and re-checks the WHERE on
\* the row's newest version (EvalPlanQual). A row its snapshot did not match
\* is never a target, whatever committed since.
DRetireApply(d) ==
  /\ dpc[d] = "rapply"
  /\ LET e == dEntry[d]
         took == dMatch[d] /\ RetireWhere(e)
     IN /\ status' = IF took THEN [status EXCEPT ![e] = "failed"] ELSE status
        /\ IF Mutant = "discard-before-retire"
             THEN /\ dpc' = [dpc EXCEPT ![d] = "answered"]
                  /\ UNCHANGED dDiscard
           ELSE IF Base = "fix-reread-session" /\ took
             THEN /\ dpc' = [dpc EXCEPT ![d] = "reread"]
                  /\ UNCHANGED dDiscard
           ELSE /\ dDiscard' = [dDiscard EXCEPT ![d] = took]
                /\ dpc' = [dpc EXCEPT ![d] = "stop"]
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dAdopted, dMatch>>

\* fix-reread-session only: sessions.byId(entry.id) again once retire took
\* the row; a session found means an ordinary stop.
DReread(d) ==
  /\ dpc[d] = "reread"
  /\ dDiscard' = [dDiscard EXCEPT ![d] = session[dEntry[d]] = "none"]
  /\ dpc' = [dpc EXCEPT ![d] = "stop"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dAdopted, dMatch>>

\* sealant.getWorkspace(id) then sealant.stopWorkspace(workspace,
\* discard ? { discardUnsaved: true } : undefined). Counted as sent even if
\* getWorkspace fails first, which only adds behaviours.
DStop(d) ==
  /\ dpc[d] = "stop"
  /\ discardSent' = IF dDiscard[d] THEN discardSent \cup {dEntry[d]} ELSE discardSent
  /\ dpc' = [dpc EXCEPT ![d] =
               IF Mutant = "discard-before-retire" /\ dWs[d] /\ ~dAdopted[d]
                 THEN "rscan" ELSE "answered"]
  /\ UNCHANGED <<db, adopted, holdsWork, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dAdopted, dMatch, dDiscard>>

\* Core did not confirm the end (kept, still draining, refused, not
\* observed): HotWorkspacesRepo.setFailed, an UPDATE … WHERE id = ? with no
\* status condition, and the drain returns false.
DNotEnded(d) ==
  /\ dpc[d] = "answered"
  /\ LET e == dEntry[d]
         keepClaimed == Base = "fix-setfailed-unless-claimed" /\ status[e] = "claimed"
     IN status' = IF Exists(status[e]) /\ ~keepClaimed
                    THEN [status EXCEPT ![e] = "failed"] ELSE status
  /\ EndDrain(d)
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, launches>>

\* Core confirmed the end, or the row had no workspace: tokens and socket go,
\* then HotWorkspacesRepo.remove (DELETE … WHERE id = ?), and it returns true.
DEnded(d) ==
  /\ dpc[d] \in {"answered", "end"}
  /\ LET e == dEntry[d]
     IN status' = IF Exists(status[e]) THEN [status EXCEPT ![e] = "gone"] ELSE status
  /\ EndDrain(d)
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, launches>>

DrainStep(d) ==
  \/ DAdopt(d) \/ DRetireScan(d) \/ DRetireApply(d) \/ DReread(d)
  \/ DStop(d) \/ DNotEnded(d) \/ DEnded(d)

-----------------------------------------------------------------------------
(* reconcileHotPoolOnce: listForProject, then each entry not `claimed` in  *)
(* that list is kept or drained, then standbys are provisioned. Why a ready *)
(* entry is drained (hot sessions lowered, a stale fingerprint after an     *)
(* environment, runtime or skills change, an owner the pool no longer       *)
(* serves, a Boat account being left by changingBoatKey, a survivor whose   *)
(* probe found it dead) is not modelled: any entry may be drained. A failed *)
(* entry drained again is the retried discard ("Mend asks Sealant again at  *)
(* least every 10 minutes").                                                *)

RStart ==
  /\ rpc = "idle"
  /\ rWs' = wsid
  /\ rTodo' = {s \in Standbys : Exists(status[s]) /\ status[s] # "claimed"}
  /\ rpc' = "loop"
  /\ UNCHANGED <<db, platform, rProv, sweep, claims, launches, drains>>

RSkip(e) ==
  /\ rpc = "loop" /\ e \in rTodo
  /\ rTodo' = rTodo \ {e}
  /\ UNCHANGED <<db, platform, rpc, rWs, rProv, sweep, claims, launches, drains>>

RDrain(e) ==
  /\ rpc = "loop" /\ e \in rTodo /\ dpc[R] = "idle"
  /\ StartDrain(R, e, rWs[e], FALSE)
  /\ rTodo' = rTodo \ {e}
  /\ rpc' = "wait"
  /\ UNCHANGED <<db, platform, rWs, rProv, sweep, claims, launches>>

RDrainDone ==
  /\ rpc = "wait" /\ dpc[R] = "idle"
  /\ rpc' = "loop"
  /\ UNCHANGED <<db, platform, rWs, rTodo, rProv, sweep, claims, launches, drains>>

RListDone ==
  /\ rpc = "loop" /\ rTodo = {}
  /\ rpc' = "prov"
  /\ rWs' = NoWs
  /\ UNCHANGED <<db, platform, rTodo, rProv, sweep, claims, launches, drains>>

\* provisionHotWorkspace: hotWorkspaces.create inserts a `warming` row under
\* a fresh crypto.randomUUID() ...
RProvCreate(s) ==
  /\ rpc = "prov"
  /\ \/ status[s] = "unborn"
     \/ Mutant = "reused-id" /\ status[s] = "gone"
  /\ status' = [status EXCEPT ![s] = "warming"]
  /\ wsid' = [wsid EXCEPT ![s] = FALSE]
  /\ rProv' = s
  /\ rpc' = "provDone"
  /\ UNCHANGED <<session, platform, rWs, rTodo, sweep, claims, launches, drains>>

\* ... then setReady (UPDATE … SET status = 'ready', sealant_workspace_id = …
\* WHERE id = ?, no status condition) once the workspace is up ...
RProvReady ==
  /\ rpc = "provDone"
  /\ IF Exists(status[rProv])
       THEN /\ status' = [status EXCEPT ![rProv] = "ready"]
            /\ wsid' = [wsid EXCEPT ![rProv] = TRUE]
       ELSE UNCHANGED <<status, wsid>>
  /\ rpc' = "idle" /\ rProv' = NoId
  /\ UNCHANGED <<session, platform, rWs, rTodo, sweep, claims, launches, drains>>

\* ... or setFailed when the plan or the create failed (no workspace on the row).
RProvFailed ==
  /\ rpc = "provDone"
  /\ status' = IF Exists(status[rProv]) THEN [status EXCEPT ![rProv] = "failed"] ELSE status
  /\ rpc' = "idle" /\ rProv' = NoId
  /\ UNCHANGED <<wsid, session, platform, rWs, rTodo, sweep, claims, launches, drains>>

RPassEnd ==
  /\ rpc = "prov"
  /\ rpc' = "idle"
  /\ UNCHANGED <<db, platform, rWs, rTodo, rProv, sweep, claims, launches, drains>>

-----------------------------------------------------------------------------
(* hotPoolSweep: listAll, then for each entry `claimed` in that list,       *)
(* sessions.byId(entry.id): none drains it, settled drains it keeping the   *)
(* worktree, a live session leaves it.                                      *)

WStart ==
  /\ wpc = "idle"
  /\ wWs' = wsid
  /\ wTodo' = {s \in Standbys : status[s] = "claimed"}
  /\ wpc' = "loop"
  /\ UNCHANGED <<db, platform, recon, claims, launches, drains>>

WCheck(e) ==
  /\ wpc = "loop" /\ e \in wTodo /\ dpc[W] = "idle"
  /\ wTodo' = wTodo \ {e}
  /\ CASE session[e] = "none" ->
            StartDrain(W, e, wWs[e], FALSE) /\ wpc' = "wait"
       [] session[e] = "settled" ->
            StartDrain(W, e, wWs[e], TRUE) /\ wpc' = "wait"
       [] session[e] = "live" ->
            UNCHANGED <<drains, wpc>>
  /\ UNCHANGED <<db, platform, recon, wWs, claims, launches>>

WDrainDone ==
  /\ wpc = "wait" /\ dpc[W] = "idle"
  /\ wpc' = "loop"
  /\ UNCHANGED <<db, platform, recon, wWs, wTodo, claims, launches, drains>>

WEnd ==
  /\ wpc = "loop" /\ wTodo = {}
  /\ wpc' = "idle" /\ wWs' = NoWs
  /\ UNCHANGED <<db, platform, recon, wTodo, claims, launches, drains>>

-----------------------------------------------------------------------------
(* claimHotSession                                                          *)

\* HotWorkspacesRepo.claim: UPDATE hot_workspaces SET status = 'claimed'
\* WHERE id IN (SELECT id … WHERE status = 'ready' AND … ORDER BY created_at
\* LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *. Read Committed: the
\* subquery's candidates are the rows `ready` in its snapshot (this step) ...
CScan(l) ==
  /\ cpc[l] = "idle"
  /\ cCand' = [cCand EXCEPT ![l] = {s \in Standbys : status[s] = "ready"}]
  /\ cpc' = [cpc EXCEPT ![l] = "lock"]
  /\ UNCHANGED <<db, platform, recon, sweep, cOf, launches, drains>>

\* ... and it takes one whose newest version is still `ready` once locked
\* (EvalPlanQual). A row another statement holds locked is skipped, which
\* leaves the same outcomes as that statement committing first, so taking any
\* candidate still `ready`, or none, covers SKIP LOCKED and the owner,
\* fingerprint and oldest-first conditions.
CTake(l, s) ==
  /\ cpc[l] = "lock"
  /\ s \in cCand[l] /\ status[s] = "ready"
  /\ status' = IF Mutant = "claim-leaves-ready" THEN status
               ELSE [status EXCEPT ![s] = "claimed"]
  /\ cOf' = [cOf EXCEPT ![l] = s]
  /\ cCand' = [cCand EXCEPT ![l] = {}]
  /\ cpc' = [cpc EXCEPT ![l] = "capture"]
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, launches, drains>>

\* Nothing taken: a cold launch under a new session id, outside this model.
CNone(l) ==
  /\ cpc[l] = "lock"
  /\ cCand' = [cCand EXCEPT ![l] = {}]
  /\ cpc' = [cpc EXCEPT ![l] = "done"]
  /\ UNCHANGED <<db, platform, recon, sweep, cOf, launches, drains>>

\* ensureCaptureZero, then capture.repo.claim of the worktree's lease.
CCaptureOk(l) ==
  /\ cpc[l] = "capture"
  /\ cpc' = [cpc EXCEPT ![l] = "create"]
  /\ UNCHANGED <<db, platform, recon, sweep, cCand, cOf, launches, drains>>

\* Refused: drainHotWorkspace(entry), then a cold launch under a new id.
CCaptureFail(l) ==
  /\ cpc[l] = "capture" /\ dpc[C(l)] = "idle"
  /\ StartDrain(C(l), cOf[l], wsid[cOf[l]], FALSE)
  /\ cpc' = [cpc EXCEPT ![l] = "wait"]
  /\ UNCHANGED <<db, platform, recon, sweep, cCand, cOf, launches>>

CDrainDone(l) ==
  /\ cpc[l] = "wait" /\ dpc[C(l)] = "idle"
  /\ cpc' = [cpc EXCEPT ![l] = "done"]
  /\ UNCHANGED <<db, platform, recon, sweep, cCand, cOf, launches, drains>>

\* requestHotReconcile (a pass may start at any time here anyway), then
\* sessions.create({ id: entry.id, … }); the session's launch begins.
CCreate(l) ==
  /\ cpc[l] = "create"
  /\ LET s == cOf[l] IN
       IF session[s] = "none" /\ apc[s] = "idle"
         THEN /\ session' = [session EXCEPT ![s] = "live"]
              /\ apc' = [apc EXCEPT ![s] = "byId"]
         ELSE UNCHANGED <<session, apc>>  \* the insert collides; cannot happen without a mutant
  /\ cpc' = [cpc EXCEPT ![l] = "done"]
  /\ UNCHANGED <<status, wsid, platform, recon, sweep, cCand, cOf, aWs, drains>>

-----------------------------------------------------------------------------
(* launchSession for a session whose id is a pool row's                     *)

\* `claimedEntry = hotWorkspaces.byId(sessionId)`: only a row still `claimed`
\* is adopted; anything else is a cold launch in a new workspace.
AById(s) ==
  /\ apc[s] = "byId"
  /\ IF status[s] = "claimed"
       THEN /\ aWs' = [aWs EXCEPT ![s] = wsid[s]]
            /\ apc' = [apc EXCEPT ![s] = "check"]
       ELSE /\ apc' = [apc EXCEPT ![s] = "idle"]
            /\ UNCHANGED aWs
  /\ UNCHANGED <<db, platform, recon, sweep, claims, drains>>

\* The claimed standby is not used: refuseWorkspaceRepositories refused,
\* adoptClaimedWorkspace found it dead or half-stamped, or the layout or the
\* owner's selected-only logins no longer match. Each drains it with
\* keepWorktree, then the launch fails or goes cold.
ADrop(s) ==
  /\ apc[s] = "check" /\ dpc[A(s)] = "idle"
  /\ StartDrain(A(s), s, aWs[s], TRUE)
  /\ apc' = [apc EXCEPT ![s] = "wait"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, aWs>>

ADropDone(s) ==
  /\ apc[s] = "wait" /\ dpc[A(s)] = "idle"
  /\ apc' = [apc EXCEPT ![s] = "idle"] /\ aWs' = [aWs EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, drains>>

\* Adopted: acceptExecutor records the standby's workspace on the session.
AAccept(s) ==
  /\ apc[s] = "check" /\ aWs[s]
  /\ adopted' = [adopted EXCEPT ![s] = TRUE]
  /\ apc' = [apc EXCEPT ![s] = "remove"]
  /\ UNCHANGED <<db, holdsWork, discardSent, recon, sweep, claims, aWs, drains>>

\* hotWorkspaces.remove(claimedEntry.id), before the replan.
ARemove(s) ==
  /\ apc[s] = "remove"
  /\ status' = IF Exists(status[s]) THEN [status EXCEPT ![s] = "gone"] ELSE status
  /\ apc' = [apc EXCEPT ![s] = "replan"]
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, aWs, drains>>

\* replanClaimedStandby lays the session's worktree down; the agent starts.
\* A failed replan may still have left work on it, so it counts either way.
AReplan(s) ==
  /\ apc[s] = "replan"
  /\ holdsWork' = [holdsWork EXCEPT ![s] = TRUE]
  /\ apc' = [apc EXCEPT ![s] = "idle"] /\ aWs' = [aWs EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<db, adopted, discardSent, recon, sweep, claims, drains>>

-----------------------------------------------------------------------------
(* People and the process                                                   *)

\* The session ends (a stop, a failure, resume() settling a stranded one).
Settle(s) ==
  /\ session[s] = "live"
  /\ session' = [session EXCEPT ![s] = "settled"]
  /\ UNCHANGED <<status, wsid, platform, recon, sweep, claims, launches, drains>>

\* A person resumes or wakes the session: launchSession runs again.
Resume(s) ==
  /\ session[s] # "none" /\ apc[s] = "idle"
  /\ session' = [session EXCEPT ![s] = "live"]
  /\ apc' = [apc EXCEPT ![s] = "byId"]
  /\ UNCHANGED <<status, wsid, platform, recon, sweep, claims, aWs, drains>>

\* The Mend process restarts between any two steps: every fiber is gone and
\* every in-memory map with it; the database and Sealant keep what they had.
\* A launch cut short does not come back (a person starting again is a new
\* launch). The boot sweep is WStart, which may run at any time.
Restart ==
  /\ rpc' = "idle" /\ rWs' = NoWs /\ rTodo' = {} /\ rProv' = NoId
  /\ wpc' = "idle" /\ wWs' = NoWs /\ wTodo' = {}
  /\ cpc' = [l \in Launches |-> IF cpc[l] = "idle" THEN "idle" ELSE "done"]
  /\ cCand' = [l \in Launches |-> {}]
  /\ apc' = [s \in Standbys |-> "idle"] /\ aWs' = NoWs
  /\ dpc' = [d \in Slots |-> "idle"]
  /\ dEntry' = [d \in Slots |-> NoId]
  /\ dWs' = [d \in Slots |-> FALSE]
  /\ dKeep' = [d \in Slots |-> FALSE]
  /\ dAdopted' = [d \in Slots |-> FALSE]
  /\ dMatch' = [d \in Slots |-> FALSE]
  /\ dDiscard' = [d \in Slots |-> FALSE]
  /\ UNCHANGED <<db, platform, cOf>>

-----------------------------------------------------------------------------
Next ==
  \/ \E d \in Slots : DrainStep(d)
  \/ RStart \/ RDrainDone \/ RListDone \/ RProvReady \/ RProvFailed \/ RPassEnd
  \/ \E s \in Standbys : RSkip(s) \/ RDrain(s) \/ RProvCreate(s)
  \/ WStart \/ WDrainDone \/ WEnd
  \/ \E s \in Standbys : WCheck(s)
  \/ \E l \in Launches :
       \/ CScan(l) \/ CNone(l) \/ CCaptureOk(l) \/ CCaptureFail(l)
       \/ CDrainDone(l) \/ CCreate(l)
       \/ \E s \in Standbys : CTake(l, s)
  \/ \E s \in Standbys :
       AById(s) \/ ADrop(s) \/ ADropDone(s) \/ AAccept(s) \/ ARemove(s) \/ AReplan(s)
       \/ Settle(s) \/ Resume(s)
  \/ Restart

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties                                                               *)

\* The promise: no discard is ever sent for a workspace that a session has
\* taken as its executor or holds work in. Checked in every state, so a
\* discard sent first and a session taking the workspace afterwards breaks it
\* too ("can still come to hold").
NoDiscardOfSessionWork ==
  \A s \in discardSent : ~adopted[s] /\ ~holdsWork[s]

\* The reviewer's first property: a row is claimable only while no session
\* has its id, has taken its workspace, or holds work in it.
NoClaimableRowWithSession ==
  \A s \in Standbys :
    status[s] = "ready" => session[s] = "none" /\ ~adopted[s] /\ ~holdsWork[s]

Symmetry == Permutations(Standbys) \cup Permutations(Launches)
=============================================================================
