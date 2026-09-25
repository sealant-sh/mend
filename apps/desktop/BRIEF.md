# Mend Desktop — brief

The desktop app is a herdr rebuilt as a GUI, with Mend as the engine. Herdr's layout is the part
worth keeping. Yiannis lives in it all day and its shape is proven: a tree of places on the left,
tabs across the top, one dominant terminal, an agents list that tells you where to look next. What
changes is the substance behind each surface. The engine is the Mend server, so every terminal is a
supervised PTY in a Mend-managed workspace: recorded, worktree-isolated, reviewable.

Herdr itself is not in the stack. No herdr binary, no socket client, no `agent attach`. Mend's
server already is the multiplexer (workspaces, PTYs, the byte-exact record), and unlike herdr its
`/api/tty` accepts many clients per PTY, so nothing fights over who renders a terminal. Herdr stays
Yiannis's terminal tool; this app is its GUI sibling on a different engine.

## How we got here (so nobody rebuilds the wrong thing again)

Two prototypes died before this brief:

1. A tile-grid cockpit from the Figma "Desktop / Cockpit" frame. Wrong working model. Nobody works
   in six 450px terminals at once; herdr's one-big-terminal with instant switching is how the day
   actually goes.
2. A wrapper that mirrored herdr's state over its socket and attached panes with
   `herdr agent attach --takeover`. Wrong dependency. Herdr is single-client per terminal, so the
   app and the TUI stole panes from each other, and none of herdr's keybindings existed in the
   wrapper anyway.

The synthesis: herdr's information architecture, Mend's session engine, native widgets.

## Nouns

| Herdr surface        | Desktop surface                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| space (dir/worktree) | **project** (adopted repo in the store), sessions nested beneath       |
| pane                 | **PTY over `/api/tty`**, either the coding agent or a supporting shell |
| tab                  | **tab**, a view of one session or one supporting process               |
| agents list          | **inbox**, static order with attention shown through contrast          |
| the focused pane     | **the terminal**, one dominant surface rather than a terminal grid     |

Product-language rules from `MEND-AGENT-WORKBENCH-PLAN.md` §5/§16 apply unchanged: status words are
observations, "recorded/observed" only when a Sealant run stands behind the claim, no verdicts.

## The main screen

Left to right: project tree · (tabs above) the terminal · inbox. The Evidence Review token sheet
(`@mend/ui`) styles everything; the terminal is the one always-dark surface.

### The left rail — two faces (`docs/SIDEBAR-MAP.md`)

Ctrl+Shift+B (or the toggle at the top of the rail) switches faces; the choice persists.

- **Tree.** Projects from `/api/projects`, any number open at once (`mend-sidebar-expanded`). Each
  session is a worktree and opens into what runs in it: the harness process, every live supporting
  shell, and its Services. Every session is listed, `shell` sessions included — a shell is never
  hidden behind a closed tab. Row = dot + name + the status word; clicking a shell child raises its
  tab.
- **Inbox.** t3code's flat cross-project list: static creation order (activity never reorders a
  row), a collapsed Snoozed shelf, a Settled tail with show-more paging, attention by contrast
  (done-unseen / input / failed prominent, working receded). Snooze is client-local with t3's
  presets and hand-raise wakes. A scope menu narrows to one project; a scoped project reveals
  **Inbox · Services · PRs · Files** behind a compact switcher. Files root at the focused session's
  worktree when it belongs to the project, else the default branch's tree. PRs come from the host's
  `gh`, with honest states when it cannot answer.

Ctrl+1..9 and Ctrl+Shift+J/K walk whatever the visible face numbers. The rail resizes by dragging
its edge (208px minimum, the main pane keeps 640px); double-click the edge to reset.

### Tabs: sessions and their supporting shells

A tab bar per project, herdr-style numbered. Two kinds of tab:

- **Session tab:** the coding-agent PTY for a visible session. Focusing a session from the tree,
  inbox, or palette opens this view.
- **Shell tab:** an independently recorded supporting shell in the focused session's current
  workspace. It sees and may mutate that session's worktree, so its work belongs to the same change.

`+` and Ctrl+Shift+T open a named shell when a session is focused. If only the project is focused,
they open the session launcher instead of creating a hidden worktree. Supporting shells are
processes, not sessions. They remain out of the tree and inbox, but the owning session exposes them.

