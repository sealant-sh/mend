# t3code as a frontend: a gateway that speaks t3code's environment protocol

Status: accepted 2026-10-03; built in 0.36 (phases 0 to 4, mend#494 to mend#727). The owner's
constraint, not re-opened here: supporting t3code changes no core behaviour of Mend. Additive
adapters are fine. Read against t3code `main` at `31a9da179` (2026-10-03, after orchestration V2
landed as `de3439142`, pingdotgg/t3code#2829) and Mend at `00504e19a`. `t3:` paths are in the t3code
repository.

## Context

t3code (MIT) ships a web app, a desktop app and a mobile app in front of its own server. People who
already use those clients should be able to point them at Mend: see their sessions, watch a turn
live, send a follow-up, interrupt, answer a request, read the change.

### How a t3code client talks to its server

- **Transport.** One WebSocket at `/ws` carries Effect RPC in JSON (`Request`/`Ack`/`Interrupt`/
  `Eof`/`Ping` from the client, `Chunk`/`Exit`/`Defect`/`Pong` from the server, a ping every 5 s).
  The group is 188 methods, 29 of them streams (173 and 27 at the first pin). A small HTTP API sits
  beside it.
- **Remote servers are a public seam.** Desktop, mobile and the hosted app add a server by pairing
  URL (`…/pair#token=`) or host plus pairing code (`t3:packages/shared/src/remote.ts:188-245`). The
  base URL is always forced to path `/` (`remote.ts:100-130`), so a server needs its own origin.
- **Handshake.**
  1. `GET /.well-known/t3/environment` returns a descriptor whose `orchestrationProtocolVersion`
     must equal the client's exactly (`t3:packages/client-runtime/src/connection/compatibility.ts`).
     It is `2` on `main` and in `v0.0.46` nightlies; stable `v0.0.45` speaks `1`.
  2. `POST /oauth/token` exchanges the pairing credential for a bearer
     (`t3:packages/contracts/src/auth.ts:186-205`).
  3. On every connect, `POST /api/auth/websocket-ticket`, then
     `GET /ws?wsTicket=…&orchestrationProtocol=2`. Without the parameter the server answers 426
     (`t3:apps/server/src/ws.ts:3730-3742`).
  4. The connection is ready only once `subscribeServerConfig` emits a `snapshot` with the
     descriptor's `environmentId` (`t3:packages/client-runtime/src/rpc/session.ts:265-301`).
- **Orchestration V2 subscriptions.** `orchestration.subscribeShell` and
  `orchestration.subscribeThread` emit `snapshot | synchronized | event{sequence, event}`. Events
  are whole-entity upserts that the client replaces by id
  (`t3:packages/client-runtime/src/state/orchestrationV2Projection.ts:153-286`). Events at or below
  the last sequence are dropped, and a snapshot replaces the projection and resets the sequence
  (`t3:packages/client-runtime/src/state/threads.ts:450,583-608`), so a fresh snapshot at any time
  is a legal reset. Streaming text arrives as the growing full `text` with `streaming: true`.
- **Capabilities.** Most features are switched by flags on the provider and server config
  (`requiresNewThreadForModelChange`, `supportedRuntimeModes`, `supportsConversationRollback`, …;
  `t3:packages/contracts/src/server.ts:225-232`).
- **Unknown methods are fatal.** A method the server does not register answers with a defect; the
  client's durable subscription fails and is not retried
  (`t3:packages/client-runtime/src/rpc/client.ts:297-348`). Typed failures are retried with backoff.
  So a server must register every method and refuse what it lacks with the method's own typed error.

### What stands between Mend and those clients

- **Effect.** t3code is on `effect@4.0.0-rc.115`; Mend is on `4.0.0-beta.93`. The RPC wire is not
  compatible: rc.115 clients send numeric request ids and match replies by the echoed id, and the
  beta.93 server echoes `String(requestId)`, so replies never resolve.
- **Queue on interrupt.** Every t3code interrupt sends `holdQueue: true`
  (`t3:packages/client-runtime/src/operations/commands.ts:804`). Mend dispatches the next queued
  turn when a turn ends (`packages/sessions/src/protocol-host.ts:216`).
- **Resume drops `ask`.** A follow-up to a stopped protocol session, and
  `POST /sessions/:id/resume`, relaunch with `permissionMode: "bypass"`
  (`packages/sessions/src/engine.ts:11585,11684`). A session that asked for approval comes back
  without it. This is a Mend defect independent of t3code.

## Decision

### A gateway, not a provider

Mend gets a new app, `apps/t3-gateway` (`@mend/t3-gateway`). To a t3code client it is a t3code
environment. Toward Mend it is an ordinary HTTP and SSE client of `/api`, calling with the pairing
person's own device token. Mend stays the only source of truth for projects, sessions, worktrees,
records and checkpoints, and its access rules apply unchanged because every call is the person's
own.

A t3code environment is a whole server, so a person can keep their own t3code server beside Mend in
the same client; nothing here has to merge the two.

### Effect on its own catalog

The gateway runs on t3code's Effect (`4.0.2` since the 2026-10-10 pin; `rc.115` before) through a
named pnpm catalog (`catalogs.t3`). It does not import `@mend/api-contracts` (beta.93 schemas); it
carries its own decoders for the handful of Mend responses it reads. Nothing else in the monorepo
moves.

### The vendored contract

`packages/t3-contracts` (`@mend/t3-contracts`) is a verbatim, MIT-attributed copy of
`t3:packages/contracts/src` (99 files, depends on `effect` only), plus t3code's default keybindings.
A copy script writes it from a pinned tag and records the tag and SHA. It is never edited by hand.
The first pin was `v0.0.46-nightly.20261003.2623`; the current one is in
`packages/t3-contracts/t3code.pin.json`.

### Concepts

| t3code                      | Mend                                                                              |
| --------------------------- | --------------------------------------------------------------------------------- |
| environment                 | one Mend instance, through one gateway; a stable `environmentId`                  |
| project                     | a project the person can see; `workspaceRoot` is its store path                   |
| thread                      | a protocol-mode session (codex, claude); its worktree directory is `worktreePath` |
| provider instance           | the session's harness (`codex` → driver `codex`, `claude` → `claudeAgent`)        |
| run (a t3code turn)         | an agent turn; queued, running, completed, interrupted, failed, cancelled map 1:1 |
| user message                | the turn's input                                                                  |
| assistant message, activity | agent items, ordered by turn ordinal, then creation time                          |
| runtime request             | an agent request (exists only under `permissionMode: ask`)                        |
| runtime mode                | permission mode: `full-access` ↔ `bypass`, `approval-required` ↔ `ask`            |
| checkpoint                  | a `turn-boundary` checkpoint, matched to its turn by session and time             |
| changes panel               | the change (one per worktree)                                                     |

Review comments, session summaries and context packs have no t3code surface and stay in Mend's own
clients. Landing has one. t3code's git panel pushes a thread's change and opens its pull request
through Mend's landing, as the change's owner, and its remote status comes from the landing record.
Mend never moves the thread's branch and never commits it alone (ADR 0007), so the panel's other
writes are refused in Mend's words.

### The surface

Every method in t3code's RPC group is registered. A test asserts the registered set equals the
vendored group.

| t3code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Phase | From Mend                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| descriptor, `/oauth/token`, WS ticket, `/api/auth/session`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 0     | constants; claim via `POST /api/pair`; a gateway-local single-use 30 s ticket; `GET /api/me/devices`                                                            |
| `subscribeServerConfig`, `server.getConfig`, `subscribeServerLifecycle`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 0     | config built from `GET /api/harnesses/models`; lifecycle `welcome` (`bootstrapStatus: "complete"`)                                                              |
| `orchestration.subscribeShell`, `GET /api/orchestration/shell`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1     | projects and sessions, kept live from Mend's SSE                                                                                                                |
| `orchestration.subscribeThread`, thread snapshots                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 1     | the session, its turns, items (paged by `after=`) and requests                                                                                                  |
| `message.dispatch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 1     | `POST /sessions/:id/turns`; when the session is not live, `POST /sessions/:id/launch` with its recorded protocol options                                        |
| `run.interrupt`, `queued-run.cancel`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 1     | `POST /turns/:id/interrupt`                                                                                                                                     |
| `runtime-request.respond`, `thread.user-input.dismiss`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 1     | `POST /requests/:id/respond` (dismiss answers `cancel`)                                                                                                         |
| `review.getDiffPreview`, `getDiffFileContents`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 1     | `GET /changes/:id/diff` for the thread's worktree                                                                                                               |
| `orchestration.launchThread`, rename, delete, images, `@`-mentions, VCS status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 2     | session create and launch, label, delete, images, project files, change stats                                                                                   |
| queued-run edit and reorder, `queue.resume`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 2     | the gateway's queue                                                                                                                                             |
| per-turn diffs, worktree file reads, terminal, runtime-mode switch, reasoning effort                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 3     | two additive reads (below); `/api/tty` with a `tty` ticket; the next launch                                                                                     |
| archive, settle, snooze, pins and order, automatic settlement, read state (`thread.visit`, `thread.mark-unread`)                                                                                                                                                                                                                                                                                                                                                                                                                                               | 3     | the gateway's own state, per person                                                                                                                             |
| `git.runStackedAction` push and create PR, VCS status remote half                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 4     | `POST /sessions/:id/land`, as the change's owner; `GET /changes/:id/landings`                                                                                   |
| mid-turn steering, model or provider switch mid-thread, the Fast service tier, plan mode, rollback, fork, delegated tasks, PR watch, `git.*` and `vcs.*` writes but push and a PR, preview, devices, provider install and auth, scheduled tasks, settings writes, usage and limits, diagnostics, self-update, T3 Connect, MCP apps, `/feedback`, non-image attachments, file writes, project add, clone, import, rename and removal, open in editor, pairing administration (Mend's), provider slash commands (absent; Mend's skills are listed per workspace) | never | the scope withheld, capability off, or the method's typed refusal; streams that never emit, or answer none (scheduled tasks) or a hub that never runs (devices) |

### Choices inside the gateway

- **The gateway holds the queue.** It never submits a second turn to Mend while one is open; it
  queues follow-ups itself and submits them in order. An interrupt therefore holds the queue as
  t3code asks, and edit, reorder and resume come for free. Queued messages are visible only in
  t3code until submitted. In phase 1 the queue lives in memory; phase 2 persists it.
- **Follow-up to a stopped session relaunches, never resumes.** The gateway calls `/launch`, as the
  Slack runner does (`apps/api/src/slack-runner.ts:1553`), and names no permission mode. Mend reuses
  the mode its last protocol agent recorded (the resume fix below), so an `ask` session stays `ask`.
  Neither the Slack runner nor the gateway carries the mode itself.
- **State.** Thread and message id maps, the persisted queue, each person's archive, settle, snooze,
  pin and order, read state and model preferences (favorites, hidden models, model order), and the
  mode, model and effort chosen for an agent's next start live in a `node:sqlite` file the gateway
  owns. No Mend migration. A settings patch of model preferences alone needs
  `orchestration:operate`, not t3code's `settings:write`: t3code keeps them for the machine, the
  gateway for one person.
- **Scopes.** A paired client is granted the scopes of t3code's standard grant the gateway backs.
  They are `orchestration:*`, `terminal:*`, `filesystem:read` and `source-control:write`. t3code
  renders a control whose scope is withheld as inert, so a refused feature never looks live. A grant
  stored before is narrowed when it is read. Pairings stored while `source-control:write` was
  withheld get it back once, from the state file's migration 16.
- **Model, effort and tier.** Mend sets the model and effort per launch and reuses what the agent
  recorded. A model or reasoning effort changed on a started thread applies from the launch the
  gateway makes when a message finds the agent stopped, as the runtime mode does; a relaunch on
  another model resumes the same conversation. Mend's own restarts, such as a hand-over to another
  person's login, reuse what the agent ran on, so the thread names the stop it waits for. A protocol
  agent takes no service tier, so the gateway offers none and refuses Fast. It also refuses another
  provider.
- **Projection.** One Mend SSE stream per paired person feeds an entity builder. The gateway diffs
  entities, stamps its own sequence, and sends a fresh snapshot after a restart or on removals.
- **Steering rules are Mend's.** A session the person cannot steer appears read-only: commands are
  refused with t3code's authorization error. Sessions started through the gateway record origin
  `"mend"`; no new origin literal.
- **Out of the MVP.** PTY and shell sessions are hidden. The `root` workspace strategy is refused.

### Additive reads in Mend (phase 3)

Two read endpoints, neither changing behaviour:

- `GET /api/worktrees/:id/diff?from=&to=`, a checkpoint-range diff over the existing
  `WorktreeReads.diffRange` and `diffFileFacts` (`packages/sessions/src/worktree-reads.ts:115-128`).
- A worktree file read for `projects.readFile` and content search.

Checkpoints stay unlinked to turns; the gateway correlates them by session and time, and says so
when sessions share a worktree.

### Access

Off by default. Enabled from `mend server setup`, its own listener and origin, published where
Mend's web port is: loopback for one machine, the tailnet or LAN address for a private network.
Publicly its port stays on loopback and the edge serves it on its own subdomain
(`--t3-gateway-origin`). Each placement is an entry of the public exposure gate (ADR 0004, item 14).
The first supported client is t3code desktop (a `v0.0.46` nightly) against a loopback or private
gateway. The hosted `app.t3.codes` follows once the edge serves the gateway over HTTPS.

The packaged gateway runs through `prlimit`, nice 10, `chroot`, and `setpriv` as its own uid, with a
256 MiB heap, 2 GiB of data, 1,024 file descriptors, and 256 processes. The data limit counts V8's
virtual address reservations as well as allocations. It leaves room for concurrent find and
regex-highlight workers beside the loaded gateway. The Linux packaging regression starts the real
gateway server and both worker paths through this chain with 256 MiB of parent buffers, including
one find and three overlapping regex highlights. Both worker sites reserve a 64 MiB code range and
share one process-wide semaphore of four permits. A pooled find worker retains its permit while
idle; a permit is returned only after termination completes. Waiting for a highlight permit counts
against its existing 250 ms budget. The four-worker load left over 850 MiB of data headroom in the
local exact-chain measurement.

Pairing needs no Mend UI change. A pairing code comes from Mend's existing
`POST /api/me/devices/pairings`; `mend pair` creates one with the person's CLI login and prints the
gateway's address and a t3code-shaped `<gateway>/pair#token=<code>` link (built as `mend pair`, not
the `mend t3 pair` first planned). The gateway's `/oauth/token` claims it through `POST /api/pair`
and keeps the device token it gets back.

### Protocol churn

- The pin is a nightly or preview tag, never `main`; clients ship per tag.
- Every outbound frame is encoded through the vendored schemas, so a mapping bug fails in the
  gateway, not as a defect in a client.
- Golden frames recorded from a real t3code server at the pinned tag.
- In CI, t3code's own `client-runtime` (test-only) drives the gateway headless; a Playwright smoke
  pairs the t3code web build at the tag.
- A scheduled job diffs `packages/contracts/src` at the newest nightly or preview against the pin
  and opens an issue. Bumps are deliberate.
- The descriptor reports `serverVersion` as `<t3code tag>+mend.<n>`. A protocol bump on the client
  side is refused cleanly by t3code as an unsupported server until the gateway follows.

## Considered

- **Mend as a t3code provider.** t3code's drivers are compiled in (`BUILT_IN_DRIVERS`,
  `t3:apps/server/src/provider/builtInDrivers.ts:53`), so it needs a fork. t3code's server would
  keep its own event store and checkpoint the worktree itself, a second source of truth beside
  Mend's. Turns started from Mend's web app, CLI or Slack would never appear in t3code.
