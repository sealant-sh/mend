# The T3 Code gateway, phases 0 and 1

- **Release:** 0.36
- **Status:** on main. Phase 0: mend#494 and mend#495, merged 2026-10-03. Phase 1: mend#508, #509,
  #510 and #511 (stack #512), merged 2026-10-04. Phases 2–4 are planned. The resume fix it depends
  on is mend#493, merged 2026-10-03.
- **PRs:** mend#494, mend#495, mend#508, mend#509, mend#510, mend#511 (with mend#493 as the
  prerequisite).
- **Decision records:** docs/adr/0012-t3code-gateway.md. Also docs/t3code-parity.md (the
  phone-parity list), docs/adr/0004-access-without-a-private-network.md (exposure) and
  docs/adr/0013-whoever-sends-a-turn-pays.md (proposed; whose login a turn spends).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`. The gateway does not touch Core or sealantd.

## Why it exists

Some people already use t3code's desktop, web or mobile client. Before the gateway, the only way to
use Mend from one of those clients was a fork of t3code: its provider drivers are compiled in. The
alternative was to leave t3code, switch to Mend's own web app, phone app or CLI, and lose the client
they know. The owner asked for t3code's clients to work against Mend with no change to Mend's core
behaviour (ADR 0012, "Context"). Those clients should see a person's Mend sessions, watch a turn
live, send a follow-up (also after the 15-minute idle stop), interrupt, answer an approval or a
question, and read the change. docs/t3code-parity.md maps each feature of Mend's phone app onto
t3code.

Who hits it: anyone with a t3code `v0.0.46` nightly (orchestration protocol 2) who has a Mend
account. It is off unless someone runs the gateway, and nothing in Mend starts it
(`apps/t3-gateway/src/bin.ts:8`).

## What it does

**What a person does, and what they see:**

- **Pairing.** An operator runs `mend-t3-gateway` beside a Mend server. The person mints a pairing
  code in Mend (`POST /api/me/devices/pairings`, or the devices page) and adds a remote environment
  in t3code: either the gateway's host plus the code, or `http://<gateway>/pair#token=<code>`. The
  environment appears in t3code under the label `Mend` (`MEND_T3_GATEWAY_LABEL`). In Mend's device
  list the client shows as `t3code · <client label>`, or `t3code` when the client sends no label.
- **The sidebar (shell).** It lists every project the person can see in Mend and every session whose
  current agent is a `codex` or `claude` protocol-mode process.
  - Thread title: the session's label, else the first line (at most 80 characters) of its first
    non-harness turn's input, else `Codex session` or `Claude session`.
  - Status: the latest run's status, else `idle`.
  - A turn that is running while its agent waits on a person reads `waiting`.
  - PTY and shell sessions, and sessions of other harnesses (opencode, pi), are not shown.
- **A thread.** It shows each Mend turn as a run:
  - the turn's input as the user message (a turn the agent opened on its own is a system message);
  - assistant text and reasoning, streaming while in progress;
  - commands, file changes and web searches, read from the harness's own item;
  - every other item as a tool row named by the harness;
  - approval and question requests;
  - when a turn failed, its error after everything it did.
- **Sending a message** in a thread queues it in the gateway. It goes to Mend once no Mend turn is
  open on the session. If the agent stopped (the idle stop, or a stop), the gateway launches the
  session again first. While it waits, the run reads `queued`; while the session relaunches,
  `preparing`; while Mend takes it, `starting`.
- **Refusals,** in t3code's error surfaces:
  - A session the person may not steer:
    `This session is not yours to steer. Its owner can turn on shared control in Mend.` (t3code's
    authorization error).
  - Images or files: `Mend's t3code gateway does not send images or files yet.`
  - Steering a running turn:
    `Mend cannot steer a turn while it runs. Send the message to run after it instead.`
  - Holding a message for later: `Mend's t3code gateway does not hold a message back for later.`
  - An empty message: `The message is empty.`
- **A message Mend did not take** shows as a failed run with an error item in the thread. The text
  is Mend's reason or the gateway's:
  - `Mend did not bring the session's agent up within 10 minutes.`
  - `Mend could not keep the session's agent running to take this message.`
  - `The session is gone from Mend, or is no longer a protocol session.`
  - `Mend no longer accepts the device that sent this message.`
  - `Every device of this person was revoked in Mend.`
- **Stop (interrupt).**
  - It interrupts the Mend turn. t3code always sends `holdQueue: true`, so the queued messages then
    wait until the client resumes the queue.
  - Interrupting a run that is still in the gateway's queue takes it back. It reads `cancelled`.
- **Approvals.** `Approve`, `Approve for this session` and `Decline` answer through Mend. t3code's
  `acceptAlways` becomes Mend's `accept-for-session`. A question's answers go to Mend as lists of
  strings. Dismissing a question answers `cancel`.
- **The changes panel** shows the thread's change against its base, as one source titled
  `Changes · <Mend's observation label>` (for example `Changes · observed at capture 18 · seq 22`),
  or `Changes` when Mend sends no label.
  - A whole file can be expanded only when it was added or deleted.
  - Expanding a modified file answers
    `Mend serves the change as a patch; whole files of a changed file are not available yet.`

**Defaults and settings** (`apps/t3-gateway/src/config.ts:43-66`):

| Variable                     | Default                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `MEND_T3_GATEWAY_MEND_URL`   | `http://127.0.0.1:3101`                                                                            |
| `MEND_T3_GATEWAY_HOST`       | `127.0.0.1`                                                                                        |
| `MEND_T3_GATEWAY_PORT`       | `3120`                                                                                             |
| `MEND_T3_GATEWAY_STATE_PATH` | `$XDG_STATE_HOME/mend/t3-gateway/state.sqlite`, else `~/.local/state/mend/t3-gateway/state.sqlite` |
| `MEND_T3_GATEWAY_LABEL`      | `Mend`                                                                                             |

- A hub outlives its last socket by 2 minutes (`hub.ts:1543`).
- Queue waits (`queue.ts:101-106`): launch deadline 10 min; retry backoff 1 s doubling to 15 s; send
  deadline 2 min.

**In scope.**

- Phase 0:
  - the descriptor;
  - pairing through `/oauth/token`;
  - bearer sessions;
  - WebSocket tickets;
  - `/ws` on Effect `4.0.0-rc.115`;
  - the server config built from Mend's model catalog;
  - the lifecycle `welcome`;
  - `server.probe`;
  - a typed refusal for every method not served.
- Phase 1:
  - the per-person projection hub fed by Mend's SSE;
  - the shell, over RPC and HTTP;
  - thread snapshots and live thread events, over RPC and HTTP;
  - `message.dispatch` with relaunch;
  - the in-memory queue (`queued-run.cancel`, `queue.resume`);
  - `run.interrupt`, `runtime-request.respond` and `thread.user-input.dismiss`;
  - `review.getDiffPreview` and `review.getDiffFileContents`;
  - the turn id map in the state file;
  - device gating: a 401 from Mend refuses the device.

