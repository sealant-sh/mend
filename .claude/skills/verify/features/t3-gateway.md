# T3 gateway

The T3 gateway (`apps/t3-gateway`, ADR 0012) puts a t3code environment in front of Mend, so
t3code's desktop, mobile and web clients can add Mend as a remote environment. A person pairs a
t3code client with a Mend pairing code; the gateway claims the code, keeps the Mend device token,
and gives the client a bearer of its own. To the client it is a t3code server; to Mend it is an
ordinary client of `/api` acting as the person who paired, so Mend's access rules apply unchanged.
In phase 1 (what this branch holds) a person sees their projects and their claude and codex
conversation sessions as threads, watches turns live, sends follow-ups (relaunching an idle-stopped
agent), interrupts, answers approvals and questions, and reads the change's diff. Nothing in Mend
starts the gateway: someone runs it beside a Mend server.

## Sub-features

- `t3-run` starts the gateway beside a Mend server, on loopback by default, with its own state
  file.
- `t3-descriptor` answers `GET /.well-known/t3/environment` with a persisted environment id and
  orchestration protocol 2.
- `t3-pair` exchanges a Mend pairing code for a gateway bearer at `POST /oauth/token`; the device
  shows in Mend as `t3code · <client label>`.
- `t3-session` answers `GET /api/auth/session` as authenticated only while the bearer lives and Mend
  still accepts its device token.
- `t3-ws-ticket` mints a single-use, thirty-second ticket for `/ws?wsTicket=…` at
  `POST /api/auth/websocket-ticket`.
- `t3-ws` upgrades `/ws?…&orchestrationProtocol=2` to t3code's RPC; without the protocol parameter
  answers 426.
- `t3-refusals` refuses browser sessions, pairing links and client sessions with t3code's own error
  bodies.
- `t3-shell` projects projects and protocol-mode claude and codex sessions as t3code projects and
  threads (`GET /api/orchestration/shell`, `orchestration.subscribeShell`).
- `t3-thread` serves one thread in full and keeps it live from Mend's event stream.
- `t3-commands` takes `message.dispatch` (queued, relaunching a stopped agent), `run.interrupt`,
  `queued-run.cancel`, `queue.resume`, `runtime-request.respond` and `thread.user-input.dismiss`.
- `t3-review` serves the thread's change as `review.getDiffPreview` and `review.getDiffFileContents`.
- `t3-revoke` ends the bearer when the device is revoked in Mend.

## How to get to it (user POV)