The tab close button and Ctrl+Shift+W confirm before stopping a live shell process group.
`Detach tab` is a separate context action that removes only the view. Closing a session tab,
switching tabs, quitting the app, or losing the network detaches without stopping the coding agent
or supporting processes.

The server process list is authoritative for shell existence and identity. Local tab state stores
only layout, focus, and replay position. Shell labels are unique within the session and may be
renamed.

### The launcher (`+` on a project / palette action)

The same composer the web app starts sessions with: type the session's first message, pick harness
(claude, codex, opencode), model, and settings (thinking, codex speed, permissions, base ref) from
the pill row, and go. Choices are sticky per project + harness (`mend-composer-prefs`); the Settings
default harness is what a project starts on until it picks its own. `createSession` +
`launchSessionStart` — the server composes harness argv from the structured start and seeds
auto-naming from the prompt — then the terminal opens as a new session tab and the session appears
in the tree and inbox. For claude and codex, Settings › Runs as picks Terminal (the PTY default) or
Conversation (protocol mode, sticky per project + harness); a conversation start sends `mode` on
create and launch, the prompt becomes its opening turn, and the tab opens as the conversation. An
empty prompt is `mend claude` as a button; the CLI and the app produce identical sessions. The same
composer fills the terminal pane inline whenever the focused project has no tabs open, so an empty
cockpit starts with a prompt, not a hint.

### Conversations (protocol-mode sessions)

A claude or codex session can run its agent in protocol mode (codex app-server, claude stream-json)
instead of a PTY. It has no terminal to attach: its session tab shows the conversation where the
terminal would be (`components/conversation.tsx`), on the app's own sheet, since nothing there is a
terminal. The feed is the phone's, shared as `@mend/agent-conversation`: authored turns in order,
each turn's items (what the agent said and did) and requests (approvals, questions) beneath it. A
caller who steers sends turns, answers approvals (allow once, allow for session, decline) and
questions, and interrupts the open turn; anyone else reads it, and a request tells them it is
waiting for an answer. A turn names who sent it when that was someone else, and who interrupted it
when the control record (`/api/sessions/:id/control-events`) says. A turn without an author is
Mend's (a Review follow-up) only on a conversation process; the terminal history a handoff imports
also has no author, recorded against the terminal agent's process, and reads "from the terminal".
The stream's `agent-conversation` pointer re-reads the conversation (items from the held cursor on)
and the detail. Pointers come per streamed delta, faster than a read completes, so a read in flight
is left to finish and the pointers that land meanwhile coalesce into one read after it (cancelling
the read in flight, the default invalidation, froze the view until the agent paused). A 4-second
poll covers a dropped stream while the agent runs.

The pane knows a conversation from the agent's own row (`kind: agent-protocol`), from the project
list's annotation before the detail answers, and from the launcher's intent before any row exists.

A settled session offers **resume** (`control.steer`), which rejoins it in the mode its agent last
ran in. A claude or codex session whose agent ran offers **continue as conversation** or **continue
in terminal**: the same provider session in the other mode (`POST /api/sessions/:id/handoff`). That
is the owner's alone even while control is shared (`control.own`, the server's rule); handing off a
live agent confirms first, since its process ends.

### The terminal

One ghostty-web surface rides `/api/tty` (`?session=` for a coding-agent PTY, `?process=` for a
supporting shell), with binary frames, JSON resize, and reconnect backoff. Main mints a single-use
upgrade ticket per connect and strips the page's `Origin` (and any `Cookie`) from sockets to the
configured server (`src/main/socket-headers.ts`), so the upgrade reaches authentication as a token
client, the way the CLI and the phone do.

Only a caller who steers the session attaches (docs/adr/0003); anyone else reads the record of the
live agent, and a line under the header says who steers. The owner's header carries the Shared
control switch.

A browser socket cannot see why an upgrade failed: a refusal and a dropped network both close 1006.
After an attach that never opened, the terminal asks the server whether the PTY's process still runs
(`lib/tty-attach.ts`): live or no answer climbs the ladder; ended stops it; a refusal stops with
"the server refused the attach".

An ended agent is never attached. Its session tab replays the record read-only from
`GET /api/processes/:id/logs` (`components/record-replay.tsx`); the scrubber's checkpoint ticks seek
by record sequence, a toggle reads the conversation from `GET /api/sessions/:id/transcript`, and the
fact line says how the process ended (`exited · observed`). A session that never ran supervised
shows its own summary instead.