**Out of scope** (ADR 0012, "The surface" and "Delivery"; not bugs):

- **Phase 2:**
  - `orchestration.launchThread` (start a session with a model, effort, tier or base branch);
  - rename, delete, images and `@`-mentions;
  - VCS status;
  - a persisted queue with edit and reorder;
  - replay after a sequence (every subscription opens with a full snapshot);
  - origin `"mend"` for sessions the gateway starts;
  - refusing the `root` worktree strategy.
- **Phase 3:**
  - the two additive Mend reads (a checkpoint-range diff, and a worktree file read);
  - per-turn diffs and whole-file expansion of modified files;
  - the terminal over `/api/tty`;
  - the runtime-mode switch;
  - archive.
- **Phase 4:**
  - the `mend server setup` opt-in;
  - `mend t3 pair` with a QR code;
  - the public exposure gate entry (ADR 0004);
  - the docs page;
  - the contracts drift job.
- **Pulled in by the parity ask (docs/t3code-parity.md), not in the ADR table:**
  - Stop session (`provider-session.detach`);
  - the thread's pull request fields and a read-only pull request card.
- **Never** (each is answered with a capability flag set off, a typed refusal, or a stream that
  never emits):
  - mid-thread model or provider switch, plan mode, rollback, fork;
  - delegated tasks, PR watch, `git.*`, `vcs.*`, preview;
  - provider install and auth, scheduled tasks, settings writes, usage;
  - T3 Connect, and with it push notifications to t3code mobile.
- **Not in t3code at all:** review comments, slices, tours, passes, follow-up delivery, handoffs,
  context packs and landing. They stay in Mend's own clients.

## How it works

**Process and wiring.**

- `apps/t3-gateway` (`@mend/t3-gateway`, private) runs on Effect `4.0.0-rc.115` from the `t3` pnpm
  catalog.
- It does not import `@mend/api-contracts`. It decodes only the Mend fields it reads
  (`src/mend-workbench.ts`).
- t3code's contracts are vendored verbatim in `packages/t3-contracts`, pinned at
  `v0.0.46-nightly.20261003.2623` / `fed41fa88` (`packages/t3-contracts/t3code.pin.json`).
- `src/server.ts:24-42` composes the layers: state, environment, Mend client (its own
  `FetchHttpClient`), tickets, projections, auth and routes. `HttpRouter.serve` then listens on
  `host:port`.
- `serverVersion` is `<tag>+mend.2` (`src/version.ts:10-13`).

**State file** (`src/state.ts`). One `node:sqlite` file, WAL mode, migrated by `PRAGMA user_version`
(`state.ts:109-170`):

- `meta`: the `environment_id`, generated once (`state.ts:241-248`).
- `bearer_sessions`:
  - the sha256 of each bearer (never the bearer itself);
  - the Mend device token in clear (`device_token`, `state.ts:118`);
  - the Mend user;
  - the device id, scopes, client metadata, issue and expiry times, and `revoked_at`.
- `run_ids` (migration 2) and `message_ids` (migration 3, keyed by `(mend_session_id, mend_ref)`):
  the t3code run id and message id of every turn the gateway sent.
- `project_ids` and `thread_ids` exist and stay empty in phase 1.

Mend's database is never touched.

**Pairing** (`src/auth.ts:164-215`).

1. `POST /oauth/token` (form-encoded, t3code's `AuthTokenExchangeRequest`) checks the requested
   scopes first.
   - Malformed scopes are refused with `invalid_scope`.
   - Scopes outside t3code's standard client scopes (`orchestration:read`, `orchestration:operate`,
     `terminal:operate`, `review:write`, `relay:read`) are refused with `scope_not_granted`.
   - A request with a DPoP header is refused with `invalid_proof`.
   - In all three cases the pairing code is not spent.
2. Then `POST /api/pair` with `{ code, name: "t3code · <label>", platform }`. The platform is
   `android` or `ios` from the client's OS, `desktop` for a desktop client, else `other`
   (`auth.ts:140-150`).
   - Mend's 404, 410 or 429 becomes `GatewayCredentialInvalid` (`invalid_credential`).
   - Any other non-200 becomes `MendUnavailable` (`access_token_issuance_failed`).
3. On success the gateway mints a 32-byte bearer and stores the session (30 days, `auth.ts:34`). It
   answers `Bearer`, `expires_in`, the scopes, and `cache-control: no-store`.

**Authentication.**

- `EnvironmentAuthenticatedAuthLive` (`src/http.ts:61-90`) authenticates each HTTP request against
  the state file only: hash lookup, not revoked, not expired.
- `GET /api/auth/session` (`auth.ts:254-282`) also calls `GET /api/me/devices` with the device
  token. A 401 there refuses the device through `Projections.refuseDevice`, and the answer is
  `authenticated: false`.
- `POST /api/auth/browser-session` is refused with `invalid_credential`.
- The pairing-link and client-administration routes are refused with `insufficient_scope`
  (`http.ts:148-156`).

**WebSocket** (`src/ws.ts`).

1. `POST /api/auth/websocket-ticket` issues `wst_<32 bytes>`: in memory, single use, 30 s
   (`src/tickets.ts:17-69`).
2. `GET /ws` without `orchestrationProtocol=2` answers 426 with t3code's body (`ws.ts:43-52,95-97`).
3. With a `wsTicket`, the ticket is consumed and its bearer session must still be live
   (`ws.ts:68-87`). Without one, the request's own `Authorization` bearer is used.
4. Each socket gets its own `RpcServer` over `WsRpcGroup`, with the handlers of the bearer's person
   (`ws.ts:103-110`, `src/rpc.ts:742-751`).
5. The socket races the person's hub's refusal of that device token. When Mend refuses the token,
   the socket closes 250 ms later (`ws.ts:35,113-120`).

**RPC surface** (`src/rpc.ts`).

- Every method of `WsRpcGroup` has a handler; `test/rpc-surface.test.ts` asserts the set equals the
  vendored group.
- Served (`rpc.ts:80-91`):
  - `server.probe`, `server.getConfig`, `subscribeServerConfig`, `subscribeServerLifecycle`;
  - `orchestration.subscribeShell`, `subscribeThread`, `getThreadProjection`, `dispatchCommand`;
  - `review.getDiffPreview`, `review.getDiffFileContents`.
- Feeds of things Mend never has stay open and never emit (`rpc.ts:94-111`).
- Everything else fails with a typed error from its own contract. When nothing fits, that is
  `EnvironmentAuthorizationError` with `Mend's t3code gateway does not offer <method>.`
