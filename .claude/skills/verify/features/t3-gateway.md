# T3 gateway

The T3 gateway (`apps/t3-gateway`, ADR 0012) puts a t3code environment in front of Mend, so t3code's
desktop, mobile and web clients can add Mend as a remote environment. A person pairs a t3code client
with a Mend pairing code; the gateway claims the code, keeps the Mend device token, and gives the
client a bearer of its own. To the client it is a t3code server; to Mend it is an ordinary client of
`/api` acting as the person who paired, so Mend's access rules apply unchanged. A person sees their
projects and their claude and codex protocol sessions as threads, launches a new thread in a new or
an existing worktree (from origin when asked, running the setup action the person saved), watches
turns live, sends follow-ups with images, queues, edits and reorders them, interrupts, answers
approvals and questions, renames, stops, deletes, archives, pins, settles and snoozes a thread,
switches its model, effort or runtime mode from the agent's next start, finds text in a thread,
reads each turn's diff and the change's whole files, browses and searches the worktree, reads the
branch status, pushes the change and opens its pull request through Mend's landing, and opens Mend's
own shell as a terminal. Pins, thread order, automatic settlement, model favorites, hidden models
and model order are kept per person. It is off unless someone turns it on:
`mend server setup --t3-gateway` runs it in the Mend server image, or someone starts it by hand from
a checkout beside a Mend server.

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
  harness t3code has a driver for (`codex`, `claude`), its login as Mend holds it for the person
  (`GET /api/me/sealant`), and Mend's skills for the composer (`apps/t3-gateway/src/skills.ts`).
  `threadFind` and `threadFindProgressive` are true only when the `/ws` URL carries a
  `clientAppVersion` of 0.1.0 or later (`apps/t3-gateway/src/server-config.ts`, `findsInThread`).
- `t3-settings` keeps each person's model favorites, hidden models and model order
  (`server.updateSettings` with `setModelFavorites`, `setModelsHidden`, `setProviderModelOrder`,
  read back by `server.getSettings`), and their saved project actions; any other settings patch is
  refused (`apps/t3-gateway/src/model-preferences.ts`, `apps/t3-gateway/src/rpc.ts`).
- `t3-shell` projects projects and protocol-mode claude and codex sessions as t3code projects and
  threads (`GET /api/orchestration/shell`, `orchestration.subscribeShell`), with replay after a
  sequence.
- `t3-thread` serves one thread in full and keeps it live from Mend's event stream.
- `t3-launch` takes `orchestration.launchThread`: a new session in a new worktree from a base
  branch, or in an existing worktree, under the client's own thread id. With start from origin it
  refreshes the project first (`POST /api/projects/:id/refresh`). It then runs the first
  `runOnWorktreeCreate` action the person saved for the project in a Mend shell, and reports the
  stages (`fetch`, `checkout`, `setup-script`, `agent`) over `subscribeWorktreeSetup`
  (`worktreeSetup.cancel` stops it). A `t3.json` in the worktree never runs by itself
  (`apps/t3-gateway/src/worktree-setup.ts`).
- `t3-commands` takes `message.dispatch` (queued, relaunching a stopped agent), `run.interrupt`,
  `queued-run.cancel`, `queue.resume`, `queued-run.start`, `queued-run.edit`, `queued-run.reorder`,
  `prepared-run.retry`, `runtime-request.respond`, `thread.user-input.dismiss`,
  `thread.metadata.update` (title only), `provider-session.detach`, `thread.delete`,
  `thread.archive`, `thread.unarchive`, `thread.settle`, `thread.unsettle`, `thread.snooze`,
  `thread.unsnooze`, `thread.pin`, `thread.unpin`, `thread.pin.reorder`, `thread.active.reorder`,
  `thread.auto-settle.set`, `thread.visit`, `thread.mark-unread`, `thread.runtime-mode.set` and
  `thread.model-selection.set` (same provider only) (`apps/t3-gateway/src/commands.ts`). Pins,
  order, settlement and visits are the person's own, in the gateway's state file; automatic
  settlement uses t3code's default days (`apps/t3-gateway/src/lifecycle.ts`).
