# T3 gateway

The T3 gateway (`apps/t3-gateway`, ADR 0012) puts a t3code environment in front of Mend, so t3code's
desktop, mobile and web clients can add Mend as a remote environment. A person pairs a t3code client
with a Mend pairing code; the gateway claims the code, keeps the Mend device token, and gives the
client a bearer of its own. To the client it is a t3code server; to Mend it is an ordinary client of
`/api` acting as the person who paired, so Mend's access rules apply unchanged. A person sees their
projects and their claude and codex protocol sessions as threads, launches a new thread in a new or
an existing worktree, watches turns live, sends follow-ups with images, queues, edits and reorders
them, interrupts, answers approvals and questions, renames, stops, deletes and archives a thread,
switches its runtime mode from the agent's next start, reads each turn's diff and the change's whole
files, browses and searches the worktree, reads the branch status, and opens Mend's own shell as a
terminal. It is off unless someone turns it on: `mend server setup --t3-gateway` runs it in the Mend
server image, or someone starts it by hand from a checkout beside a Mend server.

## Sub-features

- `t3-run` starts the gateway by hand from a checkout beside a Mend server, on loopback by default,
  with its own state file.
- `t3-setup` turns it on in a packaged server: `mend server setup --t3-gateway`
  (`--t3-gateway-port <n>`, `--no-t3-gateway`) writes `compose.t3.yaml`, and the image's supervisor
  starts it confined once Mend answers (`scripts/bundle-supervisor.mjs:374`).
- `t3-status` adds the gateway's lines to `mend server status`.
- `t3-exposure` lists `t3code-gateway` in the public exposure gate while the gateway is enabled.
- `t3-descriptor` answers `GET /.well-known/t3/environment` with a persisted environment id and
  orchestration protocol 2.
- `t3-pair` exchanges a Mend pairing code for a gateway bearer at `POST /oauth/token`; the device
  shows in Mend as `t3code · <client label>`.
- `t3-session` answers `GET /api/auth/session` as authenticated only while the bearer lives and Mend
  still accepts its device token.
- `t3-ws-ticket` mints a single-use, thirty-second ticket for `/ws?wsTicket=…` at
  `POST /api/auth/websocket-ticket`, after Mend confirms the device.
- `t3-ws` upgrades `/ws?…&orchestrationProtocol=2` to t3code's RPC, each call checked against the
  bearer's scopes; without the protocol parameter answers 426.
- `t3-refusals` refuses browser sessions, pairing links and client sessions with t3code's own error
  bodies.
- `t3-config` answers `server.getConfig` and `subscribeServerConfig` with one provider per Mend
  harness t3code has a driver for (`codex`, `claude`), and its login as Mend holds it for the person
  (`GET /api/me/sealant`).
- `t3-shell` projects projects and protocol-mode claude and codex sessions as t3code projects and
  threads (`GET /api/orchestration/shell`, `orchestration.subscribeShell`), with replay after a
  sequence.
- `t3-thread` serves one thread in full and keeps it live from Mend's event stream.
- `t3-launch` takes `orchestration.launchThread`: a new session in a new worktree from a base
  branch, or in an existing worktree, under the client's own thread id.
- `t3-commands` takes `message.dispatch` (queued, relaunching a stopped agent), `run.interrupt`,
  `queued-run.cancel`, `queue.resume`, `queued-run.edit`, `queued-run.reorder`,
  `runtime-request.respond`, `thread.user-input.dismiss`, `thread.metadata.update` (title only),
  `provider-session.detach`, `thread.delete`, `thread.archive`, `thread.unarchive` and
  `thread.runtime-mode.set` (`apps/t3-gateway/src/commands.ts`).
- `t3-queue` keeps each person's queue in the state file across a gateway restart.
- `t3-images` takes a message's images (`assets.persistChatAttachments`) and places them in the
  session's workspace when the message is sent.
- `t3-files` answers `projects.searchEntries`, `projects.listEntries`, `projects.readFile` and
  `projects.searchContents` from the thread's worktree.
- `t3-vcs` answers `subscribeVcsStatus`, `vcs.refreshStatus` and `vcs.listRefs` from the session's
  branch and change.
- `t3-review` serves the thread's change as `review.getDiffPreview` and
  `review.getDiffFileContents`, whole files included.