- The server config (`rpc.ts:247-295`, `src/server-config.ts`) is built from
  `GET /api/harnesses/models`, read with the socket's device token:
  - one provider per harness: `codex` as driver `codex`, `claude` as driver `claudeAgent`;
  - `requiresNewThreadForModelChange: true`, no rollback, no interaction-mode toggle;
  - runtime modes `full-access` and `approval-required`;
  - `auth.status: "unknown"`;
  - effort options from Mend's catalog, and a `serviceTier` option when the harness is
    `fastCapable`.
- If Mend refuses the device, the config answers `EnvironmentAuthorizationError`, which blocks the
  client. If Mend is unreachable, it answers `ServerSettingsError`, which t3code retries.

**The device gate** (`src/device-gate.ts:63-103`).

- Every Mend call that carries a device token goes through `gateDeviceCalls`. A `MendDeviceRefused`
  (HTTP 401) calls `tokens.refuse(token)`.
- A 403 is never a refusal: Mend's `SessionNotSteerable` stays the command's error.
- `GatedMend` is nominal, so a hub cannot hold Mend's raw client.
- `refuse` (`hub.ts:1590-1604`):
  1. completes the token's refusal deferred, which closes its sockets;
  2. if the person has no live token left, completes their "none left";
  3. revokes every bearer with that device token in the state file.

**The projection hub** (`src/hub.ts`). There is one per Mend user id, in an `RcMap` with a 2-minute
idle TTL (`hub.ts:1632-1646`). All of the person's paired device tokens are known to it, in pairing
order (`hub.ts:1648-1660`).

- **Reads.**
  - Reads use `tokens.current()`, the first token Mend has not refused. On a 401 the read is retried
    with the next token (`asPerson`, `hub.ts:516-532`).
  - Writes (commands) never use `asPerson`.
- **The first full read** (`refreshAll`, `hub.ts:798-843`) runs once, under `loadLock`, whoever
  needs it first (`ensureLoaded`, `hub.ts:925-933`). It reads, as the person:
  - `GET /api/projects`;
  - `GET /api/projects/:id` (concurrency 4);
  - `GET /api/sessions/:id/turns` and `/requests` for every projectable session (concurrency 4).

  Pointers that arrive before it finishes are deferred and replayed after it
  (`hub.ts:913-922,986-989`).

- **SSE.**
  - One `GET /api/events` per hub (`hub.ts:1022-1039`).
  - Every reconnect first queues a full read.
  - Backoff is 500 ms doubling to 15 s. A stream that lasted over 30 s resets it.
  - A full read that fails retries after 3 s (`hub.ts:996-1006`).
- **Pointers to refresh keys** (`refreshKeyOf`, `hub.ts:392-412`). A burst for one key is one read
  (`pendingKeys`, `hub.ts:958-965`).

  | Pointer                                                                                     | Refresh                                                                                                    |
  | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
  | `project`, `session`, `session-process`, `worktree`, `session-change`, `shared-control-off` | `project:<id>`, a project-detail read (`hub.ts:846-876`)                                                   |
  | `agent-conversation`                                                                        | `conversation:<sessionId>`: turns and requests, plus items past the cursor when watched (`hub.ts:886-911`) |
  | `user` with facet `devices`                                                                 | `devices`: `GET /api/me/devices` for every live token (`hub.ts:941-955`)                                   |
  | `user` with facet `access`, `organization`, `resync`                                        | `all`                                                                                                      |
  | anything else (`session-progress`, review comments)                                         | nothing                                                                                                    |

  Every 60 s a `devices` check runs whether or not a pointer arrived (`hub.ts:1041-1045`).

- **Publishing.** Every read applies under one semaphore (`lock`, `hub.ts:510-511`), then runs
  `publishAll` (`hub.ts:746-750`): `settleQueues`, then `publishShell`, `publishThreads` and
  `holdWhileBusy`.
  - **Shell** (`hub.ts:579-644`). Each project shell and thread shell is encoded through the
    vendored schema; one that fails is logged and left out. Only entities whose encoding changed are
    published. Each delta gets `++sequence`:
    - `project.updated`, `thread.updated` (`location: "active"`);
    - `thread.removed`, `project.removed`.
  - **Threads** (`hub.ts:664-729`). Only threads someone subscribes to (`watches`) are diffed. Each
    changed entity is one upsert event:
    - `thread.metadata-updated`;
    - `provider-session.updated`, `provider-thread.updated`;
    - `run.updated`, `runtime-request.updated`;
    - `message.updated`, `turn-item.updated`.

    If an entity the client holds went away, a fresh `snapshot` goes instead. If the session is no
    longer a thread, `thread.deleted` goes. One `sequence` counter serves the shell and every thread
    of the hub.

  - **Fan-out** (`src/fanout.ts`). Each subscriber has a bounded queue of 2,048, filtered before
    buffering. A subscriber that falls behind gets `SubscriberFellBehind`, mapped to the method's
    typed error. t3code then resubscribes.

- **Subscriptions** (`hub.ts:1423-1497`). Each one subscribes to the fan-out before taking its
  snapshot. `subscribeShell` and `subscribeThread` always start with a full snapshot (the requested
  `afterSequence` is ignored), then `synchronized` when `requestCompletionMarker` is true, then
  changes.
  - A thread subscription reads items with `GET /api/sessions/:id/items?after=<cursor>&limit=500`,
    page by page (`hub.ts:755-772`). The cursor is the highest item `seq` seen.
  - An unwatched thread's snapshot (HTTP, or `getThreadProjection`) reads its items from 0 for that
    request alone.
- **HTTP orchestration routes** (`http.ts:165-261`).
  - `GET /api/orchestration/shell`.
  - `/threads/:id`.
  - `/threads/:id/bounded`: the whole thread, `historyCursor: null`, `hasMoreHistory: false`,
    `latestLocalTurnOrdinal` = the highest turn-item ordinal.
  - `/threads/:id/history`: always `items: []`.
  - Each needs `orchestration:read`.

**Mapping** (`src/shell.ts`, `src/thread-projection.ts`).

- **Projects.** `workspaceRoot` is the project's store path. A project has no default model.
- **Threads.**
  - Thread id = Mend session id.
  - `worktreePath` = `dirname(storePath)/worktrees/<session.worktree>` (`shell.ts:138-139`).
  - The runtime mode comes from the current agent's `protocolOptions.permissionMode`: `ask` is
    `approval-required`, anything else `full-access` (`shell.ts:142-143`).
- **Runs.**
  - Run id = the gateway's minted `t3-run:<uuid>` when the gateway sent the turn, else the Mend turn
    id (`shell.ts:155-160`).
  - Status mapping (`shell.ts:165-185`):
    - Mend `queued` reads `starting` if the gateway sent it, else `queued`;
    - `running` reads `waiting` when a pending request hangs from the turn;
    - `completed`, `interrupted` and `cancelled` map 1:1;
    - anything else reads `failed`.