### Inbox (bottom of the left rail, herdr's agents slot)

t3code's sidebar model, copied from the nightly (v0.0.34-nightly.20260819.1133, MIT, clone at
`~/Developer/refs/t3code` — `apps/web/src/components/Sidebar.tsx` + `Sidebar.logic.ts`). The parts
worth stealing verbatim:

- **Static order.** The active list sorts by creation time, newest first, and activity NEVER
  reorders it — a row holds its position from open until settled, so the screen only moves at
  lifecycle transitions. Their comment says it outright: "Activity NEVER reorders the list."
- **Attention is contrast, not position.** Rows that need nobody recede (reduced opacity, normal
  weight); rows that need a human hold full weight. The status slot is one mutually-exclusive word:
  `input` (amber) > `working` (accent) > `failed` (red) > `done` (green, only while unseen) > a
  relative timestamp. No dots-as-badges, no counts on rows.
- **Unseen is client-local.** A session shows `done` when it settled after the last time its
  terminal was focused. Never-visited counts as read (a fresh install must not light up history).
  The visit is stamped at the settle time, not `now`, and never moves backwards. Stored in
  localStorage (`lib/seen.ts`).
- **Settled is a shelf.** Below the active list, collapsible, ordered by when work ended, paged (10,
  then +25). The active block and the shelf are flat — projects are the tree's job, not the inbox's.
- **Jump pills.** Holding Ctrl paints 1..9 pills on the first nine rows; Ctrl+N jumps.

Not copied (yet): pin, snooze/wake, drag-to-reorder pinned, multi-select. Worth revisiting once the
daily rhythm shows a need.

Shells never appear here. The inbox is about agents that may need you; a shell is you.

## Review

"Review the change" opens **in the app**, not the browser. Same API the web review uses
(`/api/changes/:id/diff|comments|stats|tour|passes`), same loop: unified diff with 2px edge marks,
line comments and change-level comments, read/suggest passes, edit-the-instruction send-back to the
same session. The web app (`apps/web/src/routes/changes.$changeId.tsx`) is the reference
implementation; port, don't reinvent, and extract shared pieces into a package only when the second
consumer proves the shape. Until M2 lands, the review button deep-links to the web app so the loop
is never broken.

## Repo store (projects surface)

The GUI for what `mend adopt` and the web project page do today, same endpoints:

- Adopt a repository (path or URL) into the central store; show store path, default branch, adopted
  SHA.
- Per-project settings: git auth mode (ambient / mend-key / bridge), workspace image, dotfiles
  toggle, environment + secrets, references and mounts, service recipes, automation
  (autoTour/autoSuggest).
- Remove a project (the removal report says what would not delete).

Phased after the main screen; nothing here blocks daily use since the CLI covers it.

## Settings (built)

`/settings` (gear in the titlebar, Ctrl+Comma). Everything applies live and persists per machine;
nothing writes to the server.

- Terminal: font family (validated with the adapter's monospace probe — a proportional face warns
  that the terminal will fall back) and size (6–32px, also Ctrl+Shift+= / − / 0 anywhere), with a
  live preview strip on the terminal surface color.
- Appearance: theme — system / light / dark (same `mend-theme` key and `.dark` contract as the web
  app; the terminal stays dark either way).
- Workbench: default harness, what a project's composer starts with. Supporting shells follow the
  focused session workspace's configured login shell.
- Connection: signed-in fact + the shared credential path, Manage → /connect, sign out.

Signing in (`/connect`) is `mend login`'s authorize walk (`src/main/device-login.ts`): the app opens
a `cliAuth` request, the browser opens on the approve page with the code to compare, and an approval
saves `{url, token, deviceId}` to the shared `cli.json`, keeping every other field there. The
desktop is then a listed device, named `<hostname> · desktop`. Sign-out revokes it
(`DELETE /api/me/devices/:id`) before forgetting the token, as `mend logout` does; it clears only
the token and device id, keeping the file's own url. While `MEND_TOKEN` supplies the token, sign-out
changes nothing and says so. An approval that lands on the poll a cancel interrupted is revoked with
its own token, not dropped. Pasting a token stays as the fallback; email + password is gone.

- Keyboard: the keymap, read-only for now.

Still to come here: automation defaults (autoTour/autoSuggest) once project settings land in M3.

## Keyboard (sane defaults; Ctrl+Shift or Ctrl+digit, so readline never sees them)