- `t3-turn-diffs` answers `orchestration.getTurnDiff` and `orchestration.getFullThreadDiff` from the
  worktree's checkpoint chain.
- `t3-archive` keeps the person's archived threads (`orchestration.getArchivedShellSnapshot`,
  `subscribeArchivedShell`).
- `t3-terminal` opens Mend's shell beside the agent over `/api/tty`, with a `tty` upgrade ticket.
- `t3-revoke` signs the client out when the device is revoked in Mend.

## How to get to it (user POV)

- Packaged server: `mend server setup --t3-gateway` (help in `apps/cli/src/help.ts:1206`,
  `apps/cli/src/help.ts:1212`). The gateway is published on `127.0.0.1:3120` only;
  `--t3-gateway-port <n>` picks another loopback port and implies `--t3-gateway`; `--no-t3-gateway`
  turns it off and keeps its volume, `mend_mend-t3-gateway`. Setup prints
  `The t3code gateway answered at 127.0.0.1:<port>, observed from this machine; …` or
  `The t3code gateway did not answer at 127.0.0.1:<port> from this machine within about a minute. …`
  (`apps/cli/src/server-setup.ts:1851`, `:1855`).
- `mend server status` prints
  `t3code gateway · on · 127.0.0.1:<port> · loopback only · reaching it from elsewhere is an exposure you declare`
  (`apps/cli/src/server-edge.ts:268`), then
  `t3code gateway · observed answering at 127.0.0.1:<port> from this machine` or
  `t3code gateway · not observed at 127.0.0.1:<port> from this machine · mend server logs shows what it said`
  (`apps/cli/src/server-setup.ts:3435`).