- Gateway host: `MEND_T3_GATEWAY_MEND_URL=<api> pnpm --filter @mend/t3-gateway start` (the bin
  `mend-t3-gateway`, `node src/bin.ts`). Variables: `MEND_T3_GATEWAY_MEND_URL` (default
  `http://127.0.0.1:3101`, Mend's API), `MEND_T3_GATEWAY_HOST` (`127.0.0.1`),
  `MEND_T3_GATEWAY_PORT` (`3120`), `MEND_T3_GATEWAY_STATE_PATH`
  (`$XDG_STATE_HOME/mend/t3-gateway/state.sqlite`), `MEND_T3_GATEWAY_LABEL` (`Mend`).
- t3code clients (desktop, mobile, web): add a remote environment with the gateway's host and a Mend
  pairing code, or paste `http://<gateway>/pair#token=<code>` into t3code's pairing input.
  The URL is pairing input for t3code; the gateway serves no `/pair` page.
- Web: Settings → Devices mints the pairing code, and lists the paired client as
  `t3code · <client label>` with its revoke (see [Pairing devices](./pairing-devices.md)).
- CLI: `mend pair` mints a pairing code (`✓ pairing code <code>`); the gateway takes that code as its
  credential.
- HTTP: the descriptor, authentication and orchestration snapshot routes answer `curl`.
  The `/pair#token=…` URL is not an HTTP route; `/ws` is the socket endpoint.
- Docs: `apps/t3-gateway/README.md` and `docs/adr/0012-t3code-gateway.md`. The docs site has no page
  for it yet.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, its API answers at `<api>` (the gateway's default
  `http://127.0.0.1:3101`; Launch names it), and the CLI is signed in.
- The repository's dependencies are installed. Nothing listens on `127.0.0.1:3120`.
- A scratch path for the gateway's state, `<scratch>/t3/state.sqlite`, in a directory of its own.
- Start the gateway and record its PID:
  `MEND_T3_GATEWAY_MEND_URL=<api> MEND_T3_GATEWAY_STATE_PATH=<scratch>/t3/state.sqlite pnpm --filter @mend/t3-gateway start`.
  It is ready when `curl -s http://127.0.0.1:3120/.well-known/t3/environment` answers. The gateway
  is written `<gw>` below.
- For the shell steps, at least one claude or codex session runs as a conversation (started from
  the phone, the desktop's `Conversation` mode, or Slack). The t3code client itself is
  `not drivable yet`: the verify stack has no t3code client.

- **Descriptor.** Run `curl -s <gw>/.well-known/t3/environment`. The JSON holds an
  `environmentId`, `"label":"Mend"`, a `platform`, `serverVersion` `<t3code tag>+mend.<n>`,
  `"orchestrationProtocolVersion":2` and `"capabilities":{"repositoryIdentity":false}`. Stop and
  start the gateway; the `environmentId` is the same.
- **Unauthenticated session.** Run `curl -s <gw>/api/auth/session`. The JSON reads
  `"authenticated":false`.
- **A wrong code.** Run
  `curl -s -i -X POST <gw>/oauth/token --data-urlencode grant_type=urn:ietf:params:oauth:grant-type:token-exchange --data-urlencode subject_token=AAAA-AAAA --data-urlencode subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap --data-urlencode requested_token_type=urn:ietf:params:oauth:token-type:access_token`.
  Status `401`; the body carries `"code":"auth_invalid"` and `"reason":"invalid_credential"`.
- **Pair.** Run `mend pair --url <web>` and take the code from `✓ pairing code <code>`. Run the same
  `curl` with `subject_token=<code>` and `--data-urlencode client_label=verify`. Status `200`; the
  JSON holds `access_token`, `"token_type":"Bearer"`, `expires_in` (thirty days) and `scope`. The
  code is spent: the same request again answers `401`.
- **Second view of the pairing.** On the web, Settings → Devices lists `t3code · verify`. The state
  file exists with mode `600` (`stat -c %a <scratch>/t3/state.sqlite`).
- **Authenticated session.** Run
  `curl -s <gw>/api/auth/session -H "authorization: Bearer <access_token>"`. The JSON reads
  `"authenticated":true` with `"sessionMethod":"bearer-access-token"`, the scopes and `expiresAt`.
- **Socket ticket.** Run
  `curl -s -X POST <gw>/api/auth/websocket-ticket -H "authorization: Bearer <access_token>"`. The
  JSON holds `ticket` and `expiresAt`, thirty seconds out.
- **Socket without the protocol.** Run `curl -s -i "<gw>/ws?wsTicket=<ticket>"`. Status `426`; the
  body reads `"code":"orchestration_protocol_incompatible"`,
  `"message":"Update this client to one that supports orchestration protocol 2."`. The protocol is
  checked before the ticket, so the ticket is not spent by this request.
- **Refusals.** Run
  `curl -s -i <gw>/api/auth/pairing-links -H "authorization: Bearer <access_token>"`. Status `403`
  with `"code":"insufficient_scope"`. Run
  `curl -s -i -X POST <gw>/api/auth/browser-session -H "Content-Type: application/json" -d '{"credential":"not-a-browser-credential"}'`.
  Status `401` with `"code":"auth_invalid"`; the gateway offers bearer tokens only. The request
  needs a non-empty JSON `credential` to reach that refusal.
- **Shell.** Run
  `curl -s <gw>/api/orchestration/shell -H "authorization: Bearer <access_token>" -H "x-t3-orchestration-protocol: 2"`.
  The JSON holds `projects` (one per project the person sees, `workspaceRoot` the store path) and
  `threads` (one per claude or codex conversation session; PTY sessions, `mend run` sessions and
  other harnesses are absent).
- **Thread snapshots (HTTP).** Take `<threadId>` from the shell's `threads` list. Run
  `curl -s -i <gw>/api/orchestration/threads/<threadId> -H "authorization: Bearer <access_token>" -H "x-t3-orchestration-protocol: 2"`.
  Status `200`; the JSON holds the thread's projection with its turns and items. Run
  `curl -s -i <gw>/api/orchestration/threads/<threadId>/bounded -H "authorization: Bearer <access_token>" -H "x-t3-orchestration-protocol: 2"`.
  Status `200`; it holds the full thread with `"historyCursor":null` and `"hasMoreHistory":false`.
  The history route requires a non-empty cursor, though this gateway never hands one out. Run
  `curl -s -i --get <gw>/api/orchestration/threads/<threadId>/history --data-urlencode cursor=verify -H "authorization: Bearer <access_token>" -H "x-t3-orchestration-protocol: 2"`.
  Status `200`; it holds `"items":[]`, `"nextCursor":null` and `"hasMoreHistory":false`.
- **Client thread view, follow-up, interrupt, approvals, diff.** `not drivable yet` (no t3code
  client in the stack; the RPC is t3code's Effect RPC over `/ws`). End state when driven from t3code: the thread
  shows the session's turns and items; a sent message becomes a turn in Mend
  (`GET /api/sessions/<id>/turns`, or the session page on the web); an idle-stopped session is
  launched again first; an interrupt ends the open turn; an approval answered in t3code reads as
  answered on the web; the changes panel shows the change's patch.
- **Revoke.** On the web, revoke `t3code · verify` in Settings → Devices. Run the authenticated
  session `curl` again: it reads `"authenticated":false`.
- **Proof.** Keep every `curl` with its status line and body, the `mend pair` transcript, the
  `stat` line, a screenshot of Settings → Devices listing `t3code · verify`, and the gateway's
  stdout and stderr. Stop the gateway by its PID and delete `<scratch>/t3`.

## Gotchas

- The state file holds every paired person's Mend device token in clear. Keep it in scratch, delete
  it in cleanup, and revoke the `t3code · …` device so the token stops acting.
- `MEND_T3_GATEWAY_HOST` other than loopback is an exposure (ADR 0004). A verify run keeps the
  default. The gateway needs its own origin: t3code forces a remote environment's base path to `/`.
- Mend allows ten failed pairing claims a minute per client address; a burst answers `429` with
  `retry-after` and `"error":"rate_limited"`, and the code is not spent. Several wrong-code steps in
  one minute can trip it.
- Only protocol-mode `claude` and `codex` sessions are threads. A run with only PTY sessions sees
  `projects` and an empty `threads`.
- Phase 1 only: launching a new thread from t3code, rename, delete, images, `@`-mentions, per-turn
  diffs, the terminal and a persisted queue answer t3code's typed refusal or stay silent. Whole file
  contents come back only for added or deleted files.
- ADR 0012 names `mend t3 pair`, which prints a t3code-shaped `https://<gateway>/pair#token=<code>`
  and a QR. The CLI has no such command (`apps/cli/src/help.ts` has no `t3`); use `mend pair` or the
  web's devices page for the code. Product gap.
- ADR 0012 has `mend server setup` enable the gateway, with an exposure gate entry and a docs page
  (phase 4). None exist on this branch: the gateway runs only when started by hand, and the docs
  site has no page for it.