- **An ACP shim.** The same two sources of truth, plus a stdio process per thread; still needs a
  dedicated driver upstream to be reliable.
- **Upgrading Mend to Effect rc.115 first, then a route group in `apps/api`.** Still needs its own
  origin, ties a third-party protocol's release cadence to Mend's server, and is a monorepo-wide
  upgrade to unblock one app. Revisit when Mend moves to rc for its own reasons; the gateway can
  then fold in.
- **Porting t3code's contracts to beta.93.** The wire is incompatible as described above.

## Consequences

- t3code users can use Mend without a fork, through t3code's own remote-environment flow.
- Mend core is untouched through phase 2. Phase 3 adds two read endpoints.
- Mid-turn steering, per-turn model changes, rollback and fork are off in t3code because Mend has no
  equivalent; the capability flags say so instead of failing. A model or reasoning effort waits for
  the launch a message makes once the agent has stopped.
- The gateway owns a second, small state file. Losing it loses only queued messages, archive, settle
  and snooze flags, read state and t3code-side ids; Mend's records are unaffected.
- Following t3code costs a pin bump per nightly we choose to support, guarded by the drift job and
  the client-runtime tests.
- Only `v0.0.46`-and-later clients connect until t3code ships protocol 2 as stable.

## Delivery

| Phase | Scope                                                                                                                                                                                                                                                                                                                                                                  | Size         |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 0     | vendored contracts at the pin; descriptor, pairing, ticket, `/ws` on rc.115, config snapshot, lifecycle, empty shell, the full refusal table. Done when t3code desktop pairs and shows an empty, healthy environment                                                                                                                                                   | 2–3 days     |
| 1     | per-person SSE fan-in; shell and thread projection; dispatch with relaunch; interrupt; respond; queue in memory; change diff; id map. Done when a person lists sessions, watches a codex or claude turn live, follows up (also after an idle stop), interrupts, approves under `ask`, reads the diff, and sees sessions started from Mend's web app, CLI or Slack live | 1.5–2 weeks  |
| 2     | `launchThread`, rename, delete, images, `@`-mentions, VCS status, persisted queue with edit and reorder, replay after a sequence                                                                                                                                                                                                                                       | about 1 week |
| 3     | the two additive reads and per-turn diffs; terminal over `/api/tty`; runtime-mode switch; archive                                                                                                                                                                                                                                                                      | about 1 week |
| 4     | `mend server setup` opt-in, exposure gate entry, docs page, drift job                                                                                                                                                                                                                                                                                                  | 3–5 days     |