- From a checkout: `MEND_T3_GATEWAY_MEND_URL=<api> pnpm --filter @mend/t3-gateway start` (the bin
  `mend-t3-gateway`, `node src/bin.ts`). Variables: `MEND_T3_GATEWAY_MEND_URL` (default
  `http://127.0.0.1:3101`, Mend's API), `MEND_T3_GATEWAY_HOST` (`127.0.0.1`), `MEND_T3_GATEWAY_PORT`
  (`3120`), `MEND_T3_GATEWAY_STATE_PATH` (`$XDG_STATE_HOME/mend/t3-gateway/state.sqlite`),
  `MEND_T3_GATEWAY_LABEL` (`Mend`) (`apps/t3-gateway/src/config.ts`).
- t3code clients (desktop, mobile, web): a client of the pinned nightly
  `v0.0.46-nightly.20261010.2922` (`packages/t3-contracts/t3code.pin.json`). Add a remote
  environment with the gateway's host and a Mend pairing code, or paste
  `http://<gateway>/pair#token=<code>` into t3code's pairing input. The URL is pairing input for
  t3code; the gateway serves no `/pair` page.
- Web: Settings → Devices mints the pairing code, and lists the paired client as
  `t3code · <client label>` with its revoke (see [Pairing devices](./pairing-devices.md)).
- CLI: `mend pair` mints a pairing code (`✓ pairing code <code>`); the gateway takes that code as
  its credential. `mend operator exposure` lists the `t3code-gateway` item while the gateway is
  enabled (see [Exposure](./exposure.md)).
- HTTP: the descriptor, authentication and orchestration snapshot routes answer `curl`. The
  `/pair#token=…` URL is not an HTTP route; `/ws` is the socket endpoint.
- Docs: the docs site page `apps/docs/src/content/docs/integrations/t3code.md` (t3code),
  `apps/t3-gateway/README.md` and `docs/adr/0012-t3code-gateway.md`.

## Driving it with verify

The verify stack runs Mend from source, not the server image, so the recipe starts the gateway by
hand from the checkout and drives it over HTTP with `curl`. The shipped entry point,
`mend server setup --t3-gateway`, is driven only on a disposable host, as [server.md](./server.md)
drives `mend server`; never against the owner's machine or Launch's stack. The live pass on
2026-10-10 started the gateway by hand from a checkout and drove the HTTP steps below; its shell
read `threads 0`, so it drove no thread, and nothing past the HTTP routes was observed then.

Preconditions:

- Mend is healthy at `<web>`, its API answers at `<api>` (the gateway's default
  `http://127.0.0.1:3101`), and the CLI is signed in. On the verify stack `<api>` is `<web>`: the
  web answers `/api`, and the gateway runs on this machine against the tunnel with
  `MEND_T3_GATEWAY_PORT` set to a free port.
- The repository's dependencies are installed. Nothing listens on `127.0.0.1:3120`.
- A scratch path for the gateway's state, `<scratch>/t3/state.sqlite`, in a directory of its own.
- Start the gateway and record its PID:
  `MEND_T3_GATEWAY_MEND_URL=<api> MEND_T3_GATEWAY_STATE_PATH=<scratch>/t3/state.sqlite pnpm --filter @mend/t3-gateway start`.
  Wait until `curl -s http://127.0.0.1:3120/.well-known/t3/environment` answers. The gateway is
  written `<gw>` below.
- For the shell and thread steps, at least one claude or codex session runs as a conversation
  (started from the phone, the desktop's `Conversation` mode, or Slack). The t3code client itself is
  `not drivable yet`: the verify stack has no t3code client.
- For the exposure step, the run may restart the instance with changed server variables through the
  stack Launch made, as [exposure.md](./exposure.md) does, and restores them at the end. The CLI is
  signed in as the operator.

- **Descriptor.** Run `curl -s <gw>/.well-known/t3/environment`. The JSON holds an `environmentId`,
  `"label":"Mend"`, a `platform`, `serverVersion` `<t3code tag>+mend.<n>`,
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
  `threads` (one per claude or codex protocol session; PTY sessions, shell sessions, `mend run`
  sessions and other harnesses are absent).
- **Thread snapshots (HTTP).** Take `<threadId>` from the shell's `threads` list. Run
  `curl -s -i <gw>/api/orchestration/threads/<threadId> -H "authorization: Bearer <access_token>" -H "x-t3-orchestration-protocol: 2"`.
  Status `200`; the JSON holds the thread's projection with its turns and items. Run
  `curl -s -i <gw>/api/orchestration/threads/<threadId>/bounded -H "authorization: Bearer <access_token>" -H "x-t3-orchestration-protocol: 2"`.
  Status `200`; it holds the full thread with `"historyCursor":null` and `"hasMoreHistory":false`.
  The history route requires a non-empty cursor, though this gateway never hands one out. Run
  `curl -s -i --get <gw>/api/orchestration/threads/<threadId>/history --data-urlencode cursor=verify -H "authorization: Bearer <access_token>" -H "x-t3-orchestration-protocol: 2"`.
  Status `200`; it holds `"items":[]`, `"nextCursor":null` and `"hasMoreHistory":false`.
- **Exposure item.** Restart the instance with `MEND_T3_GATEWAY_ENABLED=1`. The API reads it as a
  configuration fact and starts nothing (`apps/api/src/exposure.ts:436`). Run
  `mend operator exposure`: fifteen item lines instead of fourteen. Between `edge-tls` and
  `reassessment` a line starts `·`, names `t3code-gateway` and `open`, and reads
  `the t3code gateway is enabled (MEND_T3_GATEWAY_ENABLED), on a port of its own; this process cannot observe who reaches that port, nor whether the gateway is listening there. …`
  (`apps/api/src/exposure.ts:359`). The last line counts `<k> of 15 items open`
  (`apps/cli/src/organization.ts:395`). The item does not refuse a public start
  (`blocksStart: false`, `apps/api/src/exposure.ts:159`), so it counts among the `do not`. Restart
  with `MEND_T3_GATEWAY_ENABLED=1` and `MEND_EXPOSURE_DECLARED=t3code-gateway`: the line starts `○`
  and reads `declared`. Restart without either: no `t3code-gateway` line, fourteen items.
- **Client thread view, launch, follow-up, images, interrupt, approvals, rename, archive, runtime
  mode, files, branch status, diffs, terminal.** `not drivable yet` (no t3code client in the stack;
  the RPC is t3code's Effect RPC over `/ws`). End state when driven from t3code: the thread shows
  the session's turns and items; a new thread is a session in a new worktree named from the branch's
  last segment and a random suffix (`health-check-k3x9qa`), owned by the person who paired; a sent
  message becomes a turn in Mend (`GET /api/sessions/<id>/turns`, or the session page on the web);
  an idle-stopped session is launched again first; an interrupt ends the open turn; an approval
  answered in t3code reads as answered on the web; a rename shows as the session's label in Mend; an
  archived thread is still listed in Mend; the changes panel shows the change's patch and each
  turn's files; the terminal is a shell process on the session in Mend.
- **Revoke.** On the web, revoke `t3code · verify` in Settings → Devices. Wait more than five
  seconds (one confirmation of the device serves its requests for five seconds,
  `DEVICE_CONFIRMED_FOR_MS` in `apps/t3-gateway/src/auth.ts`). Run the authenticated session `curl`
  again: it reads `"authenticated":false`. Run the socket ticket `curl` again: status `401` with
  `"code":"auth_invalid"` and `"reason":"invalid_credential"`.
- **Proof.** Keep every `curl` with its status line and body, the `mend pair` transcript, the `stat`
  line, the `mend operator exposure` output of each restart, a screenshot of Settings → Devices
  listing `t3code · verify`, and the gateway's stdout and stderr. Stop the gateway by its PID,
  restore the server variables, and delete `<scratch>/t3`.

## Gotchas

- The state file holds every paired person's Mend device token in clear. Keep it in scratch, delete
  it in cleanup, and revoke the `t3code · …` device so the token stops acting. On a packaged server
  it lives in the `mend_mend-t3-gateway` volume, which `--no-t3-gateway` keeps and `mend uninstall`
  removes (`apps/cli/src/uninstall.ts:337`).
- `MEND_T3_GATEWAY_HOST` other than loopback is an exposure (ADR 0004). A verify run keeps the
  default. The gateway needs its own origin: t3code forces a remote environment's base path to `/`.
- `mend server setup --t3-gateway` refuses a Mend image without the `dev.sealant.mend.t3-gateway`
  label (`Mend <version> has no t3code gateway …`, `apps/cli/src/server-setup.ts:2064`), a gateway
  port already in use on the machine (`apps/cli/src/server-setup.ts:2534`), Mend's own `--port` or
  `--ssh-port`, and 80 or 443 with an edge. In the image the gateway listens on 3120 inside the
  container; only the host's published port moves with `--t3-gateway-port`.
- `MEND_T3_GATEWAY_ENABLED` (`1` or `true`) both lists the exposure item and, in the server image,
  makes the supervisor start the gateway (`scripts/bundle-supervisor.mjs:168`). The exposure item
  says the gateway is enabled, never that it listens: `mend server status` is what reports whether
  it answered.
- Mend allows ten failed pairing claims a minute per client address; a burst answers `429` with
  `retry-after` and `"error":"rate_limited"`, and the code is not spent. Several wrong-code steps in
  one minute can trip it.
- When Mend does not say within two seconds whether the bearer's device is still paired, the ticket
  and the snapshot routes answer `503` with `retry-after: 5` and `"error":"temporarily_unavailable"`
  (`apps/t3-gateway/src/http.ts`); a slow tunnel can surface this mid-recipe.
- Only protocol-mode `claude` and `codex` sessions are threads. A run with only PTY sessions sees
  `projects` and an empty `threads`.
- Refused with t3code's typed errors (`apps/t3-gateway/src/launch.ts`,
  `apps/t3-gateway/src/commands.ts`, the docs page): a thread in the project's root, runtime modes
  other than `full-access` and `approval-required`, a `thread.metadata.update` naming a branch,
  worktree or pull request, steering mid-turn and holding a message for later, and every other
  command (`OrchestrationV2DispatchCommandError`). Pull request views, git operations, switching a
  thread's model or provider, plan mode, rollback and forks, other providers, and provider or
  settings changes have no counterpart in Mend.
- The branch status never claims uncommitted changes (`hasWorkingTreeChanges` is false: Mend has no
  read of HEAD or the index) and has no remote half. A binary file, or one past 1 MiB, answers
  `VcsUnsupportedOperationError` for whole contents. Mend lists at most 20,000 files.
- A runtime-mode switch applies from the agent's next start; until then the thread says
  `From the agent's next start: …`. Archive is the person's own view in the gateway's state file:
  Mend has no archive, and queued messages are held, not cancelled.
- ADR 0012 names `mend t3 pair`, which prints a t3code-shaped `https://<gateway>/pair#token=<code>`
  and a QR. The CLI has no such command (`apps/cli/src/help.ts` has no `t3`); use `mend pair` or the
  web's devices page for the code. Product gap.
