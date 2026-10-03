# t3code as a frontend: a gateway that speaks t3code's environment protocol

Status: proposed 2026-10-03. The owner's constraint, not re-opened here: supporting t3code changes
no core behaviour of Mend. Additive adapters are fine. Read against t3code `main` at `31a9da179`
(2026-10-03, after orchestration V2 landed as `de3439142`, pingdotgg/t3code#2829) and Mend at
`00504e19a`. `t3:` paths are in the t3code repository.

## Context

t3code (MIT) ships a web app, a desktop app and a mobile app in front of its own server. People who
already use those clients should be able to point them at Mend: see their sessions, watch a turn
live, send a follow-up, interrupt, answer a request, read the change.

### How a t3code client talks to its server

- **Transport.** One WebSocket at `/ws` carries Effect RPC in JSON (`Request`/`Ack`/`Interrupt`/
  `Eof`/`Ping` from the client, `Chunk`/`Exit`/`Defect`/`Pong` from the server, a ping every 5 s).
  The group is 173 methods, 27 of them streams. A small HTTP API sits beside it.
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

The gateway runs on `effect@4.0.0-rc.115` through a named pnpm catalog (`catalogs.t3`). It does not
import `@mend/api-contracts` (beta.93 schemas); it carries its own decoders for the handful of Mend
responses it reads. Nothing else in the monorepo moves.

### The vendored contract

`packages/t3-contracts` (`@mend/t3-contracts`) is a verbatim, MIT-attributed copy of
`t3:packages/contracts/src` (99 files, depends on `effect` only), plus t3code's default keybindings.
A copy script writes it from a pinned nightly tag and records the tag and SHA. It is never edited by
hand. The first pin is `v0.0.46-nightly.20261003.2623`.

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

Review comments, handoffs, context packs and landing have no t3code surface and stay in Mend's own
clients.

### The surface

Every method in t3code's RPC group is registered. A test asserts the registered set equals the
vendored group.

| t3code                                                                                                                                                                                   | Phase | From Mend                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| descriptor, `/oauth/token`, WS ticket, `/api/auth/session`                                                                                                                               | 0     | constants; claim via `POST /api/pair`; a gateway-local single-use 30 s ticket; `GET /api/me/devices`                     |
| `subscribeServerConfig`, `server.getConfig`, `subscribeServerLifecycle`                                                                                                                  | 0     | config built from `GET /api/harnesses/models`; lifecycle `welcome` (`bootstrapStatus: "complete"`)                       |
| `orchestration.subscribeShell`, `GET /api/orchestration/shell`                                                                                                                           | 1     | projects and sessions, kept live from Mend's SSE                                                                         |
| `orchestration.subscribeThread`, thread snapshots                                                                                                                                        | 1     | the session, its turns, items (paged by `after=`) and requests                                                           |
| `message.dispatch`                                                                                                                                                                       | 1     | `POST /sessions/:id/turns`; when the session is not live, `POST /sessions/:id/launch` with its recorded protocol options |
| `run.interrupt`, `queued-run.cancel`                                                                                                                                                     | 1     | `POST /turns/:id/interrupt`                                                                                              |
| `runtime-request.respond`, `thread.user-input.dismiss`                                                                                                                                   | 1     | `POST /requests/:id/respond` (dismiss answers `cancel`)                                                                  |
| `review.getDiffPreview`, `getDiffFileContents`                                                                                                                                           | 1     | `GET /changes/:id/diff` for the thread's worktree                                                                        |
| `orchestration.launchThread`, rename, delete, images, `@`-mentions, VCS status                                                                                                           | 2     | session create and launch, label, delete, images, project files, change stats                                            |
| queued-run edit and reorder, `queue.resume`                                                                                                                                              | 2     | the gateway's queue                                                                                                      |
| per-turn diffs, worktree file reads, terminal, runtime-mode switch                                                                                                                       | 3     | two additive reads (below); `/api/tty` with a `tty` ticket; the next launch                                              |
| model or provider switch mid-thread, plan mode, rollback, fork, delegated tasks, PR watch, `git.*`, `vcs.*`, preview, provider install and auth, scheduled tasks, settings writes, usage | never | capability off, or the method's typed refusal; streams that never emit                                                   |

### Choices inside the gateway

- **The gateway holds the queue.** It never submits a second turn to Mend while one is open; it
  queues follow-ups itself and submits them in order. An interrupt therefore holds the queue as
  t3code asks, and edit, reorder and resume come for free. Queued messages are visible only in
  t3code until submitted. In phase 1 the queue lives in memory; phase 2 persists it.
- **Follow-up to a stopped session relaunches, never resumes.** The gateway calls `/launch`, as the
  Slack runner does (`apps/api/src/slack-runner.ts:1553`), and names no permission mode. Mend reuses
  the mode its last protocol agent recorded (the resume fix below), so an `ask` session stays `ask`.
  Neither the Slack runner nor the gateway carries the mode itself.
- **State.** Thread and message id maps, the persisted queue and archive flags live in a
  `node:sqlite` file the gateway owns. No Mend migration.
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

Off by default. Enabled from `mend server setup`, bound to loopback, its own listener and origin. A
private-network or public exposure goes through the public exposure gate (ADR 0004) as its own
entry; publicly it sits behind the edge on its own subdomain. The first supported client is t3code
desktop (a `v0.0.46` nightly) against a loopback or private gateway. The hosted `app.t3.codes`
follows once the edge serves the gateway over HTTPS.

Pairing needs no Mend UI change. A pairing code comes from Mend's existing
`POST /api/me/devices/pairings`; `mend t3 pair` creates one with the person's CLI login and prints a
t3code-shaped `https://<gateway>/pair#token=<code>` and a QR code for mobile. The gateway's
`/oauth/token` claims it through `POST /api/pair` and keeps the device token it gets back.

### Protocol churn

- The pin is a nightly tag, never `main`; clients ship per tag.
- Every outbound frame is encoded through the vendored schemas, so a mapping bug fails in the
  gateway, not as a defect in a client.
- Golden frames recorded from a real t3code server at the pinned tag.
- In CI, t3code's own `client-runtime` (test-only) drives the gateway headless; a Playwright smoke
  pairs the t3code web build at the tag.
- A scheduled job diffs `packages/contracts/src` at the newest nightly against the pin and opens an
  issue. Bumps are deliberate.
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
  equivalent; the capability flags say so instead of failing.
- The gateway owns a second, small state file. Losing it loses only queued messages, archive flags
  and t3code-side ids; Mend's records are unaffected.
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
  pairing printed by `mend t3 pair`.
- 2026-10-03: Mend has no `GET /api/me`. `/api/auth/session` checks the device token with
  `GET /api/me/devices` and takes the person from the `POST /api/pair` answer; no new Mend route.
- 2026-10-03: the Slack runner never carried the recorded permission mode. The resume fix makes any
  relaunch that names no mode reuse the last protocol agent's, which covers Slack and the gateway.
