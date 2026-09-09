# @sealant/mend

## 0.25.0

### Minor Changes

- 51c2742: The self-hosted server bundle no longer ships RabbitMQ or a workspace-image registry. It
  pins Sealant 0.29.0, which runs its job queue in Postgres and keeps workspace images in the host
  Docker Engine, so the Mend container now supervises only Mend and the Sealant API, worker and SSH
  gateway. Idle memory drops accordingly. The bundle asset contract moves to v2 (`compose.v2.yaml`,
  `setup-contract.v2.json`): no registry port is published, `--registry-port` is gone from
  `mend server setup`, and setup, start, restart and upgrade no longer run the loopback registry
  round-trip. Existing v1 installations upgrade in place with
  `mend server upgrade --version <target>`; their volume-ownership identity is carried over
  unchanged.

  The Mend API server and web front now run from esbuild bundles inside the images (no
  `node_modules`, no type stripping at start), which also drops code the server never calls, such as
  the OpenAPI viewers Effect re-exports.

## 0.24.2

### Patch Changes

- 8780acb: The dashboard no longer bounces on Enter while a session's workspace is still booting. A
  `starting` row has no terminal to attach yet, so Enter now leaves the dashboard up and says so,
  instead of suspending the screen once per keystroke and returning. A worktree header attaches its
  newest live member that is past starting.

## 0.24.1

### Patch Changes

- 106a49c: `mend server setup`, `start`, `restart` and `upgrade` now announce each slow phase before
  it starts: resolving the release, downloading assets, pulling images, starting containers and
  waiting for health. Image pulls show Docker's own progress on the terminal instead of running
  silently, so a first setup no longer looks frozen for the minutes a pull takes.

## 0.24.0

### Minor Changes

- f02a7ae: Redesign the web workbench around projects, worktrees, and their sessions. Add list and
  card views, compact project/worktree selection when starting a session, consistent page widths and
  setup cards, and a project setting to inherit or exclude global skills.

## 0.23.0

### Minor Changes

- e54c03d: Package Mend, the pinned Sealant runtime, RabbitMQ, and the workspace registry in one
  application image. Keep Postgres separate, preserve application data and SSH identity in named
  volumes, and supervise the application processes as one restartable unit.
- 13999dd: Use `APP_URL` and explicit `MEND_ALLOWED_ORIGINS` for authentication, credentialed CORS,
  pairing, and advertised addresses. Enforce the policy on unsafe cookie-authenticated requests and
  WebSocket upgrades, including the web proxy. Pairing clients honor the server's configured
  addresses. Stop trusting discovered container interfaces and forwarded host headers. Pin the
  Sealant SDK and API contracts to 0.28.0 for the upcoming container bundle.
- 95e3992: Support remote workspace SSH with per-server aliases, effective OpenSSH configuration
  checks, and usable client-key validation. Keep host-key trust explicit and leave unrelated SSH
  configuration intact.

  Adopt repositories by network Git URL only. Reject local paths, option-like sources, and Git
  remote helpers while preserving cwd project selection and session worktrees. Bundle the CLI's
  private workspace dependencies so its npm tarball works outside the monorepo.

- 867ee9d: Add server status, bounded logs, start, stop, restart, and explicit version upgrades.
  Verify installation ownership before operations. Validate target artifacts before stopping writers
  and save a private streamed database backup before activation. Retain the target pin and recovery
  files after possible migrations, with no automatic downgrade or database restore. Bound
  subprocesses and recover pre-startup failures without replacing identity or deleting volumes.
- a2acca0: Install only the CLI through npm or the POSIX bootstrap. Add explicit Docker server setup
  with exact version pins, private configuration generations, persistent identity, daemon volume
  ownership checks, and a real Engine registry roundtrip. Validate release assets and image versions
  before activation. Support explicit private origins, configurable ports, local release assets, and
  offline setup.

## 0.22.0

### Minor Changes

