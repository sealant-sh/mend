# @mend/t3-gateway

A t3code environment in front of Mend (ADR 0012, `docs/adr/0012-t3code-gateway.md`). t3code's
desktop, mobile and web clients add it as a remote environment and pair with a Mend pairing code. To
them it is a t3code server; to Mend it is an ordinary client of `/api`, calling with the device
token of the person who paired. Mend stays the only source of truth and its access rules apply
unchanged.

It runs on Effect `4.0.0-rc.115` from the `t3` catalog and speaks t3code's contracts from
`@mend/t3-contracts`, pinned to one t3code nightly tag. It does not import `@mend/api-contracts`: it
decodes only the Mend fields it reads.

## Phase 0: HTTP

| t3code route                      | What the gateway does                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /.well-known/t3/environment` | The descriptor: a persisted `environmentId`, `orchestrationProtocolVersion` 2, `serverVersion` `<t3code tag>+mend.<n>`, no optional capability |
| `POST /oauth/token`               | Claims the pairing code through Mend's `POST /api/pair`, keeps the device token, answers a bearer of its own (30 days, standard scopes)        |
| `POST /api/auth/websocket-ticket` | A gateway-local ticket for `/ws?wsTicket=`: single use, thirty seconds, in memory                                                              |
| `GET /api/auth/session`           | Authenticated while the bearer is live and Mend still accepts its device token (`GET /api/me/devices`; Mend has no `GET /api/me`)              |
| `POST /api/auth/browser-session`  | Refused: the gateway offers bearer tokens only                                                                                                 |
| pairing links and client sessions | Refused with `insufficient_scope`: devices are administered in Mend                                                                            |

Refusals carry t3code's own error bodies (`EnvironmentAuthInvalidError`,
`EnvironmentRequestInvalidError`, `EnvironmentScopeRequiredError`, `EnvironmentInternalError`).

## Phase 0: the RPC socket

`GET /ws?wsTicket=…&orchestrationProtocol=2` upgrades to Effect RPC in JSON on `rc.115`, serving
t3code's whole `WsRpcGroup`. Without `orchestrationProtocol=2` it answers 426 with t3code's body. A
ticket is spent once; a socket without one may use the request's own bearer, as t3code allows. Each
socket gets its own RPC server, holding the handlers of the person who paired.

| Method                                                  | What the gateway does                                                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `subscribeServerConfig`, `server.getConfig`             | The config: the descriptor, and one provider per Mend harness from `GET /api/harnesses/models` read as the person |
| `subscribeServerLifecycle`                              | `welcome` with `bootstrapStatus: "complete"`, then open                                                           |
| `server.probe`                                          | `{}`                                                                                                              |
| every other command or read                             | A typed failure from the method's own contract, never a defect                                                    |
| feeds of things Mend never has (terminals, previews, …) | Open, and never emit                                                                                              |

`codex` is driver `codex` and `claude` is driver `claudeAgent`; other harnesses are left out. The
capability flags say what Mend does: a session keeps its model (`requiresNewThreadForModelChange`),
no rollback, no plan mode, runtime modes `full-access` (`bypass`) and `approval-required` (`ask`),
and no provider setup through t3code. Mend unreachable answers `ServerSettingsError`, which t3code
retries; a device revoked in Mend answers `EnvironmentAuthorizationError`, which blocks the
connection.

## Phase 1: the projection

One projection hub per paired person (`src/hub.ts`), shared by all of their sockets and requests and
kept two minutes after the last one closes. It holds one `GET /api/events` stream from Mend, read
with one of the person's device tokens, and re-reads what each pointer names through Mend's API:
`project`, `session`, `session-process`, `worktree` and `session-change` re-read the project
(`GET /api/projects/:id`), `agent-conversation` re-reads the session's turns and requests, and
`organization`, `user` and `resync` re-read everything. A project read also re-reads
`GET /api/sessions` for the people live in each executor, whether control is shared and whether the
executor waits to be replaced. A turns read also reads what holds the next sender's turn
(`GET /api/sessions/:id/waiting`), but only while someone is live there and control is shared, and
the retirement is read only while the session says one is under way: with neither, the gateway asks
Mend nothing more. A server without these fields reads as nobody live and nothing waiting. A burst
of pointers for one thing is one read. After the stream drops, the hub reconnects with backoff and
reads everything again.

Each read rebuilds the t3code entities (`src/shell.ts`), encodes them through the vendored schemas,
and sends only what changed, each change stamped with the hub's next sequence. A fresh snapshot is
always a legal reset for a t3code client, so a restarted gateway starts its sequence again.

| t3code                                                         | From Mend                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `orchestration.subscribeShell`, `GET /api/orchestration/shell` | Every project the person sees, and every session whose current agent is a codex or claude protocol process      |
| project                                                        | `workspaceRoot` is the store path; no default model                                                             |
| thread                                                         | the session; title from its label, else its first message; `worktreePath` is the worktree beside the store      |
| run                                                            | one per turn; a running turn whose agent asked something is `waiting`                                           |
| shell status                                                   | the latest run's status, else `idle`; the newest pending request; message bodies stay out, as in t3code's shell |
| pending background tasks                                       | what a waiting turn waits for: the previous sender's own work (ADR 0016, decision 6)                            |

PTY and shell sessions, and harnesses t3code has no driver for, are not threads.

### Threads

`orchestration.subscribeThread`, `orchestration.getThreadProjection` and the HTTP thread routes
serve one thread in full (`src/thread-projection.ts`). While anyone subscribes to a thread, the hub
keeps its items current: an `agent-conversation` pointer re-reads its turns and requests and the
items past the last change-feed cursor (`GET /api/sessions/:id/items?after=`). Each entity that
changed is one upsert event (`run.updated`, `turn-item.updated`, `message.updated`,
`runtime-request.updated`, …); one that went away sends a fresh snapshot; a session that is no
longer a thread sends `thread.deleted`. A subscription always opens with a full snapshot, whatever
sequence the client resumes after: replay after a sequence is phase 2.

| t3code                                     | From Mend                                                                                                                                                                                                                                                 |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user message                               | the turn's input; a turn the agent opened on its own is a system message                                                                                                                                                                                  |
| assistant message, reasoning               | `assistant-message` and `reasoning` items, `streaming` while in progress                                                                                                                                                                                  |
| command, file change, web search           | read from the harness's own item in `data` (codex app-server items, claude `tool_use` blocks)                                                                                                                                                             |
| other tool calls, plans, background tasks  | a tool row named by the harness                                                                                                                                                                                                                           |
| error                                      | `error` items, and a failed turn's error after everything it did                                                                                                                                                                                          |
| runtime request, approval or question item | the agent's request; answered through Mend while its agent is live                                                                                                                                                                                        |
| system notices                             | ADR 0016's lines, word for word (`src/notices.ts`): the waiting line after the waiting turn's input; the shared-workspace line and, while the thread is watched, the retirement line (`GET /api/sessions/:id/workspace-retirement`) after everything else |
| ordinals                                   | each turn owns a block of 100 000, its input first, then items and requests in the order Mend recorded them                                                                                                                                               |
| `GET …/threads/:id/bounded`                | the whole thread as one window: no cursor, nothing older                                                                                                                                                                                                  |

### Commands

`orchestration.dispatchCommand` takes what Mend can back (`src/commands.ts`); every other command
answers `OrchestrationV2DispatchCommandError` naming it.

| t3code                              | What the gateway does                                                                                                                                                                                                                                                        |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message.dispatch`                  | Checks Mend's steering rule as the sender (`GET /api/sessions/:id`), queues the message, and sends it once no turn is open: `POST /api/sessions/:id/turns`, or, when the agent stopped, `POST /api/sessions/:id/launch` with no prompt and then the turn once the agent runs |
| `run.interrupt`                     | `POST /api/turns/:id/interrupt`; with `holdQueue` (t3code always sends it) the queue is held before the turn ends. A queued run is taken back instead                                                                                                                        |
| `queued-run.cancel`, `queue.resume` | The gateway's queue                                                                                                                                                                                                                                                          |
| `runtime-request.respond`           | `POST /api/requests/:id/respond`: decisions as Mend's (`acceptAlways` is `accept-for-session`), answers as lists of strings                                                                                                                                                  |
| `thread.user-input.dismiss`         | The same, answering `cancel`                                                                                                                                                                                                                                                 |