Separately, and first: fix resume dropping `ask` (`packages/sessions/src/engine.ts:11585,11684`) in
its own pull request.

## Decision log

- 2026-10-03: a gateway on its own origin, not a provider or an ACP shim.
- 2026-10-03: Effect `rc.115` on a named catalog for the gateway only.
- 2026-10-03: the gateway holds the queue.
- 2026-10-03: two additive read endpoints in phase 3 count as no core behaviour change.
- 2026-10-03: the resume `bypass` defect is fixed on its own, before phase 1.
- 2026-10-03: first client t3code desktop against loopback or private; hosted app later.
- 2026-10-03: gateway state in its own `node:sqlite` file.
- 2026-10-03: origin `"mend"`; others' sessions read-only; PTY sessions hidden; `root` refused;
  pairing printed by `mend t3 pair` (as built: `mend pair`).
- 2026-10-03: Mend has no `GET /api/me`. `/api/auth/session` checks the device token with
  `GET /api/me/devices` and takes the person from the `POST /api/pair` answer; no new Mend route.
- 2026-10-03: the Slack runner never carried the recorded permission mode. The resume fix makes any
  relaunch that names no mode reuse the last protocol agent's, which covers Slack and the gateway.
- 2026-10-10: a device revoked in Mend ends its bearers in the state file before anything closes.
  The box check found the bearer of a revoked device still getting tickets: the revocation was
  written after the refusal tore the hub down, and the teardown interrupted it. A ticket now asks
  `GET /api/me/devices` first, and a start checks every paired device once.