- **Ordering.** Each turn owns a block of 100,000 item ordinals: its input first, then items and
  requests by `createdAt`, then `id` (`thread-projection.ts:54,429-601`).
- **Gateway queue entries** follow the turns as runs `queued`, `preparing`, `starting`, `failed` or
  `cancelled` (`shell.ts:289-330`, `thread-projection.ts:604-680`). A cancelled queued run's user
  message is hidden from `visibleTurnItems` (`thread-projection.ts:748-771`).

**Commands** (`src/commands.ts:68-179`). Every command first checks two things:

- that the socket's device token is not refused
  (`Mend no longer accepts this device. Pair again from Mend.`);
- that the bearer holds `orchestration:operate`.

Both refusals are `EnvironmentAuthorizationError`. A gateway refusal flagged `authorization`, or a
`MendDeviceRefused`, also maps to `EnvironmentAuthorizationError`. Everything else maps to
`OrchestrationV2DispatchCommandError` naming the command.

**`message.dispatch`** (`hub.ts:1276-1321`):

1. `ensureLoaded`.
2. Reserve the `commandId` in `handledCommands`. A duplicate returns the current sequence. The
   reservation is released if this command fails.
3. `GET /api/sessions/:id` with the sender's device token. A 404 is refused with
   `Thread <id> is not in this environment.` and `control.steer === false` with the steering
   refusal. When `control` is absent (older servers), sending goes ahead and Mend decides.
4. Under the lock, refuse a session that is no longer a thread, and push a `QueueEntry` with these
   fields:
   - `runId: t3-run:<uuid>`;
   - the client's `messageId`;
   - the text, `requestedAt`;
   - `token` = the sender's device token.
5. Run `publishAll`, which runs `settleQueues`.

**The queue** (`src/queue.ts`, carried out by `hub.ts:1064-1258`). Per thread, per hub. `nextStep`
(`queue.ts:268-332`) runs after every read and on every wake:

- The session is not a projectable thread any more: `failAll` with
  `The session is gone from Mend, or is no longer a protocol session.`
- A `launching` entry:
  - **Agent up.** When the launch answered and the agent is live, the entry turns `sending` and its
    turn is sent.
  - **Session ended.** When Mend's session status is `failed`, `stopped` or `completed`, with
    `updatedAt` later than the launch answer's, the entry fails. The reason is the session's
    `summary`, else `The session <status> while it launched.`
  - **Deadline.** Past the launch deadline the entry fails with the 10-minute text.
  - Otherwise the thread waits.
- Then nothing moves while any of these holds: the queue is `held`; an entry is `sending`; Mend
  reports a turn `queued` or `running` on the session (`turnOpen`, from any client, `hub.ts:1090`).
- The first `queued` entry with a pending retry:
  - fails at its send deadline;
  - waits until `retryAt` and until the session's evidence counter has moved past `retryEvidence`.