- 0ce748d: Docker inside workspaces on Kubernetes. Mend pins Sealant 0.27.0, which serves the
  workspace Docker switch on Kubernetes deployments whose operator enabled `workspaces.docker` (a
  rootless daemon beside the workspace, in a user-namespaced Pod). Where the deployment cannot serve
  it, the platform refuses at create and the session now shows that refusal in one sentence, naming
  the two ways out, instead of a launch failure minutes later. Platform error codes Mend branches on
  are read from the error body again (the SDK reports the error's tag as its code), which also makes
  the cluster-bindings refusal match the real platform.

## 0.21.1

### Patch Changes

- 2baf887: A new conversation inside an existing worktree (⇧S "session here" in the dashboard, the
  web's new session in a worktree, `POST /worktrees/:id/sessions`) now claims a ready standby
  skeleton like every other launch, instead of always creating a fresh workspace. A standby skeleton
  serves any worktree since 0.18.0; this path had simply been left on the cold road.
- 70a69e5: The Mend key's private half is pinned to mode 0600 on every use, not only when it is
  created. On Kubernetes the volume's fsGroup policy adds group read/write to every file at pod
  start, ssh then refuses the key ("UNPROTECTED PRIVATE KEY FILE"), and every mend-key fetch and
  push, host-side and through the workspace shim, failed with "Permission denied (publickey)".

## 0.21.0

### Minor Changes

- 5d9dd24: Git access is now a per-user choice, asked once on first run and kept in Settings: a Mend
  key of your own on the server (recommended; add it to your git account's SSH keys and every
  repository works, from detached sessions and the phone too, or add it as one repository's deploy
  key), or your own machine's key through the bridge. New projects adopt with your choice; a
  project's setup page still overrides it. `mend keys mode [mend-key|bridge]` sets it from the CLI.

  The Mend key is per user, not per server. A server-wide key from before is claimed by the first
  user who asks, so a public key already on your git host keeps working.

  When your choice is bridge, every attaching `mend` command (codex, claude, opencode, run, attach,
  shell, resume, rejoin) and the dashboard share this machine's ssh-agent for as long as they run,
  and the dashboard header says "agent shared". Projects then fetch their base before a worktree is
  created instead of silently starting on whatever the store last fetched. `mend keys share` still
  runs the relay in the foreground on a machine without one.

### Patch Changes

- 884f34f: Ctrl+V (image paste) and Ctrl+] (detach) in an attached terminal are now recognised in
  every form the kitty keyboard protocol can send them. Codex asks the terminal to report all keys
  as escape codes, and under that flag the lock modifiers ride along: with Num Lock on, Ctrl+V
  arrived as `ESC[118;133u` instead of `ESC[118;5u`, slipped past the matcher, and reached codex's
  own clipboard handler inside the workspace, which has no display and failed with an X11 error. The
  matcher now parses the report (key code, modifiers, event type) and masks the lock bits.

## 0.20.0

### Minor Changes

- 9972147: Ctrl+V in an attached terminal (`mend codex`, `mend claude`, `mend attach`, the
  dashboard) now pastes an image from this machine's clipboard into the session: the CLI reads the
  clipboard (wl-paste on Wayland, xclip on X11, osascript on macOS), stores the image beside the
  session, and pastes its workspace path, which codex and claude read as an attachment. Before, the
  keystroke reached the agent's own clipboard handler inside the workspace, which has no display,
  and failed with an X11 error. With no image on the clipboard the keystroke goes through untouched.

  The dashboard now renders every worktree as a header with its sessions indented underneath, one
  session or many. A worktree with a single session used to collapse into one row that carried the
  worktree's name, so ⇧D on it read as "remove the worktree" while it removed the session.

- 9972147: The dashboard hides settled sessions that never had a conversation — no transcript
  captured at settle, none in the harness home — since there is nothing to resume or hand off;
  `mend sessions --all` still lists them. Mend now records that fact once at settle (and classifies
  older sessions once at boot). ⇧D on a session row removes that session and leaves the worktree; a
  session killed a moment ago removes without a second stop, since the server closes its shells and
  settles it on the way out. ⇧D on a worktree header still removes the worktree.

## 0.19.0

### Minor Changes

- ff25c3c: The dashboard hides settled sessions that never had a conversation — no transcript
  captured at settle, none in the harness home — since there is nothing to resume or hand off;
  `mend sessions --all` still lists them. Mend now records that fact once at settle (and classifies
  older sessions once at boot). ⇧D on a session row removes that session and leaves the worktree; a
  session killed a moment ago removes without a second stop, since the server closes its shells and
  settles it on the way out. ⇧D on a worktree header still removes the worktree.

## 0.18.0

### Minor Changes

- a228468: The CLI explains itself. `mend help` is an index again: one line per command, grouped
  into start, sessions, services, project setup, and this machine, aligned in two columns at your
  terminal's width. Every command now has its own page, `mend help <command>` or
  `mend <command> --help`, with usage, a description, options, examples, and see-also;
  `mend help service` lists a family. Usage errors quote the same synopsis. The same pages ship as
  man pages: `man mend` and `man mend-<command>` after a global install, or `mend man <command>`
  from anywhere. Every description was rewritten to say what the command does in plain words.

  `mend version` (also `--version`, `-v`) prints this CLI's version, then the server's when it
  answers within two seconds, and states a mismatch as a fact.

- 62e947a: Linked projects. A project's setup page gains a "Linked projects" section: pick another
  adopted project and a name, and every next session of this project works in that project too,
  read-write, at `/workspace/repos/<name>`. The linked project's named worktree is bound at launch
  (blank picks, creating it if needed, the worktree named after its default branch); commits there
  are that project's own change, reviewed on its side, never part of this session's change. Distinct
  from references, which are read-only clones for reading, and from mounted folders, which are host
  paths and so cannot exist on a cluster. Linking rewarms the hot pool.
- d9e397e: Hot sessions are standby workspaces. A pooled workspace no longer pre-creates a worktree:
  it mounts the project's worktrees directory and the session that claims it binds its own worktree
  at launch, so the pool now serves a named join into an existing worktree as well as a brand-new
  one, and a skeleton never spends a worktree or a worktree row ahead of time. Every session's
  workspace is created this way (Sealant 0.26, sealantd 0.13), which is also what lets a project
  mount sibling repositories next. Migration 0048 relaxes the pool's worktree columns.

## 0.17.0

### Minor Changes

- 2227524: Paste an image into a session's terminal. Ctrl+V inside claude or codex reads the
  clipboard of the machine the TUI runs on — the workspace container, which has none — so pasting a
  screenshot did nothing anywhere in Mend. Now an image pasted or dropped onto the terminal (web,
  desktop) or the new `img` key on the phone's key bar goes to `POST /sessions/:id/images`: Mend
  stores the bytes in the session's durable harness home (mounted read-write into every workspace
  the session gets, never inside the worktree, so nothing touches the change or the checkpoints) and
  the terminal pastes the workspace path — which codex attaches as an image input and claude reads.
  PNG, JPEG, GIF, and WebP up to 8 MB; the format is sniffed from the bytes.