- 2026-10-10: the pin moves to `v0.0.46-nightly.20261010.2922`, and the `t3` catalog with it to
  Effect `4.0.2` (stable; `effect/unstable/*` became `effect/http`, `effect/rpc`, `effect/socket`,
  `effect/http-api`). t3code split its scopes into granular permissions and put an
  `RpcScopeAuthorization` middleware on every RPC; the gateway serves it from a copy of t3code's own
  scope map, and reads a grant from before the split as the standard grant it stood for.
- 2026-10-17: the pin moves to the preview `v0.1.1-preview.20261017.3254`, and the `t3` catalog with
  it to Effect `4.0.5`. The orchestration protocol is still 2 and pairing is unchanged. t3code
  folded its administrative scopes into the standard client grant; the gateway's grant does not
  change. Its 11 new RPCs and the thread transcript route are registered, and the vendored client
  state now brings the `@t3tools/shared` files it imports, under `t3-shared/`.
- 2026-10-24: the pin moves to the release `v0.1.2` (044f07257c96). The orchestration protocol is
  still 2. t3code removed the four `peerLinks.*` RPCs and added `pullRequests.changeBreakdown`,
  `device.easAccount` and `projects.listIgnoredFiles`. `docs/t3code-support-matrix.md` grades the
  gateway against it.