One capture-phase listener on the window, so the combos work while the terminal owns focus.

| Keys              | Action                                                                    |
| ----------------- | ------------------------------------------------------------------------- |
| Ctrl+Shift+J / K  | next / previous **session** (agents only, skips shells, crosses projects) |
| Ctrl+Shift+H / L  | previous / next **project**                                               |
| Ctrl+Shift+T / W  | new shell in focused session / confirm and stop focused shell             |
| Ctrl+Tab / +Shift | next / previous tab in the project                                        |
| Ctrl+1…9          | jump to inbox row N (hold Ctrl to see the pills)                          |
| Ctrl+Shift+P      | palette (jump to any session; Ctrl+K is readline kill-line — left alone)  |
| Ctrl+Shift+B      | sidebar face: tree ⇄ inbox (Ctrl+B is readline back-char — left alone)    |
| Alt+Space         | summon the window from anywhere (global)                                  |

## What survives, what goes, what's new

Survives from the prototypes: the ghostty terminal component (+ font-ready gate), the replay
scrubber (now reading the record), the data layer (`lib/api.ts`, queries, SSE invalidation), the
connect screen and shared credential file, the titlebar with native-feeling window controls, the
Wayland scale pin (`MEND_DEVICE_SCALE`, default 1 on Linux).

Goes: `src/main/herdr.ts` (socket client), `src/pty-broker/` and `src/main/pty.ts` (node:ffi PTY
broker — no local PTYs are needed when every terminal is a server attach), the herdr/pty halves of
the bridge, the tile grid, the cockpit model that merged two sources.

New: project tree rail, server-discovered session and shell tabs, the inbox, the launcher, native
Review, Services drawer, and store/settings screens. The legacy bench path is gone (2026-09-24): the
tree lists every session, so a former bench is an ordinary `shell` session with its worktree and
change in view.

## Milestones

- **M0: connect (2026-09-24, branch `desktop/01-connect`).** Terminal sockets leave without the
  page's Origin, ended sessions replay their record and stop reconnecting, sign-in is the device
  flow with revocable sign-out. Live typing into a fresh PTY on alpha is still unproven: the proof
  session's workspace reached "failed" before becoming ready on the linear-cli project, as an
  earlier claude session there did.
- **M1: honest ownership.** Tree, visible sessions, session-owned shells, terminal, inbox, launcher,
  keybindings, and retained-workspace controls. Clean base (2026-09-24, branch
  `desktop/02-contracts`): wire shapes and routes from `@mend/api-contracts`, the bench path
  removed, controls gated on what the server says the caller may do.
- **Conversations (2026-09-24, branch `desktop/03-conversations`).** Protocol-mode sessions read and
  steer as a conversation (turns, approvals, questions, interrupt), the launcher starts claude and
  codex in either mode, settled sessions resume, and the owner hands a session between modes. Proven
  with unit tests on the data layer and a component harness driven in Chromium against fixtures; not
  proven live: alpha has no protocol-mode session, and launching one spends the owner's credentials.
