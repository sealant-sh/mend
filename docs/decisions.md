# Decisions

Mend's product decision log. Add an entry at the top when a product-level decision is made. When a
decision needs its options and consequences argued out, write an ADR in [`adr/`](adr/) instead and
link it from a short entry here.

Entries up to 2026-11-13 come from `MEND-AGENT-WORKBENCH-PLAN.md`, retired that day. Where one cites
a section of it ("§8.1.A", "M2.5"), read the plan's last version with:

```sh
git show "$(git rev-list -n1 HEAD -- MEND-AGENT-WORKBENCH-PLAN.md)^:MEND-AGENT-WORKBENCH-PLAN.md"
```

## Decided

- **2026-11-08: one account, several organizations.** Yiannis: "add the concept of org switching ie
  one acc multiple orgs". An account holds a role in each organization it belongs to, and each
  sign-in or paired device acts in one of them, chosen with a switch; a request answers only for
  that organization, even to a member of both. A person's own logins, dotfiles and signer follow
  them into each one. Details: [ADR 0003](adr/0003-organizations-and-tenancy.md), "Organization
  switching".
- **2026-10-26: VS Code carries the extensions a person installs in a workspace, per project, and
  nothing else.** Yiannis, on SLNT-328, after a user met about 30 Settings Sync dialogs from the
  first design, which installed every local extension in every workspace. What a person installs
  from the Extensions panel in a Mend workspace window, VS Code's **Install in SSH: …** included,
  joins that project's set; uninstalling it there removes it. There is no Mend picker. The set lives
  in the extension's `globalState`, keyed by project id and carried by Settings Sync, and each open
  of a workspace window of the project reinstalls it silently with `donotSync`. Mend copies no
  settings: VS Code already applies User settings in a remote window, except `machine` and
  `machine-overridable` ones, which are mostly local paths. `mend.workspaces.bringMyEditor` takes
  `off | picked`, default `picked`, and every older value reads as `picked`. Rule D5 (2026-10-17)
  still holds: Mend acts only in a Mend alias window whose remote server runs as a person uid (40001
  to 49999) with HOME `/home/m*` and its server folder inside that HOME. A shared or root home does
  nothing and shows `editor stays local · shared home`. `editorHomeOf` in
  `apps/vscode/src/editor-home.ts` is the rule, with its test table. Not taken: a Mend picker for
  local extensions; keeping the set on the Mend server (SLNT-329, for 0.37); a persistent
  per-project `~/.vscode-server` (the SDK has no per-project storage for capture workspaces, and two
  live sessions would share it); copying machine-scoped settings; `isMachineScoped` to tell Mend's
  installs from the person's (with Settings Sync off a person's install is not machine-scoped
  either); per-window recovery journals on disk; adopting gallery extensions already listed at the
  first read.