- 2026-10-11: the gateway follows the web port's exposure instead of loopback only, which needed a
  tunnel per client (owner's call). Private installs publish it on the web port's address; behind
  the edge it is served on a host of its own, since t3code forces a server's base path to `/`.
  `mend pair` prints the address T3 Code's Remote link takes; t3code's SSH mode starts t3code's own
  server and is not a way to reach Mend.
- 2026-10-11: the gateway grants only the scopes it backs. Granting t3code's whole standard set made
  refused features look live; a Files-tab edit was lost to a refused `projects.writeFile` with only
  a console warning. Stored grants are narrowed on read.
- 2026-10-17: the gateway grants `source-control:write`. The git panel's push and create PR land the
  thread's change through `POST /sessions/:id/land`, and the remote half of VCS status reads
  `GET /changes/:id/landings`. Everyone who can see the change reads the same counts. After a push
  the record cannot say nothing is new, so Push stays offered and Mend answers "nothing new" itself.
  A landing by anyone but the change's owner is refused with Mend's own words. A refresh the owner
  asks for has Mend ask GitHub about the pull request, at most once a minute. Commit alone, a new
  branch, a selection of files, the panel's commit message, branch switch and create, pull and pull
  request checkout are refused in Mend's words. The grant is stored per pairing, so migration 16
  widens only the pairings narrowed while the scope was withheld, never one made later that asked
  for less.
- 2026-10-18: `hasWorkingTreeChanges` is true only while the change holds work no landing took: the
  change has files, and nothing has landed or Mend observed files that differ from the last landed
  checkpoint (`changed-since-landing`). Before a landing t3code's main action reads "Commit, push &
  PR", which lands, since Mend commits when it lands. Once everything has landed it is false, so
  t3code offers no commit and Push stays offered for Mend to answer.
- 2026-10-11: read state is the gateway's, per person, and `threadVisitedTracking` says so. The
  shell sent `lastVisitedAt: null`, which t3code reads as server-tracked, and every `thread.visit`
  was refused, so no thread ever showed as unread.
- 2026-10-11: a reasoning effort changed on a started thread applies from the agent's next start; a
  changed service tier is refused. Mend records the effort with the agent and none of the tier.
- 2026-10-17: a model picked on a started thread applies from the agent's next start, the way the
  effort does, and `requiresNewThreadForModelChange` is off. Mend resumes a protocol agent by its
  provider id whatever the model, so the conversation survives. The service tier stays refused: a
  protocol launch ignores `speed`, so no tier the gateway names would reach the agent.
- 2026-10-17: a model or effort chosen on a started thread waits for the launch a message makes once
  the agent has stopped, and the thread says so in those words. Mend's own restarts copy the last
  agent's options: a hand-over to another person under shared control kept the old model while the
  thread promised the new one from "the agent's next start". The gateway cannot change what a
  hand-over runs on without stopping work Mend waits for, so the promise names the start the gateway
  makes. The gateway also stopped offering the service tier: a thread launched on Fast ran on
  Standard and showed Fast. Mend core needs `speed` on the protocol path before the tier returns.