- `t3-queue` keeps each person's queue in the state file across a gateway restart.
- `t3-images` takes a message's images (`assets.persistChatAttachments`) and places them in the
  session's workspace when the message is sent: up to 100 a message, 8 MiB each and 80 MiB together
  (`apps/t3-gateway/src/images.ts`).
- `t3-files` answers `projects.searchEntries`, `projects.listEntries`, `projects.readFile` and
  `projects.searchContents` from the thread's worktree, and `filesystem.getMetadata` (kind and
  `byteLength`, the composer's file chip sizes) for paths under a project or worktree.
- `t3-find` answers `orchestration.searchThread` and its streaming form over the hub's projection of
  the thread (`apps/t3-gateway/src/thread-find.ts`).
- `t3-vcs` answers `subscribeVcsStatus`, `vcs.refreshStatus` and `vcs.listRefs` from the session's
  branch, change and landings: `hasWorkingTreeChanges` is true while the change has work not yet
  landed, and the remote half (`hasUpstream`, ahead count, pull request) comes from the change's
  last landing (`apps/t3-gateway/src/vcs.ts`, `apps/t3-gateway/src/landing.ts`). Reads are ordered:
  a status never goes back to an older one.
- `t3-landing` takes the git panel's `git.runStackedAction`: Push lands the change (push to
  `mend/<name>` on origin), Create PR lands it with its pull request, as `mend land` does. Commit
  alone, a feature branch, chosen files, a commit message and the project's root are refused in
  Mend's words (`apps/t3-gateway/src/landing.ts`).
- `t3-review` serves the thread's change as `review.getDiffPreview` and
  `review.getDiffFileContents`, whole files included.
- `t3-turn-diffs` answers `orchestration.getTurnDiff` and `orchestration.getFullThreadDiff` from the
  worktree's checkpoint chain.
- `t3-archive` keeps the person's archived threads (`orchestration.getArchivedShellSnapshot`,
  `subscribeArchivedShell`).
- `t3-terminal` opens Mend's shell beside the agent over `/api/tty`, with a `tty` upgrade ticket.
- `t3-revoke` signs the client out when the device is revoked in Mend.

## How to get to it (user POV)

- Packaged server: `mend server setup --t3-gateway` (help in `apps/cli/src/help.ts`). The gateway is
  published where Mend's web port is (`t3GatewayPlacement` in `apps/cli/src/server-edge.ts`):
  `127.0.0.1:3120` on a loopback install, the tailnet or LAN address on a private one, and
  `127.0.0.1` behind the edge, where `--t3-gateway-origin <host>` has Caddy serve it on a host of
  its own (`Caddyfile.t3`, imported from `/etc/caddy/sites/`). `--t3-gateway-port <n>` picks another
  port and implies `--t3-gateway`; `--no-t3-gateway` turns it off and keeps its volume,
  `mend_mend-t3-gateway`. `server.env` carries `MEND_T3_GATEWAY_BIND_HOST`,
  `MEND_T3_GATEWAY_PUBLISHED`, `MEND_T3_GATEWAY_URL` (and `MEND_T3_GATEWAY_EDGE_HOST` when the edge
  serves it). Setup prints
  `The t3code gateway answered at <address>:<port>, observed from this machine. …` with the Remote
  link address, or `The t3code gateway did not answer at
  <address>:<port> from this machine within about a minute. …`.
- `mend server status` prints the placement (`t3code gateway · on · published on …`), then
  `t3code gateway · observed answering at <address>:<port> from this machine · T3 Code's Remote link takes <url>`
  or `t3code gateway · not observed at <address>:<port> from this machine · …`.
- `mend pair` prints `t3 code <url>` and the one-paste link `<url>/pair#token=<code>` beside the
  code, read from `GET /api/machine`'s `t3Gateway`; `mend doctor` has a `t3code gateway` line from
  the same field.