### Patch Changes

- 8bff8b1: Take a session over from a phone pickup. When a session is live in protocol mode (handed
  off to the phone), `mend attach` and the dashboard's attach now hand it back to a terminal — end
  the protocol agent, resume the same conversation as a TUI, and attach — instead of failing with
  "tty attach unavailable" or dropping you into a bare bash shell. `mend rejoin` already did this;
  the two most natural "get me in" entrypoints now match it.

## 0.16.0

### Minor Changes

- bef9f10: `mend skills` — skill libraries on the server. `mend skills push` scans
  `~/.agents/skills` (the shared agent-skills convention; `--dir` overrides) and uploads every
  bundle to your library, or a project's with `--project`; `--prune` removes server-side skills the
  directory no longer carries. `mend skills` lists a library. Sessions receive the merged libraries
  in their harness home at launch — claude and codex both discover them natively; a same-named
  project skill overrides a personal one.

## 0.15.2

### Patch Changes

- 0688777: Ambient-mode remote git operations now use `StrictHostKeyChecking=accept-new`, matching
  mend-key and bridge: a daemon has no terminal to answer a first-contact host-key prompt, so a
  server with an empty known_hosts (a fresh pod) could never reach any remote. A changed host key
  still refuses, and the failure message now names that one remaining case.
