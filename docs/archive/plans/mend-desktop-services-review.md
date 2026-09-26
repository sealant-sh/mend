# Mend desktop: ownership, Services, and Review

> Historical record (2026-09-26): closed out. Steps 1 to 10 shipped; step 10's desktop Services are
> `apps/desktop/src/renderer/src/components/services-sheet.tsx` (#92, later #338 and #360). Step 11
> (process frontiers and process-aware evidence) was not built, and step 12 stays unticked.

**Status:** Approved; implementation in progress (Steps 1–8 complete)

**Authority:** `MEND-AGENT-WORKBENCH-PLAN.md` remains canonical. This plan records the approved
implementation sequence for desktop ownership, Review, and Services. Step 1 folded the product
decisions into the canonical plan and supporting documents.

**Research basis:** The initial workflow audited the desktop, API, session engine, Services
implementation, web Review, database model, and public Sealant boundary. It also compared terminal
ownership and forwarded-port behavior in modern developer tools. Completed steps have since been
validated with package tests, forced repository checks, and real-repository or real-database exit
proofs where required.

## Approved direction

Retire the hidden project bench. A visible coding-agent session should own every writable shell and
Service that can affect its worktree.

A session keeps one coding-agent conversation, one worktree, and one change. Its current Sealant
workspace may also contain supporting shell and Service processes. These processes are independently
recorded and independently controlled, but they are not additional sessions.

Build in this order:

1. Fix shell ownership and lifecycle.
2. Pin Review to immutable checkpoint pairs and prove that contract in web or CLI.
3. Ship the human Review loop in desktop with evidence beside the diff.
4. Make follow-up delivery atomic and retryable.
5. Separate stable Services from their process attempts and forwards, then ship desktop Services.
6. Add process-aware checkpoint evidence and machine findings last.

The short version is simple: session-owned terminals, native pinned Review, and explicit
session-owned Services.

## Why this direction

The current desktop looks like one shell per project, but that is not what the server runs. It
creates one hidden shell session called `bench` per project, then opens any number of shell PTYs in
that bench workspace. The desktop renders one dominant terminal at a time, which creates the
one-shell impression.

The hidden bench causes real problems:

- it owns a separate worktree and change that the desktop hides;
- closing a shell tab removes only local state and leaves the process running;
- restored tabs can point at dead process IDs;
- a bench can keep a workspace alive without appearing in the tree or inbox;
- Services started there belong to a hidden session;
- opening another bench after the first primary PTY exits can leave two bench workspaces alive.

Session-owned shells remove that ambiguity. Every edit has a visible owner, every Service belongs to
the worktree it serves, and Review has one change to explain.

## What exists today

| Area             | Shipped in source                                                                                                                                                                                                                                        | Important gap                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop runtime  | Electron main owns HTTP, SSE, credentials, external navigation, and TTY URL minting. The renderer owns React, TanStack Router, queries, and Ghostty. See `apps/desktop/src/main/`, `apps/desktop/src/preload/`, and `apps/desktop/src/shared/bridge.ts`. | Native Review and Services do not need an Electron rewrite. They can use the existing API, event, and TTY boundaries.                                             |
| Desktop routes   | `/`, `/connect`, and `/settings` exist under `apps/desktop/src/renderer/src/routes/`.                                                                                                                                                                    | There is no native Review route, session detail route, or Services mode.                                                                                          |
| Project shells   | `openShellTab` creates or reuses a hidden `harness="shell", label="bench"` session and opens more PTYs in it. See `apps/desktop/src/renderer/src/lib/workbench.ts`.                                                                                      | This hides a real session, worktree, and change.                                                                                                                  |
| Shell close      | `workbench.closeTab` changes local storage only.                                                                                                                                                                                                         | The process keeps running and may retain the workspace. This contradicts `apps/desktop/BRIEF.md`.                                                                 |
| Process model    | `SessionProcess` already represents agent, shell, and Service processes. See `packages/domain/src/workbench/session-process.ts` and `packages/db/src/repos/session-processes.ts`.                                                                        | Desktop does not use the process list as the source of truth for shell restoration.                                                                               |
| Hot workspaces   | Per-project ready workspace skeletons are implemented in `packages/sessions/src/engine.ts`, `hot-pool.ts`, and `packages/db/src/repos/hot-workspaces.ts`.                                                                                                | They should serve new visible sessions, not hidden benches.                                                                                                       |
| Services backend | Explicit recipes, supervised and adopted Services, TCP and UDP forwarding, leases, restart, stop, logs, and reconciliation exist. See `packages/sessions/src/engine.ts`, `service-host.ts`, and `recipes.ts`.                                            | One row currently mixes stable Service identity, the latest process, run pointer, forward, and observation. Restart overwrites prior run pointers.                |
| Services clients | CLI and web controls exist. See `apps/cli/src/main.ts` and `apps/web/src/components/services-card.tsx`.                                                                                                                                                  | Desktop has DTOs and query invalidation but no Services UI. Web misses background `session-process` invalidation and disables controls after the agent completes. |
| Review backend   | Checkpoints, live git diff, stats, comments, machine passes, tours, and follow-ups exist. See `packages/store/src/store.ts`, `packages/api/src/contract.ts`, and `packages/api/src/workbench.ts`.                                                        | The public Review flow reads a moving worktree, not an immutable checkpoint pair.                                                                                 |
| Web Review       | Unified diff, comments, drafts, tours, and send-back exist in `apps/web/src/routes/changes.$changeId.tsx` and `apps/web/src/components/diff.tsx`.                                                                                                        | It lacks several canonical P0 controls, deletion-side anchors, and stable slice-bound comments.                                                                   |
| Desktop Review   | `TerminalPane` opens the web Review in the system browser.                                                                                                                                                                                               | The desktop has no Review route, diff component, comment client, evidence inspector, or follow-up flow.                                                           |
| Replay           | Desktop has a checkpoint scrubber and `/api/tty` accepts `from`.                                                                                                                                                                                         | `/api/tty` still requires a live workspace and PTY. It cannot replay a reaped process from the durable record.                                                    |

The public platform boundary is intact. Mend reaches workspaces, PTYs, records, and forwards only
through `packages/sealant/src/client.ts` and public `@sealant/sdk` APIs.

## Product model

### Independent state groups

Do not use `session live` or `settledAt` as a proxy for everything in the workbench. Show these
observations independently:

| Observation           | Example states                                               | Meaning                                                              |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- |
| Coding-agent state    | starting, running, waiting, completed, failed, stopped       | The current or most recent coding-agent run.                         |
| Workspace state       | provisioning, ready, retained, unreachable, stopped, expired | The current Sealant workspace incarnation.                           |
| Process state         | starting, running, exited, stopped, absent                   | One shell or Service attempt.                                        |
| Review snapshot state | pinned, worktree moved, anchor moved, anchor not found       | The relationship between a pinned diff and current repository state. |

A coding-agent run may complete while a shell or Service still retains the workspace. The change
remains mutable until the user opens a pinned Review checkpoint.

### Ownership boundary

Mend owns projects, sessions, changes, checkpoints, comments, Service declarations, process
indexing, and product state. Sealant owns workspaces, PTYs, runs, durable records, and byte
forwards. Mend stores stable Sealant IDs, record cursors, and small evidence excerpts. It never
reads Sealant internals.

## Shell model options

| Option                             | Owner of writable work                                             | Evidence and Review                             | Lifecycle                                            | Resource cost | Main trade-off                                                                            |
| ---------------------------------- | ------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------- |
| Keep the hidden project bench      | Hidden shell session                                               | Weak because its change is hidden               | Current close and restore behavior is misleading     | Moderate      | Preserves today's UI but keeps the product contradiction.                                 |
| Session-owned shells               | Focused visible coding-agent session                               | Strong. All edits land in that session's change | Clear after generic process stop and discovery exist | Low           | A writable shell requires a visible session.                                              |
| Visible shell-backed sessions      | A visible manual session with its own worktree                     | Strong                                          | Clear                                                | High          | Requires changing the canonical definition of session beyond a coding-agent conversation. |
| Writable project utility workspace | A new project-scoped worktree owner                                | Weak unless it becomes a new product object     | Another lifecycle to explain                         | Moderate      | Recreates hidden changes under a different label.                                         |
| Ephemeral task terminals           | A selected session or clean verification workspace                 | Strong for bounded commands                     | Clear                                                | Low           | Good for checks, poor for interactive work and Services.                                  |
| Hybrid                             | Session-owned interactive shells now, bounded task terminals later | Strong                                          | Clear                                                | Moderate      | Slightly less convenient before a session exists.                                         |

### Recommendation

Use the hybrid.

- `+` and Ctrl+Shift+T open a named shell in the focused session.
- If only a project is focused, the same action opens the session launcher. It never creates a
  bench.
- The launcher supports Claude, Codex, OpenCode, and an arbitrary command.
- The tab close button and Ctrl+Shift+W confirm and stop a live shell process group.
- A context action named `Detach tab` removes only the view.
- Closing the app, switching projects, switching tabs, or losing the network only detaches.
- Closing a coding-agent session tab always detaches. It never stops the run.
- Shell labels are unique inside the session, for example `shell 1` and `shell 2`, and may be
  renamed.
- The server process list decides which processes exist. Local storage remembers order, focus, and a
  decimal replay cursor.

When a coding-agent run completes but supporting processes remain:

- the workspace stays retained;
- the user may explicitly open another shell or Service while the workspace remains reachable;
- resuming the coding agent reuses that retained workspace and starts a new Sealant run;
- an explicit `Stop retained work and resume fresh` action names every process it will end;
- when the last lease ends, Mend reaps the workspace;
- a later resume creates a fresh workspace around the same worktree.

### Hot-workspace rules

Keep the existing pool as prepared capacity:

```text
ready workspace skeleton
-> claimed by a new visible session
-> session and change become visible
-> coding-agent PTY opens
-> supporting shells and Services may open in the same workspace
```

A shell or Service never claims another hot workspace. Recipes do not affect the pool fingerprint
because they do not affect `workspaces.create`. After a claim freshens the worktree, Mend must
reread `mend.toml` and rewrite the operational note so prewarmed instructions cannot list stale
recipes.

## Mend Review

### Review anchor

Anchor every Review and new comment to:

```text
checkpoint A
checkpoint B
diff digest
```

A defaults to the session-start checkpoint. B is an explicit `review-open` checkpoint. Git refs
define an immutable patch. The digest detects stale or mismatched transport data.

Opening Review must be an idempotent command, not a side effect of a GET route or React mount.
Reloading, reconnecting, or opening a second window must not create duplicate checkpoints.

### Desktop journey

1. The user selects `Review the change` in a visible session.
2. Desktop sends the open command with an idempotency key.
3. The server creates or reuses checkpoint B and returns A, B, and the diff digest.
4. Desktop enters a native Review route or app mode. It does not open a browser or create a PTY tab.
5. The file navigator, diff, comments, and inspector all read the same checkpoint pair.
6. If a shell edits the worktree after B, the Review stays unchanged and shows
   `Worktree changed since this review snapshot`.
7. The user may create a new checkpoint and move B explicitly.
8. The user comments on additions, deletions, ranges, files, or the whole change.
9. The user selects the comments to send, edits the assembled instruction, and delivers it to the
   same session.
10. Comments become sent only after the next run starts and Mend persists its membership and
    delivery correlation.

### Desktop layout

At wide widths, use a file navigator, a flexible diff, and a comments and evidence inspector. At
medium widths, move the inspector into a drawer. At the minimum desktop width, use unified diff with
file and inspector sheets. Collapse the normal inbox rail by default while Review is open. The diff
remains primary.

The toolbar needs:

- From and To checkpoints;
- unified and side-by-side modes;
- whitespace include or ignore;
- context expansion;
- search;
- previous and next file;
- previous and next hunk;
- previous and next open comment.

The file navigator must represent additions, modifications, deletions, renames, binary files,
generated files, and elided untracked files as git facts.

### Stable comments

New comments need a slice-bound anchor with old and new paths, side, line range, and hunk context
hash. Reviewer disposition is separate from anchor mapping. `addressed`, `anchor moved`, and
`anchor not found` are different observations.

Keep old comments readable as `Legacy live-diff anchor`. Do not invent a checkpoint pair or deletion
side during migration.

### Minimum evidence in the first desktop release

The first native Review release must show evidence. Begin with the coding-agent run pointers
available on the checkpoint pair and label the limits honestly:

- `direct` when a process-specific record event identifies the write or check;
- `inferred` when timing and a process span support attribution;
- `unknown` when neither is enough;
- `supporting-process attribution incomplete` until process frontiers ship.

Each pointer displays the session, process or run, Sealant run ID, decimal sequence, excerpt, and
telemetry-loss facts. A shell process uses its process attempt and Sealant run ID, not a
coding-agent run ordinal.

### Mend reads the change

Keep the trigger manual. Pin every machine pass to checkpoint A and B. Draft findings stay separate
from reviewer comments until accepted.

Until runnable verification exists, emit only record-linked findings. The current evidence-free
suggestion exception must not appear in native Review. Let the user edit a draft before acceptance
and preserve its disposition.

### Follow-up delivery

Define `delivered` as:

> Sealant accepted the new PTY process for the exact edited instruction, Mend persisted the new run
> membership and delivery correlation, and a retry returns that run ID.

Store selected comment IDs, checkpoint A and B, diff digest, edited instruction, and an idempotency
key before launch. Use states `pending`, `delivering`, `delivered`, `delivery_failed`, and
`superseded`.

The first implementation relaunches settled coding-agent sessions only. Sending to a live TUI is a
later action with separate idempotency. If added, it must send the body and Enter as separate PTY
writes.

## Mend Services

### Direction to make canonical

The repository currently disagrees about Service detection and authentication. The recommended
amendment is:

1. A recipe or explicit user action creates a Service.
2. Public Sealant listener events may later produce a factual suggestion. They never create a
   Service.
3. A raw forwarded port has no Mend authentication. Loopback and selected private interfaces are the
   access boundary.
4. Mend does not inspect container internals to discover listeners.
5. Transport and browser behavior are separate declarations: `transport: tcp | udp` and
   `browserScheme: http | https | null`.
6. `Open` appears only when a browser scheme is declared. Otherwise the client offers
   `Copy endpoint`.
7. Recipes are inert. Nothing autostarts during session creation, hot claim, resume, or reconnect.

### Service facts

Keep these concepts separate:

1. A recipe describes how to run or adopt a Service.
2. A Service is the stable session-owned entry.
3. A process attempt is one recorded command execution.
4. A forward is one host binding to one workspace port.
5. A target observation records whether the workspace port answered.
6. A browser URL exists only when the recipe or user declared HTTP or HTTPS.

Restart appends a process attempt. It never overwrites the previous Sealant run pointer or logs.

An adopted Service has a forward and target observations but no Mend-owned process attempt. It gets
Open when declared as HTTP or HTTPS, Copy endpoint, and Remove forward. It does not get Restart,
Stop process, or process logs.

### Desktop journey

1. The user focuses a session and opens a compact `Services N` control beside the terminal.
2. A drawer lists stable Services, recent attempts, and startable recipes.
3. The user selects `Run web`.
4. Mend appends an attempt, starts a sibling PTY, and opens a forward.
5. The UI reports independent facts such as `Process running`, `Forward bound to 127.0.0.1:43127`,
   and `TCP accepted on :5173, observed 8s ago`.
6. `Open` launches the system browser when the Service declares HTTP or HTTPS.
7. `Logs` opens a read-only sequence-addressed stream.
8. Restart creates a new attempt and preserves the old one.
9. Stop ends the current process group, closes the forward, records the end, and releases its lease.

Do not use `healthy`, `ready`, `authenticated`, or `working` because a TCP connection succeeded.

### Recipes

Keep repository `mend.toml` recipes and machine-local project recipes. Every row shows its source.
Reject a machine-local recipe that collides with a current file recipe, or return both with an
explicit `shadowed` fact and disable the losing Run action. Never hide the collision.

### Completion and reconnect

A Service may outlive a coding-agent run. Show independent facts:

```text
Coding agent completed, observed
web reachable, observed 12s ago
Workspace retained by web
```

Controls remain available after coding-agent completion when the retained workspace still supports
them. Closing a drawer, desktop window, browser, or network connection stops nothing.

On event-stream loss, keep the last observation and timestamp. On reconnect, refetch attempts,
forwards, and target observations. If the preferred host port is taken, record and report the old
and new endpoints. If the workspace is gone, close stale forwards and preserve attempt history and
logs.

### Security and exposure

Bind loopback by default. Allow only explicitly selected private interface addresses. Reject
wildcard and public addresses unless a later operator policy approves an unsafe override.

Display this beside any private-interface bind:

> No Mend sign-in protects this port. Anyone who can reach this private address can connect.

Return exact server-resolved endpoints. Desktop must not derive them from `window.location`, which
is wrong under Electron `file://`. Open browser Services in the system browser, not a privileged
in-app browser.

## Proposed domain and API work

All items below are proposed, not shipped APIs.

### Process controls

Add generic shell-process stop, rename, server-authoritative discovery, and a read-only record
stream. Stop must verify ownership and process kind and use public PTY close behavior.

Likely contract shapes:

```text
GET   /sessions/:id/processes
POST  /sessions/:id/processes/shell
PATCH /processes/:id
POST  /processes/:id/stop
GET   /processes/:id/logs?run=<runId>&from=<decimal-sequence>
```

The log route accepts no input frames and reports sequence bounds and telemetry loss. Keep decimal
sequences as strings. Do not convert them to JavaScript numbers.

### Service persistence

Separate stable Services from attempts and forwards. Pre-stable Service rows may be discarded rather
than converted into invented history.

A stable Service stores its session, name, declaration source, workspace port, transport, browser
scheme, bind policy, preferred host port, and current attempt and forward IDs.

Each attempt stores immutable argv, workspace ID, Sealant PTY and run IDs, process state, last
observed sequence, exit code, and timestamps.

Each forward stores preferred and current host ports, exact bound addresses, forward state and
error, previous endpoint, and timestamps. Persist target state, last observation time, and
observation error separately.

### Review contracts

Add an idempotent open command that returns checkpoint A, checkpoint B, diff digest, and whether it
reused an unchanged Review snapshot.

Expose diff reads only against explicit comparisons. Return structured file facts, hunks, and the
digest rather than patch text alone. Use existing `Store.diffRange` instead of rebuilding git
comparison logic.

Add slice-bound comment anchors. Extend follow-ups with selected comment IDs, checkpoint IDs,
digest, delivery state, idempotency key, delivered run ID, and last error. Replace the current
client-side deliver-then-launch pair with one server-owned command.

### Checkpoint process frontiers

Before changing checkpoint evidence, supervise and persist a cursor for every process attempt. Then
attach a set of process frontiers to each checkpoint. Phrase them as `latest Mend observed` unless
the public SDK provides an exact cross-run barrier. If the SDK cannot expose a needed cursor or
barrier, add the gap to `PLATFORM-FEEDBACK.md`.

### Shared client contracts

Desktop and web currently handwrite DTOs. Extract transport-neutral encoded schemas and decoders
before the Review and Services payloads grow. Keep Electron IPC and browser fetch adapters separate.

Share diff parsing, anchor mapping, instruction assembly, pass labels, and keyboard commands. Do not
share complete web route components. Move `@pierre/diffs` to the root catalog before adding it to
desktop.

## Implementation phases

### Phase 0: record the decisions

Scope:

- amend the canonical plan with shell ownership, retained-workspace resume, Service declaration and
  exposure, Review anchors, and follow-up delivery;
- retire the bench decisions in `apps/desktop/BRIEF.md`;
- reconcile `docs/SESSION-SERVICES.md` with the canonical plan;
- record public SDK gaps in `PLATFORM-FEEDBACK.md`.

Likely files:

- `MEND-AGENT-WORKBENCH-PLAN.md`
- `apps/desktop/BRIEF.md`
- `docs/SESSION-SERVICES.md`
- `PLATFORM-FEEDBACK.md`

Exit test: a new agent can answer the owner decisions at the end of this plan without finding
conflicting rules.

### Phase 1: remove hidden benches and fix process ownership

Scope:

- add shell stop, rename, unique labels, discovery, and idempotent lifecycle operations;
- remove bench creation from desktop;
- restore tabs from server state and persist layout plus a decimal cursor only;
- implement the exact close and detach controls;
- permit explicit supporting-process starts in a retained reachable workspace;
- reuse a retained workspace for coding-agent resume, with a separate stop-and-resume-fresh action;
- rewrite the operational note after a hot claim;
- surface legacy benches without reparenting them.

Likely files:

- `apps/desktop/src/renderer/src/lib/workbench.ts`
- `apps/desktop/src/renderer/src/lib/api.ts`
- `apps/desktop/src/renderer/src/lib/queries.ts`
- `apps/desktop/src/renderer/src/routes/index.tsx`
- `apps/desktop/src/renderer/src/components/tab-bar.tsx`
- `apps/desktop/src/renderer/src/components/terminal-pane.tsx`
- `packages/domain/src/workbench/session-process.ts`
- `packages/db/src/repos/session-processes.ts`
- `packages/sessions/src/engine.ts`
- `packages/api/src/contract.ts`
- `packages/api/src/workbench.ts`

Real-repository exit test:

1. Start two visible sessions in one project and confirm distinct worktrees.
2. Open two named shells in each and edit different files.
3. Confirm each edit appears only in its owning change.
4. Close one shell and confirm only that process group ends.
5. Detach another and confirm it remains discoverable.
6. Restart desktop and restore live tabs from server state.
7. Complete the coding-agent run while a shell and Service retain the workspace.
8. Open another shell, resume the coding agent in place, and confirm retained processes survive.
9. Choose fresh resume and confirm the warning names every process that will end.
10. Confirm no new bench session or hidden change appears.
11. Confirm shell starts do not consume a hot workspace.
12. Confirm a sequence above `2^53` survives a client round trip unchanged.

### Phase 2: prove immutable Review contracts

Scope:

- add idempotent open-review and checkpoint A to B diff APIs;
- return structured file metadata and a digest;
- add addition-side, deletion-side, file, and change anchors;
- separate anchor mapping from comment disposition;
- pin machine-pass inputs to A and B;
- prove the contract in web or CLI before desktop depends on it.

Likely files:

- `packages/store/src/store.ts`
- `packages/domain/src/workbench/checkpoint.ts`
- `packages/domain/src/workbench/change.ts`
- `packages/domain/src/workbench/review-comment.ts`
- `packages/db/src/repos/checkpoints.ts`
- `packages/db/src/repos/review-comments.ts`
- `packages/api/src/contract.ts`
- `packages/api/src/workbench.ts`
- `packages/inference/src/session-tools.ts`
- `apps/web/src/components/diff.tsx`
- `apps/web/src/routes/changes.$changeId.tsx`

Real-repository exit test:

1. Open Review repeatedly with the same key and confirm one B checkpoint and digest.
2. Edit the worktree after B and confirm the A to B patch remains unchanged.
3. Move B explicitly and see the new patch.
4. Reload a deleted-line comment and keep it on the deletion side.
5. Exercise renames, binary files, generated files, whitespace handling, context expansion,
   untracked-file elision, and a large diff.
6. Confirm no machine pass reads beyond A and B.

### Phase 3: ship the human Review loop in desktop

Scope:

- add the native Review route or app mode;
- port the proven diff and comment contracts, not the current web route module;
- add file navigation, unified and split diff, keyboard controls, and stale-worktree facts;
- show minimum honest evidence and supporting-process limitations;
- add comment selection and editable instruction assembly;
- update desktop Review event invalidation;
- keep machine-pass actions hidden unless they obey the evidence rule.

Likely files:

- `apps/desktop/package.json`
- `pnpm-workspace.yaml`
- `apps/desktop/src/renderer/src/router.tsx`
- new files under `apps/desktop/src/renderer/src/routes/` and `components/`
- `apps/desktop/src/renderer/src/lib/api.ts`
- `apps/desktop/src/renderer/src/lib/queries.ts`
- `apps/desktop/src/renderer/src/lib/events.ts`
- `apps/desktop/src/renderer/src/components/terminal-pane.tsx`
- shared review utilities extracted from the web components

Real-repository exit test:

1. Let an agent modify source and run a check.
2. Open Review without launching a browser.
3. Use unified and split modes, whitespace control, context expansion, and keyboard navigation.
4. Comment on an addition, deletion, range, file, and change.
5. Restart desktop and preserve the checkpoint pair and anchors.
6. Open evidence for the observed check and navigate to its run and sequence.
7. Modify the worktree from a shell and keep the pinned Review unchanged.
8. Return to the workbench and reattach the prior terminal.

Do not call this native Review complete unless evidence is visible beside at least one file, hunk,
comment, or check.

### Phase 4: make follow-up delivery recoverable

Scope:

- store selected comments and immutable Review inputs;
- replace client-side deliver then launch with one server-owned operation;
- add idempotency, launch correlation, recovery, and explicit failure states;
- update desktop, web, and CLI to use the same operation.

Likely files:

- `packages/domain/src/workbench/follow-up.ts`
- `packages/db/src/repos/follow-ups.ts`
- `packages/db/src/repos/review-comments.ts`
- `packages/sessions/src/engine.ts`
- `packages/api/src/contract.ts`
- `packages/api/src/workbench.ts`
- `apps/web/src/components/follow-up.tsx`
- desktop Review send dialog

Real-repository exit test:

1. Select two of four open comments and edit the instruction.
2. Deliver it and confirm only those comments become sent after the new run is persisted.
3. Retry after a client timeout with the same key and confirm no second run starts.
4. Crash before process launch and recover to a retryable failure.
5. Crash after process launch but before the final database write and reconcile the existing run.
6. Attempt delivery after the session became active and keep the bundle pending.

### Phase 5: harden the Service model

Scope:

- separate stable Services, attempts, forwards, and target observations;
- append an attempt on restart;
- declare browser scheme separately from transport;
- validate bind policy and return server-resolved endpoints;
- add sequence-addressed read-only logs;
- preserve controls after coding-agent completion;
- renew workspace TTL while leases remain, or show exact expiry if renewal fails;
- fix web `session-process` invalidation and recipe collision visibility;
- dogfood through CLI and web before desktop UI.

Likely files:

- `packages/domain/src/workbench/session-process.ts`
- `packages/domain/src/workbench/service-recipe.ts`
- new Service domain files
- `packages/db/src/schema/workbench.ts`
- `packages/db/src/repos/session-processes.ts`
- new Service repositories
- `packages/sessions/src/engine.ts`
- `packages/sessions/src/service-host.ts`
- `packages/sessions/src/recipes.ts`
- `packages/api/src/contract.ts`
- `packages/api/src/workbench.ts`
- `apps/cli/src/main.ts`
- `apps/web/src/components/services-card.tsx`
- `apps/web/src/lib/workbench-events.ts`

Real-repository exit test:

1. Run a declared Vite Service, open it, establish HMR, edit a component, and observe the update.
2. Restart twice and preserve three attempt records with separate run IDs and logs.
3. Complete and resume the coding-agent run without interrupting the retained Service.
4. Restart Mend and reconcile the process and forward.
5. Occupy the preferred host port and report endpoint movement.
6. Reap the workspace and retain read-only attempt logs.
7. Adopt Postgres without a browser scheme and offer only Copy endpoint and Remove forward.
8. Exercise UDP without claiming reachability before traffic is observed.
9. Reject wildcard, public, stale, and mixed bind lists. Accept loopback and selected private IPv4
   and IPv6 interfaces.
10. Expose a recipe collision rather than silently shadowing it.

### Phase 6: ship desktop Services

Scope:

- add a compact session Services control and drawer;
- add recipe launch, one-off run, adopted port, factual rows, Open, Copy, logs, restart, stop, and
  remove-forward actions;
- preserve controls after coding-agent completion;
- show stale observation times during disconnect;
- nest actionable Service observations under the owning session in Now;
- keep ordinary reachable Services out of the attention inbox.

Likely files:

- `apps/desktop/src/renderer/src/lib/api.ts`
- `apps/desktop/src/renderer/src/lib/queries.ts`
- `apps/desktop/src/renderer/src/lib/events.ts`
- `apps/desktop/src/renderer/src/components/terminal-pane.tsx`
- new desktop Services components
- `apps/desktop/src/renderer/src/routes/index.tsx`
- `apps/desktop/src/renderer/src/lib/now.ts`

Real-repository exit test:

Repeat the Vite, Postgres, UDP, resume, restart, endpoint movement, and private-device scenarios
entirely from desktop. Confirm that app quit stops nothing, Logs cannot send input, Open uses the
system browser, and a normal reachable Service does not become a standalone inbox row.

### Phase 7: add process-aware evidence

Scope:

- supervise and persist cursors for every recorded process attempt;
- add checkpoint process frontiers and telemetry gaps;
- update evidence lookup across coding-agent, shell, and Service runs;
- add direct, inferred, and unknown attribution;
- expose compliant machine passes and runnable proposed checks.

Likely files:

- `packages/domain/src/workbench/checkpoint.ts`
- `packages/db/src/repos/checkpoints.ts`
- `packages/db/src/repos/session-processes.ts`
- `packages/sessions/src/engine.ts`
- `packages/inference/src/session-tools.ts`
- `packages/inference/src/change-reader.ts`
- `packages/inference/src/change-suggester.ts`
- `packages/inference/src/tour-composer.ts`
- desktop Review inspector

Real-repository exit test:

1. Modify one file from the coding agent, one from a shell, and one from a Service.
2. Create checkpoints around the work.
3. Show `direct` only for a process-specific write event.
4. Show `inferred` for supported timing attribution and `unknown` when evidence is insufficient.
5. Introduce telemetry loss and show `latest Mend observed`, not an exact barrier.
6. Resume the coding agent and resolve evidence against the correct run after sequence numbers
   restart at one.
7. Run `Read this change` and emit no finding without a record span or runnable check.

## Failure, reconnect, security, and resources

### Failure and reconnect

- Tab switch, app close, and network loss detach only.
- Shell stop is idempotent and ends one process group.
- Server process discovery prevents local state from resurrecting dead processes.
- Connection loss is blindness, not exit. Keep the last observation and timestamp.
- A live worktree change never mutates a pinned Review.
- Delivery failure leaves selected comments unsent and retryable.
- Anchor mapping failures stay visible. They never delete or silently relocate comments.
- Mend restart reconciles processes, forwards, leases, and delivery attempts.

### Authorization

Add authorization and audit with each control slice. A review-only device token must not open a TTY,
send terminal input, stop a shell, run or stop a Service, bind or remove a port, or deliver a
follow-up.

Audit shell open, input, stop, Service bind, restart, stop, forward removal, Review comment write,
and follow-up delivery. Include actor, project, session, process, Service, checkpoint, and Sealant
run IDs.

### Resources

Normal workspaces currently receive a 12-hour TTL. Renew expiry while an agent, shell, or Service
lease remains live. If renewal fails, show the last successful renewal and known expiry. Stop the
workspace promptly after the last lease ends. Keep hot-workspace rearming separate from ordinary
retained-workspace renewal.

### TTY and logs

The existing bearer-bearing TTY WebSocket URL is an existing risk. Do not reuse it for Service URLs
or increase its lifetime. Prefer short-lived process-scoped attach tickets when that path is
revised.

Read-only logs must not accept input. Durable output must remain readable after process exit and
workspace reaping, with sequence bounds and telemetry-loss facts.

## Migration and rollout

### Legacy benches

Never reparent a bench process to another session. Its worktree and change have a different owner.

- expose each legacy bench as a visible migration-only session and change;
- preserve worktree, checkpoint, process, and run IDs;
- allow Review, stop, export or publication, and removal;
- do not allow new processes in a legacy bench;
- require every process to end and the change to be resolved before removal;
- show missing record facts instead of inventing history;
- test dirty, clean, live, duplicate, and partially missing benches.

### Existing Services

Add the stable Service, attempt, forward, and observation schema without fabricating history from
pre-stable mutable process rows. Discard those legacy Service rows during migration; their
previously overwritten run, forward, and reachability facts are not reliable enough to promote.

### Existing comments

Keep old file and line comments readable as `Legacy live-diff anchor`. New comments use slice-bound
anchors only.

### Rollout

1. Land decisions and server migrations.
2. Dogfood shell ownership and immutable Review in a real repository.
3. Enable desktop shell ownership after legacy bench detection exists.
4. Enable native Review after the P0 and minimum-evidence exit tests pass.
5. Enable atomic follow-up delivery for all clients.
6. Dogfood the new Service model through CLI and web.
7. Enable desktop Services.
8. Enable process-aware inference last.

## Test strategy

Add contract and domain tests for process ownership, stop idempotency, retained-workspace resume,
checkpoint-open idempotency, diff digest stability, deletion-side anchors, anchor mapping,
selected-comment follow-ups, delivery recovery, Service attempts, endpoint movement, bind policy,
TTL renewal, and adopted-Service restrictions.

Add API authorization tests for unauthenticated requests, review-only scope refusal, cross-session
ownership, idempotency replay, stale-state conflicts, audit creation, and decimal sequences above
`2^53`.

Add desktop tests for tab close versus detach, server-authoritative restoration, large scrollback
reconnect, native Review route persistence, keyboard routing while Ghostty has focus, deletion-side
comments, stale Review copy, post-completion Service actions, disconnect timestamps, and read-only
logs.

Use fault injection for Mend crashes before and after process launch, database failure after Sealant
accepts a process, SSE loss, workspace disappearance, stale handles, occupied host ports, bind-list
partial failure, missing telemetry, and client retry after timeout.

Every phase has a real-repository exit test. Fixtures alone cannot close a phase.

## Non-goals

- no hidden or writable project bench;
- no new product noun for manual work;
- no writable project utility workspace;
- no Service autostart;
- no listener event creating a Service;
- no listener discovery through container internals;
- no public Service ingress;
- no authenticated path-prefix proxy in the raw-forward design;
- no privileged in-app browser for repository code;
- no standalone Service inbox rows by default;
- no full IDE or arbitrary source editor;
- no staging, commit, discard, or publication controls in the first native Review release;
- no merge verdicts, confidence scores, or risk scores;
- no machine pass that gates human review;
- no evidence-free machine findings;
- no direct Sealant database, daemon, or private package access;
- no claim of durable terminal replay until record-backed replay works after workspace reaping;
- no claim of exact multi-process attribution until process cursors and checkpoint frontiers exist.

## Approved decisions

| ID  | Decision                                                                 | Approved decision                                                                                |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| D1  | Who owns writable interactive shells?                                    | The focused visible coding-agent session. No hidden bench.                                       |
| D2  | What does shell tab close do?                                            | Confirm and stop the process group. `Detach tab` is a separate context action.                   |
| D3  | Can the user start shells and Services after the coding agent completes? | Yes, while the retained workspace remains reachable.                                             |
| D4  | What does resume do with live supporting processes?                      | Reuse the retained workspace. Offer explicit stop-and-resume-fresh.                              |
| D5  | What anchors Review and comments?                                        | Checkpoint A, checkpoint B, and diff digest.                                                     |
| D6  | What makes follow-up delivery complete?                                  | The new PTY accepts the instruction and Mend persists the run membership and correlation.        |
| D7  | How is a Service created?                                                | Explicit recipe or action. Listener events may suggest, never create.                            |
| D8  | How is a Service exposed?                                                | Raw TCP or UDP on loopback and selected private interfaces, without Mend request authentication. |
| D9  | How is browser behavior declared?                                        | Optional `http` or `https` scheme separate from TCP or UDP transport.                            |
| D10 | What keeps a workspace alive?                                            | Any live agent, shell, or Service lease, with TTL renewal.                                       |
| D11 | Where do Services appear in Now?                                         | Nested under the owning session only when they need attention.                                   |
| D12 | When may native machine passes appear?                                   | After they use pinned inputs and obey the record-link or runnable-check rule.                    |

## Implementation checklist

1. [x] Record approved decisions in the canonical plan, desktop brief, Services design, and platform
       feedback.
2. [x] Remove hidden bench creation and ship honest shell stop, detach, discovery, restore, and
       resume behavior.
3. [x] Migrate legacy benches without reparenting or deleting dirty changes.
4. [x] Add immutable checkpoint-pair diff contracts and slice-bound comments.
5. [x] Prove the Review contract in web or CLI against a real repository.
6. [x] Ship native desktop Review with P0 diff controls, comments, and minimum honest evidence.
7. [x] Make follow-up delivery idempotent, atomic from the client perspective, and recoverable.
8. [x] Separate stable Services, process attempts, forwards, and observations.
9. [x] Enforce private bind policy, browser-scheme declaration, read-only logs, and workspace TTL
       renewal.
10. [ ] Ship desktop Services with factual state and retained-workspace controls.
11. [ ] Add process frontiers and process-aware evidence without false precision.
12. [ ] Run the real-repository exit test for every phase, then run `pnpm format:fix`, forced turbo
        typecheck, and forced turbo lint before publication.
