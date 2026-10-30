# GUIs in sessions: a screen the agent drives and people watch

Status: accepted 2026-10-30. It commits Mend to a **screen** in a session. A screen is an X display
in the session's workspace that the session's agent sees and drives through two tools on the `mend`
MCP server, that people watch live from Mend, and that the owner can take over. Mend, not the
workspace, holds every input to the screen. Mend keeps a **screen log** of what the screen showed
and who acted on it, with its frames in Mend's own blob store. Proposed on 2026-10-29. On 2026-10-30
Yiannis took the recommendation on every decision, D0 to D13, as the orchestrator thread relayed it
("Take your recommendation on every one"). The mechanisms are an agent's design, and the decision
log lists them so that he can overturn any one alone. One mechanism changed during the build, after
his answers: an agent process names itself with an id, not a credential (decision log 7). He can
overrule that change.

**What this ADR does not claim.** A frame shows what the screen showed at one moment. It does not
say that a flow works, that a change is correct, or that the agent's account of the screen is true.
The record keeps the frame beside the agent's report so that a person can compare them
(`screen · agent has input · frame 3 s ago`). The screen is not a sandbox against the session's own
agent. Other people's processes cannot use the display, but the owner's agent runs as the same Linux
user, can read the display's password and cookie, and can drive it with any X client outside the
screen log. Takeover arbitrates Mend's input paths, as the prototype's lease did
(`docs/experiments/computer-use.md:139-142`). A screen on a `public` instance still needs ADR 0004's
gate.

## Context

### What was asked

Dates are Yiannis's local dates (EEST, and EET from 2026-10-25). He asked for the feature while
looking at Cursor's cloud agents (T3 thread `e2c83255`, 2026-10-07):

> they don't just show it to you and you can take control over it, they also send you back recorded
> artifacts. I am not aiming to include this in this release, but I would love to have it in the
> next release of mend.

He let the prototype be rough ("One shot it. Doesn't have to be perfect."), and set out what it
would take:

> 1\) Add a new image option (only for say x86 for now) 2) Have that image have the xfce shit and
> the cpu graphics, ffmpeg etc. 3) What other software would it need so we could spawn an agent that
> would just pilot it ? Same way cursor does