- Then:
  - **Agent live.** The entry turns `sending` and `POST /api/sessions/:id/turns {input}` goes out
    with its own token (`hub.ts:1136-1163`).
  - **Agent not live, `launches` at 2.** The entry fails with
    `Mend could not keep the session's agent running to take this message.`
  - **Agent not live otherwise.** The entry turns `launching`; `launches` goes up by one, and the
    launch deadline is set to now + 10 min. The send deadline, the 409 count and `lastRefusal` are
    reset. Then `POST /api/sessions/:id/launch {mode: "protocol"}` goes out with no prompt and no
    options, with its own token (`hub.ts:1170-1208`, `mend-client.ts:453-464`).

  Mend's engine reuses the session's model and effort, and the last protocol agent's permission mode
  (`packages/sessions/src/engine.ts:12223-12245`, mend#493).

- **Launch answers.**
  - A launch that answers 2xx stamps `launchAnsweredAt` with the session's `updatedAt`.
  - A 422 makes the gateway read the session. If it reads `starting`, or its agent is running or
    starting with no `exitedAt`, the launch counts as under way: Mend refused it as
    `session_starting` or `session_active`.
  - Any other launch failure fails the entry.
- **`POST /turns` answers.**
  - A 2xx is adopted (`hub.ts:1099-1133`). The ids are remembered and written to `run_ids` and
    `message_ids` (a write failure is logged, not fatal), and the entry leaves the queue. An entry
    taken back while sending gets its new turn interrupted.
  - A 409 tagged `ProtocolSessionNotLive` is handled by `notLive` (`queue.ts:231-260`). The entry
    goes back to `queued` with `retryAt` = now + min(15 s, 1 s × 2^(n−1)), and the send deadline is
    set at the first 409. Past that deadline it fails with Mend's message.
  - Any other failure fails the entry with Mend's message, or
    `Mend no longer accepts the device that sent this message.` on a 401.
- **Wakes.** `scheduleWake` (`hub.ts:1216-1235`) sleeps until the next `retryAt` or launch deadline,
  then requests the thread's project refresh.
- **Clock.** Deadlines and retry times use `performance.now()`. Only `endedAfterLaunch` compares
  Mend timestamps.
- **Settled entries** (failed, cancelled) never change again: `fail` and `notLive` return early when
  `!canProgress` (`queue.ts:170-176,241`). At most 20 settled entries per thread are kept
  (`queue.ts:113,157-164`).
- **Holding the hub.** While any entry is `queued`, `launching` or `sending`, `retain(true)` holds
  the hub in the registry under a scope of its own (`hub.ts:740-745,1612-1630`). It survives every
  socket closing.

**`run.interrupt`** (`hub.ts:1348-1385`).

- **The run is a queue entry.** `takeBack` (`queue.ts:211-219`):
  - a `queued` or `launching` entry turns `cancelled` at once;
  - a `sending` entry is marked `takenBack`, and its turn is interrupted when `POST /turns` answers;
  - `holdQueue` holds the remaining queued entries.
- **The run is a Mend turn** (found by minted run id or by turn id):
  1. Under the lock, hold the queue if `holdQueue` and something is queued, and publish.
  2. Send `POST /api/turns/:id/interrupt` with the socket's token.
  3. On failure, restore the previous `held` and return Mend's refusal. A 403 is an authorization
     error.
- An unknown run is refused with `Run <id> is not in this thread.`

**`queued-run.cancel`** is `takeBack` without hold. **`queue.resume`** clears `held`. A run that is
no longer queued is refused with `That message is not queued any more.`

**`runtime-request.respond` and `thread.user-input.dismiss`** (`hub.ts:1396-1417`,
`commands.ts:29-64`).

- The request must be in the hub's copy of the thread's requests; otherwise the refusal is
  `Request <id> is not in this thread.`
- The answer goes as `POST /api/requests/:id/respond` with the socket's token, carrying one of:
  - `{decision}`: `accept`, `accept-for-session` (also for t3code's `acceptAlways`), `decline` or
    `cancel`;
  - `{answers: {questionId: string[]}}`.
- A dismissal sends `{decision: "cancel"}`.
- Mend's 409 `AgentRequestResolved` is passed back as the command error.

**Teardown** (`hub.ts:1055-1061,1261-1271`). When every token of the person was refused:

1. Mark the hub dead.
2. Interrupt the SSE, worker and device-check fibers.
3. `failAll` with `Every device of this person was revoked in Mend.` and publish.
4. Release the hold and invalidate the hub in the registry.

A later pairing gets a fresh hub (`hub.ts:1655-1658`).

**Review** (`src/review.ts`).

- `changeOfWorktree(cwd)` (`hub.ts:1499-1511`) finds the first thread of the person's whose
  `worktreePath` equals `cwd` exactly, and takes its `changeId` from the project annotations.
- `GET /api/changes/:id/diff` is read with the socket's token (`review.ts:179-194`).
- The preview (`review.ts:196-233`) is one `branch-range` source:
  - `id: mend-change:<changeId>`;
  - `baseRef`: the session's `baseRef`, else the change's `baseSha`;
  - `headRef`: `headSha`, else the branch;
  - `diffHash`: `sha256:<hex of patch>`;
  - `truncated: false`;
  - `files` from Mend's file stats, with `previousPath: null`.
- A one-file request filters `splitPatch` by new path, old path or `previousPath`. Paths quoted by
  git are decoded as UTF-8 (`review.ts:54-78`).
- `getDiffFileContents` (`review.ts:235-258`):
  - `new` and `deleted` files are rebuilt from the `+` or `-` side of the patch;
  - any other change type fails with `VcsUnsupportedOperationError`;
  - a file not in the change any more fails with `The file is not in the change any more.`
- Errors map to `VcsUnsupportedOperationError` with the Mend message.

**Restart behaviour.**

- **Gateway restart.**
  - Kept: the environment id, the bearers, the run and message id map.
  - Lost: tickets (clients ask for new ones on each connect), every queue entry (queued, launching,
    sending, failed, cancelled), held flags, `handledCommands`, and the sequence, which restarts
    at 0. Each client resubscribes and gets a snapshot, which is a legal reset.
  - Persisted ids reconcile a client's own message on turns that were adopted before the restart.
- **Mend restart.** SSE errors (502s) reconnect with backoff, and full reads retry every 3 s. A
  `POST /turns` in flight fails as `MendUnavailable` and the entry fails (see Divergences). A launch
  in flight that Mend forgets ends at the 10-minute deadline.
- **Executor or sealantd restart.** Not seen by the gateway except through Mend's session and turn
  states.

## Happy path

Alice owns project `mend`. Bob is a member with a shared project `site`. Mend runs on the box with
its API on `127.0.0.1:3101`.

1. The operator runs the gateway on the box with
   `MEND_T3_GATEWAY_MEND_URL=http://127.0.0.1:3101 pnpm --filter @mend/t3-gateway start` and reaches
   it over a private network. Alice opens Mend's devices page and creates a pairing code,
   `K7QD-2M9X`.
2. In t3code desktop (`v0.0.46` nightly), Alice adds a remote environment at the gateway with that
   code.
   - t3code reads `/.well-known/t3/environment` (protocol 2), posts `/oauth/token`, gets a bearer,
     asks for a ticket and opens `/ws?wsTicket=…&orchestrationProtocol=2`.
   - The environment shows as `Mend`.
   - Mend's device list shows `t3code · Alice's MacBook`.
3. The sidebar lists project `mend` and Alice's two codex and claude protocol sessions. It also
   lists Bob's protocol session in `site`, because Bob's project is shared. Alice's PTY session
   `scratch` is not listed. Session `fix-flaky-test` reads `completed`.
4. Alice opens `fix-flaky-test`. She sees each turn's input, the reasoning, a `command_execution`
   row `pnpm vitest run engine.test.ts` with its output, and the answer.
5. The session has been idle for 20 minutes, so Mend stopped its agent. Alice types
   `Also add a regression test for the retry path` and sends it.
   - The run reads `preparing`.
   - The gateway posts `/api/sessions/<id>/launch` with `{"mode":"protocol"}`. Mend relaunches on
     the recorded model and `ask` mode (about 67 s on the box, 2026-10-04).
   - When Mend reports the agent `running`, the gateway posts `/turns`. The run reads `starting`,
     then `running`, under the same run id `t3-run:…`.
6. The agent asks to write `test/retry.test.ts`. The run reads `waiting`, and an approval card shows
   `Write /…/test/retry.test.ts`. Alice clicks `Approve for this session`. Mend records
   `accept-for-session` and the run continues.
7. While it runs, Alice queues `Then run the whole suite`. It reads `queued`, position 1. She clicks
   Stop: the turn reads `interrupted`, and the queued message stays queued, held. She clicks resume:
   the message goes out as the next turn.
8. Alice opens the changes panel. It shows one source, `Changes · observed at capture 21 · seq 40`,
   with `test/retry.test.ts` added (expandable in full) and `src/retry.ts` modified (expansion
   answers the patch-only message).
9. Alice sends a message to Bob's `site` session and is refused with t3code's authorization error:
   `This session is not yours to steer. Its owner can turn on shared control in Mend.`
10. In Mend's web app, Alice revokes `t3code · Alice's MacBook`. Within 60 s, sooner if Mend sends
    the `user`/`devices` pointer, the gateway finds the 401. Her socket closes. Reconnects fail:
    `/api/auth/session` answers `authenticated: false`, and the bearer is revoked, so the client
    must pair again.

## Invariants

1. One person's credentials are never spent by or exposed to another person through the gateway.
   - Every Mend call a hub makes uses a device token of the hub's own Mend user: hubs are keyed by
     the user id `POST /api/pair` returned.
   - No call uses a token paired by a different Mend user.
2. A message is submitted, its relaunch posted, and its taken-back turn interrupted with the device
   token of the client that sent it (`QueueEntry.token`), never another token, even one of the same
   person. Interrupts and answers use the token of the socket that sent the command.
3. The gateway never sends a second `POST /api/sessions/:id/turns` for one thread from one hub while
   any of these holds:
   - an entry of that thread is `sending` or `launching`;
   - the queue is held;
   - Mend reports a turn `queued` or `running` on the session.
4. A queue entry becomes at most one Mend turn.
   - Identity comes only from the turn `POST /turns` returned, never from matching text or ordinals.
   - One `commandId` is queued at most once per hub, even when two copies arrive at once.
5. A settled entry (`failed`, `cancelled`) never changes state again, whatever answer arrives later.
6. Every launch the gateway posts has the body exactly `{"mode":"protocol"}`: no prompt, model,
   effort or permission mode. An `ask` session followed up through the gateway comes back `ask`.
7. Every wait on Mend is bounded:
   - a launch, by 10 minutes;
   - a session that keeps answering 409 while it reads live, by 2 minutes after the first 409;
   - a session that keeps failing to stay up, by 2 launches per message.

   (Waiting behind an open turn or a held queue is not bounded; see Divergences.)

8. A 409 retry is never sent in the same pass as the 409. It waits at least the backoff and at least
   one further applied read of the session.
9. A device token Mend answers 401 for, on any call, is refused:
   - its sockets close (250 ms after the refusal is seen);
   - every bearer with that device token is revoked in the state file;
   - every later command on a socket holding it is refused before Mend is called.

   A 403 never refuses a token.

10. When every device of a person is refused, their hub:
    - stops Mend's event stream;
    - fails every entry that could still progress, with
      `Every device of this person was revoked in Mend.`;
    - releases its hold.
11. A message the gateway accepted is never dropped silently while the gateway runs. It ends up
    adopted as a Mend turn, failed with its text and a reason, or cancelled at the person's request.
    The hub holding it is not disposed while it can still progress.
12. The state file never holds a bearer, only its sha256. A paired client never holds `access:read`,
    `access:write` or `relay:write`.
13. A pairing code is not spent when the token request names an invalid or ungranted scope, or
    carries DPoP.
14. A WebSocket ticket opens at most one socket, only within 30 s of being issued, and only for a
    bearer session that is live at the upgrade.
15. Every RPC method of the pinned `WsRpcGroup` has a handler, and none answers with a defect.
16. Every entity the gateway sends encodes through the vendored schema first. One that does not
    encode is logged and left out of both events and snapshots.
17. The gateway writes nothing to Mend except these calls:
    - `POST /api/pair`;
    - `POST /api/sessions/:id/turns`;
    - `POST /api/sessions/:id/launch`;
    - `POST /api/turns/:id/interrupt`;
    - `POST /api/requests/:id/respond`.

    It never touches Mend's database.

18. Shell and thread events for a hub carry strictly increasing sequences. Every subscription starts
    with a full snapshot.
19. Product wording states what Mend observed and never a verdict:
    - the review source title carries Mend's observation label;
    - failure texts say what Mend did or did not do.

## Edge cases and failure behaviour

**Concurrency**

- **Two t3code clients of the same person send to one thread.** Both share the hub and its queue.
  Messages queue in arrival order and go one at a time.
- **The same command twice at once.** One message. The second call returns the current sequence.
- **A follow-up from Mend's web app, CLI or Slack while a gateway message is queued.** The gateway
  sees `turnOpen` from Mend's turn list and waits. It never interleaves.
- **Two different people (owner and a shared-control steerer) send through the gateway to one
  session.** Each has their own hub and queue. Both may see no open turn and both send. Mend queues
  the second turn itself (protocol host `dispatchNext`). The "no second turn while one is open" rule
  holds per hub, not per session.
- **The gateway relaunches while another client launches the same stopped session.**
  - Mend answers 422 (`session_starting` / `session_active`).
  - The gateway reads the session. If it reads `starting`, or its agent is up, the message waits for
    the agent and sends.
  - If it reads neither, the message fails with Mend's 422 text.
- **Interrupt while `POST /turns` is in flight.** The entry is marked `takenBack`. When Mend
  answers, the turn is adopted, then interrupted with the sender's token. The run may read
  `starting`, then `running`, then `interrupted`, which is cosmetic.
- **Cancel while `POST /launch` is in flight.** The entry is `cancelled` at once. A later launch
  success or failure does not change it. The relaunch itself may still bring the agent up.

**Restarts**

- **Gateway restart.**
  - Kept: pairings and the environment id.
  - Lost: queued and settled messages, and held flags. A failed message's text and reason disappear
    from the thread.
  - Clients reconnect with a new ticket and get snapshots.
- **Gateway restart mid-launch.** The launch may complete in Mend. The message is gone from the
  gateway and never sent.
- **Mend restart.**
  - The SSE drops, and the hub reconnects (500 ms → 15 s) and reads everything again, retrying every
    3 s through 502s.
  - Watched threads catch up their items past their cursors (`hub.ts:816-824`).
  - A `POST /turns` that fails as unavailable fails its message.
  - A 409 while Mend re-hosts processes is retried with backoff for up to 2 minutes.
- **Mend restart mid-relaunch.** If the row reads `stopped` again with no newer `updatedAt`, the
  message fails at the 10-minute deadline
  (`Mend did not bring the session's agent up within 10 minutes.`).
- **Executor or sealantd restart during a turn.** Whatever Mend records (failed or interrupted turn,
  error items) is shown. The gateway does not retry a turn.

**Partial failures**

- **A launch answers, then provisioning fails.** Mend settles the session `failed` with a newer
  `updatedAt`. The message fails with the session's summary.
- **The agent comes up, then dies before the turn attaches.** 409s are retried with backoff. Once
  the row reads exited, the message relaunches (second launch). A third need fails it.
- **`recordTurnIds` fails (disk full).** It is logged. The turn is still adopted in memory. After a
  gateway restart the client's message id for that turn is lost, so the client shows the turn under
  `message:<turnId>` instead.
- **One entity fails to encode.** It is logged and left out. The rest of the thread is sent.
- **A subscriber 2,048 changes behind.** Its stream fails typed and t3code resubscribes for a fresh
  snapshot.

**Missing or odd input**

- `message.dispatch` with attachments, `steer_active`, `restart_active` or `defer_start` is refused
  with the texts above. Whitespace-only text is refused.
- An unknown thread id answers `OrchestrationV2GetThreadProjectionError` over RPC and 404
  `thread_not_found` over HTTP.
- An unknown run id answers `Run <id> is not in this thread.` An unknown request id answers
  `Request <id> is not in this thread.`
- A respond with neither a decision nor answers answers `An answer needs a decision or answers.`
- A review `cwd` that is no thread worktree of the person's, or a worktree with no change yet,
  answers `No Mend thread of yours works in <cwd>, or its worktree has no change yet.`
- **A malformed `Authorization` header.**
  - A non-Bearer scheme, or an empty token: `missing_credential`.
  - `DPoP …`: `invalid_credential` with `invalid_proof` and `www-authenticate: DPoP`.
- **Mend items the gateway does not recognise.**
  - Shown as a `dynamic_tool` row, never dropped.
  - `other` items with no data become `system_notice`, or are skipped when they have no text.
  - `user-message` items are skipped, because the input is the user message.
- **Mend timestamps that do not parse** read as the epoch.
- **Turns from older servers without `origin`** count as non-harness. **Sessions without `model`**
  show the agent's protocol model, else `default`.

**Older data**

- **Sessions from before protocol mode, and PTY sessions.** Not threads.
- **A session handed from PTY to protocol mode.** Appears as a thread once its current agent is a
  protocol process.
- **A Mend server from before organizations** (no `control` in session detail). The gateway sends,
  and Mend's own 403 refuses.
- **A state file from phase 0** (`user_version` 1) migrates to 3 on open. Message ids stored under
  migration 1 are moved, keyed by `(session, turn)`.

**Permissions**

- **Owner.** Reads and steers their sessions.
- **Member in a shared project.** Reads every protocol session Mend shows them. Commands on others'
  sessions are refused unless shared control is on.
- **Steerer with shared control on.**
  - Sends, relaunches, interrupts and answers with their own device token. Mend records them as
    author.
  - Under ADR 0008 the turn still runs on the session owner's login, as from Mend's web app. ADR
    0013 (proposed) changes that. The gateway neither adds nor removes credential spending.
- **Operator without organization access.** Sees what Mend's `/api` gives their account, normally
  nothing.
- **A deactivated account or a revoked device.** 401 on every call: the sockets close and the
  bearers are revoked.

**Clients**

- **t3code desktop or web, `v0.0.46` nightlies.** The target.
- **t3code stable `v0.0.45` (protocol 1).** Refused by the descriptor check: 426 on `/ws`.
- **t3code mobile.** Connects the same way, but gets no push notifications: T3 Connect is refused.
- **Mend web, CLI, desktop, mobile, VS Code and Slack.** Unaffected. Their sessions appear live in
  the gateway, and the gateway's turns appear in them as ordinary turns by the sending person.

**Exposure**

- **`MEND_T3_GATEWAY_HOST` set wider than loopback.** The gateway serves plain HTTP on that
  interface. The descriptor's auth policy becomes `remote-reachable`. There is no exposure gate
  entry yet (phase 4).
- **CORS** allows any origin without credentials (`http.ts:270-281`). Any web page the person opens
  can reach a loopback gateway's unauthenticated routes: the descriptor and `/oauth/token`.

## Known limits

- The queue lives in memory. A gateway restart loses queued and settled messages and held flags (ADR
  0012, "Choices inside the gateway"; phase 2 persists it).
- After a hub idles out (2 minutes with no socket and nothing in progress), failed and cancelled
  messages are gone from the thread too.
- Every subscription opens with a full snapshot. There is no replay after a sequence (phase 2). On
  long threads that is a full read per resubscribe.
- No starting sessions, no rename or delete, no images, no `@`-mentions, no VCS status (phase 2).
- No per-turn diffs, no whole-file expansion of modified files, no terminal, no runtime-mode switch,
  no archive (phase 3). Whitespace is never ignored in diffs.
- Not started by Mend, no setup opt-in, no exposure gate entry, no `mend t3 pair`, no drift job
  (phase 4).
- A session the person cannot steer is not shown as read-only. Commands are refused instead
  (docs/t3code-parity.md, "Shared control").
- Checkpoints are not linked to runs (`checkpointId: null`).
- t3code mobile gets no push notifications: they need T3 Connect's relay, which the gateway refuses
  (docs/t3code-parity.md, "Notifications").
- A shared-control steerer's turn spends the owner's login, as everywhere in Mend today (ADR 0008;
  ADR 0013 proposed).
- Only t3code clients speaking orchestration protocol 2 connect.
- No real t3code desktop or web build has been driven against the gateway. Live checks used a
  scripted client built from the vendored contracts (mend#511, "Phase 1 'done when'").

## How to verify

**Tests** (`pnpm --filter @mend/t3-gateway test`, run in CI by `pnpm test`). Each runs the gateway
on an ephemeral port in front of a fake Mend (`test/support/fake-mend.ts`, `fake-workbench.ts`):

- `test/descriptor.test.ts`: the descriptor decodes; protocol mismatch refused; the environment id
  kept across restarts.
- `test/oauth.test.ts`: claim, `no-store`, refused codes, scopes refused before spending, Mend down,
  session ends once the device is revoked.
- `test/ticket.test.ts`: single use, 30 s, unknown tickets.
- `test/unauthenticated.test.ts`: 401 bodies, `browserSession` refused, access-admin refused.
- `test/ws.test.ts`: the handshake end to end; 426; ticket spent once; config errors (Mend down,
  revoked).
- `test/rpc-surface.test.ts`: registered = vendored group; every unserved method answers typed or
  stays silent.
- `test/shell.test.ts`: projection; live follow; full read after a drop; revoked device loses its
  socket while the other device reads; last device stops the hub; pointer during the first read.
- `test/thread.test.ts`: full thread, streaming, approvals, items by cursor, `thread.deleted`,
  catch-up after a drop, typed refusals, codex and claude item shapes.
- `test/dispatch.test.ts`:
  - follow-up and queue; relaunch then send; steering refusal;
  - review rounds 1–4: queued message outlives its client; launch fails after answering; take-back
    while launching; duplicate command; 401 on send; last device revoked fails the queue;
  - holdQueue on a message in flight; pre-relaunch failure not counted; another client's turn with
    the same text not taken;
  - session removed; forgotten relaunch; 409 backoff; 409 deadline; racing launch; deadline reset on
    relaunch; cancel during an in-flight launch;
  - interrupt, hold and resume; respond and dismiss; id map across restart; decision and answer
    mapping.
- `test/review.test.ts`: preview, one file, whole added file, refusals, git-quoted names,
  `splitPatch`.
- `test/state.test.ts`: id map per turn, migration 3.
- `test/device-gate.test.ts`, `test/fanout.test.ts`.

**Not covered by tests:**

- a real t3code client;
- Mend over a real network, or a real Mend at all;
- two different people on one session;
- state file permissions;
- a held queue with no client left;
- a turn that never ends;
- `MendUnavailable` on `POST /turns`;
- the pairing rate limit shared through the gateway;
- CORS from a hostile page.

**By hand on the box** (from a Mend checkout on the box, Node 26):

```sh
MEND_T3_GATEWAY_MEND_URL=http://127.0.0.1:3101 pnpm --filter @mend/t3-gateway start &
curl -s http://127.0.0.1:3120/.well-known/t3/environment | jq '.orchestrationProtocolVersion, .serverVersion'
# 2, "v0.0.46-nightly.20261003.2623+mend.2"
code=$(curl -s -X POST -H "authorization: Bearer $MEND_TOKEN" http://127.0.0.1:3101/api/me/devices/pairings | jq -r .code)
curl -s -X POST http://127.0.0.1:3120/oauth/token \
  --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange \
  --data-urlencode subject_token="$code" \
  --data-urlencode subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap \
  --data-urlencode requested_token_type=urn:ietf:params:oauth:token-type:access_token \
  --data-urlencode client_label=probe | tee /tmp/t3-token.json
bearer=$(jq -r .access_token /tmp/t3-token.json)
curl -s -H "authorization: Bearer $bearer" http://127.0.0.1:3120/api/orchestration/shell | jq '.threads[] | {id, title, status}'
curl -s -H "authorization: Bearer $bearer" http://127.0.0.1:3120/api/orchestration/threads/<sessionId>/bounded | jq '.projection.runs[] | {id, status}'
ls -l "${XDG_STATE_HOME:-$HOME/.local/state}/mend/t3-gateway/state.sqlite"   # file mode (see Divergences)
```

Then pair t3code desktop at the gateway and walk the happy path. For the idle-stop path, use
`POST /api/sessions/:id/stop` in place of the 15-minute idle stop.

**Signals to watch:**

- Gateway log lines:
  - `t3 gateway lost Mend's event stream`
  - `t3 gateway could not refresh from Mend`
  - `t3 gateway could not check a device with Mend`
  - `t3 gateway could not encode a thread entity`
  - `t3 gateway could not encode a project`
  - `t3 gateway could not record a turn's ids`
  - `t3 gateway could not interrupt a taken-back turn`
  - `t3 gateway could not revoke a refused device's bearers`
  - `t3 gateway request failed` (with reason and traceId)
- Mend's device list: `t3code · <label>`.
- Mend's turn author on gateway turns: the sender.
- Run statuses in t3code: `queued`, `preparing`, `starting`, `running`, `waiting`, `completed`,
  `interrupted`, `failed`, `cancelled`.

## Divergences found while writing

1. **Device tokens stored in clear** (`apps/t3-gateway/src/state.ts:118`, `:258-259`).
   - The state file stores every paired person's Mend device token in clear. The file and directory
     are created with default modes (`mkdirSync` and `new DatabaseSync` set no mode), so under a
     usual umask any local user who can read `~/.local/state/mend/t3-gateway/state.sqlite` gets
     those tokens and can act as those people in Mend.
   - Mend itself keeps only the sha256 of a device token (`apps/api/src/routes/devices.ts:108-112`).
   - This conflicts with the rule that one person's credentials are never exposed to another.
2. **A held queue pins the hub** (`apps/t3-gateway/src/queue.ts:143-152`, `:302`; `hub.ts:740-745`).
   - A held queue (every t3code interrupt sends `holdQueue: true`) keeps its `queued` entries. Those
     count as progress, so `retain(true)` holds the hub, its Mend SSE stream and its 60 s device
     checks indefinitely, until a client sends `queue.resume` or the gateway restarts.
   - `README.md:131` says "a hub with nothing that can progress is let go".
3. **"Every wait is bounded" is not true** (`apps/t3-gateway/src/queue.ts:304`).
   - A queued message waits behind an open Mend turn with no deadline. A turn Mend never ends (stuck
     `running`) holds the message, and the hub, forever.
   - `README.md:120` and `queue.ts:13` say every wait is bounded.
4. **The 409 retry's "fresh read" is a conversation read** (`apps/t3-gateway/src/hub.ts:1150-1155`
   with `:1162` and `:907`).
   - After a 409, `sendTurn` itself requests a conversation refresh. That refresh runs `sawSession`,
     which satisfies the retry's evidence check without re-reading the agent row (the agent row
     comes only from a project read).
   - `README.md:127` says a retry waits for "a fresh read of the session". In practice only the
     backoff gates retries: about 10 POSTs in the 2 minutes.
5. **Any non-409 `POST /turns` failure fails the message** (`apps/t3-gateway/src/hub.ts:1156-1158`).
   - This includes `MendUnavailable`: Mend restarting, a 502, a dropped connection.
   - If Mend accepted the turn and the answer was lost, the thread shows a failed run and a separate
     run for the real turn (`message:<turnId>`). A resend sends the text twice. There is no retry or
     reconciliation for an ambiguous failure.
6. **Pairing shares one rate-limit bucket** (`apps/t3-gateway/src/mend-client.ts:270-305` and
   `auth.ts:182-187`).
   - Every claim reaches Mend from the gateway's own address with no `X-Forwarded-For`. Mend's claim
     limiter (10 failures a minute per address, `apps/api/src/routes/devices.ts:155`, `:324-340`) is
     therefore one bucket for every t3code client of the gateway.
   - With CORS open to any origin (`http.ts:270-281`), a web page the person visits can exhaust it
     against a loopback gateway.
   - A 429 is reported to the client as `invalid_credential`, not as a rate limit, so the person is
     told their valid code is wrong.
7. **The README's state section is stale** (`apps/t3-gateway/README.md:176-181`).
   - It says phase 1 fills `project_ids`, `thread_ids` and `message_ids`.
   - The code (`state.ts:103-108`) leaves `project_ids` and `thread_ids` empty until phase 2, and
     fills `run_ids` (migration 2), which the README's State section does not list.
8. **ADR 0012 "Consequences" misattributes losing queued messages.**
   - It says losing the state file loses queued messages. The queue is not in the file: any gateway
     restart loses them, and losing the file loses pairings, which the ADR omits.
9. **ADR 0012 "Protocol churn" items are absent from phase 0–1.**
   - Missing: golden frames from a real t3code server, t3code's `client-runtime` driving the gateway
     in CI, and a Playwright smoke.
   - `test/ws.test.ts` builds its own client (`README.md:186-189`).
   - The phase-1 "done when" was checked with a scripted client, not a t3code build (mend#511).
10. **ADR 0012 "Steering rules are Mend's" is not implemented as written.**
    - The ADR says a session the person cannot steer "appears read-only". Nothing marks it so, and
      only commands are refused (acknowledged in docs/t3code-parity.md).
11. **Sockets outlive bearer expiry** (`apps/t3-gateway/src/ws.ts:113-120`).
    - An open socket outlives its bearer's 30-day expiry and a local revocation that did not come
      from a device refusal. Expiry is checked only at the upgrade and on HTTP requests.
12. **`handledCommands` grows without bound** (`apps/t3-gateway/src/hub.ts:496`, `:1281-1283`).
    - It is never pruned while a hub lives. A hub held by Divergence 2 accumulates every command id.
13. **The shell's item counts are turn counts** (`apps/t3-gateway/src/hub.ts:596-599`).
    - The shell's `itemCount` and `visibleItemCount` are set to the number of turns, not turn items.
      It is cosmetic unless a client relies on them.
14. **`MEND_REVISION` was not raised within phase 1** (`apps/t3-gateway/src/version.ts:10`).
    - It stayed at 2 from #508 through #511, although #509–#511 changed what the gateway serves. The
      four merged together, so no build ever served #508 alone. This is noted only because the
      README's rule is "raise it when the gateway changes what it serves".