- 0688777: Worktree creation in the dashboard is one floating, fixed-size modal: name, base, and
  harness all visible at once — enter or tab advances (shift+tab and esc step back; esc cancels from
  the name), nothing shifts as focus moves. The base step is a fuzzy finder over the project's
  branches, prefilled with the branch checked out where `mend` ran when creating in that project; a
  name that joins an existing worktree shows the base as fixed. Running `mend` inside a repo the
  store doesn't know raises an adopt offer: the origin URL (or local path, honestly labeled) with an
  arrow-key auth-mode toggle — ambient, mend-key, or bridge.

## 0.15.1

### Patch Changes

- f4a6f5e: Entering a session whose agent terminal has ended now rejoins the shell already holding
  the workspace instead of opening a fresh bash per attempt — the failure mode where Ctrl+C out of
  an agent left a session held open by a stack of orphan shells. Stops and worktree removals in the
  dashboard paint optimistically: the row settles (its live process and service fact lines drop with
  it) or leaves the list before the server answers, and an error refetches truth.

## 0.15.0

### Minor Changes

- be4ece9: The worktree becomes the durable container: sessions are conversations inside it — many
  per worktree, several live at once — with one change and one checkpoint chain per worktree.
  Launching with an existing worktree name joins it (`--worktree` joins only); `s` in the dashboard
  starts a session inside the selected worktree, Shift+D is the one explicit removal (refused while
  anything is live), and deleting a session leaves the worktree, its change, and its checkpoints
  standing. `mend worktrees` lists containers with their sessions; `mend sessions --json` stays
  byte-stable v1, `--json=v2` emits the worktree envelope. Migration 0046 re-keys existing data
  one-worktree-per-session; review slices may now span checkpoints from different conversations of
  one worktree.

### Patch Changes

- fc9ea8e: The dashboard shows what actually lives in each worktree: live agent and shell processes
  hang under their worktree row beside the Services, and unnamed worktrees are called by their
  auto-name label (or short session id) instead of the `session/<uuid>` branch noise. The attach and
  rejoin banners use the same name.

## 0.14.0

### Minor Changes

- 0a90f6f: The dashboard groups everything by worktree: each session row leads with its worktree
  (branch), its live Services hang underneath, and the detail panel is titled by the worktree. A
  stop shortcut lands too — `x` (or `Shift+K`) arms against the selected worktree and a second press
  stops it; lowercase `k` stays vim-up. `mend attach`/`mend rejoin` banners name the worktree as
  well.
- 0a90f6f: The start-a-session flow asks the worktree's name first, then the session details — on
  the dashboard (`n` opens the name input, then the harness picker), the CLI (`mend claude` asks on
  a TTY; `--name` skips the ask), the web and desktop composers, and the phone. A named session gets
  branch `mend/<name>` and worktree directory `<name>`; empty keeps the auto-derived identity. Named
  sessions provision cold (hot skeletons carry pre-created worktrees), and a taken name fails with a
  readable message.

### Patch Changes

- 3204a33: Detach works — and leaves a working terminal — while talking to claude. The claude TUI
  pushes the kitty keyboard protocol through the PTY onto the user's own terminal: Ctrl+] then
  arrives as a CSI-u escape instead of the 0x1d byte the attach loop scanned for (detach silently
  dead), and after any detach the terminal kept encoding every keystroke as CSI-u junk. The detach
  key now matches both encodings, and ending an interactive attach restores the local terminal (pops
  the kitty keyboard stack, disables bracketed paste and mouse reporting, leaves the alternate
  screen, shows the cursor). Reattach replays from 0, which re-establishes whatever the TUI had set.

## 0.13.0

### Minor Changes

- df25891: Background sessions: launches take `--detach`/`-d` (start without attaching) and
  `--foreground` (the session stops when this CLI exits), governed by the new background-sessions
  switch in Settings with a per-project override. New `mend stop <prefix> | --all` ends a session
  explicitly — inside the workspace too, via the staged helper. Attach now tells a dropped
  connection apart from a settled session (no more "session ended" on a network cut), and
  SIGHUP/SIGTERM restore the terminal cleanly instead of leaving raw mode pushed.

## 0.12.2

### Patch Changes