He wanted the display beside the terminal ("put it side by side", then "The fucking video and the
terminal"). Just after midnight, on 2026-10-08, he accepted the result without approving its shape:

> Ok perfect. I would say this is a success. Let's document everything about ti so we can implement
> it properly when the time is riight

On 2026-10-18 (roadmap thread `ec2e5833`), under "post .36 add", he listed "- Guis in sessions with
computer use - Recorded video and image artifacts as proof", which became Linear projects P-SLNT-43
and P-SLNT-44. On 2026-10-24 he set the 0.37 scope ("All yellow plus firecracker are in",
`eea284e9`), and on 2026-10-29 he picked this feature for the free slot after previews ("9) guis").
On 2026-10-28 (`eea284e9`), in feedback on a promo video's copy, he wrote:

> Live recording is useless. We are building real artifacts (like the agent uses computer use to
> take screesnshots etc)

He said it about the video's copy, so its reach into the product is his call (D5). The quote is the
thread investigator's reading, not re-read for this ADR. Agents wrote the rest of the framing,
including the Linear statement ("A person can watch the same display live, or take over"), the done
condition ("An agent opens the web app in a session and clicks through a flow while a person watches
it from Mend") and the brief that puts the tools on Mend's `mend` server.

### What the proof of concept proved and left open

In branch `feat/desktop-pilot` (write-up `docs/experiments/computer-use.md`), Claude and Codex
terminal sessions drove Chromium on an X display in their workspace while a person watched a
Mend-bundled noVNC beside the terminal, took over and released (`:16-24`). "No release version or
production architecture is approved by this experiment" (`MEND-AGENT-WORKBENCH-PLAN.md:1411-1418`).

It proved that an unprivileged workspace with no GPU runs Xvnc, a window manager and Chromium
(`computer-use.md:61-63`, `:93-95`), that ordinary Claude Code and Codex conversations drive it from
MCP image results (`:54-57`, `:255-257`), that RFB over the SDK's forward feeds a viewer whose code
is Mend's own (`:180-185`), and that a recording survives a workspace stop (`:24`). It left these
open:

- The controller's raw Service listener "reports `Mend auth: none`", and closing it "is a release
  requirement" (`:211-214`). Xvnc ran with `-SecurityTypes None` (`deploy/desktop/start:16`).
- Watch-only "is a client convention; an authorized owner can still send VNC input directly"
  (`:188-189`), so the controller never logged a person's input.
- A fixed display, ports and token file "allow one controller per workspace/UID" (`:274-277`).
- Recordings were loose files in the harness home, read by a manifest scan capped at 1000 entries
  (`:206-209`). Record links and retention, the separate pilot, browser state on resume and
  Chromium's `--no-sandbox` stayed open (`:283-289`, `:278`, `:290-293`).
- Owner-only viewing was an agent's rule, added 80 minutes into the build
  (`feat/desktop-pilot:apps/api/src/routes/desktop.ts:55-57`). No message from Yiannis covers who
  may watch or take over.

Its Core findings exist only in the branch's `PLATFORM-FEEDBACK.md`. This ADR carries them to main.

### What exists since

- **The `mend` MCP server** (#1150, #1161). `MendMcp` runs in the API process
  (`packages/sessions/src/mend-mcp/server.ts:30-60`) with one tool, `html_render` (`toolkits.ts:6`),
  and every Claude and Codex argv passes `withMendMcp` (`launch.ts:38`). The workspace's bridge
  relays requests concurrently (`packages/sessions/src/session-socket.ts:602-606`), mints a call key
  per `tools/call` into an HTTP header (`:552`), and retries with it until a 110 s deadline (`:40`,
  `:483-505`, `caller.ts:9`). The caller is `{sessionId, accountId, callKey}` (`caller.ts:11-15`),
  and nothing names the calling process. The Docker socket carries no token
  (`session-socket.ts:45`), a person's token is one per launch in a file in their home
  (`engine.ts:8202`, `script-transport.ts:25-30`), and Codex passes four variables
  (`launch.ts:22-27`). Mend stages its dependency-free Node helpers into workspaces
  (`workspaceScriptStaging`, `session-socket.ts:832`, run at `engine.ts:20220-20226`).
- **Pages** (#1166, #1167, #1170). A page is a Postgres row plus an `agent_items` row of kind `page`
  on the current agent process's latest turn (`packages/db/src/repos/session-pages.ts:84-110`). The
  transcript places it by the `attachmentId` in the tool's output
  (`packages/sessions/src/transcript-pages.ts:13-41`). Both protocol adapters strip page HTML
  (`packages/agent-protocol/src/mend-page-call.ts:217`), and Codex stores any other `mcpToolCall`
  whole (`codex.ts:373-391`). Native transcripts are kept raw
  (`packages/sessions/src/harness-state.ts:1-4`), and their converter keeps tool arguments and has
  no timestamps (`native-convert.ts:34-47`, `:143`). A terminal session's pages do not reach T3
  Code, which reads only items (#1170).
- **Live previews** (ADR 0017). `ForwardAdapter` is the one dialer
  (`packages/sessions/src/forward.ts`). A `{kind: "session"}` binding reaches a port only while that
  Sealant session holds it (`apps/api/src/preview-pools.ts:170`). Forwards are bounded. The gateway
  admits by visibility and relays an upgrade byte for byte (`apps/api/src/preview-relay.ts:311`). An
  open preview is rechecked on project, device, user-access and organization events
  (`apps/api/src/preview-identity.ts:188-203`) and every 50 s (`:139`, `:649-650`).
  `ConnectionRegistry` closes sockets only on membership loss and when shared control goes off
  (`apps/api/src/connections.ts:150-172`).
- **Per-person workspaces** (ADR 0016, #1144). Every process runs as one person's Linux user, with a
  private `TMPDIR` and `XDG_RUNTIME_DIR` (SDK `dist/types.d.ts:1574-1591`). People still share an
  executor, its loopback and `/tmp/.X11-unix`. A person who starts a session where another's runs
  gets their own user in it (ADR 0016 `:658`), and a steerer's turn runs as the steerer (`:169`).
  The one-person rule (SLNT-230) is decided, an agent relayed its original words, and this branch
  has no commit for it.
- **Two upgrade-ticket target lists that differ.** The contract lists four
  (`packages/api-contracts/src/upgrade-tickets.ts:11-16`) and the database six
  (`packages/db/src/repos/upgrade-tickets.ts:35-42`), with `tty-renew`, the 12-hour renewal the
  terminal embed reconnects with (`:20-34`).
- **A web defect on this path.** The session page mounts a terminal for protocol agents
  (`apps/web/src/routes/sessions.$sessionId.tsx:98-99`, `session-process.ts:44-47`), which
  `/api/tty` refuses (`apps/api/src/routes/tty.ts:175`, `:210`).

### What stands

- **ADR 0004.** "Executor-served HTML is never served under the authenticated origin" (`:437`). A
  budget refuses new work and "never stops a running session, never closes a socket that is already
  open, and never drops a capture" (`:229-231`). Upgrade tickets are single use, last 30 seconds,
  and open one target (`:289-294`). The T3 asset amendment (Yiannis, 2026-10-24) binds each token
  "to one device and one worktree file, or the file's directory for PDF and HTML", moves "the
  existing `ast_` chat-image tokens" to that rule (`:260-265`), and "does not change upgrade
  tickets" (`:274`). Pages became an asset subject with #1170, an agent's PR
  (`apps/t3-gateway/src/assets.ts:44-58`).
- **ADR 0013.** In a terminal session only the owner types, because typing spends the workspace's
  login (`:106-121`). The rule is `canTypeInTerminal`
  (`packages/domain/src/workbench/session-control.ts:63`), enforced by `ttyInputOf`
  (`apps/api/src/routes/tty.ts:38`).
- **AGENTS.md.** Mend uses Sealant only through `@sealant/sdk`, and a gap is platform feedback.
- **Yiannis's preview decisions, not reopened here.** The domain rules, the tailnet default,
  `__Host-` cookies, anyone who can see a session opens its preview (ADR 0017 `:535`), and recipe
  approval by the starting session's owner.
- **One API process.** The Mend API runs one replica, pinned by the session channel registry
  (`deploy/aws/issues-for-real-ha.md:34`).

## The design

### The workspace runs a display, and Mend holds the input

The workspace runs only Xvnc on `127.0.0.1:5900+n`, a small window manager and the apps on it. It
has no controller, lease, recorder or MCP server. Mend speaks RFB to Xvnc over bounded,
session-bound forwards.

**The hand.** For each live screen, Mend's API process holds exactly one RFB connection that sends
input, called the hand. The hand has one serial queue for every input and every observation: the
agent's actions, a holder's keys and pointer moves, the releases at each change of holder, and the
moment each answer's frame is copied from Mend's framebuffer. PNG encoding runs in a worker off the
queue. Xvnc applies one connection's messages in the order Mend sent them, so nothing a former
holder sent can land after a fence. The prototype also ran its actions through one queue
(`feat/desktop-pilot:deploy/desktop/server.mjs:509`). Viewers only observe. A holder's keys and
pointer reach Xvnc through the hand, never on the viewer's own connection.

Every input passes one service, `Screens`. That arbiter makes takeover atomic, enforces watch-only
on the server, logs human input and removes the raw listener. The price is an RFB client and codec
in Mend, about 600 lines with fixtures by guess, that treats the workspace's bytes as hostile. D0
puts the alternative, a Mend controller inside the workspace, to Yiannis.

### The display is authenticated

Xvnc runs with `-SecurityTypes VncAuth` and an X `-auth` cookie. Mend generates a full and a
view-only password at each start. They travel in neither argv nor env, since the SDK says a
session's env is "not for secrets" (`dist/types.d.ts:1565`) and its only secret channel carries
connected-account logins. The script fetches them over the session channel it already holds, with
the staged helper (`/run/mend/bin/mend screen-secret`), and writes them with `vncpasswd -f` to a
0600 file in the person's private runtime directory, with the cookie beside it. The hand signs in
with the full password, and each relay with the view-only one, so Xvnc ignores input on a relay's
connection (PR 11 checks it). `-SendCutText=0` keeps the screen's clipboard from every relay, since
a relay passes server bytes to every watcher.

People still share an executor's loopback, and the one-person rule has no commit. Without a
password, another person's agent could drive the owner's screen, and its logins, through
`localhost:59xx` or `/tmp/.X11-unix/X<n>`. With one, screens need not wait for SLNT-230.

### The screen is a session process, not a Service

`Screens` starts and stops a screen through its own module,
`packages/sessions/src/screen-process.ts`, on the engine's process primitives, not in `engine.ts`
(26,289 lines). It opens a Sealant PTY session as a Service attempt does (`engine.ts:22985-23025`)
and records a process row of a new kind, `screen`. It is not a Service, because `ServiceHost` gives
a Service a raw listener with no Mend authentication
(`packages/sessions/src/service-host.ts:193-201`, tenancy item `raw-service-ports` in
`apps/api/src/tenancy.ts:139`).

**Startup and teardown.** The argv is `sh -c <script> mend-screen :<n> 1280x800 <dir>`, where
`<dir>` is the screen's 0700 runtime directory, named by the engine so that the cookie path is the
same at every start. The script forks one child, then `exec`s Xvnc, so Xvnc is the leader and holds
the port. A `{kind: "session"}` forward reaches this X server only, and resets with `owner-exited`
when Xvnc exits (SDK `dist/types.d.ts:1484-1495`). The child waits for the display with `xdpyinfo`,
at most 10 s, as the prototype did (`deploy/desktop/start:16-21` on the branch). It then starts the
window manager and the browser, and prints `mend-screen ready` or `mend-screen degraded <client>` to
the session's output, which Mend reads into the status line. When the display goes, the child kills
its process group. The SDK does not say what happens to a session's other processes after its leader
exits, so PR 11 checks that nothing outlives Xvnc, and platform feedback 3 asks.

**One display per session.** A display number is reserved at the session's first launch in a project
whose Environment has a screen, kept while the session lives (idle stops and restarts reuse it), and
released when it ends. A partial unique index on `(workspace_id, display)` among unended sessions
allocates it. Every launch path (cold, claimed standby, join, resume, follow-up, retained run and
mode switch, ADR 0016 `:169`) gets `DISPLAY=:<n>` and `XAUTHORITY`, so an app the agent starts
appears on its own screen and never on another session's. A session launched before its project
gained a screen has no `DISPLAY`, and the tool text names the display.

**One browser profile per screen.** Mend stages a `chromium` wrapper as it stages its helper, first
on the PATH of a session with a display. It starts the browser on that display with
`--user-data-dir` in the screen's private runtime directory. The script starts the browser through
the same wrapper, so the agent's `chromium <url>` opens a tab in that instance. Without it, a shell
launch takes the default profile in the person's home and can open in another screen's browser, as
the prototype saw (`deploy/desktop/control.mjs:65` on the branch).

**Lifetime.** The screen starts on demand (D7), at the first screen tool call or the owner's **Start
screen**. It stops after 15 minutes with no agent call and no holder, with the session's **Stop** or
the protocol idle stop, and with its workspace. It holds that idle stop only while a person holds
its input, as a new `ProtocolIdleHold`, `screen`
(`packages/domain/src/workbench/protocol-idle.ts:41`). It does not make its session `running`, since
it is not an agent kind (`session-process.ts:44-48`), and unlike a Service it does not hold the
workspace after the agent stops. Viewers alone do not keep it running, and the status line counts
them from `ConnectionRegistry`, with no table. Watching a stopped screen never starts it.

**A lost start.** The engine marks a failed open exited (`engine.ts:23023`), but a lost answer to
`sessions.open` leaves Mend unable to tell whether Xvnc started. Mend reaps by display through
`sealant.exec` as the person, killing the process named in `/tmp/.X<n>-lock`, and starts again on
the same display. Platform feedback 4 asks for a keyed start.

### The agent's two tools

`screen_look` and `screen_act` join `MEND_TOOLKITS` through `McpServer.addTool`, so a result carries
a real `ImageContent` block beside a text block. They reach every Claude and Codex session, protocol
and terminal, through resume, mode switch and join, because those launches pass `withMendMcp`. The
tool catalog lives once in `@mend/agent-protocol`, below both the MCP adapter and the record
compactors.

In a typical turn, the agent starts `pnpm dev` and `chromium http://localhost:3000` from its shell,
calls `screen_look`, sends a few `screen_act` batches, and reports what it saw. Each answer is the
frame after the screen went quiet (300 ms without an update, at most 2 s) and one line per action.
Claude Code calls tools in parallel and the bridge relays them at once, so a second `screen_act`
while one runs answers `busy`, and a `screen_look` waits in the queue. A batch runs at most 60 s,
well under the bridge's 110 s, and actions past it answer `skipped: time limit` (D13). Without a
screen, both tools answer
`This session's workspace has no screen. The project's owner turns it on in the project's Environment.`
Nothing hangs, and no other agent starts (`computer-use.md:311-312`).

- **Caller attribution.** The engine gives each agent process its id in env,
  `MEND_AGENT_PROCESS_ID`, when it stages the launch. Codex's `env_vars` gains it. The `mend` helper
  sends it with each `tools/call` on both transports, and the caller resolves it against the
  session's process rows. The channel credential (the socket mount, or the launch or person token)
  still authenticates the call. The id only names which of that caller's processes speaks, so a
  screen mutation can refuse a superseded process, such as a retained MCP child of an old turn.
  `html_render` places its page on the calling process's turn. The proposal was a credential per
  process. The build dropped it, because the SDK says a session's env is "not for secrets"
  (`dist/types.d.ts:1565`), and a same-user process can read another's env anyway. Yiannis can
  overrule this change.
- **Durable call claims.** Before any input, `Screens` claims `(screen_id, call_key)` with a SHA-256
  of the canonical arguments, each `type` text replaced by its length. A retry with the same key and
  arguments answers the stored outcome (`applied`, `interrupted`, `refused` or `outcome_unknown`)
  and sends no input. The same key with other arguments answers `call_reused`. A claim open when
  Mend boots becomes `outcome_unknown`. A completed call whose frame is gone answers
  `observation_unavailable`, and the agent looks again. Mend never repeats input for a frame.
- **The receipt.** Every answer carries `receipt {screenId, seq, callKey}` in its text and its
  `structuredContent`. The compactors and native-transcript ingestion read it from the result, as
  pages read `attachmentId` (`transcript-pages.ts:20`). The call key alone links nothing, because no
  harness sees the bridge's header.
- **Compaction and typed text.** Both protocol adapters strip a screen tool's image blocks and
  `type` text from stored items and approval requests, and leave a `mendScreenCall` marker that
  holds the receipt, as they do for pages. The screen tables keep a text's length only. The native
  transcript keeps the arguments, and the frames show the text (D6).

### Who holds the input

One row per screen holds the input state and its epoch, which counts changes of holder. The pure
function `transitionInput` changes it under a row lock, and nothing else decides who holds the
input. The hand runs an agent action only under the epoch its call read, rechecked before each
action, and re-issues a viewer's input only while the state is `Person` of that connection.

The table is total. `+` means the epoch goes up, `=` means nothing changes, and "releases" means the
hand sends a key-up and a button-up for everything the former holder holds, ahead of anything behind
it in the queue.

| Event                                            | `Agent`                              | `Fencing(X)`                                                 | `Person(C)`                            | `Paused`                               | `AwaitingAgent`                |
| ------------------------------------------------ | ------------------------------------ | ------------------------------------------------------------ | -------------------------------------- | -------------------------------------- | ------------------------------ |
| The owner presses **Take over** on connection D  | `Fencing(D)`+, batch stops, releases | X = D: =. Else `Fencing(D)`+                                 | C = D: =. Else `Fencing(D)`+, releases | `Fencing(D)`+                          | `Fencing(D)`+                  |
| Anyone else presses **Take over**                | Refused `owner-only`                 | Refused                                                      | Refused                                | Refused                                | Refused                        |
| The hand reports the fence done, current epoch   | =                                    | `Person(D)` and `Taken`, or `AwaitingAgent` and `HandedBack` | =                                      | =                                      | =                              |
| The holder C lapses: no heartbeat, gone, revoked | =                                    | X = C: `Paused(reason)`+. Else =                             | `Paused(reason)`+, releases            | =                                      | =                              |
| The owner presses **Hand back**                  | =                                    | X = AwaitingAgent: =. Else `Fencing(AwaitingAgent)`+         | `Fencing(AwaitingAgent)`+, releases    | `AwaitingAgent`+ and `HandedBack`      | =                              |
| The `Paused` timeout passes (D13)                | =                                    | =                                                            | =                                      | `AwaitingAgent`+, `HandedBack` by Mend | =                              |
| An attributed `screen_look`                      | Answers                              | `held`                                                       | `held`                                 | `held`                                 | `Agent`+, with `sinceLastLook` |
| An attributed `screen_act`                       | Runs, or `busy`                      | `held`                                                       | `held`                                 | `held`                                 | Refused `look_first`           |
| Mend boots and finds the row                     | `AwaitingAgent`+                     | `Paused(restart)`+                                           | `Paused(restart)`+                     | =, its timeout still running           | =                              |
| The screen process exits or the workspace ends   | Input resets, viewers close          | The same                                                     | The same                               | The same                               | The same                       |

A fence report from an older epoch changes nothing. At boot, a fresh hand first sends a pointer
event with no buttons and a key-up for each modifier, because the old hand's record of held keys
died with it. PR 8 checks whether Xvnc already releases a closed connection's keys. An `Agent` row
goes to `AwaitingAgent`, not `Paused`, because no person held the input and the agent must look
first anyway. One API process holds every hand, so the epoch needs no cross-process notice. A second
replica would have to route each viewer's input to the process that holds the hand.

### Watch-only is a filter on RFB messages

`Screens.relay` answers the viewer's RFB handshake itself, with security type None, because the
viewer's access is its Mend sign-in plus a ticket. It dials the screen (purpose `screen`,
session-bound), signs in with the view-only password, and sends a `ClientInit` with the shared flag
set, as the hand does, so no connection displaces another. It relays the server's bytes untouched
and parses the viewer's:

- `SetEncodings` is rewritten to an allow-list: Raw, CopyRect, ZRLE and the `DesktopSize`
  pseudo-encoding. `Cursor` is left out, so Xvnc draws the real pointer into the frames every
  watcher and the agent see; with it, noVNC would draw each viewer's own pointer instead. noVNC asks
  for Fence, ContinuousUpdates, QEMU Extended Key Event, ExtendedDesktopSize and xvp by default.
  Offered those, it would send message types 248, 150, 255, 251 and 250, with its keys as type 255.
  Without them, it sends only `KeyEvent` and `PointerEvent`, and no watcher can resize the screen or
  ask it to shut down.
- `SetPixelFormat` and `FramebufferUpdateRequest` pass.
- `KeyEvent` and `PointerEvent` go to the hand, which re-issues them for the holder only.
- `ClientCutText` follows the clipboard default (D13) and never passes on the relay's connection.
- Any other message type closes the viewer.

This is the RFB form of `ttyInputOf`.

**Admission and revocation.** Each relay registers with `ConnectionRegistry` under a new kind,
`screen` (`apps/api/src/connections.ts:16`), so membership loss, shared control going off and the
owner's **Stop** close it, and it counts against a new ADR 0004 budget, `screen-viewers`, per
account and per screen. The registry misses a project turning private and a device being revoked, so
screens reuse the preview recheck, extracted from `preview-identity.ts` into one policy. A frame
read checks the same rule on every request.

**Bounded decoding.** The hand decodes the workspace's bytes in Mend's API process, and the agent
controls what the display sends. A bounded forward bounds bytes in flight, not what they decode to.
The codec accepts Raw, CopyRect and ZRLE, refuses a `DesktopSize` other than 1280x800, checks every
rectangle against the framebuffer before it allocates, and caps decoded bytes per update at one
framebuffer (4,096,000 bytes). It also caps buffered messages per connection and zlib output per
rectangle, decodes in a worker with a deadline, and caps decoders running at once. A violation
closes the hand and marks the screen degraded. Viewers decode in their own browsers.

### How people watch and take over

Every surface shows one status line built from observed state, such as
`screen · agent has input · frame 3 s ago`, `screen · input paused · connection lost` or
`screen · ended after 15 min idle`.

- **Web.** The screen sits beside the terminal or the Record, stacked on narrow widths. The viewer
  is Mend's bundled noVNC on `/api/screen-socket`, which the CSP already allows (`connect-src` names
  the app's WebSocket origin, `apps/web/src/entry/security-headers.ts:47`). The owner sees **Take
  over** and then **Hand back**. Everyone else reads `Only <owner> puts input on this screen.` With
  no screen yet, the owner sees **Start screen**. The same PR fixes the terminal predicate, so a
  protocol session shows its Record beside the screen.
- **Phone.** **Screen** opens Mend's own `/screen-embed` page in a top-level WebView. Its ticket is
  exchanged for a `screen` ticket and a 12-hour `screen-renew` ticket, as `tty-embed`'s is, so the
  page reconnects after the app returns from the background. The page posts its viewer connection id
  to the app as `mend:screen-connection:<id>`, as the terminal embed posts `mend:embed-expired`
  (`apps/web/src/components/terminal.tsx:81-88`,
  `apps/mobile/src/components/ghostty-terminal.tsx:296-298`). The native **Take over** and **Hand
  back** buttons send that id.
- **T3 Code.** In a protocol session, an episode projects as a completed `screen` tool call with
  frames as output images, if D4 adds a frame asset. A terminal session has no items, so the gateway
  reads the screen log and projects its episodes as system notices. People's entries are system
  notices in both, which need no provider turn (`apps/t3-gateway/src/thread-projection.ts:753-787`).
  **Watch in Mend** is a plain link to the web screen. T3 Code gets no live view and no control
  credential.
- **VS Code.** The record reads `## screen · 14 actions · 15 frames · Watch in Mend`. The command
  **Mend: Watch Screen** opens the web screen in the browser, since the extension has no webview.

### The screen log, its frames and the record

The screen log (`screen_log`, append-only, keyed `(screen_id, seq)`) is a stream per session. Each
entry names its actor: the agent (its process, its turn in a protocol session, and its receipt), a
person, or Mend. A frame is a PNG that Mend encoded, stored in its `BlobStore`
(`packages/store/src/blob-store.ts:87`) under a key scoped to its screen. Identical consecutive
frames share a blob, and no blob is shared across organizations.

Mend stores one frame per agent call, one at each take, pause and hand back, and, while a person
holds the input, one when the screen changed, at most one a second (D5). Stored frames count against
a byte budget per screen and per organization (D13). At the limit, input and answers keep working
and the agent still gets its image, but Mend stores no more frames, and the log reads
`frames not kept · budget reached`. A frame not yet stored is new work, so refusing it keeps to ADR
0004, and stored frames stay.

The log reaches the record without inventing a turn:

- **Agent entries, protocol session.** Each pair of screen and turn gets one `agent_items` row of a
  new kind, `screen`, upserted in the transaction of each append, as `ensurePageItem` does for
  pages. The row holds a span of the log, counts and a cover frame, never the frames.
- **Agent entries, terminal session.** It has no turns and no items. The projection builds each
  episode from the screen log and places it at the native tool call whose output holds its receipt.
- **People's entries.** `AgentItem.turnId` is required
  (`packages/domain/src/workbench/agent-protocol.ts:148`), and `GET /sessions/:id/items` returns
  only agent items (`packages/api-contracts/src/sessions.ts:374-379`), so these entries cannot be
  items, and native events carry no time to merge by. The projection places each one before the
  agent's next look, when the agent learns of it through `sinceLastLook`, and any after the last
  look at the end. `withMendItems` replaces `withPages` and applies it to `/transcript` on the
  server. The phone and the T3 gateway apply it to `/items` plus `GET /sessions/:id/screen/log`.

### The seam for "Recorded proof artifacts"

That later feature builds on three things this design stores and does not use itself:

- **`ScreenMoment {screenId, seq}` and `ScreenSpan {screenId, fromSeq, toSeq}`** address any part of
  the log.
- **Exact or gap.** An agent entry links to the tool call that holds its receipt (`Pending` until
  the item arrives), and reads `Gap` when nothing holds it, as in a transcript that lost the call. A
  checkpoint link is only `ObservedAfter`, the latest checkpoint before the entry
  (`packages/db/src/schema/workbench.ts:2250`). No entry claims a frame shows a checkpoint's tree.
- **Frame states.** Each frame is `stored`, `expired` or `missing`, so a filmstrip says what was
  observed and what is gone. Holds that keep a span past retention arrive with that feature, as a
  table the retention sweep reads before it deletes. Until then, D6's retention applies to every
  frame. A video, if one ships, is another media kind over a span and changes none of this.

### Where the preview access model is reused, and where it is not

| ADR 0017 part                                                    | For a screen                                                                       |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `ForwardAdapter`, the bounded forward, the session binding       | Reused, with a new purpose, `screen`, and a 15 s dial.                             |
| Revocation registration, the admission recheck, budgets          | Reused, with the `screen` connection kind, the shared policy and `screen-viewers`. |
| Upgrade tickets                                                  | Reused, with three new targets, `screen`, `screen-embed` and `screen-renew`.       |
| "Anyone who can see the session"                                 | Recommended for watching (D2). Yiannis decided it for previews only.               |
| The preview gateway, its origin, the grant cookie, tailnet ports | Not reused.                                                                        |

The gateway does not fit, for three reasons. Its relay is byte-blind (`preview-relay.ts:311`), so it
cannot drop input. It admits by visibility, which would let every viewer type with the owner's
login. RFB is not HTTP, so the gateway's head checks have nothing to check. The same-origin socket
keeps to ADR 0004, because nothing the workspace sends runs on Mend's origin. The viewer is Mend's
bundle, the workspace sends RFB rectangles, and frames are PNGs Mend encoded and serves with
`nosniff`.

### What the design does not do

0.37 has no video, audio, file transfer, second monitor, code-execution tool or separate pilot
(D11). Size, resizing and clipboard are defaults in D13. Mend does not filter screen text. The tool
description tells the agent to stop at passwords, payments and one-time codes, and the
prompt-injection case (`computer-use.md:322-323`) joins the verify map.

## Data shapes

The core types, trimmed, with `readonly` dropped. They live in
`packages/domain/src/workbench/screen.ts` unless marked.

```ts
export interface Screen {
  id: ScreenId;
  sessionId: SessionId;
  workspaceId: SealantWorkspaceId;
  display: DisplayNumber; // 10..99, reserved from the session's first launch until it ends
  processId: SessionProcessId | null; // the live `screen` process
  life: { _tag: "Starting" } | { _tag: "Live"; degraded: Degraded | null } | Ended;
  input: ScreenInput;
}
type Degraded = "client-failed" | "decoder-refused";
type EndReason = "idle" | "session-stopped" | "process-exited" | "workspace-ended";
type Ended = { _tag: "Ended"; reason: EndReason };
type Lapse = "lease-lapsed" | "disconnected" | "revoked" | "restart";

/** Who may put input on the screen. Every change of holder bumps `epoch`. */
export type ScreenInput = { epoch: number } & (
  | { _tag: "Agent" }
  | { _tag: "Fencing"; to: { _tag: "Person"; connection: ViewerConnectionId } | "AwaitingAgent" }
  | { _tag: "Person"; userId: UserId; connection: ViewerConnectionId } // heartbeat lease (D13)
  | { _tag: "Paused"; reason: Lapse; since: Date } // leaves after D13's timeout
  | { _tag: "AwaitingAgent" }
);
// InputEvent: Take(by, connection) | Fenced(epoch) | Lapsed(connection, reason) | HandBack(by)
//   | PauseTimedOut | AgentLooked(caller: session, process, launch) | Booted

/** Pure, applied under the screen row's lock. `Unchanged` keeps the epoch. */
export declare const transitionInput: (
  input: ScreenInput,
  event: InputEvent,
  owner: UserId | null,
) =>
  | { _tag: "Changed"; next: ScreenInput; releases: boolean }
  | { _tag: "Unchanged" }
  | { _tag: "Refused"; why: "owner-only" | "held" | "look-first" };

export type ScreenActor =
  | { _tag: "Person"; userId: UserId }
  | { _tag: "Mend" }
  | {
      _tag: "Agent";
      processId: SessionProcessId;
      turnId: AgentTurnId | null;
      callKey: string;
      toolCall: { _tag: "Item"; itemId: AgentItemId } | { _tag: "Native" | "Pending" | "Gap" };
    };

export type ScreenLogBody =
  | { _tag: "Started" | "Looked" }
  | { _tag: "Acted"; notes: ReadonlyArray<ActionNote> } // a `type` note keeps the length only
  | { _tag: "Taken" | "HandedBack"; epoch: number } // HandedBack by a Person, or Mend at D13
  | { _tag: "PersonInput"; clicks: number; keys: number; pastes: number }
  | { _tag: "Paused"; reason: Lapse }
  | { _tag: "FramesNotKept"; budget: "screen" | "organization" }
  | { _tag: "Degraded"; reason: Degraded }
  | { _tag: "Ended"; reason: EndReason };

export interface ScreenLogEntry {
  screenId: ScreenId;
  seq: number;
  at: Date;
  actor: ScreenActor;
  body: ScreenLogBody;
  frame: { id: ScreenFrameId; digest: string; state: "stored" | "expired" | "missing" } | null;
  checkpoint: { _tag: "ObservedAfter"; checkpointId: CheckpointId } | null;
}
// ScreenMoment {screenId, seq} and ScreenSpan {screenId, fromSeq, toSeq} address the log.
// ScreenEpisode, the `screen` record item: { span, actions, frames, coverFrameId, personHeld }
```

The tools, in `packages/agent-protocol/src/mend-screen-tools.ts`:

```ts
export const ScreenLookParams = Schema.Struct({});
export const ScreenActParams = Schema.Struct({
  actions: Schema.Array(ScreenAction).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
}); // and at most 60 s per batch (D13)
// ScreenAction: click {at, button?, count?} | move {to} | drag {from, to} | scroll {at, dx, dy}
//   | type {text, at most 2,000 characters} | key {combo, "ctrl+l"} | wait {ms, at most 5,000}

/** The text block beside the PNG. `structuredContent` carries the same object. */
export interface ScreenToolText {
  screen: { display: string; size: "1280x800"; input: "agent" | { person: string; since: string } };
  receipt: { screenId: string; seq: number; callKey: string };
  frameId: string | null; // null when the frame budget kept no frame
  outcome: "applied" | "interrupted" | "refused" | "outcome_unknown";
  refusal?:
    | "no_screen"
    | "held"
    | "busy"
    | "look_first"
    | "call_reused"
    | "observation_unavailable"
    | "unattributed_caller";
  actions?: ReadonlyArray<{ action: string; result: "done" | `skipped: ${SkipReason}` }>;
  sinceLastLook?: ReadonlyArray<string>; // "Yiannis took the screen at 14:02:10"
  message: string;
}
type SkipReason = "taken over" | "time limit";
```

## Decisions for Yiannis

Each keeps its options, its evidence, and what changes under the others, for the record. Yiannis
took every recommendation on 2026-10-30. D13 groups small defaults in one table.

### D0. The architecture

- **(a)** Mend holds the input through the hand and speaks RFB, as above. **(b)** A Mend controller
  inside the workspace owns X input, a journal and capture, and takes signed, typed actions from
  Mend. People watch a full-frame JPEG stream and send typed input on a separate socket. The two
  arena candidates that proposed (b) chose it for a watch channel with no input message and no RFB
  parser in Mend.
- **Decided 2026-10-30, as recommended: (a).** People see real RFB updates through the viewer the
  prototype proved (`computer-use.md:180-185`). The (b) candidates stream a few full frames a second
  and say that stream must be measured before anyone calls it usable. Yiannis's bar for interactive
  surfaces, as Mend's agent memory recorded it on 2026-07-25, is "anything other than instant is not
  acceptable".
- **The same under both.** Neither needs a platform image layer. A controller can be staged beside
  the `mend` helper and versioned with the server. Both start a process with `sessions.open`, so a
  lost start costs both the same.
- **What differs.** Under (a), Mend's API process decodes the workspace's RFB within bounds, and
  watch-only is a filter over a view-only password. Under (b), a hostile stream harms only the
  workspace, and watch-only is structural, but the watch stream is unmeasured, and (b) adds signing
  keys, an envelope protocol and a controller journal. One (b) stack ran to 31 PRs against 14 for
  (a), and this ADR's runs to 21. Under (b), PRs 7 and 8 become the controller and its protocol.

### D1. Which apps first

- **(a)** A browser only, full screen in kiosk mode. **(b)** Any X app: a light window manager,
  Chromium preinstalled, and `DISPLAY` set for the agent.
- **Decided 2026-10-30, as recommended: (b).** The agent-written statement names "a browser, an
  Electron app", and Yiannis's message of 2026-10-07 asks for "the xfce shit and the cpu graphics".
  With Mend speaking RFB, any app costs only a window manager.
- **Under (a):** the script runs Chromium in kiosk mode through the wrapper, with no window manager.

### D2. Who may watch

- **(a)** The owner only, as the prototype did. **(b)** People who may steer, as the terminal does.
  **(c)** Anyone who can see the session, as previews do.
- **Decided 2026-10-30, as recommended: (c).** Yiannis decided previews this way ("Sure", ADR 0017
  `:535`). ADR 0013 lets steerers watch a terminal (`:111-112`). The prototype's owner-only rule was
  an agent's (`desktop.ts:55-57` on the branch). The frames land in the record, which everyone who
  sees the session reads. A screen shows the owner's signed-in pages, so teammates would see those.
  A tab left open costs the owner nothing, because viewers do not keep a screen running.
- **Under (a) or (b):** the view, relay, log and frame routes and the recheck use the stricter rule,
  and the record hides screen items from the same people. Otherwise the rule is not real.

### D3. Who may take over

- **(a)** The owner only. **(b)** Anyone who may steer, while control is shared.
- **Decided 2026-10-30, as recommended: (a).** The screen runs as the owner's Linux user and holds
  the owner's browser logins, so typing on it spends them, the case ADR 0013 gives to the owner
  alone (`:114-117`). A related proposal, for the same reason, refuses `screen_act` on a turn
  someone other than the owner sent. In a one-person workspace that turn never happens.
- **Under (b):** a steerer's keys spend the owner's logins with no turn to switch at, so (b) needs
  an amendment to ADR 0013, not a setting.

### D4. How each client watches and takes over

- **(a)** Web and phone watch live and the owner takes over there. T3 Code and VS Code show the
  record and link to the web screen. **(b)** As (a), plus a live view in T3 Code through its
  `preview.*` browser on `/screen-embed`, and a VS Code webview of the same page. **(c)** Web only
  in 0.37, with frames on the phone. For frames in T3 Code: **(i)** an ADR 0004 amendment for a
  `frame` asset subject under the rule pages, files and images follow
  (`apps/t3-gateway/src/assets.ts:44-58`), or **(ii)** counts and **Watch in Mend** only.
- **Decided 2026-10-30, as recommended: (a) with (i).** The T3 gateway refuses `preview.*` today
  (`apps/t3-gateway/src/rpc.ts:1250-1255`), and the VS Code extension has no webview. The amendment
  as Yiannis wrote it names worktree files and chat images (ADR 0004 `:260-265`). An agent's PR
  added pages, so this ADR asks him before frames join them.
- **Under (b):** the gateway answers `preview.*`, and a control-capable entry from T3 Code needs an
  ADR 0004 amendment of its own. **Under (c):** the phone PR shrinks to the filmstrip. **Under
  (ii):** a T3 Code reader opens Mend to see a frame.

### D5. What is recorded, and capture during a takeover

- **(a)** Frames: one per agent call, one at each take, pause and hand back, and an entry per
  action. **(b)** (a) plus continuous video segments while anyone acts. **(c)** Video only. During a
  takeover: **(i)** a frame when the screen changed, at most one a second, with counts of clicks,
  keys and pastes, **(ii)** only the take and hand-back frames, or **(iii)** nothing more.
- **Decided 2026-10-30, as recommended: (a) with (i).** His words of 2026-10-28, "Live recording is
  useless. We are building real artifacts", point to frames, though he said them about promo copy.
  The prototype's MP4 could be unplayable after an abrupt stop (`computer-use.md:207-209`).
- **Under (b):** the image adds ffmpeg, the screen process writes closed segments, Mend imports them
  over the forward, and the log gains a `Segment` entry. **Under (c):** the agent still sees its
  frames, but the log holds none. **Under (ii) or (iii):** what a person did shows as counts.

### D6. Where frames live, and for how long

- **(a)** In Mend's blob store until the session is deleted. **(b)** In the blob store for 30 days.
  **(c)** In the harness home, captured, as the prototype did.
- **Decided 2026-10-30, as recommended: (b).** A 1280x800 PNG of a UI is 100 to 300 KB, so 300 agent
  calls hold 30 to 90 MB. A takeover adds at most 3,600 frames an hour, 360 MB to 1.08 GB on a
  screen that changes every second and far fewer on a still page. All are guesses to measure in PR
  13, and the frame budget (D13) caps the total. Outside any answer here, the native transcript
  keeps each `screen_act`'s arguments, typed text included, and probably each image block (PR 14
  measures it), under the harness-state capture's retention.
- **Under (a):** no sweep, and storage grows until the budget. **Under (c):** every capture uploads
  the frames, and reading them after a stop needs the prototype's manifest scan
  (`computer-use.md:206-209`).

### D7. Always on or on demand, and when it stops

- **(a)** On demand: the first screen tool call or the owner's **Start screen**, and a stop after 15
  minutes with no agent call and no holder. **(b)** Always on in a screen Environment, from the
  workspace's start. **(c)** On demand with another idle period.
- **Decided 2026-10-30, as recommended: (a).** A live screen with Chromium takes 300 to 700 MB of
  the workspace's memory (a guess to measure in PR 11), and most turns never look at a screen. The
  display is reserved either way.
- **Under (b):** the engine starts the screen beside the agent, and the idle stop goes away. The
  first `screen_look` is faster by the start time, about 2 s by guess.

### D8. The image, its cost, and its architectures

- **(a)** A **Screen** toggle in the project's Environment adds a package set (TigerVNC, a window
  manager, Chromium, fonts) to the project's own image. Family images take portable names, and a
  custom base passes them to its own package manager (`packages/domain/src/settings.ts:60-79`,
  `:82-93`, SDK `dist/types.d.ts:810`). **(b)** A Mend-published screen base that replaces the
  project's base. **(c)** Wait for a Sealant layer. **(d)** The packages in Mend's default image for
  everyone. Architectures: **(i)** x86_64 only in 0.37, or **(ii)** x86_64 and arm64, which the
  base-image contract covers (SDK `README.md:423`).
- **Decided 2026-10-30, as recommended: (a) with (i)**, with (b) for a family where the set fails to
  build (`settings.ts:16`). Yiannis's prototype message of 2026-10-07 began "Add a new image option
  (only for say x86 for now)", and no package set has been tried on arm64. The prototype's
  hand-built base met the mutable-tag bug (`computer-use.md:245-246`). The image grows by 400 to 700
  MB once per image plan, and each session pays the live screen's memory (D7), both guesses for PRs
  10 and 11.
- **Under (b):** a project with its own base cannot have a screen. **Under (c):** 0.37 ships without
  screens unless Core lands the layer first. **Under (d):** every workspace pays the size. **Under
  (ii):** PR 10 builds each family on both, and a failure hides the toggle there.

### D9. What the agent may do without asking

- **(a)** Both tools run without approval per call. Claude gets an allow rule. Codex skips approval
  only for a tool marked read-only (`html-render.ts:32`), so either **(a1)** both tools are
  annotated read-only, as `html_render` is although it writes a page row (`:60`), a false hint on a
  tool that clicks and types, or **(a2)** Codex outside bypass mode asks per call. **(b)**
  `screen_act` asks a person every time. **(c)** No prompts, and Mend refuses `type` into a password
  field.
- **Decided 2026-10-30, as recommended: (a) with (a1).** A person watching can take over at any
  moment, and a prompt per click makes the feature unusable. Only Mend's harnesses read this
  server's hints, and `html_render` set the precedent. One arena candidate argued the other way,
  that a tool that acts is never marked read-only to skip approval. `launch.ts` adds no allow rule
  today. (c) cannot be built, because Mend sees pixels, not fields.
- **Under (a2):** Codex outside bypass mode waits on a person for each batch. **Under (b):** every
  batch waits for a person.

### D10. The browser profile on resume

- **(a)** A fresh profile per screen, chosen by the wrapper, gone when the screen ends. **(b)** A
  profile saved per session and restored on resume. **(c)** A profile saved per person and project.
- **Decided 2026-10-30, as recommended: (a).** "The POC promises artifact persistence, not durable
  browser profiles" (`computer-use.md:290-292`). A profile holds cookies and logins outside the
  harness credential paths that ADR 0016 manages.
- **Under (b) or (c):** the profile is a secret store with its own retention and deletion rules, and
  (c) also needs a rule for two live sessions. It is never shared between people.

### D11. Whether the prototype's separate pilot ships

- **(a)** Not in 0.37. The session's own agent drives. **(b)** Ship the pilot, a second headless
  harness on a copied login with its own home.
- **Decided 2026-10-30, as recommended: (a).** His message of 2026-10-07 asked what it would take:
  "What other software would it need so we could spawn an agent that would just pilot it ?" The
  write-up leaves the pilot open (`computer-use.md:278`), and it needs a copied login per session
  (`:163-172`). The session's agent is the one that knows what it changed.
- **Under (b):** the pilot is a second attributed caller with its own credential and call keys.
  `Screens` does not change. The launch path and the login copy do.

### D12. Chromium's sandbox

The prototype ran Chromium with `--no-sandbox` (`computer-use.md:292-293`). Whether a person's user
(a uid in 40001-49999) can start the sandbox on each executor is untested.

- **(a)** The wrapper starts Chromium with its sandbox where the workspace allows it and with
  `--no-sandbox` otherwise, and the status line says `browser sandbox off`. **(b)** Always
  `--no-sandbox`. **(c)** No screen where the sandbox cannot start.
- **Decided 2026-10-30, as recommended: (a).** It keeps the sandbox wherever it works and says where
  it does not. With it off, a renderer exploit on a page the agent visits would run as the owner's
  user, beside the workspace's files, the agent's credentials and the screen's logins. Platform
  feedback 1 asks what each executor allows.
- **Under (b):** every screen runs unsandboxed, said once in the Environment. **Under (c):** screens
  may be unavailable on today's executors until the platform answers.

### D13. Defaults to confirm

Yiannis took every default as proposed on 2026-10-30. Each row keeps its alternative. The first two
are product calls. The rest are constants that the stack builds with their tests.

| Item            | Default                                                                                    | Alternative                                                                              | Evidence                                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lapsed holder   | `Paused` until the owner takes over or hands back, or 2 minutes pass, then `AwaitingAgent` | No timeout, so the agent waits for the owner; or no pause, so a lapse hands back at once | Whether an absent person blocks the agent. A phone back from the background reconnects within 2 minutes (a guess). With no timeout, a closed tab leaves the agent answering `held`, and its calls keep the screen from idling.         |
| Noun            | `screen`                                                                                   | `display`; or `desktop`                                                                  | `desktop` is the Electron app (`apps/desktop`), and `display` is also the X variable. `screen` collides with ordinary UI usage: "The home screen is a sparse attention inbox" (`MEND-AGENT-WORKBENCH-PLAN.md:414`). Only names change. |
| Screen size     | 1280x800, fixed, no resizing                                                               | 1440x900, as the prototype ran; or a size per project                                    | All three arena candidates chose 1280x800 (`deploy/desktop/start:16` on the branch). A resize moves every click target.                                                                                                                |
| Clipboard       | The holder's paste goes through the hand and is logged as a count. Nothing copies out.     | No paste in 0.37; or copy-out to the holder, which needs a parsing relay                 | A relay passes every server message to every watcher, so copy-out cannot reach one person through it.                                                                                                                                  |
| Heartbeat lease | 10 s                                                                                       | 30 s                                                                                     | A guess. Shorter frees the agent sooner, and longer survives a slower phone.                                                                                                                                                           |
| Batch limits    | 20 actions, 2,000 characters per `type`, 5 s per `wait`, 60 s per batch                    | 120 s per batch, with a longer tool timeout                                              | The bridge gives up at 110 s (`session-socket.ts:40`, `caller.ts:9`) and does not retry a timeout.                                                                                                                                     |
| Frame budget    | 500 MB per screen, 20 GB per organization, then `frames not kept · budget reached`         | Retention only, with no budget                                                           | D6's sizes. ADR 0004 `:229-231`: refuse new work, never stop running work.                                                                                                                                                             |

## Considered

- **The prototype, productionized.** Two arbiters remain, Mend for watching and the controller for
  typing. Mend still parses RFB for watch-only, and the image carries Mend code.
- **The screen as a preview.** The gateway's relay cannot drop input, and visibility would let every
  viewer type.
- **Viewers that send input to Xvnc themselves**, behind an epoch check in each relay. Separate
  connections have no common order, so a former holder's bytes can land after a fence.
- **Browser-only control over the DevTools protocol.** It loses Electron and every other app.
- **A Mend controller in the workspace**, D0's (b), and **continuous video** (ffmpeg `x11grab` in
  segments), D5's (b).

## Consequences

- The product language gains `screen`, `screen log`, `frame`, `take over` and `hand back`, and
  `SessionProcessKind`, `AgentItemKind`, `ForwardPurpose`, `ConnectionKind` and `ProtocolIdleHold`
  each gain `screen`. New tables: `screens`, `screen_log`, `screen_calls`.
- New routes under `/sessions/:id/screen`, frame reads at `/api/screen-frames/:id`, the
  `/api/screen-socket` WebSocket, the `/screen-embed` page, three ticket targets and two budgets.
- Each agent process carries its own channel credential, the tool catalog moves to
  `@mend/agent-protocol`, the preview recheck becomes a shared policy, and `withMendItems` replaces
  `withPages`. Mend owns an RFB client and one input connection per live screen.
- Workspaces gain a staged `chromium` wrapper, and the image gains packages and no Mend code.
  Services, previews, the terminal and pages do not change.

## Platform feedback

This ADR adds five entries to `PLATFORM-FEEDBACK.md`, each with a draft Sealant issue: (1) named,
versioned package layers that a client defines, an image capability report, and which executors let
a person's process start Chromium's sandbox; (2) compiled images keyed by the base's digest, with
three other build findings observed on 0.39.0-next.696 and not reproduced since; (3) which processes
a session-bound forward accepts, and what happens to the others when the leader exits; (4) a keyed,
reconcilable start of a supporting process, without which Mend reaps by display; and (5) a memory
limit per PTY session. None blocks 0.37 under the recommendations, and none weighs on D0 (b) more
than on (a).

## Delivery

One `gh stack`. Each PR stays under about 250 production lines and ends in a check. "Verifier" is
what the merge-gate verifier drives on a real stack through the project's `verify` skill. PRs 2 to 5
started before the decisions, because none of them changed with an answer.

1. **docs: this ADR and its platform feedback** (now, with the answers written in before it merges).
   AGENTS.md gains the nouns. Verifier: each cited `file:line` still holds.
2. **tickets: one target list.** Merged as #1174. The database type derives from the contract's.
3. **sessions and mcp: the caller names its agent process** (PRs 3 and 4 as one). The engine gives
   each agent launch `MEND_AGENT_PROCESS_ID`, the helper sends it, and the caller resolves it.
   Check: a superseded process's page lands on its own turn, and another session's id resolves to
   nothing. Verifier: the old MCP child calls after a resume, on Docker and on the network
   transport.
4. Folded into 3.
5. **One admission-and-recheck policy.** Moved into PR 15, which brings its second caller, so that
   previews are not the only user of an extracted layer.
6. **domain: screen types and the input machine** (after D0, D3, D13). Check: a table test over
   every state and event, boot included. Verifier: reads the table against D3 and D13.
7. **sessions: the RFB codec, pure and bounded** (after D0). Check: bytes from noVNC with default
   options against TigerVNC, split at every chunk boundary, the `SetEncodings` rewrite, and
   malformed, oversized and decompression-bomb streams. Verifier: reruns the capture on the box.
8. **sessions: the hand** (after D0). Check: an Xvnc container draws a known pattern and the PNG
   matches, a click moves the pointer, a key held at a change of holder is released, and a
   full-update benchmark passes the benchmark checklist. Verifier: the integration test on the box.
9. **db: screens, per-session displays, the log and call claims** (after D0, D5, D6). Check: two
   sessions in one workspace keep two displays across an idle stop, a claim replays, and forty
   appends in one turn make one episode. Verifier: the repo tests on the box's Postgres.
10. **image: the package set behind the Screen toggle** (after D1, D8). Check: the set resolves on
    each offered family and architecture. Verifier: records the image size for D8.
11. **sessions: the screen process** (after D7). Its module, the script, the helper's
    `screen-secret` verb, teardown, the idle hold and the lost-start reap. Verifier: Xvnc on
    loopback only, a client without the password and another person's user refused, a view-only
    connection moves nothing, a killed window manager reads `degraded`, nothing outlives Xvnc, a
    lost start reopens on its display, memory recorded.
12. **sessions: the display on every launch path, and the wrapper** (after D10, D12). Check: each
    path's env holds `DISPLAY`, `XAUTHORITY` and the wrapper first on PATH. Verifier: two sessions
    in one workspace run `chromium <url>`, and each opens on its own screen and profile.
13. **sessions: the `Screens` service** (after D3, D7, D13). Check: a Take during a batch skips the
    rest and holds no key, a second act answers `busy`, a batch stops at its limit, a retry sends no
    input, and a crash at each persistence step boots into the table's row. Verifier: look and act
    through a test route, restart the API during a takeover, read a frame.
14. **mcp: the two tools, the catalog, the receipt and compaction** (after D9). Check: no base64 and
    no typed text in a stored item or approval request. Verifier: fresh Claude and Codex sessions,
    protocol and terminal, then a resume and a mode switch, each reporting a page title, and the
    native transcript's copy measured. It is the go or no-go for Codex images.
15. **api: routes, the viewer socket, tickets, the viewer budget and the recheck policy extracted
    from `preview-identity.ts`** (after D2, D3). Check: the preview tests pass unchanged, and a
    non-owner's input moves nothing, the owner's moves only after Take, and a viewer closes when its
    project turns private or its device is revoked. Verifier: two accounts, a hand-written RFB
    client as the non-owner, and a default noVNC that stays connected.
16. **record: the projection** (after D5). Check: in both modes, people's entries sit before the
    next look, a terminal episode sits at its tool call, and no turn is created. Verifier: a
    takeover between two turns, in a protocol and a terminal session.
17. **web: the screen, screen items, the terminal predicate fix** (after D4). Verifier: the done
    condition. An agent signs up a test user while a non-owner watches and cannot click, the owner
    takes over and hands back, and the agent's next look reports it.
18. **phone: the embed, its renewal and screen items** (after D4). Verifier: watch, take over,
    background the app past the lease, return, and hand back.
19. **T3 Code: episodes and notices** (after D4). Verifier: a protocol thread shows frames and the
    notice, and a terminal-only session shows both as notices.
20. **VS Code: the record line and Mend: Watch Screen** (after D4). Verifier: the command opens it.
21. **retention and the frame budget** (after D6, D13). Check: expired frames read `expired`, and at
    the budget input works, the agent gets its image and the log reads `frames not kept`. Verifier:
    a short retention and a small budget on the box.

## Built differently

What the build changed against this text, with the PR that carries each. Yiannis can overrule any.

- **The agent process names itself with an id, not a credential** (#1175). `MEND_AGENT_PROCESS_ID`
  in the launch env, sent by the helper and resolved against the session's process rows; the channel
  credential still authenticates. The SDK says a session's env is "not for secrets".
- **The screen's packages come from Core's catalog** (#1197, sealant#419, pinned from
  0.40.0-next.768 in #1200), as D8 (a) chose, with no Mend-published base. Fedora, Arch and nix
  carry all six; Ubuntu 24.04's `chromium` is a snap stub, so Core refuses it there with its reason.
  A custom base gets no Screen switch, because Mend cannot know its package manager. The
  architecture is the Mend server's own until the SDK reports the executor's.
- **No `Cursor` pseudo-encoding** (#1183), so every watcher sees the agent's real pointer.
- **Passwords**: eight characters made fresh at each start, handed once per start over the session
  channel to the person the screen runs as, never logged (#1204). Xvnc also gets `-nolisten tcp`.
- **The browser** starts through a staged `chromium` wrapper that keeps one profile per screen in
  the screen's directory; the agent's own `chromium <url>` opens a tab in that instance (#1209).
  D12's fallback is a probe: the first run starts Chromium headless with its sandbox and, only if
  that fails, without it, and records the answer for the status line.
- **PATH** reaches the wrapper through argv, because sealantd applies a session's env without
  expansion (#1209, with a platform feedback entry).
- **A shared-control turn runs as the steerer and gets no display**; the owner's cookie and profile
  are 0700 (#1209). This follows D3.
- **A display goes back when its session stops**, not only when the session is removed (#1209):
  otherwise stopped sessions hold all ninety numbers. An idle stop of the screen alone keeps it, a
  restart asks for the session's previous number first, and a boot gives back any number a stopped
  session still holds. Only a launch that runs as a person gets a display. A number goes back only
  between the session's launches, so a resume sent meanwhile waits for it and never runs on a number
  given away.
- **A screen that outlives Mend is rekeyed, not restarted** (#1220): the passwords lived only in the
  old process, so boot makes fresh ones and the session's person rewrites the passwd file through
  the helper. Xvnc reads that file again at each sign-in, so the screen's apps keep running. The
  rekey has one 15 s deadline and is fenced to the start it was asked about by an id that start
  wrote into its directory. If it fails, Mend starts the screen over and logs `Restarted` with the
  reason. Take over without a hand answers `NoHand`, never `Person`.
- **Only the screen's own person's turns look and act** (#1217): a turn someone else steers under
  shared control gets `owner_only`, as a steerer's turn gets no display (#1209). Releases on the
  hand go ahead of anything queued (#1219).
- **The hand** ends with a typed reason (`stream-stalled`, `decoder-failed`, `decode-deadline`, and
  the sign-in and size refusals); paced typing honors the batch limit, and nothing queued reaches
  Xvnc after the hand ends (#1189).
- **Delivery** split the planned PRs further to stay near 250 lines each, merged PRs 3 and 4 as
  #1175, and moved PR 5's recheck extraction into PR 15.

## Decision log

Yiannis accepted these with his answers on 2026-10-30, except entry 7, which changed during the
build. He may overturn any one without touching the rest.

1. **Mend holds the input and speaks RFB, and the workspace runs only a display** (D0).
2. **One input connection per screen, the hand, with one queue.** Viewers only observe.
3. **Xvnc and the X display need a password and a cookie**, and no viewer gets the clipboard.
4. **A screen is a session process of kind `screen` in its own module, not a Service.** It holds the
   idle stop only while a person holds input, and a lost start is reaped by display.
5. **The display is reserved per session**, with `DISPLAY`, `XAUTHORITY` and the browser wrapper on
   every launch path.
6. **Two tools on the `mend` server, from one catalog.** Rejected: the prototype's dozen tools.
7. **Each agent process carries its id in env, and the channel credential authenticates.** Revised
   during the build from a credential per process (see "Caller attribution"). Open to his overrule.
8. **A durable call claim, a plain hash without the typed text, and no repeated input.**
9. **Every answer carries a receipt** that links its entry to the tool call.
10. **A fenced takeover, total over every state and event**, with releases at every loss of control
    and reconciliation at boot.
11. **Watch-only is an RFB filter over an allow-list**, with a view-only password beneath it.
12. **Screens reuse the preview recheck, and the hand's decoder is bounded.**
13. **Frames are Mend's PNGs in its blob store, within a byte budget.**
14. **People's entries carry no turn and sit before the agent's next look.**
15. **Tool-call links are exact or a gap, and checkpoints are only observed after.**
16. **The preview gateway does not carry pixels**, for the three reasons above.
17. **No presence table, holds table or cross-process notice in 0.37.**