- From a checkout: `MEND_T3_GATEWAY_MEND_URL=<api> pnpm --filter @mend/t3-gateway start` (the bin
  `mend-t3-gateway`, `node src/bin.ts`). Variables: `MEND_T3_GATEWAY_MEND_URL` (default
  `http://127.0.0.1:3101`, Mend's API), `MEND_T3_GATEWAY_HOST` (`127.0.0.1`), `MEND_T3_GATEWAY_PORT`
  (`3120`), `MEND_T3_GATEWAY_STATE_PATH` (`$XDG_STATE_HOME/mend/t3-gateway/state.sqlite`),
  `MEND_T3_GATEWAY_LABEL` (`Mend`) (`apps/t3-gateway/src/config.ts`).
- t3code clients (desktop, mobile, web): a client of the pinned tag `v0.1.1-preview.20261017.3254`
  (`packages/t3-contracts/t3code.pin.json`). Add a remote environment with the gateway's host and a
  Mend pairing code, or paste `http://<gateway>/pair#token=<code>` into t3code's pairing input. The
  URL is pairing input for t3code; the gateway serves no `/pair` page.
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
hand from the checkout and drives it over HTTP with `curl`, and its t3code RPC over `/ws` with
`scripts/drive-t3.mjs` (one call per run, as a t3code client makes it; see the skill's Drive
section). The shipped entry point, `mend server setup --t3-gateway`, is driven only on a disposable
host, as [server.md](./server.md) drives `mend server`; never against the owner's machine or
Launch's stack. The live pass on 2026-10-10 started the gateway by hand from a checkout and drove
the HTTP steps below; its shell read `threads 0`, so it drove no thread, and nothing past the HTTP
routes was observed then. On 2026-10-18 the RPC steps below were driven with `drive-t3.mjs` on a
local verify stack with a fake Claude login, two threads launched through the gateway.

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
- For the shell and thread steps, at least one claude or codex session runs as a conversation. The
  RPC steps below launch one through the gateway; with only a fake Claude login connected
  (`mend connect claude --from-stdin` with `FAKES.claude`) the session and its thread are made, and
  the agent's own turns never run. The t3code client itself is `not drivable yet`: the verify stack
  has no t3code client.
- For the RPC steps, the gateway bearer from **Pair** is in a private file, `<bearer-file>`
  (`jq -r .access_token` of the token response, written under the run's private directory), and
  `<t3>` is `node <skill>/scripts/drive-t3.mjs --gw <gw> --bearer-file <bearer-file>`. Each `<t3>`
  call prints `{"chunk":…}` lines for a stream and one `{"exit":…}` line; exit `0` on success, `1`
  on a typed failure.
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
- **Find is offered by client version.** Run `<t3> server.getConfig`: the exit value holds
  `"threadFind":true` and `"threadFindProgressive":true`, and `providers` lists `claudeAgent` and
  `codex`. Run `<t3> --client-app-version none server.getConfig`: both read `false`.
- **Model preferences per person.** Run
  `<t3> server.updateSettings '{"patch":{"setModelFavorites":[{"provider":"claude","model":"claude-opus-4-1","favorite":true}]}}'`:
  `Success`, its `favorites` list holding that model. `<t3> server.getSettings` returns the same
  `favorites`; stop and start the gateway, and it still does. Run
  `<t3> server.updateSettings '{"patch":{"worktreesDirectory":"/tmp"}}'`: `Failure` with
  `EnvironmentAuthorizationError`,
  `The authenticated token is missing required scope: settings:write.`
- **The project's root.** Take `<root>` (`workspaceRoot`) and `<projectId>` (`id`) from the shell's
  first project. Run
  `<t3> git.runStackedAction '{"actionId":"v1","cwd":"<root>","action":"push","projectId":"<projectId>"}'`:
  `Failure` with `Mend lands a thread's change. The project's root has none.`
- **Launch from origin.** Run `<t3> orchestration.launchThread '<input>'` with `<input>` holding a
  `commandId`, a new `threadId`, `"projectId":"<projectId>"`, a `title`,
  `"modelSelection":{"instanceId":"claudeAgent","model":"mend:claude-default"}`,
  `"runtimeMode":"full-access"`, `"interactionMode":"default"`,
  `"workspaceStrategy":{"type":"worktree","baseRef":"main","branch":"t3code/<name>","startFromOrigin":true}`
  and an `initialMessage` (`messageId`, `text`, `"attachments":[]`). `Success`: the projection's
  thread has a `worktreePath` under the project's `worktrees/` and a `branch`
  `mend/<name>-<suffix>`. Run `<t3> subscribeWorktreeSetup '{"threadId":"<threadId>"}'`: one chunk,
  `"phase":"done"`, with stages `fetch` `done`, `checkout` `done`, `setup-script` `skipped`
  (`None of your actions runs on a new worktree.`) and `agent` `done`. Subscribe within 30 seconds
  of the setup's end: the gateway then drops the snapshot, and the chunk reads `null`.
- **A saved setup action.** Run
  `<t3> server.updateSettings '{"patch":{"projectScriptOverrides":{"<projectId>":[{"id":"proof","name":"Proof","command":"echo verify-setup-ran > setup-proof.txt","icon":"configure","runOnWorktreeCreate":true}]}}}'`.
  Launch a second thread the same way, with `"startFromOrigin":false`. Its setup chunk names the
  `setupScript` `Proof`, with `fetch` `skipped` and `setup-script` `done` (`exited with 0`). Run
  `<t3> filesystem.getMetadata '{"paths":["<worktreePath>/setup-proof.txt"]}'`:
  `{"kind":"file","byteLength":17}`.
- **Pin, model, find.** On the first thread, run
  `<t3> orchestration.dispatchCommand '{"type":"thread.pin","commandId":"v2","threadId":"<threadId>"}'`
  (`Success`); `<t3> orchestration.getThreadProjection '{"threadId":"<threadId>"}'` then shows a
  `pinnedAt`. Dispatch `thread.model-selection.set` with
  `"modelSelection":{"instanceId":"codex","model":"gpt-5"}`: `Failure`,
  `Mend keeps a thread on the agent it started with and cannot hand it to another provider. Start a new thread.`
  With `{"instanceId":"claudeAgent","model":"opus"}`: `Success`, and the projection holds
  `From your next message after the agent stops: opus · it runs as it started until then`. Run
  `<t3> orchestration.searchThread '{"threadId":"<threadId>","query":"<a word of the opening message>"}'`:
  `"totalMatches":1`, the match naming the opening message's `messageId`.
- **Status and the git panel.** On the second thread (the setup action made a change), run
  `<t3> vcs.refreshStatus '{"cwd":"<worktreePath>"}'`: `"hasWorkingTreeChanges":true`,
  `"hasUpstream":false`, `"aheadCount":1`. Run `<t3> git.runStackedAction` with `"action":"commit"`
  and `"threadId":"<threadId>"`: `Failure`,
  `Mend commits a thread's work only when it lands it, and never on the thread's branch. Push commits what is uncommitted and pushes it.`
  With `"action":"push"` and `--chunks 20`: chunks `action_started` (phases `commit`, `push`) and
  `phase_started` `Landing with Mend...`, then the landing's own result. On the verify stack the
  fixture origin refuses pushes:
  `push refused · mend/<name> · fatal: unable to access 'http://verify-stack-fixture:9080/repo.git/': The requested URL returned error: 403`.
  With a pushable origin (as [land-change.md](./land-change.md) sets up), the push lands and
  `vcs.refreshStatus` then reads `"hasWorkingTreeChanges":false` and `"hasUpstream":true` (from
  source, `apps/t3-gateway/src/landing.ts`; not yet observed on a verify stack).
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
- **Client thread view, follow-up, images, interrupt, approvals, rename, archive, runtime mode,
  files, diffs, terminal, skills in the composer, find highlighting, drag order.** Through a t3code
  client: `not drivable yet` (no t3code client in the stack; `drive-t3.mjs` makes single RPC calls,
  so these are reachable call by call, but the client's rendering is not). An agent's turns need a
  real provider login. End state when driven from t3code: the thread shows the session's turns and
  items; a new thread is a session in a new worktree named from the branch's last segment and a
  random suffix (`health-check-k3x9qa`), owned by the person who paired; a sent message becomes a
  turn in Mend (`GET /api/sessions/<id>/turns`, or the session page on the web); an idle-stopped
  session is launched again first; an interrupt ends the open turn; an approval answered in t3code
  reads as answered on the web; a rename shows as the session's label in Mend; an archived thread is
  still listed in Mend; the changes panel shows the change's patch and each turn's files; the
  terminal is a shell process on the session in Mend.
- **Revoke.** On the web, revoke `t3code · verify` in Settings → Devices. Wait more than five
  seconds (one confirmation of the device serves its requests for five seconds,
  `DEVICE_CONFIRMED_FOR_MS` in `apps/t3-gateway/src/auth.ts`). Run the authenticated session `curl`
  again: it reads `"authenticated":false`. Run the socket ticket `curl` again: status `401` with
  `"code":"auth_invalid"` and `"reason":"invalid_credential"`.
- **Proof.** Keep every `curl` with its status line and body, the `mend pair` transcript, the `stat`
  line, the `mend operator exposure` output of each restart, a screenshot of Settings → Devices
  listing `t3code · verify`, every `<t3>` output cut with `jq` to the fields the step reads (a whole
  `server.getConfig` answer fails the evidence scan; the skill's Drive section says why), and the
  gateway's stdout and stderr. Stop the gateway by its PID, restore the server variables, delete
  `<scratch>/t3`, remove the fake Claude login (`mend connect claude --remove`), and stop the
  threads' sessions.

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
  command (`OrchestrationV2DispatchCommandError`). Pull request views, git operations other than the
  panel's Push and Create PR, switching a thread to another provider
  (`Mend keeps a thread on the agent it started with and cannot hand it to another provider. Start a new thread.`),
  plan mode, rollback and forks, other providers, and provider or settings changes other than model
  preferences and project actions have no counterpart in Mend.
- `hasWorkingTreeChanges` means unlanded work, not a dirty index: Mend has no read of HEAD or the
  index. It reads `true` while the change has work its last landing does not cover, and `false` once
  `mend land` (or the panel's Push) has landed it. A binary file, or one past 1 MiB, answers
  `VcsUnsupportedOperationError` for whole contents. Mend lists at most 20,000 files.
- A model, effort or runtime-mode switch applies from the agent's next start; until then the thread
  says `From your next message after the agent stops: <choice> · it runs … until then`
  (`apps/t3-gateway/src/model-options.ts`). Archive is the person's own view in the gateway's state
  file: Mend has no archive, and queued messages are held, not cancelled.
- The git panel's Push and Create PR are landings: only the change's owner lands
  (`only the change's owner lands it`), the push goes to `mend/<name>` on origin and never moves the
  thread's branch, and a pull request needs a GitHub origin and `mend connect github`, as in
  [Land a change](./land-change.md). Commit alone answers
  `Mend commits a thread's work only when it lands it, and never on the thread's branch. …`, and a
  git action at the project's root `Mend lands a thread's change. The project's root has none.`
- The setup card runs only a project action the person saved (t3code's action editor, or its "From
  t3.json" import): a `t3.json` the person has not saved is skipped, with a reason naming the file.
  Mend itself runs no setup when it makes a worktree.
- ADR 0012 names `mend t3 pair`, which prints a t3code-shaped `https://<gateway>/pair#token=<code>`
  and a QR. The CLI has no such command (`apps/cli/src/help.ts` has no `t3`); use `mend pair` or the
  web's devices page for the code. Product gap.