- 559b1cf: The agent bridge reconnects after a server restart on shared storage. A dead pod's socket
  file on an NFS-backed mount answers `lstat` with EINVAL, and the bridge's cleanup (`rmSync`, which
  stats first) threw that at every attach — `mend keys share` could never reconnect after a pod swap
  until someone removed the file by hand. Cleanup now unlinks without statting; anything the
  filesystem still refuses is left for `listen` to report loudly.

## 0.12.1

### Patch Changes

- fdb8ca5: The branches and refresh endpoints answer instead of 400ing. Their handlers returned
  plain objects where the contract's `ProjectBranch` is a class schema — the work succeeded (the
  fetch ran) and then response encoding refused the body, starving the composer's branch picker and
  `mend refresh` alike. Handlers now construct instances, and a contract test pins the invariant:
  class schemas encode instances only, shape-alikes compile and then fail at runtime.

## 0.12.0

### Minor Changes

- 7652f22: Sessions carry their base branch, visibly and currently. A session records the base as
  you named it (`baseRef`) beside the pinned commit, and every surface shows it: the sessions table
  and dashboard, the web lists, session page and review header, and the mobile session screen. The
  web composer and the mobile start rows pick a base from the project's real branches instead of a
  blind text field. Bases are current, not adoption-day stale: provisioning freshens the base ref
  from origin through the project's git auth (best-effort — offline or signer-less still provisions
  on what the store has), and `mend refresh [project]` (`POST /projects/:id/refresh`) fetches every
  origin branch into the store on demand. Nothing is ever pruned; session branches are untouched.

### Patch Changes

- 482be61: External agents stay visible whatever their harness does to file modes. Workspaces run as
  root and codex tightens its state to 0700, which blinded the store-side observer (uid 1000) — a
  codex run in a workspace terminal never appeared. The relocate boot script now keeps the harness
  home group/other-readable (a detached root mode-keeper loop), the observer warns instead of going
  silently blind, and a conversation that went quiet before mend could see it is late-observed: the
  row appears already-ended and the conversation is captured into the record.
- b764702: Project stores defend themselves against root-side git. Workspace containers run git as
  root against the store's shared gitdir, and a root `git gc --auto` could leave the ref database
  root-owned — locking the server (uid 1000) out of creating session refs, failing every new session
  on the project. Stores now run `core.sharedRepository=group` with setgid group-writable trees:
  applied at adoption, healed into existing stores on the next worktree create, and applied to each
  session's worktree gitdir (where checkpoints write). A store already poisoned by an earlier root
  write still needs a one-off root `chown -R 1000:1000` — only root can reclaim root's files.

## 0.11.0

### Minor Changes

- 9a6567a: Harness state is durable by construction: every session mounts a store-backed harness
  home into its workspace, and boot symlinks each harness's `$HOME` state dirs (`.claude`, `.codex`,
  `.local/share/opencode`) onto it. A workspace that dies without settling no longer loses the
  conversation — relaunch commits a capture from the live harness home and resumes natively instead
  of failing with "Saved harness state is missing". The mounted home is also the server-side seam
  for upcoming skills management.
- 19da134: Agents run by hand — in a mend shell, an SSH session, an editor terminal — become
  first-class: their transcript writes through the mounted harness home are observed server-side and
  surfaced as `agent-external` process rows ("claude (observed)"). The session reads as running, the
  workspace lease holds while the agent works, and the conversation is harvested and natively
  resumable like any engine-launched agent's. The row ends when the writes go quiet (five minutes) —
  but quiet is an inference, not an exit: the workspace is never reaped on it, and the next write
  revives the session with a fresh observed row. Mend observes, it does not own the process.
- 6487570: Workspace SSH sets itself up. `mend ssh` shows the observed state (gateway, registered
  keys, ssh config); `mend ssh setup` makes a machine ready once — it prefers the running
  ssh-agent's key so no new key material is created, registers it under the signed-in user, and
  writes one managed `Host mend-ws` block. The VS Code extension discovers the gateway through the
  server and offers the same setup as a single dialog on first open; the manual gateway settings
  become overrides.

## 0.10.1

### Patch Changes