- **Packaging (2026-09-24, branch `desktop/04-packaging`).** `pnpm -F @mend/desktop package` builds,
  then runs electron-builder (`electron-builder.config.ts`) for the host: Linux AppImage and tar.gz,
  macOS dmg and zip for arm64 and x64, unsigned and not notarized. Artifacts land in `release/`. The
  app icon is the seam mark from `apps/mobile/assets/images/icon.png`, copied to
  `resources/icon.png`. The package holds `out/` and `package.json` only (a 16 MB `app.asar`, no
  node_modules), with the ghostty wasm, the Nerd Font symbols and the fontsource faces under
  `out/renderer/assets`. Proven on Linux: the unpacked tar.gz ran against alpha read-only
  (`app.isPackaged` true, renderer at `file://…/app.asar/out/renderer/index.html`), drew the tree,
  loaded Space Grotesk, Inter and JetBrains Mono, and replayed a completed codex session's record
  through the ghostty terminal. The AppImage was built but not launched: on NixOS it needs
  `appimage-run`. On Linux the macOS `.app` and zip build, and the dmg stops at `sips`, a macOS
  tool. No macOS artifact has been opened on a Mac yet.
  - Proposed CI job, not wired: `release-desktop.yml`, on the same `v*.*.*` tag as
    `release-cli.yml`. A matrix of `ubuntu-latest` (AppImage, tar.gz) and `macos-latest` (dmg, zip,
    arm64 and x64). Each leg runs `pnpm install --frozen-lockfile --ignore-scripts`
    (electron-builder fetches its own Electron, so electron's postinstall is not needed), stamps the
    version from the tag (`pnpm -F @mend/desktop exec npm version "$VERSION" --no-git-tag-version`,
    as the CLI job does), runs `pnpm -F @mend/desktop package --publish never` and uploads
    `release/Mend-*` as a workflow artifact. A final job, needing both legs and `github-release`,
    attaches them to the tag's release with `gh release upload`, skipping assets already present, as
    the setup assets do. It lists them under "Artifacts of this release" as unsigned builds. Signing
    and notarization (Developer ID secrets, `mac.identity`, `notarize: true`, hardened runtime
    entitlements) come later in their own change. So does auto-update: the release job publishes
    only files, and no `latest*.yml` feed.
- **M2: Review in-app.** Immutable checkpoint-pair diff, P0 controls, comments, minimum evidence,
  and recoverable send-back.
- **M3: Services in-app.** Stable Services, attempt history, private forwards, read-only logs, and
  factual controls beside the owning session.
- **M4: store, settings, and polish.** Adopt, project settings, notifications, summon refinements,
  and keybinding configuration.

## Decision log

- 2026-09-24: packaging ships the electron-vite output alone. Every runtime import is bundled (main
  and preload need only electron and node builtins), so the desktop's former `dependencies` moved to
  `devDependencies` and `beforeBuild` answers false. Without that hook electron-builder finds no
  dependencies in `apps/desktop`, falls back to the workspace root and packs the root's (`effect`
  and its tree, msgpackr's native addon): 56 MB of asar instead of 16. `npmRebuild: false` is left
  out on purpose, because it returns before `beforeBuild` runs. The config is TypeScript
  (`Configuration` from electron-builder) and type-checked with the node project.
- 2026-09-24: the packaged app keeps the package name, so `userData` is the same
  `~/.config/@mend/desktop` in dev and packaged runs, and the credential stays in the CLI's
  `~/.config/mend/cli.json`. `desktopName` (`mend-desktop.desktop`, added through `extraMetadata`)
  with `linux.syncDesktopName` gives the Wayland app_id and the AppImage's desktop entry one name.
- 2026-09-24 (review): the package name is not the name people read. Electron takes `app.name` from
  it, and macOS spells the app menu's About, Hide and Quit items from `app.name`, so the packaged
  Mac build said "Quit @mend/desktop". Main now pins `userData` to the path the package name gives,
  then calls `app.setName("Mend")`: the rename alone would have moved the profile to
  `~/.config/Mend`. The X11 WM_CLASS was already `mend-desktop` (checked with xprop): Electron takes
  it from `desktopName`, not from the app name.

- 2026-09-24: the phone's platform-free conversation logic moved into `@mend/agent-conversation`
  (ordering, item cursor paging, request words, answer composition) instead of being copied. The
  phone keeps its own DTO parsing; the feed is generic over the shapes, so the desktop passes the
  contract's wire types. The package says what the conversation is doing (`waiting`/`working`); each
  client words it for who is looking.
- 2026-09-24: a conversation is drawn on the app's sheet, not the dark terminal ground; the terminal
  stays the one always-dark surface. Assistant text is plain pre-wrapped prose: the desktop has no
  markdown renderer yet.
- 2026-09-24: handoff is gated on `control.own`, not `control.steer`: the server's handoff answers
  only the owner (`steering.owned`), and SessionControlView says hand-off is the owner's. It is
  offered only once an agent process ran and the session left a conversation behind. Resume is
  `control.steer`, as the server enforces.

- 2026-09-24: the terminal socket drops `Origin` and `Cookie` in main
  (`session.webRequest.onBeforeSendHeaders`, sockets to the configured server only) instead of
  asking operators to list `file://` as a public origin. The upgrade ticket is the credential; the
  public-network policy already admits origin-less token clients. Relaying the socket through main
  over IPC was rejected: it adds a hop to every keystroke.
- 2026-09-24: an ended PTY replays from the process record (`/api/processes/:id/logs`), not from
  `/api/tty`, which answers 502 for a settled session. Checkpoint `seq` and log chunk sequences
  share the run's record sequence, so the scrubber seeks the log cursor.
- 2026-09-24: sign-in is the CLI's device flow and sign-out revokes the device. Main still checks
  the `cliAuth` answers by hand (a non-Mend server answering 200 must read as nothing), but the
  shapes it returns are the contract's types.
- 2026-09-24: the renderer's wire shapes come from `@mend/api-contracts`, at the type level only
  (`lib/contract.ts`). A call names its endpoint by method and path template exactly as the contract
  declares it (`"GET", "/api/sessions/:id"`), so a moved or dropped route fails the build, and
  params, query, body and answer are read off that endpoint's schemas as JSON carries them (dates
  and sequences as strings, no brands). The derived client (`makeMendApiClient`) over an
  `HttpClient` riding the bridge was rejected: it would decode into `Date`/`bigint`/branded values
  every screen then has to convert back, and load every schema into the page to re-check what the
  server just encoded. The phone hand-rolls its DTOs and pins routes in a test; the desktop got both
  checks from the compiler instead.