The gateway holds the queue (ADR 0012): it never sends a second turn while one is open in Mend,
whoever opened it. A queued message is a run of the gateway's own (`t3-run:…`) until Mend opens its
turn; from then on the turn keeps that run id and the client's message id, recorded in the state
file's `run_ids` and `message_ids`, so a client's own message is reconciled even after a gateway
restart.

The gateway never guesses which Mend turn is its message's (`src/queue.ts` holds the rules). With
the agent live, the message goes out as `POST /api/sessions/:id/turns`, which answers the turn: an
exact identity. With the agent stopped (the 15-minute idle stop), the session is launched again with
no prompt and no options (Mend reuses what its last protocol agent recorded, mend#493, so an `ask`
session comes back asking), and once Mend reports the agent running the message goes out the same
way. A launch that races another client's (Mend's 422 while the session reads `starting` or its
agent up) is taken as under way, and the message waits for the agent. Every wait is bounded:

- A launch fails when the call fails, when Mend settles the session as ended after the launch
  answered, or when the agent is not up 10 minutes after the launch (above Mend's own launch budget:
  a 30-second answer window plus workspace start, saves and image builds). The message then fails
  with the reason and the queue moves on.
- A `409 ProtocolSessionNotLive` while the row still reads the agent running is retried only after a
  backoff (1 s doubling to 15 s) and a fresh read of the session from Mend, never in the same pass;
  still refused 2 minutes after the first 409, the message fails with Mend's refusal.