- a421d71: Two protocol-session fixes, both diagnosed live on a Kubernetes deployment:
  - Claude sessions no longer show every assistant message twice. The stream-json CLI echoes each
    completed content block as its own `assistant` event whose content array holds just that block;
    the adapter keyed those echoes by array position (always 0), so with a thinking block at stream
    index 0 the completed text landed on the thinking block's item while the streamed deltas had
    already built the same text under its real id. The adapter now recovers the true stream index by
    counting consumed blocks per provider message id.
  - Resuming (or following up on) a stopped protocol session onto a fresh workspace now restores the
    harvested harness state before the harness starts. `launchProtocol` passed an explicit null
    state to `launchInternal` — the contract that skips both the read and the restore — while the
    composed argv still resumed by provider id, so `claude --resume` exited with "No conversation
    found". Deployments that reuse a retained workspace never saw this; fresh-workspace relaunches
    (Kubernetes, stopped workspaces) always did.

## 0.10.0

### Minor Changes

- 5930a45: `mend login` signs in through the browser instead of asking for a password. The CLI opens
  an authorize request against the server, points the browser at `<server>/authorize?code=…`, and
  polls until you press Authorize there. Approval mints a revocable device token, the same kind a
  paired phone holds. It shows up under Settings → Devices and replaces the old expiring session
  token, so the CLI no longer signs itself out when a browser session would have lapsed. A server
  that is already configured (`--url`, `MEND_URL`, or the config file) is used without asking; only
  a fresh machine with nothing set prompts for the URL, and Enter accepts the default. `--email` and
  the terminal password prompt are gone. `mend logout` now revokes the device server-side before
  forgetting the token locally.
- 8e71837: `mend service run` reaches the Service in one step. On a local server nothing changes:
  the command starts the Service and returns, and the bound endpoint already answers on this
  machine. On a remote server (a VPS, a Kubernetes Pod) the CLI now keeps running and tunnels the
  Service's port to `127.0.0.1` here — the same authenticated WebSocket `mend service connect` opens
  — instead of printing a suggestion to run a second command. Ctrl-C closes the tunnel, never the
  Service. `--no-connect` restores start-and-return. UDP Services are unchanged (no connection to
  tunnel).

  The server side of the tunnel is now authorized as well as authenticated: `/api/service-tunnel`
  refuses callers who are not the Service's session owner with 403.

- 00c683a: The dashboard is a drawn multi-pane workbench: projects and sessions panes side by side,
  a session detail panel beneath them, and the harness picker as a panel in the detail slot — no
  painted background, the terminal's own ground shows through, and chrome is near-mono with color
  only where it states a fact. Async state moved to optimistic mutations: starting or resuming a
  session puts a `starting` row in the list at the keystroke and leaves the keyboard free while the
  workspace provisions, renames land immediately, and review comment triage never waits on a round
  trip. The event stream is now parsed properly — heartbeats and per-record-line progress no longer
  refetch the workbench, so an idle dashboard makes no requests.

## 0.9.0

### Minor Changes

- eb2d1e3: Cluster bindings: a project can declare name-only references to Kubernetes Secrets and
  ConfigMaps (`mend env cluster add secret|configmap <name>`, `remove <kind>/<name>`) and a
  workspace ServiceAccount (`mend env cluster sa <name>` / `sa --clear`); `mend env show` lists them
  as a third section beside Configuration and Secrets. On a Kubernetes deployment the platform
  resolves the names inside the workspace at launch — Mend stores and forwards names, never the
  bound contents. Each session run records the binding names, revision, and service account it
  launched with; a binding or ServiceAccount change drains warm skeletons the same way an env or
  secret edit does. On a deployment that cannot resolve them, launch refuses readably, naming each
  binding, before any workspace is created (requires the platform SDK 0.24.0 surface). Also in this
  release: SessionRepository, the identity-keyed authority for session workspaces.

## 0.8.0

### Minor Changes