- **2026-10-19: a finished terminal turn is idle, not Needs you.** A terminal agent that finished
  its turn (`Stop`, claude's `idle_prompt`) keeps its `prompt` wait on the process row, and the
  session reads `idle · claude finished its turn` while the agent stays live. It asks nothing of the
  person, so it gets no Needs you, no badge and no push. Only a permission or a question reads
  `waiting`. The other `idle`, an ended agent beside a shell or Services, has no live agent and no
  wait. Several live agents fold together, whatever order their rows come in: any ask reads
  `waiting` with the earliest ask's line, else any working agent reads `running`, and only when
  every live agent finished its turn does the session read `idle`. A session that ends still rings
  "finished", and so does an agent that exits after its finished turn while a shell or Service keeps
  the session `idle`: the push and review prep read the process event as well as the session's. This
  replaces the G4 entry's `waiting` for a finished turn below.

- **2026-10-19: a terminal agent's own hooks say that it waits, and why (G4).** A session also reads
  `waiting` while its live terminal agent (`agent-pty`) has reported a wait. Claude's `--settings`
  hooks and Codex's `[hooks]` in `/etc/codex/config.toml` run `mend hook <harness>`, which sends the
  hook's event, notification type and tool over the session channel; one table (`AGENT_HOOKS`)
  derives both harnesses' wiring and the server's reading. The fact is on the agent's process row
  (`session_processes.waiting`: `permission`, `question` or `prompt`, the tool, and since when), and
  clients show it as `waiting · claude needs your permission to use Bash`. A tool that ran, a
  submitted prompt, or the end of the process clears it; a keystroke in that terminal clears a
  permission or question wait (a finished turn waits for the submitted prompt), and the emulator's
  own replies are not keystrokes. A report names its process by the harness's own session id: Mend
  pins a fresh terminal Claude with `--session-id` and records it, a fresh Codex's first
  `SessionStart` claims its row, and a report under any other id changes nothing. A finished turn
  reads `waiting · claude finished its turn`. This lifts the 2026-08-21 reservation of `waiting` for
  protocol mode.

- **2026-10-18: "handoff" means bringing local work into a session; the planned summary is a session
  summary.** `handoff` now names one act: copying a person's local branch, commits and uncommitted
  files included, into a new session from their checkout. The checkout is never changed, and the
  session row reads `handed off from <machine>`. The planned editable end-of-session summary
  promoted into durable context, previously called a handoff (§5, §7.1, M3), is a `session summary`;
  its manifest kind is `session-summary`. The shipped 2026-08-31 cross-mode pickup is called a mode
  switch in words and internal names. Its wire keeps the released names
  (`POST /sessions/:id/handoff`, `HandoffRequest`, `HandoffUnsupported` with status 422), because
  every `mend` CLI since 0.13 and the mobile app call it. The 2026-08-31 entry below keeps its
  original wording as history.

- **2026-10-17: `mend handoff` copies a local branch into a new session and never touches the
  checkout.** Yiannis decided these between 2026-10-17 and 2026-10-21; do not reopen them. Handoff
  writes nothing to the checkout: no index or ref write, no stash, no file touched. The commits
  ahead of the merge base with the default branch and the staged, unstaged and untracked files
  travel as one git bundle in the raw request body. Gitignored and `.env*` files stay behind and the
  CLI names them. A `.env*` committed in a commit ahead travels with that commit and is named
  (`travels in a commit · .env.local (1a2b3c4)`), and so is a file git hides with assume-unchanged
  or skip-worktree. Review shows exactly the local diff, based at the merge base of the branch with
  the project's default branch. The fact line reads
  `2 commits ahead of main · 3 uncommitted files · 1 untracked`, and the session row
  `idle · handed off from dana-mbp`. A checkout that is not adopted is offered adoption, a detached
  HEAD works, and a foreign origin is refused: the origin must be the project's on the same port and
  with the same path case, except on hosts known to ignore case (`github.com`). Files over 8 MiB
  (`MEND_BUDGET_HANDOFF_FILE_BYTES`) are named and left out, and an old server gets a plain error.
  Without a prompt Mend holds a workspace for the person with no agent; with one, the CLI launches
  the session and returns without attaching. A second handoff of the same branch is a new one,
  `fix-login-2`. The CLI came first, VS Code with its extension rebuild. Not taken, so not to be
  reported missing: receipts with tombstones, a durable opening outbox and a reconciler; a
  transactional rewrite of worktree publication; streaming the body through `handleRaw`; an
  `Idempotency-Key` with saved retry material; refusing intent-to-add, skip-worktree or sparse
  checkouts, or split indexes; a metadata commit carrying the prompt; reading the POST's 413 instead
  of asking for the terms first; running git against the real `GIT_DIR` with a scrubbed environment;
  writing the bundle header by hand. Buffering the whole body before the account's handoff slot is
  taken was kept for 0.36 (2026-10-21).

- **2026-10-08: the computer-use experiment succeeded; shipping is deferred.** Real Claude and Codex
  terminal sessions operated the same Chromium desktop the human viewed beside the terminal,
  retained recordings, and supported takeover without ending the coding conversation. This validates
  a container desktop plus image-provided MCP tools through the public Sealant SDK. No release
  version or production architecture is approved by this experiment. Its write-up was
  `docs/experiments/computer-use.md`, removed; see git history. Overtaken by
  [ADR 0020](adr/0020-guis-in-sessions.md).

- **2026-09-17: organizations are the tenant.** One organization per account, owners and members, an
  operator role with no default read access, private and shared projects, owner-only steering with
  opt-in shared control, invitation-only registration, and `MEND_TENANCY=single|multi` with `multi`
  refused until the isolation gate passes. Details and the delivery stack:
  [ADR 0003](adr/0003-organizations-and-tenancy.md). Overtaken, for one organization per account, by
  the 2026-11-08 entry above.

- **2026-09-05: CLI-installed, two-container server.** Installing Mend installs only the CLI;
  `mend server setup` creates one application container containing Mend and its pinned Sealant
  services, plus a separate official Postgres container with separate databases and users. Setup
  manages named-volume storage, exact public origins, and persistent secrets/SSH identity. Users
  select only a Mend version. Adoption accepts Git URLs, replacing earlier local-path adoption.
  Remote-SSH uses per-server configuration and the client's Mend hostname by default. macOS and
  installed VS Code acceptance are release gates. Details and implementation sequence: the packaging
  plan, `docs/archive/PACKAGING-PLAN.md`, removed; see git history.

- **2026-08-28: externally-run agents are observed process rows.** An agent the user runs by hand —
  in a mend shell, an SSH session, an editor terminal — writes through the mounted harness home, and
  that makes it observable server-side: fresh transcript writes become an `agent-external` process
  row ("claude (observed)"), the session fold reads `running`, the workspace lease holds, and the
  settle harvest captures the conversation like any engine-launched agent's. Mend observes; it does
  not own the process — it cannot steer or stop it, and the row ends when the writes go quiet (five
  minutes). Quiet is an inference, not an exit: ending an observed row never sweeps the workspace (a
  user reading output writes nothing, and reaping on quiet would kill an agent between turns — the
  platform TTL stays the backstop), and the next write revives the session with a fresh observed
  row, including a quiet-settled session whose workspace pointer survives (revival requires writes
  that postdate the settle). While an engine-launched agent is live, transcript writes are presumed
  to be its; observation fills only the blind spot. This is what makes opening the workspace from an
  editor (VS Code over SSH) a normal workflow: run the agent by hand, keep the workbench's status,
  record, and resume.

- **2026-08-28: harness state is durable by construction — the mounted harness home.** Every session
  owns a store-backed `harness-home/` directory (beside its harvested captures), mounted read-write
  into each of its workspaces at `/workspace/harness-home`; boot moves whatever `$HOME` holds into
  it and symlinks each harness's state dirs (`.claude`, `.codex`, `.local/share/opencode`) onto the
  mount, so every transcript/todo/skill write lands on the store the moment the harness makes it.
  Harvest-at-settle stays as the immutable per-process evidence capture (now dereferencing the
  symlinks), but it is no longer the only copy: a workspace that dies without settling loses
  nothing, and a relaunch commits a capture straight from the live harness home ("Saved harness
  state is missing" becomes a working native resume). An archive restore runs only when no live
  state exists (legacy sessions). Decided after an OOM-killed workspace pod took two sessions'
  conversations with it — the container writable layer was the sole copy. The mounted home is also
  the server-side seam for managing what a harness sees in `$HOME` (skills management writes into
  `harness-home/.claude/skills` with no workspace exec). Trade-off accepted: harness-written
  credential files land on the store volume, which already holds the repo and Mend's keys. Overtaken
  by [ADR 0002](adr/0002-session-capture-store.md) and
  [ADR 0016](adr/0016-per-person-harness-homes.md).

- **2026-08-26: deployment strategies are named compositions; the session workspace authority is
  identity-keyed.** The co-located store ("Mend and the workspace see the same POSIX worktree") is
  an implementation technique of the `local` and `kubernetes` strategies, not the product invariant.
  The invariant is: every session has one authoritative mutable workspace, and
  checkpoints/diffs/evidence are ordered against it. The engine reaches that authority through the
  `SessionRepository` port (identity-keyed; co-location is the explicit `worktreeMount` capability),
  and each deployment strategy is a named, tested bundle — `local`, `kubernetes`, and a
  `cloudflare-hosted` strategy sequenced in two tiers (hosted workspaces first, Workers-native
  control plane later). Design: [ADR 0002](adr/0002-session-capture-store.md); the Sealant half is
  the cloudflare runtime adapter + bridge Worker series.

- **2026-08-31: mode handoff — cross-mode pickup with native fidelity.** A session started as a PTY
  can be picked up from the phone in full structured mode, and a phone-driven protocol session can
  be reopened as a TUI — one live agent process at a time, the provider session id the durable
  identity (`POST /sessions/:id/handoff {to}`). Fidelity comes from the harness's own record: the
  takeover harvests synchronously, PTY-era history backfills into the durable conversation from the
  native transcript through the SAME item mapping the live adapter uses (real `msg_`/`toolu_` ids,
  raw blocks in `item.data` — never an inferred rendering), and the reverse direction is a native
  `claude --resume` / `codex resume` whose scrollback holds the phone-authored turns. The
  per-session native-ingest cursor (advanced at backfill and at every protocol harvest) is what
  keeps a second pickup from duplicating protocol-era turns. Reading stays instant and read-only on
  open; the composer is the pickup. PTY-first stands: the handoff is provider-specific machinery
  layered on top, claude and codex only, and every other harness refuses with a clear message.

- **2026-08-31: protocol process restart policy v2 — rehydrate in place.** The pipe process survives
  a Mend restart (its stdio terminates at the platform daemon), so boot re-attaches a fresh adapter
  to the surviving pipe on the SAME `session_processes` row and replays the recorded output from 0
  to rebuild correlation state: claude's client-minted turn ids come back from the durable turn rows
  as an ordered replay queue; codex skips the handshake, seeds the durable thread id, and
  epoch-scopes new JSON-RPC ids so stale replayed responses can never resolve a new call. Requests
  already resolved before the restart are skipped during replay; responses caught mid-delivery reset
  `sending → failed`; a turn dispatched but never acknowledged fails honestly. Dispatch stays gated
  until replay passes the probe-time high water. When the pipe is beyond reach the boot watcher
  settles the row; when the adapter cannot rehydrate, the row ends and a fresh pipe relaunches by
  provider id with queued turns following it. "Mend restarted" is no longer a session-failing
  verdict.

- **2026-08-21: protocol process restart policy v1 (superseded by v2 above).** Protocol adapters own
  pending provider calls in memory. On Mend boot, live `agent-protocol` rows are ended instead of
  reconstructing adapter state from the Sealant journal. An explicit resume starts a fresh pipe
  process and uses the harvested provider id (`thread/resume` or `claude --resume`). Provider-keyed
  item upserts preserve item identity and sequence if native events replay.

- **2026-08-20: desktop shells belong to visible sessions; hidden benches are retired.** A writable
  supporting shell runs in the focused coding-agent session's current workspace and contributes to
  that session's change. If only a project is focused, the shell shortcut opens the session launcher
  instead of creating hidden work. Shell tab close confirms and stops the process group; an explicit
  Detach tab action leaves it running. A completed coding-agent run may leave its workspace retained
  by shells or Services. Resume reuses that retained workspace and preserves those processes; a
  separate stop-retained-work-and-resume-fresh action names what it will end. Hot workspaces remain
  prepared capacity for new visible sessions only.

- **2026-08-20: Review is pinned to a checkpoint pair and diff digest.** Opening Review is an
  idempotent command that creates or reuses the To checkpoint. The diff, comments, evidence, and
  machine passes read the same immutable comparison. A later worktree edit marks the snapshot stale
  but never mutates it silently. New comments carry slice-bound anchors, including side and range.
  Legacy moving-diff comments stay readable and are labeled as such.

- **2026-08-20: follow-up delivery is server-owned and recoverable.** The reviewer selects comments
  and edits the instruction. Mend stores the selected comment IDs, checkpoint pair, digest,
  instruction, and idempotency key before launch. Delivery completes only when the new PTY accepts
  the instruction and Mend persists the run membership and correlation. Failed and interrupted
  delivery remains retryable; selected comments are not marked sent early.

- **2026-08-20: Services are explicit, session-owned, and privately forwarded.** Recipes and user
  actions create Services; future public listener events may suggest declarations but never create
  them. Raw TCP or UDP forwards have no Mend request authentication and bind only to loopback or
  explicitly selected private interfaces by default. Browser Open requires a separately declared
  HTTP or HTTPS scheme. Services never autostart. A stable Service retains immutable process-attempt
  history, forwards, and timestamped target observations. Any live agent, shell, Service attempt, or
  selected open forward renews its ordinary workspace's 12-hour TTL on a separate 10-minute
  heartbeat from the hot pool. Mend persists the platform-returned expiry; a failure preserves the
  last successful renewal and known expiry while recording when and why renewal failed.

- **2026-08-20 — Hot sessions: a per-project pool of pre-provisioned workspaces.** Each project
  carries a `hotSessions` count (default 0, the setup page's stepper): Mend keeps that many complete
  session skeletons ready — a pre-generated session id, its worktree and branch, its session socket
  dir, and a live workspace mounting them — so a new session claims one at provision and the launch
  skips straight to opening the PTY. The skeleton must be complete because the platform fixes every
  create-time input (mount path, mounts, env, secrets, dotfiles, image, credentials) at
  `workspaces.create` with no mutation API; a fingerprint over those resolved inputs gates claims,
  and the engine drains-and-rewarms the pool when any of them change (settings handlers trigger it;
  a 10-minute heartbeat re-arms workspace TTLs and heals the rest). The worktree is a bind mount, so
  the claim freshens it to the requested base host-side and the running container sees the reset
  immediately. Skeletons launch with the shell shape — every harness CLI baked, all connected
  accounts attached — so one pool serves every supported coding harness. Supporting shells and
  Services reuse a claimed session workspace and never claim another pool entry. A resume is cold
  when no retained workspace exists because its worktree path is fixed; a session retained by live
  leases resumes in place. Status stays observational: "2 ready · 1 warming", never a promise.

- **2026-08-22 — Mend owns the people; Sealant owns the resources.** Every Mend user ran as one
  Sealant user (`SEALANT_OWNER_USER_ID`): one set of connected accounts for the whole team, which
  shares subscriptions against the providers' terms, and every platform resource owned by one id.
  Decided: Mend is the only login. Mend authenticates to Sealant as a service principal
  (`SEALANT_SERVICE_KEY`) and acts on behalf of each signed-in user under a Sealant user it
  provisions on first use (idempotent on email; mapping in `user_sealant_identities`). The platform
  principal is an Effect reference set per request (the caller) and per session fiber (the session
  OWNER — a collaborator reads a session's workspace as its owner); an unset principal is a typed
  failure, never a seed user. Users connect their own Claude / Codex / GitHub accounts from Mend
  (Settings on web and desktop, `mend connect`); secrets pass straight through and are never stored.
  Hot-pool skeletons are claimed only by their owner's sessions. The Sealant web app is not part of
  a Mend deployment. Details and consequences: `docs/SEALANT-IDENTITY.md`.

- **2026-08-21 — Sessions are worktrees; everything else is a process.** The engine's data model and
  status logic treated "the session" as "the agent PTY" (`sessions.sealant_session_id`, one watcher
  settling the row). Protocol-mode agents and multiplayer both need the session to be the worktree
  plus its record, with every way of interacting with it a process kind sharing one lifecycle.
  Decided: `session_processes.kind` ∈ `shell | agent-pty | agent-protocol | service`; agent rows
  carry `harness` and `provider_session_id`; harness state is harvested per agent process under
  `sessions/<id>/processes/<process-id>/` (older session-root captures still read); session status
  is a fold over live processes (agent live → running; supporting only → idle; nothing → settled
  from the last agent outcome), so the same per-process watcher ends agents, shells, and Service
  attempts; stop ends agent processes only; follow-ups and resumes are refused while an agent is
  live, not while shells hold the workspace. The API exposes `processes[]` and `currentAgent` on the
  session detail (and `currentAgent` on list annotations); the singular `sealantSessionId` stays as
  a mirror of the current agent's PTY until list readers migrate. `waiting` is reserved for protocol
  mode. Nothing here builds protocol mode.
- **2026-08-11 — One saved workspace profile, with runtime services distinct from packages.** Mend
  settings own the environment for workspace launches: OS family, portable package names, and
  explicit services. The initial profile is Arch with pnpm, Python + uv, mise for managed Node and
  Python versions, GitHub CLI, lazygit, bat, curl, jq, ripgrep, fd, and fzf; Docker is a service,
  not a package. Sealant builds the client into the image and supplies a disposable rootless daemon
  per workspace without mounting the host socket. Every harness requests the user's default GitHub
  connected account so `gh` receives `GH_TOKEN`. Mend may scan only an allowlist of executable names
  and fixed configuration paths on its host and suggest additions; it never enumerates or reads the
  user's home-directory contents. Observations are suggestions, not an automatic copy.

- **2026-08-14 — Git access: host-owned credentials, workspace shim.** Remote git never enters a
  workspace: the host owns clone/fetch/push with two per-project auth modes (ambient, or a
  Mend-generated deploy key whose public half the UI hands out), and plain `git push` inside a
  session works through a `GIT_SSH_COMMAND` shim that carries transport bytes over the session
  socket to the host — stock git, no credential in the container, host-side seam for per-user
  identity and audit/gating later. Hardware keys get an optional agent bridge (laptop
  reverse-forwards its ssh-agent; touch happens where the key is). Design and scorecard:
  `docs/GIT-ACCESS.md`.

- **2026-08-13 — Workspace images: prebuilt stays, custom bases planned.** Confirmed sessions reuse
  one cache-ordered image per os family (containers are per-session, images are not); sealantd is a
  fully static musl binary on `scratch`, so any Linux base can host a workspace. Direction:
  plan-hash build short-circuit, an ubuntu family, then `baseImage` custom images (sealant overlays
  one static binary + env + entrypoint) with a per-project three-field editor — base, packages,
  setup; not a compose editor (compose lives inside the workspace's docker sidecar). Facts and
  sequence: `docs/archive/WORKSPACE-IMAGES.md`, removed; see git history.

- **2026-08-10 — Resumed sessions retain every Sealant run.** A Mend session is the stable logical
  conversation, worktree, and change; each launch or settled-session resume creates an ordered
  Sealant run with its own sequence space and supervision cursor. Mend stores only that membership
  and stable record pointers — Sealant remains the raw-record owner. Checkpoints point to a hidden
  git ref plus `(Sealant run ID, sequence)`. Sessions migrated from the former single-run pointer
  are labeled as incomplete record history because overwritten run IDs cannot be reconstructed
  honestly.

- **2026-08-02 — Mobile adoption, discovered through the host's GitHub CLI.** Adoption joins the
  mobile capability set (§7.4): typing a clone URL on a phone was the real barrier, so the server
  asks its own `gh` for repositories to tap (`GET /api/github/status`, `GET /api/github/repos`, same
  auth middleware, args passed as a vector — user input never meets a shell). The credentials are
  gh's, not Mend's — no Mend-held GitHub token, and a host where `gh auth login` ran usually has
  private-repo clones already working. No new product noun: this is still adoption; discovery
  degrades honestly (a missing or signed-out gh is reported in the CLI's own words) and the
  typed-source form always remains. `POST /projects` stays blocking; the mobile client treats a
  dropped request as "clone continuing on the server" and watches the project list for the name
  rather than failing blind. If large clones make that feel bad in practice, the recorded follow-up
  is an adopting-state project row fed by the existing `mend_events` notify path. The web adopt form
  can reuse the discovery endpoints unchanged.

- **2026-08-01 — Browser access to session development services. Superseded in part 2026-08-20.** A
  development server remains part of its session, alongside the conversation, terminal, record, and
  change. The later Service decision replaces automatic detection and authenticated-link language:
  declarations are explicit, listener events may only suggest them, and raw forwards use the private
  network rather than Mend request authentication.

- **2026-07-25 — Execution model: central store, no host bind.** Agents never execute against the
  user's pre-existing checkout. Repositories are adopted into a Mend-managed store (bare repo plus
  per-session git worktrees); sessions run in managed Sealant workspaces that mount their worktree
  (§8.1.A). This settles the former open question about "the exact Sealant noun for persistent host
  attachment": there is no new noun — workspaces gain mounts. Consequences: the primary review
  object is the session worktree versus its base; concurrent sessions are supported structurally;
  every session write is supervised, so attribution is structural; BYO-agent identity rides the
  SDK's existing `credentials` and dotfiles options (present since 0.5.x).

- **2026-07-25 — Checkpoint policy.** Checkpoints are `(hidden git ref, Sealant run ID, record seq)`
  tuples taken at session start, command settles, adapter-known turn boundaries, review opens, and
  explicit user marks. Any two checkpoints define a reviewable slice: `refA..refB` for the diff and
  the ordered run-aware record span for the evidence (§5.6). Per-session worktrees make slices clean
  — no other session can interleave edits.
- **2026-07-25 — Machine review pass ("Mend reads the change").** Mend performs an inference review
  over settled changes, grounded in the record: draft comments with dispositions, never verdicts;
  every finding must link to the record or ship with a runnable check (the evidential noise filter);
  proposed checks discharge via verification runs. New milestone M2.5; details in §7.3. Revives the
  queue-era brief compiler inside the workbench review surface.

- **2026-08-01 — Dev-server preview: per-port TCP forwards, not an HTTP path proxy; amended
  2026-08-20.** An explicitly declared Service receives a host port bound to loopback and selected
  private interfaces. Mend pumps bytes to the workspace port over the SDK forward (§8.1.H). Path
  prefixes are rejected because they break absolute asset paths, HMR WebSockets, and cookies on real
  development servers. Raw forwards cannot enforce Mend authentication per request; the UI states
  that the private network is the access boundary. Transport does not imply browser behavior: HTTP
  or HTTPS must be declared before Mend shows Open. A typed public listener event may later produce
  an observed suggestion, never an automatic declaration or forward. Overtaken by
  [ADR 0017](adr/0017-live-preview.md).

- **2026-08-01 — Per-project extra mounts, read-only, review scope unchanged.** A project may
  declare additional host folders (sibling repos, an uncommitted experiments folder) mounted into
  every session workspace outside the working directory (e.g. `/workspace/home/<name>`), default
  read-only, per-folder explicit opt-in — never "mount everything" (sibling checkouts carry `.env`
  secrets). The review focuses on the repo in question: the reviewable change remains exactly
  worktree-versus-base; extra mounts widen what the agent can see, not what Mend reviews. The mount
  set is declared on the session record and listed in the operational-contract prompt. Needs §8.1.G.
  The "scratch files inside each worktree" sub-case has a no-platform-change alternative: a
  per-project seed folder copied into each worktree at creation and covered by the managed excludes
  (a symlink would dangle inside the container).

- **2026-08-01 — References: cloned dependency sources mounted read-only.** A new product noun,
  `reference`: an upstream repository cloned into the store (`_references/<name>`, shallow by
  default, refreshed manually or periodically) — not a project: no sessions, no worktrees, no
  adoption. A global list with per-project selection; selected references mount read-only at
  `/workspace/ref/<name>` (one shared clone serves concurrent workspaces safely). Where possible,
  pin the checkout to the version the project's lockfile declares, and record reference names + SHAs
  in the session manifest for reproducibility. The operational-contract prompt tells the agent:
  source for these dependencies is mounted under `/workspace/ref/`; read it before guessing APIs.
  References sit beside context packs, not inside them — packs are immutable snapshots, references
  are live clones with a per-session pinned SHA; a later bridge may let a context item point into a
  reference. Needs §8.1.G.

- **2026-08-30 — Sessions are (project, base ref, worktree); bases stay current.** The base a
  session starts from is part of its identity, not a launch flag: the requested ref (branch, tag, or
  sha — the project's default branch when nothing was chosen) is recorded on the session as
  `baseRef` beside the pinned `baseSha`, and every surface that names a session names its base (web
  lists and review header, CLI table and dashboard, mobile detail). The composer picks from the
  store's real branches (`GET /projects/:id/branches`) instead of a blind text field, on web and
  mobile alike. Bases also stay current: provisioning freshens the base ref from origin through the
  project's git auth before the worktree is created — best-effort by design, so an unreachable
  remote, a disconnected bridge signer, or plain offline work costs currency, never a session — and
  base resolution prefers `refs/remotes/origin/<ref>` over the store's own heads, which freeze at
  adoption. `POST /projects/:id/refresh` (`mend refresh`) fetches every origin branch into the store
  on demand; nothing is ever pruned (session branches live in `refs/heads`). This dissolves the
  duplicate-project-per-branch workaround; a per-branch default project remains possible but is no
  longer the mechanism.

## Open

1. Whether the final product keeps the name Mend.
2. Whether staged/unstaged hunk operations land in M2 or immediately afterwards.
3. Whether one instance supports multiple machines before or after the MVP.
4. Whether clean verification is automatic, suggested, or always manually triggered.