- While a message can still reach Mend, the hub holds itself without any socket; a closed client
  never loses an accepted message, and a hub with nothing that can progress is let go.
- A message in the queue or waiting on a launch can be taken back (`queued-run.cancel`,
  `run.interrupt`) and stops blocking at once; one being sent has its own turn interrupted when Mend
  answers. Every interrupt honours `holdQueue`.
- A session removed, or no longer a protocol session, fails what was queued for it.
- Every Mend call made with a device token goes through one gate (`src/device-gate.ts`): a 401
  refuses that token and closes its sockets. When every device of the person is refused, the hub
  fails what was queued, stops Mend's event stream and lets itself go.
- A `commandId` is reserved before anything is read, so a command sent twice at once is one message.

Steering mid-turn, images and holding a message for later are refused; queue edit and reorder, and a
queue that survives a gateway restart, are phase 2.

### Review

`review.getDiffPreview` and `review.getDiffFileContents` (`src/review.ts`) show the thread's change:
the `cwd` t3code names is the thread's `worktreePath`, and the answer is one `branch-range` source,
the change against its base, from `GET /api/changes/:id/diff` read as the person. A preview for one
file is that file's section of the patch. Mend serves the change as a patch, so whole contents (for
expanding a hunk) come back only for files the patch holds whole, added or deleted; a changed file
answers `VcsUnsupportedOperationError` until phase 3's worktree read. Whitespace is never ignored:
Mend's change diff has no such option. Per-turn diffs are phase 3.

## Phase 2: threads from t3code

### Launching a thread

`orchestration.launchThread` (`src/launch.ts`) is how t3code starts a thread with its first message.
The gateway creates a Mend session as the person who paired, so Mend records them as its owner and
origin `mend`, and its agent runs as them (docs/adr/0016).

| t3code                                       | Mend                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `worktree { baseRef, branch? }`              | `POST /api/projects/:id/sessions`: a new worktree from `baseRef`, named from the branch's last segment when Mend takes the name |
| `existing_worktree { worktreePath }`         | `POST /api/worktrees/:id/sessions`: the worktree of the project's session at that path                                          |
| `root`                                       | Refused: every Mend session has a worktree of its own                                                                           |
| model, reasoning effort, `fast` service tier | named on every launch of the thread: a first launch that brought no agent up leaves Mend nothing to reuse                       |
| `full-access`, `approval-required`           | `bypass`, `ask`; other runtime modes are refused                                                                                |
| `title` with `generateTitle`                 | no label: the thread is named from its first message, as any unnamed Mend session                                               |
| `initialMessage`                             | queued like a follow-up; the run is `preparing` while the session launches                                                      |

The opening message goes through the queue: the queue launches the session
(`POST /api/sessions/:id/launch`, no prompt) and sends the message with
`POST /api/sessions/:id/turns` once Mend reports the agent running, so the run is the message's
exact turn. The launch answers as soon as the session exists, and the thread is in the shell, by the
client's own thread id, with its message in it: t3code's client opens a launched thread only once
its shell shows one. Images in the opening message are refused until the gateway sends images.