- d398efd: The server is now two processes: the Mend API server (`apps/api` — the typed contract,
  auth, the WebSocket data planes, the session engine, and the workers; port 3101,
  `MEND_MODE=all|api|worker`) and a stateless web server (`apps/web` — the TanStack app plus a
  transparent `/api` proxy carrying HTTP, SSE, and WebSocket upgrades; port 3105). Clients keep one
  origin and need no changes. The single-host installer and Docker image supervise both via
  `scripts/serve.mjs`; on Kubernetes the chart deploys them as separate tiers, and the web tier can
  be replicated.

## 0.7.1

### Patch Changes

- 0759bbf: Platform SDK 0.23.0: session attach, SSE output streams, and workspace port forwards now
  carry the owner assertion alongside a service key (Kubernetes deployments authenticate this way —
  attach and Service tunnels were rejected without it), and `workspaces.create` no longer pins the
  runtime family to Docker, so the deployment's default runtime decides.

## 0.7.0

### Minor Changes

- 5e1f3ce: `mend service connect [name…] [--port <n>]` brings live Services to THIS machine's
  loopback: each connection tunnels over one authenticated WebSocket to the server, which pumps it
  into the same workspace forward the server-side listener uses — works identically whether the
  server is your laptop, a VPS, or a Kubernetes Pod. Service status lines now lead with what your
  terminal can actually use (the tunnel on a remote server, the bind authority only on a local one),
  and Enter on an idle session in the dashboard opens a fresh shell in the held workspace instead of
  failing with "attach unavailable".

## 0.6.0

### Minor Changes

- 3f1eea2: Onboarding: `mend pair` prints a QR (and an eight-character code) that pairs a phone with
  this machine — the phone gets its own revocable device token, listed and revoked under Settings →
  Devices. `mend doctor` is a read-only checklist: server, sign-in, connected accounts, adopted
  projects, local harness CLIs, tailnet address — each failing line names the command that fixes it.
  `mend help` now opens with the getting-started sequence. A hidden `mend qr <text>` backs the
  installer's closing QR.