- 2026-09-24 (review): one terminal attach at a time. Each connect takes a generation, so a ticket
  mint or liveness probe answering for an older attempt changes nothing, and a window focus leaves a
  socket that is still opening alone. Before, a focus during a probe could leave two sockets on one
  PTY.
- 2026-09-24: controls follow what the server says the caller may do (docs/adr/0003). A session pane
  reads `SessionDetail.control`: delete is `own`; attach, open or stop a shell, rename a shell, run
  Services and deliver a follow-up are `steer`; stop is `stop`. A caller who cannot steer a live
  session reads its record instead of attaching, and a shell's logs instead of its PTY. Lists carry
  no per-session control, so rows and menus apply the domain's steering rule to the viewer from
  `GET /api/organization`, as the web app's lists do. The owner's pane carries the Shared control
  switch, and turning it on confirms with the web app's sentence about lending provider logins and
  Git access; anyone else is told, in the web app's words, who steers or that the owner shares
  control (with Turn off for an organization owner).
- 2026-09-24 (review): what a viewer is told about control never comes from a read that has not
  answered. A non-steering viewer of a live agent with no PTY record of its own reads the
  conversation instead of waiting on a record process that never comes; Review hides Deliver while
  the session detail loads and leaves it to the server when the detail does not answer, rather than
  telling the owner someone else steers; a shell tab's close says "Detach" when it only detaches.
- 2026-09-24: the bench path is deleted. It never surfaced anything: the tree's rows came from the
  agent-only inbox, so a `shell` session (a former bench among them) was hidden either way. Alpha
  had no `bench`-labelled session and one hidden `shell` session on the mend project; the tree now
  builds its rows from every session and shows it (`shell · mend/test-alph`). The inbox still lists
  agents only.

- 2026-08-20: hidden project benches are retired. Supporting shells belong to a focused visible
  session and its change. The old default-shell and per-project bench decisions below are
  superseded. (Approved desktop ownership plan)
- 2026-08-20: shell close confirms and stops the process group; Detach tab is the non-destructive
  alternative. Resume reuses a workspace retained by shells or Services unless the user explicitly
  chooses to stop retained work and resume fresh. (Approved desktop ownership plan)
- 2026-08-20: native Review is pinned to checkpoint A, checkpoint B, and a diff digest. It ships
  with minimum honest evidence and server-owned follow-up delivery. (Approved desktop ownership
  plan)
- 2026-08-20: Services stay nested under their owning session. Normal reachable Services do not
  become standalone inbox rows. (Approved desktop ownership plan)
- 2026-08-19 — Herdr is out of the stack; it contributes the UI model only. (Yiannis)
- 2026-08-19 — Superseded 2026-08-20: Default PTY is a mend shell, not a session; the user chooses
  when they want an agent. Shells are processes: not in the tree, not in the inbox, skipped by
  session cycling. (Yiannis)
- 2026-08-19 — Inbox copies t3code's latest-nightly model: needs-you pinned, then recency; unseen
  clears on focus. (Yiannis: "copy the latest t3 code inbox thing")
- 2026-08-19 — Superseded 2026-08-20: Tabs stay; each new tab is a mend shell. (Yiannis)
- 2026-08-19 — Review, repo store, settings are in-app surfaces, phased M2/M3. (Yiannis)
- 2026-08-19 — Binds: sane defaults now; must include next/prev project and next/prev session
  (sessions only). (Yiannis)
