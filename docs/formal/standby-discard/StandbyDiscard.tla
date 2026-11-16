--------------------------- MODULE StandbyDiscard ---------------------------
(***************************************************************************)
(* Mend's standby workspaces (the hot pool) and the one call that removes   *)
(* a workspace without saving its files: `drainHotWorkspace`'s stop with    *)
(* `discardUnsaved: true` (packages/sessions/src/engine.ts).                *)
(*                                                                          *)
(* The promise checked: a discard is never sent for a workspace that holds, *)
(* or can still come to hold, a session's work. Since SLNT-1053 a second    *)
(* call sends one too: a session's drain discards the claimed standby its   *)
(* launch gave up on when its re-plan never took and nothing ran in it      *)
(* (`discardStandbyNeverClaimed`).                                          *)
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
  Standbys,  \* hot_workspaces ids. Each is also its standby's sealant workspace
             \* and the id a claiming session takes (claimHotSession creates the
             \* session under the pool row's id).
  Launches,  \* launches that may claim a standby (claimHotSession).
  NoId,      \* a model value: no row.
  Mutant     \* "none" is the code as it is; otherwise one deliberate break, see Mutants.

(* A mutant breaks one check or one order of the code to show that a        *)
(* property can fail; check.sh says what it expects of each.                 *)
Mutants == {"none",
            "no-reread",                  \* the drain as it was before SLNT-823: no session read after retire
            "reread-before-retire",       \* the second session read is made before retire, not after
            "discard-before-retire",      \* the stop is sent before retire, whose answer goes unused
            "claim-leaves-ready",         \* claim selects FOR UPDATE but never sets 'claimed'
            "reused-id",                  \* a new standby may take the id of one that was drained
            "no-look",                    \* SLNT-1053's discard without looking for what ran in it
            "look-live-only",             \* the look sees what holds it now, not what ran and ended
            "agent-ignores-stop"}         \* a launch its owner stopped starts its agent anyway

ASSUME Mutant \in Mutants
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
  \* What happened to each standby's sealant workspace.
  adopted,     \* a launch recorded it as its session's executor (acceptExecutor)
  holdsWork,   \* something a session made may be on it: its agent started there after the
               \* re-plan, or a join ran there
  discardSent, \* drainHotWorkspace's stopWorkspace(…, { discardUnsaved: true }) was sent for it
  onWorktree,  \* sealantd's re-plan took: the standby captures as the session's worktree
  ran,         \* a session_processes row names its workspace (anyone's, live or ended)
  replanDiscard, \* discardStandbyNeverClaimed's discard was sent for it (SLNT-1053)
  \* The session's durable drain intent (agent_sessions.capture_drain), set by
  \* beginCaptureDrain; it outlives a restart.
  ending,
  stopped,     \* its owner pressed Stop while its launch was under way (stoppedDuringLaunch)
  \* reconcileHotPoolOnce: one pass per project at a time (scheduleHotReconcile).
  rpc, rWs, rTodo, rProv,
  \* hotPoolSweep: at boot and every 10 minutes.
  wpc, wWs, wTodo,
  \* claimHotSession, one per launch.
  cpc, cCand, cOf,
  \* launchSession's adoption of a claimed standby, one per session id.
  apc, aWs,
  \* drainHotWorkspace, one per caller.
  dpc, dEntry, dWs, dKeep, dAdopted, dMatch, dDiscard,
  \* The session drain's look at a claimed standby (discardStandbyNeverClaimed),
  \* and one join into each standby's executor (launchSession's join).
  gpc, jpc

db       == <<status, wsid, session>>
platform == <<adopted, holdsWork, discardSent>>
recon    == <<rpc, rWs, rTodo, rProv>>
sweep    == <<wpc, wWs, wTodo>>
claims   == <<cpc, cCand, cOf>>
launches == <<apc, aWs>>
drains   == <<dpc, dEntry, dWs, dKeep, dAdopted, dMatch, dDiscard>>
replans  == <<onWorktree, ran, replanDiscard, ending, stopped, gpc, jpc>>
vars == <<db, platform, recon, sweep, claims, launches, drains, replans>>

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
  /\ apc \in [Standbys -> {"idle", "byId", "check", "wait", "remove", "replan",
                             "identify"}]
  /\ aWs \in [Standbys -> BOOLEAN]
  /\ dpc \in [Slots -> {"idle", "adopt", "rscan", "rapply", "reread", "stop", "answered", "end"}]
  /\ dEntry \in [Slots -> Standbys \cup {NoId}]
  /\ dWs \in [Slots -> BOOLEAN]
  /\ dKeep \in [Slots -> BOOLEAN]
  /\ dAdopted \in [Slots -> BOOLEAN]
  /\ dMatch \in [Slots -> BOOLEAN]
  /\ dDiscard \in [Slots -> BOOLEAN]
  /\ onWorktree \in [Standbys -> BOOLEAN]
  /\ ran \in [Standbys -> BOOLEAN]
  /\ replanDiscard \subseteq Standbys
  /\ ending \in [Standbys -> BOOLEAN]
  /\ stopped \in [Standbys -> BOOLEAN]
  /\ gpc \in [Standbys -> {"idle", "look", "identify", "discard"}]
  /\ jpc \in [Standbys -> {"idle", "look", "done"}]

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
  /\ onWorktree = NoWs /\ ran = NoWs /\ replanDiscard = {}
  /\ ending = NoWs /\ stopped = NoWs
  /\ gpc = [s \in Standbys |-> "idle"]
  /\ jpc = [s \in Standbys |-> "idle"]

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

\* `adoptedBefore = keepWorktree || sessions.byId(entry.id) found`, then
\* `retired = capture && entry.sealantWorkspaceId !== null && !adoptedBefore && retire(…)`.
DAdopt(d) ==
  /\ dpc[d] = "adopt"
  /\ LET e == dEntry[d]
         isAdopted == dKeep[d] \/ session[e] # "none"
     IN /\ dAdopted' = [dAdopted EXCEPT ![d] = isAdopted]
        /\ IF Mutant = "discard-before-retire"
             THEN /\ dDiscard' = [dDiscard EXCEPT ![d] = dWs[d] /\ ~isAdopted]
                  /\ dpc' = [dpc EXCEPT ![d] = IF dWs[d] THEN "stop" ELSE "end"]
           ELSE IF dWs[d] /\ ~isAdopted
             THEN /\ dpc' = [dpc EXCEPT ![d] =
                               IF Mutant = "reread-before-retire" THEN "reread" ELSE "rscan"]
                  /\ UNCHANGED dDiscard
           ELSE /\ dDiscard' = [dDiscard EXCEPT ![d] = FALSE]
                /\ dpc' = [dpc EXCEPT ![d] = IF dWs[d] THEN "stop" ELSE "end"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dMatch>>
  /\ UNCHANGED replans

\* HotWorkspacesRepo.retire: UPDATE hot_workspaces SET status = 'failed'
\* WHERE id = ? AND status <> 'claimed' RETURNING id
\* (packages/db/src/repos/hot-workspaces.ts). Read Committed: the statement
\* finds its target in its snapshot (this step) ...
RetireWhere(e) == Exists(status[e]) /\ status[e] # "claimed"

DRetireScan(d) ==
  /\ dpc[d] = "rscan"
  /\ dMatch' = [dMatch EXCEPT ![d] = RetireWhere(dEntry[d])]
  /\ dpc' = [dpc EXCEPT ![d] = "rapply"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dAdopted, dDiscard>>
  /\ UNCHANGED replans

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
           ELSE IF Mutant = "reread-before-retire"
             THEN /\ dDiscard' = [dDiscard EXCEPT ![d] = dDiscard[d] /\ took]
                  /\ dpc' = [dpc EXCEPT ![d] = "stop"]
           ELSE IF Mutant # "no-reread" /\ took
             THEN /\ dpc' = [dpc EXCEPT ![d] = "reread"]
                  /\ UNCHANGED dDiscard
           ELSE /\ dDiscard' = [dDiscard EXCEPT ![d] = took]
                /\ dpc' = [dpc EXCEPT ![d] = "stop"]
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dAdopted, dMatch>>
  /\ UNCHANGED replans

\* `adopted = adoptedBefore || (retired && sessions.byId(entry.id) found)`,
\* `discard = retired && !adopted`: once retire took the row, the session is
\* read again, and one found means an ordinary stop (SLNT-823).
DReread(d) ==
  /\ dpc[d] = "reread"
  /\ dDiscard' = [dDiscard EXCEPT ![d] = session[dEntry[d]] = "none"]
  /\ dpc' = [dpc EXCEPT ![d] = IF Mutant = "reread-before-retire" THEN "rscan" ELSE "stop"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches,
                 dEntry, dWs, dKeep, dAdopted, dMatch>>
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

\* sealant did not confirm the end (kept, still draining, refused, not
\* observed): HotWorkspacesRepo.setFailed, an UPDATE … WHERE id = ? with no
\* status condition, and the drain returns false.
DNotEnded(d) ==
  /\ dpc[d] = "answered"
  /\ LET e == dEntry[d]
     IN status' = IF Exists(status[e]) THEN [status EXCEPT ![e] = "failed"] ELSE status
  /\ EndDrain(d)
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, launches>>
  /\ UNCHANGED replans

\* sealant confirmed the end, or the row had no workspace: tokens and socket go,
\* then HotWorkspacesRepo.remove (DELETE … WHERE id = ?), and it returns true.
DEnded(d) ==
  /\ dpc[d] \in {"answered", "end"}
  /\ LET e == dEntry[d]
     IN status' = IF Exists(status[e]) THEN [status EXCEPT ![e] = "gone"] ELSE status
  /\ EndDrain(d)
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, launches>>
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

RSkip(e) ==
  /\ rpc = "loop" /\ e \in rTodo
  /\ rTodo' = rTodo \ {e}
  /\ UNCHANGED <<db, platform, rpc, rWs, rProv, sweep, claims, launches, drains>>
  /\ UNCHANGED replans

RDrain(e) ==
  /\ rpc = "loop" /\ e \in rTodo /\ dpc[R] = "idle"
  /\ StartDrain(R, e, rWs[e], FALSE)
  /\ rTodo' = rTodo \ {e}
  /\ rpc' = "wait"
  /\ UNCHANGED <<db, platform, rWs, rProv, sweep, claims, launches>>
  /\ UNCHANGED replans

RDrainDone ==
  /\ rpc = "wait" /\ dpc[R] = "idle"
  /\ rpc' = "loop"
  /\ UNCHANGED <<db, platform, rWs, rTodo, rProv, sweep, claims, launches, drains>>
  /\ UNCHANGED replans

RListDone ==
  /\ rpc = "loop" /\ rTodo = {}
  /\ rpc' = "prov"
  /\ rWs' = NoWs
  /\ UNCHANGED <<db, platform, rTodo, rProv, sweep, claims, launches, drains>>
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

\* ... or setFailed when the plan or the create failed (no workspace on the row).
RProvFailed ==
  /\ rpc = "provDone"
  /\ status' = IF Exists(status[rProv]) THEN [status EXCEPT ![rProv] = "failed"] ELSE status
  /\ rpc' = "idle" /\ rProv' = NoId
  /\ UNCHANGED <<wsid, session, platform, rWs, rTodo, sweep, claims, launches, drains>>
  /\ UNCHANGED replans

RPassEnd ==
  /\ rpc = "prov"
  /\ rpc' = "idle"
  /\ UNCHANGED <<db, platform, rWs, rTodo, rProv, sweep, claims, launches, drains>>
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

WDrainDone ==
  /\ wpc = "wait" /\ dpc[W] = "idle"
  /\ wpc' = "loop"
  /\ UNCHANGED <<db, platform, recon, wWs, wTodo, claims, launches, drains>>
  /\ UNCHANGED replans

WEnd ==
  /\ wpc = "loop" /\ wTodo = {}
  /\ wpc' = "idle" /\ wWs' = NoWs
  /\ UNCHANGED <<db, platform, recon, wTodo, claims, launches, drains>>
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

\* Nothing taken: a cold launch under a new session id, outside this model.
CNone(l) ==
  /\ cpc[l] = "lock"
  /\ cCand' = [cCand EXCEPT ![l] = {}]
  /\ cpc' = [cpc EXCEPT ![l] = "done"]
  /\ UNCHANGED <<db, platform, recon, sweep, cOf, launches, drains>>
  /\ UNCHANGED replans

\* ensureCaptureZero, then capture.repo.claim of the worktree's lease.
CCaptureOk(l) ==
  /\ cpc[l] = "capture"
  /\ cpc' = [cpc EXCEPT ![l] = "create"]
  /\ UNCHANGED <<db, platform, recon, sweep, cCand, cOf, launches, drains>>
  /\ UNCHANGED replans

\* Refused: drainHotWorkspace(entry), then a cold launch under a new id.
CCaptureFail(l) ==
  /\ cpc[l] = "capture" /\ dpc[C(l)] = "idle"
  /\ StartDrain(C(l), cOf[l], wsid[cOf[l]], FALSE)
  /\ cpc' = [cpc EXCEPT ![l] = "wait"]
  /\ UNCHANGED <<db, platform, recon, sweep, cCand, cOf, launches>>
  /\ UNCHANGED replans

CDrainDone(l) ==
  /\ cpc[l] = "wait" /\ dpc[C(l)] = "idle"
  /\ cpc' = [cpc EXCEPT ![l] = "done"]
  /\ UNCHANGED <<db, platform, recon, sweep, cCand, cOf, launches, drains>>
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

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
  /\ UNCHANGED replans

\* The claimed standby is not used: refuseWorkspaceRepositories refused,
\* adoptClaimedWorkspace found it dead or half-stamped, or the layout or the
\* owner's selected-only logins no longer match. Each drains it with
\* keepWorktree, then the launch fails or goes cold.
ADrop(s) ==
  /\ apc[s] = "check" /\ dpc[A(s)] = "idle"
  /\ StartDrain(A(s), s, aWs[s], TRUE)
  /\ apc' = [apc EXCEPT ![s] = "wait"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, aWs>>
  /\ UNCHANGED replans

ADropDone(s) ==
  /\ apc[s] = "wait" /\ dpc[A(s)] = "idle"
  /\ apc' = [apc EXCEPT ![s] = "idle"] /\ aWs' = [aWs EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, drains>>
  /\ UNCHANGED replans

\* Adopted: acceptExecutor records the standby's workspace on the session.
AAccept(s) ==
  /\ apc[s] = "check" /\ aWs[s]
  /\ adopted' = [adopted EXCEPT ![s] = TRUE]
  /\ apc' = [apc EXCEPT ![s] = "remove"]
  /\ UNCHANGED <<db, holdsWork, discardSent, recon, sweep, claims, aWs, drains>>
  /\ UNCHANGED replans

\* hotWorkspaces.remove(claimedEntry.id), before the replan.
ARemove(s) ==
  /\ apc[s] = "remove"
  /\ status' = IF Exists(status[s]) THEN [status EXCEPT ![s] = "gone"] ELSE status
  /\ apc' = [apc EXCEPT ![s] = "replan"]
  /\ UNCHANGED <<wsid, session, platform, recon, sweep, claims, aWs, drains>>
  /\ UNCHANGED replans

\* The launch starts the session's agent in its executor, unless its owner
\* stopped it (refuseIfStoppedDuringLaunch, before the agent's terminal opens).
AgentStarts(s) ==
  LET starts == ~stopped[s] \/ Mutant = "agent-ignores-stop"
  IN /\ holdsWork' = [holdsWork EXCEPT ![s] = holdsWork[s] \/ starts]
     /\ ran' = [ran EXCEPT ![s] = ran[s] \/ starts]

\* replanClaimedStandby (SLNT-1053). The launch starts nothing in a standby
\* before its re-plan answers (e2e9 F-B): what a re-plan does by itself is lay
\* the worktree's saved head down (`onWorktree`), never anything unsaved.
\* Answered: the session's agent starts there.
AReplanOk(s) ==
  /\ apc[s] = "replan"
  /\ onWorktree' = [onWorktree EXCEPT ![s] = TRUE]
  /\ AgentStarts(s)
  /\ apc' = [apc EXCEPT ![s] = "idle"] /\ aWs' = [aWs EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<db, adopted, discardSent, recon, sweep, claims, drains,
                 replanDiscard, ending, stopped, gpc, jpc>>

\* At most one standby in a run goes down the failed path: two of them share
\* no workspace, session or join, so a break of either needs only its own.
\* The other standby still runs every other action, before and meanwhile.
OnlyFailedReplan(s) ==
  \A t \in Standbys \ {s} :
    /\ apc[t] # "identify"
    /\ ~ending[t]

\* Refused or not answered: it may have taken and lost its answer, or never
\* taken. Asked again (sealantd's re-plan is idempotent), or given up on (a
\* timeout is never asked again). A re-plan that times out may still take in
\* sealantd afterwards; that is not modelled: it lays down only the saved
\* head, and in this model it could only turn GIdentify's discard into a
\* drain, never add one.
AReplanFail(s) ==
  /\ apc[s] = "replan"
  /\ OnlyFailedReplan(s)
  /\ \E t \in {onWorktree[s], TRUE} : onWorktree' = [onWorktree EXCEPT ![s] = t]
  \* A stopped launch asks nothing more.
  /\ \E next \in IF stopped[s] THEN {"identify"} ELSE {"replan", "identify"} :
       apc' = [apc EXCEPT ![s] = next]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, aWs, drains,
                 ran, replanDiscard, ending, stopped, gpc, jpc>>

\* Where a drain's look at a claimed standby begins: `no-look` skips it.
LookStart == IF Mutant = "no-look" THEN "identify" ELSE "look"

\* readClaimedStandby, from the launch: the standby's own status. One that
\* answers as the session's (it took) is adopted and the agent starts; one
\* that answers under its placeholder, or cannot be read, is given up on and
\* drained (stopWorkspaceQuietly(…, { reason: "relaunch" })), whose first
\* round writes the durable intent (runDrain's sessions.beginCaptureDrain)
\* before it looks at anything. The read and the intent are one step here:
\* nothing between them reads what the intent changes, and the read changes
\* nothing a join reads. The launch goes cold or is refused once the drain
\* returns; it starts nothing in the standby, so that is not modelled.
AIdentify(s) ==
  /\ apc[s] = "identify"
  /\ \/ \* Stopped: the launch is cancelled; the Stop's own drain ends the standby.
        /\ stopped[s]
        /\ UNCHANGED <<holdsWork, ran, ending, gpc>>
     \/ /\ ~stopped[s] /\ onWorktree[s]
        /\ AgentStarts(s)
        /\ UNCHANGED <<ending, gpc>>
     \/ /\ ~stopped[s]
        /\ ending' = [ending EXCEPT ![s] = TRUE]
        /\ gpc' = [gpc EXCEPT ![s] = IF gpc[s] = "idle" THEN LookStart ELSE gpc[s]]
        /\ UNCHANGED <<holdsWork, ran>>
  /\ apc' = [apc EXCEPT ![s] = "idle"] /\ aWs' = [aWs EXCEPT ![s] = FALSE]
  /\ UNCHANGED <<db, adopted, discardSent, recon, sweep, claims, drains,
                 onWorktree, replanDiscard, stopped, jpc>>

\* Its owner's Stop while the launch of a claimed standby is under way:
\* stoppedDuringLaunch, then the Stop's drain of the session's executor, whose
\* first round writes the intent and looks (one drain per workspace: a look
\* already under way is the same one).
Stop(s) ==
  /\ adopted[s] /\ session[s] = "live"
  \* One Stop in the whole model, of either standby, and not in a run with a join: the
  \* breaks either shows need only it, and the look sees a join's process row whoever wrote
  \* the intent before it.
  /\ \A t \in Standbys : ~stopped[t] /\ jpc[t] = "idle"
  /\ apc[s] \in {"replan", "identify"}
  /\ stopped' = [stopped EXCEPT ![s] = TRUE]
  /\ ending' = [ending EXCEPT ![s] = TRUE]
  /\ gpc' = [gpc EXCEPT ![s] = IF gpc[s] = "idle" THEN LookStart ELSE gpc[s]]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches, drains,
                 onWorktree, ran, replanDiscard, jpc>>

\* The capture reaper takes a kept drain up again (a drain no fiber runs),
\* after a restart too: runDrain again, its intent already durable.
KeptRetry(s) ==
  /\ ending[s] /\ gpc[s] = "idle" /\ s \notin replanDiscard
  /\ gpc' = [gpc EXCEPT ![s] = LookStart]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches, drains,
                 onWorktree, ran, replanDiscard, ending, stopped, jpc>>

\* discardStandbyNeverClaimed: processes.existsForWorkspace, then
\* workspaceInUse, which counts a join under way (workspaceHolds). One step:
\* both read after the intent, so a join that looked before it is in one of
\* them, whichever comes first, and a join that looks after it stays out.
GLook(s) ==
  /\ gpc[s] = "look"
  /\ LET seen == IF Mutant = "look-live-only" THEN jpc[s] = "look"
                 ELSE ran[s] \/ jpc[s] = "look"
     IN gpc' = [gpc EXCEPT ![s] = IF seen THEN "idle" ELSE "identify"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches, drains,
                 onWorktree, ran, replanDiscard, ending, stopped, jpc>>

\* ... then readClaimedStandby: only an answer under its placeholder goes on to
\* the discard; one as the session's, or none, drains as before (no discard).
GIdentify(s) ==
  /\ gpc[s] = "identify"
  /\ \/ /\ ~onWorktree[s]
        /\ gpc' = [gpc EXCEPT ![s] = "discard"]
     \/ gpc' = [gpc EXCEPT ![s] = "idle"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches, drains,
                 onWorktree, ran, replanDiscard, ending, stopped, jpc>>

\* terminateWorkspace(…, { discardUnsaved: true }).
GDiscard(s) ==
  /\ gpc[s] = "discard"
  /\ replanDiscard' = replanDiscard \cup {s}
  /\ gpc' = [gpc EXCEPT ![s] = "idle"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches, drains,
                 onWorktree, ran, ending, stopped, jpc>>

\* A second session joins the standby's executor while it holds the
\* worktree's lease: enterJoin counts it in workspaceHolds ... One join in
\* the whole model, into either standby: the breaks it shows need only one.
JEnter(s) ==
  /\ adopted[s] /\ \A t \in Standbys : jpc[t] = "idle" /\ ~stopped[t]
  /\ jpc' = [jpc EXCEPT ![s] = "look"]
  /\ UNCHANGED <<db, platform, recon, sweep, claims, launches, drains,
                 onWorktree, ran, replanDiscard, ending, stopped, gpc>>

\* ... then looks at its holder once more (leaseHolderWorkspace): a drain's
\* intent keeps it out; otherwise its process row is written and it runs.
JLook(s) ==
  /\ jpc[s] = "look"
  /\ IF ending[s]
       THEN UNCHANGED <<holdsWork, ran>>
       ELSE /\ holdsWork' = [holdsWork EXCEPT ![s] = TRUE]
            /\ ran' = [ran EXCEPT ![s] = TRUE]
  /\ jpc' = [jpc EXCEPT ![s] = "done"]
  /\ UNCHANGED <<db, adopted, discardSent, recon, sweep, claims, launches, drains,
                 onWorktree, replanDiscard, ending, stopped, gpc>>

-----------------------------------------------------------------------------
(* People and the process                                                   *)

\* The session ends (a stop, a failure, resume() settling a stranded one).
Settle(s) ==
  /\ session[s] = "live"
  /\ session' = [session EXCEPT ![s] = "settled"]
  /\ UNCHANGED <<status, wsid, platform, recon, sweep, claims, launches, drains>>
  /\ UNCHANGED replans

\* A person resumes or wakes the session: launchSession runs again.
Resume(s) ==
  /\ session[s] # "none" /\ apc[s] = "idle"
  /\ session' = [session EXCEPT ![s] = "live"]
  /\ apc' = [apc EXCEPT ![s] = "byId"]
  /\ UNCHANGED <<status, wsid, platform, recon, sweep, claims, aWs, drains>>
  /\ UNCHANGED replans

\* The Mend process restarts between any two steps: every fiber is gone and
\* every in-memory map with it; the database and sealant keep what they had.
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
  /\ gpc' = [s \in Standbys |-> "idle"]
  /\ jpc' = [s \in Standbys |-> IF jpc[s] = "look" THEN "done" ELSE jpc[s]]
  /\ UNCHANGED <<db, platform, cOf, onWorktree, ran, replanDiscard, ending, stopped>>

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
       AById(s) \/ ADrop(s) \/ ADropDone(s) \/ AAccept(s) \/ ARemove(s)
       \/ AReplanOk(s) \/ AReplanFail(s) \/ AIdentify(s)
       \/ Stop(s) \/ KeptRetry(s) \/ GLook(s) \/ GIdentify(s) \/ GDiscard(s)
       \/ JEnter(s) \/ JLook(s)
       \/ Settle(s) \/ Resume(s)
  \/ Restart

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties                                                               *)

\* The promise: no discard is ever sent for a workspace that a session has
\* taken as its executor or holds work in. Checked in every state, so a
\* discard sent first and a session taking the workspace afterwards breaks it
\* too ("can still come to hold").
\* SLNT-1053's discard reaches a standby a launch adopted, so its half says
\* less: nothing a session made is, or can come to be, on it.
NoDiscardOfSessionWork ==
  /\ \A s \in discardSent : ~adopted[s] /\ ~holdsWork[s]
  /\ \A s \in replanDiscard : ~holdsWork[s]

\* The reviewer's first property: a row is claimable only while no session
\* has its id, has taken its workspace, or holds work in it.
NoClaimableRowWithSession ==
  \A s \in Standbys :
    status[s] = "ready" => session[s] = "none" /\ ~adopted[s] /\ ~holdsWork[s]

Symmetry == Permutations(Standbys) \cup Permutations(Launches)
=============================================================================