- e63ac2f: Each Mend user is their own Sealant user. Mend now authenticates to the control plane as
  a service principal (`SEALANT_SERVICE_KEY`; `SEALANT_OWNER_USER_ID` is gone) and provisions one
  Sealant user per account on first use, so sessions, records and model calls are attributed to the
  person who made them and run on that person's own connected accounts.
  - `mend connect claude|codex|github [--from-stdin] [--remove]` sends this machine's credential
    (the file the provider's CLI wrote at login, or a pasted one) to the platform under your own
    user; `mend accounts` lists what is connected. The Sealant web app is no longer needed.
  - Settings → Connected accounts does the same on web and desktop.
  - A hot-pool skeleton is claimed only by sessions of the user it was warmed for.

  Requires a control plane with service principals (`SEALANT_SERVICE_KEYS`, `POST /v1/users`).

## 0.5.0

### Minor Changes

- d60fc4b: Start a session with a prompt: `mend claude "fix the auth test"` opens the harness with
  the quoted prompt as its first message, and the session is named from it immediately instead of
  after the 45-second transcript poll. New flags on `mend claude|codex|opencode`: `--model <id>` and
  `--effort low|medium|high|xhigh|max` map to the harness's own model and reasoning flags,
  `--base <ref>` bases the worktree on a branch or sha, `--ask` restores the harness's permission
  prompts instead of the default bypass, and `--fast` requests priority processing (codex
  `service_tier=priority` — 1.5x speed at increased usage). The server composes the harness argv
  from the structured start, so the same launch path backs the web composer. Bare `mend claude` and
  `mend run -- <command...>` are unchanged.
- 196b2c7: Protocol-mode agent sessions: launch codex or claude as a structured byte protocol
  (`codex app-server`, claude stream-json) instead of a PTY. The conversation becomes rows Mend owns
  — authored turns, streamed items, and agent requests (approvals, questions) that block until a
  person answers — with new session endpoints to submit and interrupt turns, list items and requests
  by cursor, and respond to a pending request. A session with a live protocol agent reads `waiting`
  while a request is pending. PTY launches are unchanged and remain the default; protocol mode
  requires a workspace image with sealantd ≥ 0.11.

### Patch Changes

- 06beffc: The CLI now resolves the cwd's project the way you expect: a project adopted from GitHub
  matches any clone of the same remote (https, ssh, `.git` spellings compared equal), and the
  directory-name fallback goes through the same normalization `mend adopt` uses, so a checkout
  called `Mend` matches the project `mend`. Previously a GitHub-adopted project only matched when
  the folder name was spelled exactly like the store name, and `mend claude` from a mismatched
  folder would try to adopt the repository again. The guess is now visible:
  `mend claude|codex|opencode` print `✓ project mend · main · from cwd` before creating anything,
  and `mend projects` marks the cwd's project with `▸`.

## 0.4.0

### Minor Changes

- 6ed7b44: Hot sessions: a project can keep workspaces ready so new sessions attach instantly. Set
  the count on the project setup page (default 0) and Mend pre-provisions that many complete session
  skeletons — worktree, session socket, and a live workspace; starting a session claims one and goes
  straight to the terminal instead of paying the container build, dotfiles, and credential setup at
  launch. The pool drains and rewarms itself whenever the image, variables, secrets, references,
  mounts, or dotfiles change, and the setup page reports what is observed ("2 ready · 1 warming").
  Each ready workspace is a live container on this machine — the count is explicit resource intent.
  Resumes still launch cold: a resume is bound to its existing worktree, which a pooled workspace
  cannot adopt.

### Patch Changes

- ee0fd13: `mend dotfiles` shows the repository's subdirectory when one is set. The dotfiles
  repository knob now takes a repo-relative subdirectory: the launch archive is re-rooted there
  (`git archive HEAD:<subdirectory>`), so a repo whose home tree lives in a subfolder — a `dots/`
  directory, a stow package — applies to `~` without restructuring. Configured in Settings →
  Dotfiles.

## 0.3.1

### Patch Changes

- 0704527: `mend shell` sessions get the agent accounts you actually have. The shell workspace asked
  the platform for credential bundles (Claude + Codex + GitHub, then Claude + Codex, then GitHub)
  and fell back to none when any named account was not connected — a Codex-only user opened a shell
  with no agent auth at all. The ladder now degrades per provider, so a Codex-only (or Claude-only)
  user still lands on that account.

## 0.3.0

### Minor Changes

- 12f71f2: `mend env load [path]` — load a `.env` file into the project's environment store: every
  `KEY=VALUE` line becomes an entry (comments and blank lines dropped; `export` prefixes, quoted and
  multi-line values honoured), routed by name into Configuration or Secrets. Secret-shaped names
  (`*_KEY`, `*_TOKEN`, `*_SECRET`, `*_PASSWORD`, …) land in Secrets, as does everything when you
  pass `--secret` (or only the names in `--secret A,B`). Secrets are encrypted at rest and never
  printed back; the rest are plain Configuration. `mend env [show]` prints the current sets as terse
  facts — names, revisions, byte counts, never secret values. New workspace launches receive both
  sets (secrets through the platform's transient secret channel, redacted from the record); running
  sessions are unaffected.
- e7fa8de: `mend login [--url <server>]` signs the CLI in: it prompts for the email and password of
  your Mend account, exchanges them for a bearer token, and stores it (0600) in the CLI config next
  to the server url, so every other command is authenticated without setting `MEND_TOKEN`.
  `mend logout` clears it. Unauthenticated calls now say which server refused them and point at
  `mend login` instead of the bare "set MEND_TOKEN" hint.

## 0.2.0

### Minor Changes

- fefa161: `mend dotfiles` — your dotfiles on the server, captured from the machine that has them:
  `mend dotfiles sync [--all | paths…]` scans a curated candidate list (shell/git/editor/terminal
  configs — never keys or histories) on the calling machine and streams contents into your
  per-account dotfiles store; `mend dotfiles [show]` prints the store as terse facts. Sessions apply
  the snapshot before the agent starts. Also: the CLI config moves to
  `$XDG_CONFIG_HOME/mend/cli.json` (default `~/.config/mend/cli.json`); a pre-XDG `~/.mend/cli.json`
  keeps working when it is the only one present.

## 0.1.1

### Patch Changes

- d8f049c: Exit interactive CLI commands as soon as the session-end control frame arrives instead of
  waiting for the terminal transport and record finalization to close.