A launched thread keeps the id its client gave it: `thread_ids` in the state file maps it to its
session, and every method that names a thread takes that id. A retry of the same `commandId` is the
same thread (`resumed: true`), across a restart too.

## Run it

Nothing in Mend starts the gateway. Run it beside a Mend server:

```sh
MEND_T3_GATEWAY_MEND_URL=http://127.0.0.1:3101 pnpm --filter @mend/t3-gateway start
```

| Variable                     | Default                                               |
| ---------------------------- | ----------------------------------------------------- |
| `MEND_T3_GATEWAY_MEND_URL`   | `http://127.0.0.1:3101`, Mend's API                   |
| `MEND_T3_GATEWAY_HOST`       | `127.0.0.1`. Anything wider is an exposure (ADR 0004) |
| `MEND_T3_GATEWAY_PORT`       | `3120`                                                |
| `MEND_T3_GATEWAY_STATE_PATH` | `$XDG_STATE_HOME/mend/t3-gateway/state.sqlite`        |
| `MEND_T3_GATEWAY_LABEL`      | `Mend`, the name t3code shows                         |

The gateway needs its own origin: t3code forces a remote environment's base path to `/`.

To pair, mint a code in Mend (`POST /api/me/devices/pairings`, or the devices page) and give t3code
the gateway's host and that code, or `http://<gateway>/pair#token=<code>`. The device shows in
Mend's device list as `t3code · <client label>`; revoking it there ends the bearer.

Mend allows ten failed pairing claims a minute per client address. The gateway sends each claim with
`x-forwarded-for`: the client's own header, if any, then the address the gateway saw. Mend believes
it only from a hop it trusts: loopback (the default `MEND_T3_GATEWAY_MEND_URL`), or an address in
`MEND_TRUSTED_PROXIES`, the same rule as for any proxy in front of Mend. Reached any other way,
every client of the gateway shares the gateway's one budget. Clients on the gateway's own machine
share the loopback budget; a web page can't send `x-forwarded-for` through the gateway's CORS.

A claim Mend refuses for the limit answers `429 Too Many Requests` with Mend's `retry-after` and
`{"error": "rate_limited", "error_description": "…"}`. t3code's token contract declares no
rate-limit error, so its clients report "returned undeclared status 429", as a transient failure,
not as a wrong code. The code is not spent.

## State

One `node:sqlite` file the gateway owns: the environment id, bearer sessions (the bearer's sha256
and the Mend device token it stands for), and the id maps: `run_ids` and `message_ids`, filled by
every turn a t3code client sends, and `thread_ids`, every thread a t3code client launched (its id,
its session, the launch command and what the launch named; no secrets). `project_ids` stays empty.
Mend's database is never touched. Losing the file loses pairings and t3code-side ids, never Mend
records.

**The file holds every paired person's Mend device token in clear**, and the token acts as that
person in Mend until the device is revoked. The gateway needs it usable: it calls Mend for a person
when no client request is in flight (the event stream, device checks every 60 s, queued sends and
relaunches), and a socket that reconnects after a restart carries only a ticket. A hash cannot make
those calls, and a key kept beside the file would protect nothing the file's mode does not. So:

- the gateway creates the file `0600` and a missing directory `0700`, and narrows the file, and
  SQLite's `-wal` and `-shm` beside it, to `0600` each time it opens an existing one;
- an existing directory keeps its mode: point `MEND_T3_GATEWAY_STATE_PATH` at a directory of its
  own;
- run the gateway as a user no one else shares, and keep the file out of backups that others can
  read. Anyone who can read it, or is root, can act as everyone who paired. Revoking a `t3code · …`
  device in Mend ends that token.

## Tests

`pnpm --filter @mend/t3-gateway test` runs the gateway on an ephemeral port in front of a fake Mend
and drives it with `HttpApiClient` over the vendored `EnvironmentHttpApi`, as a t3code client does.

- `test/ws.test.ts` is the handshake end to end: descriptor, `/oauth/token`, ticket, `/ws`, then the
  config snapshot naming the descriptor's environment, the welcome, and the empty shell. Its client
  is built as t3code's `client-runtime` builds one; `client-runtime` itself is not used (the test
  says why).
- `test/rpc-surface.test.ts` checks that the registered handlers are exactly the vendored group's
  methods, then calls every method not served over a bare socket with a payload generated from its
  own schema: each answers a typed failure its contract decodes, or stays silent if it is a feed.
