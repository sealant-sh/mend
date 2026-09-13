# Platform feedback

Mend consumes the Sealant platform only through the public SDK (`@sealant/sdk`). When the SDK is
missing something Mend needs, it gets recorded here as feedback for the platform — never worked
around by importing internals.

Format: date · SDK version · what Mend needed · what exists today · suggested surface. Entries stay
after they ship, marked **Shipped**, so the dogfood trail stays readable.

## 2026-09-12 · 0.28.0 · Capture mode end to end on one machine: what the local proof found

`scripts/capture-e2e.sh` passed on this machine (Mend in capture mode, Core PR sealant#231 from
source, sealantd PR #71 baked into the workspace image, Garage as the bucket, a Docker executor with
no bind mount): adopt → session → capture 0 → launch (lease live 4.8 s) → an edit (first capture
registered 3.1 s later) → checkpoint (5.2 s) → the diff served "observed at capture 1" →
`docker kill` (settled "executor lost" 33.5 s later) → resume = pickup on a fresh executor (epoch 2
→ 3, 5.4 s) with the edit on its disk. It needed these platform-side changes, applied as LOCAL
uncommitted patches on a detached sealantd worktree for the proof — they are the asks:

- **sealantd, `crates/sealantd/src/boot/config.rs` `is_acceptable_secret_env_name`:** the secret env
  file rejects every `SEALANT_*` name, but the capture token is delivered in that very file as
  `SEALANT_CAPTURE_TOKEN` (Core `CAPTURE_TOKEN_SECRET_ENV_NAME`, sealantd `TOKEN_KEY`). Every
  capture boot fails with "entry \"SEALANT_CAPTURE_TOKEN\" is not an acceptable environment variable
  name". Exempt the daemon's own key (it is stripped from the harness env anyway).
- **sealantd, `crates/sealant-capture/src/gitpack.rs` `reflog_tips`:** a freshly materialised
  repository has no reflog, and `git rev-list --no-walk=unsorted --reflog` with nothing to walk
  exits with its usage text, so `seed_tips_from_repo` fails the boot on capture 0. An absent
  `.git/logs` is an empty tip set.
- **sealantd / ADR-0015 format:** the daemon's dir object is `{"entries": [...]}` (serde of
  `tree::DirObject`), and its materialiser fetches every class root by key — a `""` root is asked
  for as a URL. Mend now writes capture 0's empty workspace class as a real empty dir object in that
  form and reads both forms (`packages/store/src/captures.ts`). Fix the ADR text or the daemon so
  one form is canonical.
- **sealantd:** the staging directory `.sealantd/capture/` lives inside the worktree and its files
  land in the git index (`git status` in the executor shows `A .sealantd/capture/index/*.json`), so
  they appear in Mend's change diff as added files. The daemon's own directory must stay out of the
  index tree it snapshots.
- **Core, Docker runtime:** a killed container stays `ready` on the control plane (observed three
  minutes after `docker kill`; the expiry reaper handles TTL, stop intents and superseded runtimes,
  not death). Mend now confirms a live status with a one-shot exec before treating an expired lease
  as a paused executor (`engine.ts` `workspaceAlive`). A runtime-observed status (or an `inspect`
  surface on the SDK) would make the probe unnecessary.
- **Core, Docker runtime:** with the Docker service on, the executor joins a per-workspace network;
  with it off, the default bridge. Neither resolves `host.docker.internal` (no `--add-host`), and a
  Linux host firewall can drop bridge → host traffic — the endpoint and bucket URLs then need a
  relay. An `--add-host host.docker.internal:host-gateway` on the executor is the small ask; the
  firewall is the operator's.
- **SDK 0.28.0 (in addition to the entry below):** the facade lowers an unknown source kind to
  `{kind: "mount", hostPath: undefined}` and drops `captureToken`, and the 0.28.0 wire struct strips
  `captureToken` on encode — so Mend posts the capture create directly to `POST /v1/workspaces`
  (`client.ts` `postCaptureCreate`) until the SDK ships the source.

## 2026-09-12 · 0.28.0 · Capture workspace source: the SDK release Mend's capture mode waits on

- **Needed:** Mend's capture mode (docs/adr/0002-session-capture-store.md) launches executors with
  `workspaces.create({ source: { kind: "capture", endpoint, worktreeId }, captureToken })` and no
  mounts: the daemon fetches the head plan from Mend's session channel, materialises onto its own
  disk, claims the lease and ships captures back.
- **Today:** the published `@sealant/sdk` 0.28.0 types `CreateOptions.source` as `mount | standby`;
  Core PR sealant#231 (branch `feat/capture-workspace-source`) adds the `capture` source and the
  top-level `captureToken` (sealed into the boot env file as `SEALANT_CAPTURE_TOKEN`, beside
  `SEALANT_CAPTURE_ENDPOINT` / `SEALANT_CAPTURE_WORKTREE_ID`). Mend widens the create payload at ONE
  seam (`packages/sealant/src/client.ts`, `CaptureCreateOptions`) so it compiles against 0.28.0
  today; the control plane on that branch validates the shape. Release the SDK and the seam goes.
- **Also noted, sealantd PR #71 (`crates/sealant-capture/src/registrar.rs`):** the HTTP registrar
  sends the bearer token alone — no `x-mend-session-id` — so Mend's channel resolves the session
  from the token's hash. Mend's `plan.get` answers the `epoch` the executor must use (Mend claims
  the lease at launch) and `lease.heartbeat` answers 404 on a lost lease, as that client expects.
  Two asks for the runtime client: a `capture.now { kind: "checkpoint" }` control command reachable
  through the SDK (Mend currently waits one cadence window for the executor's own checkpoint
  capture, then derives the checkpoint on a runner), and a way for a standby (hot-pool) executor to
  be created before its worktree exists — a claim-later capture source — so the pool can
  pre-materialise the project base and the platform-matched dependency cache.

## 2026-09-05 · 0.28.0 · Volume-backed local deployments across Docker's VM boundary

**Shipped in Sealant 0.28.0**, following PRs #225 and #226. The published worker accepts
`SEALANT_DOCKER_VOLUME_MAPPINGS` and lowers existing path-based SDK requests to strict named-volume
subpaths. The containerized-launcher test passed on Linux with actual workspace control, Git,
read-only grants, staging, and persistence across controller replacement. Control directories are
retained to avoid deleting a concurrent retry's socket. Mend packaging and actual macOS/VS Code
acceptance remain separate work.

- **Needed:** the local Mend bundle runs its control plane inside one application container on
  Linux, Docker Desktop, or OrbStack. Workspaces must share selected store directories and Unix
  sockets through Linux-native volumes without a Mac process accessing those sockets. Mend keeps
  using the public SDK; users configure only Mend.
- **Original observation in Core 0.27.0:** `DockerRuntimeAdapter.buildControlSocketMountArgs`,
  `workspaceMountArgs`, and `extraMountArgs` emit host bind paths. Launch material staging returns
  paths that the adapter also binds. Replacing only the Compose host bind with a named volume does
  not translate those container-visible paths into daemon-visible sources. Mend's SDK inputs include
  standby roots, bare git metadata, its own session socket, harness homes, references, and
  linked-project roots, so fixing the platform control socket alone is insufficient.
- **Suggested contract:** a platform-owned, deployment-configured mapping of approved local
  directory roots to named volumes and relative subpaths, or an explicit public volume-source
  contract. Cover primary/standby sources, additional/bindable mounts, control sockets, and staged
  dotfiles/secrets. Enforce root containment, symlink/traversal checks, per-workspace subdirectory
  selection, permissions, read-only mounts, and cleanup. Preserve absolute git metadata paths. Do
  not require Mend to inspect Docker's private volume storage or mount an entire store into every
  workspace.
- **Acceptance:** a containerized SDK consumer launches a real workspace on macOS, exchanges
  control/session socket traffic, uses git and staged launch material, and survives application
  container replacement. Include a negative test proving one workspace cannot traverse to another
  workspace's ungranted directories. A generic Docker volume probe does not establish platform
  support. Test plan and current evidence: `docs/MACOS-VALIDATION.md`.

## ✅ 2026-09-03 · 0.27.0 · Workspace-scoped Docker on Kubernetes, refused at create where absent

**Shipped in Sealant 0.27.0 (sealant#223); Mend pins it and maps the refusal.** Mend sends
`services.docker: true` by default and the Kubernetes adapter refused it at launch, so the cluster's
Mend settings had Docker switched off and every project that needs compose or testcontainers was
blocked there.

Sealant now serves the service on Kubernetes when the operator enables it
(`workspaces.docker.enabled`): the same rootless `docker:*-dind-rootless` daemon as the Docker
adapter, as a sidecar of a **user-namespaced** workspace Pod (`hostUsers: false`), so its
`privileged` flag is privileged over the Pod's namespace only. The workspace gets
`DOCKER_HOST=unix:///run/docker/docker.sock`, and `forward({ host: "docker" })` keeps working (the
name resolves to the Pod's loopback, where nested containers publish). An install that cannot serve
it refuses `create` with `workspace-docker-unsupported` (422) — the capability probe this file asked
for on 2026-08-26, for this one capability. Mend maps it to a readable refusal in the session.
Documented limits: nested cgroup limits are ignored, the graph pulls cold per workspace, the store
filesystem must be idmap-capable (NFS is not).

## 2026-08-29 · 0.25.2 · One uid story for workspace-written store files

- **Needed:** Mend's engine reads workspace-written files server-side — the external-agent observer
  and the crash harvest read the mounted harness home as uid 1000. Workspace processes run as ROOT,
  and harnesses that tighten their own state (codex chmods `~/.codex` to 0700 and its files to 0600)
  make those files unreadable to the engine: NFS checks modes server-side, so no capability helps
  and only uid 0 passes — which PSS `restricted` on the control-plane namespace rightly forbids.
  Observed live: a codex conversation running in a workspace was invisible to the observer until the
  modes were opened by hand.
- **Today:** Mend ships a workspace-side countermeasure — the relocate boot script starts a detached
  root "mode keeper" loop that re-opens `go+rX` on the harness home every 15s, and the observer
  warns (once per session+harness) when a harness home is unreadable instead of going silently
  blind.
- **Suggested:** a single uid story at the platform layer, either: run workspace processes as a
  fixed non-root uid matching the store consumers (1000), or export the store share with
  `all_squash`+`anonuid` so every writer maps to one owner. Either retires the chmod loop and makes
  crash harvests of tightened state dirs reliable.
- **2026-08-30, it bites the other direction too:** the workspace mounts the project's bare repo (a
  linked worktree's real gitdir), and a ROOT-side `git gc --auto` from ordinary agent activity left
  `packed-refs` and `refs/heads/mend/` root-owned — the engine (uid 1000) could no longer create
  session refs and every provision on the project failed until a root chown. Mend now sets
  `core.sharedRepository=group` + setgid trees on its stores as a countermeasure (docs/BUGS.md
  2026-08-30), but that protects only git-created files; the one-uid story retires the whole class.

## ✅ 2026-08-28 · 0.24.1 · Workspace SSH is invisible to the SDK: no gateway discovery, no key registration

**Shipped in 0.25.0** ([sealant#214](https://github.com/sealant-sh/sealant/pull/214)) —
`sealant.workspaceSsh.info()` and `sealant.sshKeys.ensure/list/remove`; Mend consumes them via
`/api/workspace-ssh`, `mend ssh setup`, and the extension's one-dialog setup (docs/WORKSPACE-SSH.md
phase 1). Still open: SSH attachments hold no lease the engine can see (phase 3); phase 2's
short-lived certificates would retire registration entirely.

**Plan:** `docs/WORKSPACE-SSH.md` (2026-08-29) — phase 1 closes this entry (discovery + self-service
keys + SDK surface), phase 2 replaces registration with short-lived SSH certificates, phase 3 makes
gateway attachments visible as leases.

**2026-08-31 addendum:** attachment visibility would also serve mode handoff — picking a session up
from the phone ends a TUI another terminal may have open; live-attachment counts on the session
would let clients confirm honestly ("a terminal is attached — take over?") instead of relying on the
handed-off row's summary after the fact.

- **Needed:** Mend's VS Code extension opens a session's workspace over the Sealant workspace SSH
  gateway (`ws-<workspaceId>@<gateway>`), which needs three things Mend cannot obtain through the
  SDK: the gateway address (host/port/username prefix — deployment config the platform already
  holds), a way to register the user's SSH public key (so the gateway can resolve the principal),
  and ideally the workspace's SSH reachability so the UI can degrade honestly. Separately: an SSH
  attachment (VS Code, plain `ssh`) holds no lease Mend can see, so a workspace with an editor
  attached but no Mend process can be reaped underneath it.
- **Today:** the core API has `sshKeys` (create/list/resolve-principal) and
  `GET /v1/workspaces/:id/ssh-target` (gateway-token-guarded), but none of it reaches
  `@sealant/sdk`. Mend ships a manual `mend.workspaceSshGateway` extension setting and points users
  at Sealant for key registration.
- **Suggested:** expose on the SDK a read of the deployment's workspace SSH entry point (address +
  username prefix, nothing secret), an `sshKeys.create`/`list` surface so Mend can offer "register
  this machine's key", and surface live SSH attachments (count or last-activity) on the workspace so
  consumers can treat an attached editor as a lease.

## 2026-08-28 · 0.24.1 · Runs stuck `running` after workspace pod death; worker retry storm starves new runs

- **Needed:** when a workspace's pod dies (observed: OOMKilled at the memory limit), the run backing
  a Mend session must transition to a terminal status so Mend can show the session as ended and
  allow relaunch. Two sessions sat "running" for 40+ minutes after their pods were killed.
- **Today:** nothing reconciles run status against pod state on the k8s adapter. The worker's
  telemetry ingester retries the control-WSS handshake to the dead pod IP in a tight loop (~10s
  timeout, immediately re-queued) forever; while it does, freshly created runs fail after 15s with
  "Telemetry ingester never attached; is the worker running?" — the retry storm starves new work.
  The same unbounded growth pattern is the likely cause of the api's Node heap OOM crash (exit 139
  after ~17h). Recovery required manually PATCHing the runs to `failed` via `updateRun` and
  restarting the worker.
- **Suggested:** a pod-informer (or periodic reconcile) in the k8s adapter that flips runs to
  `failed` with the pod's termination reason (`OOMKilled`, exit code) when the workspace pod reaches
  a terminal phase; a retry budget/backoff on telemetry ingest so one dead workspace cannot starve
  the ingest pool; and surface the termination reason on the run so Mend can show "workspace ran out
  of memory" instead of a silent hang.

## 2026-08-26 · 0.23.0 · Hosted strategies: a non-mount workspace source + capability reporting

- **Needed:** the `cloudflare-hosted` deployment strategy (docs/DEPLOYMENT-STRATEGIES.md) runs
  workspaces where no host path exists, so Mend cannot launch with
  `workspaces.create({ source: { kind: "mount", path } })`. It needs (a) a workspace source that
  hands the platform the authority by reference — a clone URL plus ref with short-lived auth, or a
  restore-from-checkpoint handle — and (b) visibility into the selected runtime family's
  capabilities (raw TCP forwards, disk ceiling, DinD) so the UI can degrade honestly instead of
  discovering gaps at runtime.
- **Today:** `create` takes `mount` (host path) or `git` sources; Mend's engine uses `mount`
  exclusively and treats co-location as a launch requirement. The platform's `supports()` refusals
  surface only as launch-time `unsupported-runtime` errors, not as queryable capabilities.
- **Suggested:** keep `git` sources first-class for hosted launches with a per-launch token (the
  existing secret env channel shape), add a checkpoint-restore source kind once the hosted authority
  design lands, and expose a `capabilities` read alongside workspace creation (per runtime family)
  mirroring what the runtime adapters' `supports()` already knows.

## 2026-08-22 · 0.22.0 · Installer: a no-web mode Mend can delegate to

- **Needed:** Mend's one-line installer (`install.sh`) brings up Sealant as its control plane and
  replaces the Sealant web app with Mend (docs/SEALANT-IDENTITY.md). It wants to hand that part to
  Core's installer and only layer Mend on top.
- **Today:** `install.sh` in Core always pulls and starts `sealant-web`, waits on its port, and
  writes only the four original secrets. So Mend's script re-implements the Sealant half: same
  install dir, compose asset/raw URLs, version precedence and `.env` helpers, but it pulls
  `api`/`worker`/`ssh-gateway` only, starts with `--scale web=0`, and additionally writes
  `SEALANT_SERVICE_KEYS` (one `slt_svc_` key, generated once), `SEALANT_CREDENTIALS_KEY` (32 raw
  bytes base64) and `SEALANT_MOUNT_ALLOWED_STORE_ROOTS` (merged into any existing colon list). Two
  copies of that logic will drift — the legacy `~/.sealant` merge is already simplified on Mend's
  side.
- **Suggested:** `SEALANT_NO_WEB=1` (or `SEALANT_SERVICES=…`) in Core's installer that skips the web
  image, starts with `--scale web=0` and skips its health wait; generate `SEALANT_SERVICE_KEYS` and
  `SEALANT_CREDENTIALS_KEY` the way the other secrets are generated; accept
  `SEALANT_MOUNT_ALLOWED_STORE_ROOTS` as a merge-in setting. Mend's installer would then become
  `curl get.sealant.dev | SEALANT_NO_WEB=1 sh` plus the Mend-specific steps.

## 2026-08-20 · 0.19.0 · Codex inference: naming sessions on whichever sub the user has

**Implemented at the source** — [sealant#181](https://github.com/sealant-sh/sealant/pull/181)
(pending review/release): a codex inference engine (official Codex CLI against a private
per-invocation `CODEX_HOME`, rotated auth.json persisted newest-wins), provider routing, and the
lifted "Codex inference is not supported yet" 400. Tool-less v1: caller tools stay claude-only.

- **Needed:** session auto-naming runs a cheap mechanical pass on the user's own sub — Haiku over a
  connected claude account, the cheap OpenAI model over a connected codex account. Mend now sets
  `model` on `inference.respond` (always plumbed, never used before) and picks the provider per
  attempt: claude first, codex when no usable claude account exists.
- **Today (0.19.0):** `credentials.codex` is accepted by the SDK types but rejected with a 400 at
  the endpoint; only a claude engine exists. Mend's codex arm compiles and fails like any
  account-less attempt — sessions of codex-only users stay unnamed until the platform release.
- **Suggested (still open):** an account-existence probe. The SDK offers no way to ask which
  providers have connected accounts, so Mend infers "no claude account" from error text
  (`connected account` / `reconnect`) — a listing (or a structured error code on the inference
  surface) would make the fallback exact.

## 2026-08-20 · 0.19.0 · PTY attachment output has no resumable cursor

- **Needed:** server-authoritative terminal restoration and duplicate-free reconnect. Mend needs to
  persist the last output position a client rendered as a decimal sequence, then resume from it
  after tab switches, app restart, or network loss.
- **Today:** `session.attach({ from })` accepts a starting record sequence, but `attachment.output`
  emits raw byte chunks with no sequence or cursor. After attachment begins, the client cannot know
  which durable position a chunk represents. Reusing the old `from` value replays duplicate
  scrollback; advancing it is guesswork. This also prevents an honest read-only live log stream from
  sharing the same resume contract.
- **Suggested:** emit sequence-addressed output frames, for example `{ sequence, data }`, or expose
  an acknowledged attachment cursor that advances only after complete frames. Include the terminal
  end position and keep the value bigint-safe at the SDK boundary.

## 2026-08-20 · 0.19.0 · No record-head read or cross-run checkpoint barrier

- **Needed:** a git checkpoint records the latest Mend-observed position for every active
  coding-agent, shell, and Service attempt. Review can then bound evidence across concurrent runs
  without attributing a shell write to the coding-agent run.
- **Today:** `run.record.stream({ from })` and `timeline({ from })` expose resumable reads, but the
  public SDK has no cheap `record.position()` or workspace-level barrier. Polling each stream around
  a git snapshot produces several observation times, not one atomic frontier.
- **Suggested:** first expose the latest durable position for one run. If the platform can provide a
  workspace barrier, return the run-to-sequence set observed at that barrier. Mend will otherwise
  store each latest position and label it `latest Mend observed`, never an exact cross-run barrier.

## 2026-08-20 · 0.19.0 · Interactive process launch has no client idempotency key or durable correlation

- **Needed:** follow-up delivery must survive client timeout and Mend restart without starting a
  second coding-agent run. A retry needs to identify the PTY process created for one exact edited
  instruction.
- **Today:** the public interactive-session start path accepts argv but no client idempotency key or
  caller correlation metadata that can be queried later. Mend's existing `attemptId` is a workspace
  attempt foreign key, not a client key, and the wire operation carries no idempotency header.
- **Suggested:** accept a caller idempotency key and correlation metadata when opening an
  interactive process, persist them with the process and run, and provide lookup by key. Repeating
  the request should return the same process and run rather than start another one.

## 2026-08-20 · 0.19.0 · Warm pools must pre-bind everything: no standby workspaces, no re-pointable mounts

- **Needed:** instant session attach. Mend now keeps a per-project pool of ready workspaces ("hot
  sessions"): a new session claims one and goes straight to `sessions.open`.
- **Today:** every create-time input is fixed at `workspaces.create` — `source.path`, `mounts`,
  `env`, `secretEnv`, `dotfiles`, `credentials`, image, packages — and `Workspace` has no mutation
  surface (`restart()` reuses the stored spec). So a pooled workspace must be pre-bound to a real
  worktree and session socket dir, which forces Mend to pre-provision complete session skeletons
  (pre-generated session id → worktree → socket → workspace) and to drain the pool whenever any
  input changes. Two costs follow: **resumes can never be served hot** (a resume is bound to its
  existing worktree path), and every configuration change burns and rebuilds containers instead of
  re-binding one.
- **Suggested:** either a standby shape (`workspaces.create` without a source, with the mount bound
  at first use) or a re-point operation on a live workspace's primary mount. Independently, the
  plan-hash build short-circuit (docs/WORKSPACE-IMAGES.md direction item 1) compounds with any pool
  by making the rebuild half of drain-and-rewarm cheap.

## 2026-08-20 · 0.19.0 · Nix-family workspace images cannot boot: `sealantd` is not on the base image's PATH

**Implemented at the source** — [sealant#180](https://github.com/sealant-sh/sealant/pull/180)
(pending review/release): absolute `ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]` +
`ENV PATH=/usr/local/bin:$PATH` in both render paths. Plan hashes rotate once on upgrade.

- **Needed:** a session workspace built with `os: "nix"` — the option the image picker offers.
- **Today:** the build succeeds, but the container dies at init:
  `exec: "sealantd": executable file not found in $PATH`, and the workspace reaches terminal
  `failed` before ready (Mend surfaces it as a launch failure with no cause). The rendered
  Containerfile copies the binary to `/usr/local/bin/sealantd` and then sets
  `ENTRYPOINT ["sealantd", "boot"]` — exec form with a bare name, resolved against the image's
  `ENV PATH`. `nixos/nix`'s PATH is only the nix profile dirs (no `/usr/local/bin`), and the builder
  never emits its own `ENV PATH` (Core `packages/workspaces/src/buildkit/buildkit-builder.ts`, both
  `renderContainerfile` and `renderCustomBaseContainerfile`). Verified against a live-built session
  image. Fedora/arch/ubuntu bases include `/usr/local/bin`, which is why only nix trips it; a custom
  base with a nonstandard PATH would hit the same wall.
- **Suggested:** `ENTRYPOINT ["/usr/local/bin/sealantd", "boot"]` in both render paths, plus
  `ENV PATH=/usr/local/bin:$PATH` so in-container name lookups also resolve — sealantd's dotfiles
  manager auto-detection does its own `$PATH` search (`boot/dotfiles.rs which()`), and the docker
  CLI / socat copies land in `/usr/local/bin` too. A boot smoke test per os-family would have caught
  this: nix was in the picker but had never booted since the sealantd-PID-1 cutover.

## 2026-08-14 · 0.17.0 · Dotfiles were SDK-unreachable; archives added as the transport

**Implemented at the source** — sealant-sh/core stack #167 (PRs #163–#166) + sealantd stack #52 (PRs

# 50–#51), pending review/release as 0.18.0

- **Needed:** the user's own environment (shell, dotfiles) in every session workspace, with private
  repos reachable through the host's own ssh identity (agent, hardware keys) — never a credential in
  the container.
- **Today (0.17.0):** the platform implements dotfiles end to end (web UI → blueprint → build/boot),
  but `CreateOptions` exposes neither dotfiles nor `customization.defaultShell`, while the SDK docs
  claim "credentials and dotfiles options compose". The wire shape is GitHub-App-only.
- **Shipped at the source:** `dotfiles: { repository?, archives? }` and `shell` on
  `workspaces.create`. Archives are the per-user transport: Mend keeps a dotfiles store (a bare git
  repo per account under the store root) whose snapshots are captured on the machine that HAS the
  files (`mend dotfiles sync`, web upload — the server's own home is never read; it may be a VPS
  service account), packs the owner's repo + snapshot as gzipped tars at launch, and `sealantd boot`
  applies them before the control socket binds. Also fixed on the way: client-supplied `authRef`
  validation (unauthorized-token + host-file-read holes), chezmoi provisioning on ubuntu (not in the
  24.04 archive), dotfiles ref no longer assumes `main`, no token minting for a disabled apply, and
  boot's control socket now binds only after dotfiles so credential file injection can't be
  clobbered.
- **Still open (noted, not urgent):** in-container ssh clone for standalone (non-Mend) private
  dotfiles repos remains GitHub-App/https-token only; URL-based build-apply dotfiles go stale under
  plan-hash reuse (runtime/archive paths are immune); `dotfilesTarget: "config"` is honored only by
  the copy manager while the web UI offers it for all.

## 2026-08-12 · 0.13.1 · One workspace image with every baked harness

**Implemented at the source** — [sealant#148](https://github.com/sealant-sh/sealant/pull/148)
(pending review/release). Mend's shell resume restores a session's saved harness state AND lays the
conversation down converted for the other supported agent, so the user can open codex or claude
natively from inside the shell. Per-harness images made that pointless: a codex image had no
`claude` binary. The platform now bakes codex + claude-code into every image (opencode rides as an
extra when a blueprint asks for it) and injects `SEALANT_HARNESS_BANNER` /
`SEALANT_HARNESS_LAUNCH_COMMAND` at launch instead of baking them, so harness identity is a launch
fact and one image serves all of it. Mend needs no SDK change; the behavior arrives with the next
platform release.

## 2026-08-12 · 0.13.1 · `session.signal()` fails at the daemon; exit code lost on clean exit

Mend's session-Services design (docs/SESSION-SERVICES.md) needs to deliver signals to supervised
processes that no client terminal owns — `mend service stop` is a SIGTERM/SIGINT to a process the
user may never have attached to.

**2026-08-31 addendum:** mode handoff (cross-mode session pickup) would also prefer
SIGTERM-then-wait when taking over a TUI — a signal lets the harness flush its transcript before the
replacement process resumes it; today the takeover closes the PTY and relies on the harness's
incremental writes.

Observed against the deployed platform (SDK 0.9.0 and 0.13.1 behave identically except where noted),
with two concurrent `bash -i` PTYs in one mount-sourced workspace:

- `session.signal(2)` on a running interactive session rejects with
  `SessionBadGatewayError: Daemon request failed: proc_<id>_<n>`. The process is alive and healthy —
  sending a raw `\x03` byte through `session.send()` interrupts the foreground child correctly, so
  the PTY input path works while the out-of-band signal path does not. Mend can fall back to control
  bytes for terminal-owned processes, but that only covers signals with a control-character encoding
  and only reaches the foreground process group.
- On 0.13.1, a session that ends via a clean `exit` reports `status: "exited"` with
  `exitCode: undefined`; 0.9.0 reported `exitCode: 0` for the same sequence. Services surface exit
  codes to the user ("exited · code 0"), so the observed code should survive the wire.

**2026-09-06 packaging observation, SDK/runtime 0.28.0:** a real installed `mend run -- sh -c …`
created a workspace, committed a file, and settled with a completed session, an exited process,
three checkpoints, and a null process exit code. This is Mend's recorded observation, not a direct
reproduction of the older `sessions.get()` result. The public SDK still makes
`InteractiveSessionStatus.exitCode` optional. Mend's watcher preserves zero with `?? null`; its
first-observer-wins settlement can also retain an earlier unknown value. We have not established
that a later numeric result existed in this run. Packaging acceptance checks the file, commit,
record marker, checkpoints, and observed process end independently. It rejects an observed nonzero
code and reports null as unavailable, never as zero. Retaining terminal exit evidence in the public
status/record remains useful platform work; no platform internals are used to fill it.

Everything else the concurrent-PTY spike checked passed on both versions: two PTYs open concurrently
in one workspace, independent output streams, shared filesystem and network between PTYs,
independent close, `sessions.get()` reattach, and resize.

## 2026-08-11 · 0.13.1 · ✅ Public Effect surfaces share the consumer runtime

**Shipped in 0.13.1.** The 0.13.0 packages declared an exact Effect runtime dependency, so Mend
installed both its catalog-pinned Effect version and the SDK's older copy. Values crossing
`@sealant/sdk/effect` and `@sealant/api-contracts` then failed TypeScript compatibility even though
the APIs were otherwise compatible. Both public packages now declare Effect as a compatible peer, so
Mend and the SDK use one runtime and the Effect-native public API composes without casts or an
internal import.

## 2026-08-11 · 0.13.0 · ✅ Workspace-scoped Docker service shipped

**Implemented at the source; Mend adopts it when 0.13.0 is published.** Mend's workspace profile
needs some tools installed in the image and others provisioned by the runtime. In particular,
installing a Docker package is not enough: the client needs a daemon, and mounting the host Docker
socket would give a workspace host-equivalent control.

Sealant now exposes `workspaces.create({ services: { docker: true } })`. The image receives a static
Docker client, while the Docker runtime adapter launches a disposable rootless daemon on a private
per-workspace network and injects `DOCKER_HOST`. It never mounts the host socket. A Docker-backed
end-to-end test proves the workspace can run a nested container. Mend passes this option only
through the public SDK, alongside `os`, portable package names, and the user's GitHub connected
account.

## 2026-08-09 · 0.9.0 · Scrollback serves the PTY stream; the SDK's IoStream type hides it

**Corrected the same day it was filed** — the first version of this entry claimed PTY output was
unreachable through the record read surface. Wrong: the control plane serves it fine; only the SDK's
type surface hides it.

**What Mend needed.** "Mend reads the change" (plan §7.3) reviews a settled session against its
record. For a TUI session (`mend claude`), the agent's visible work — its reasoning, the commands it
narrated, the checks it showed — lives in the PTY stream.

**What exists today.** `GET /v1/runs/:id/scrollback?processId=…&stream=pty` returns the byte-exact
PTY content (verified live: 154KB for a real session run). But the SDK types
`scrollback(processId, stream)` with `IoStream = "stdout" | "stderr"` — no `"pty"` — so no typed
caller can ask for the stream that matters most for TUI runs, and the natural probe ("try stdout")
returns 0 bytes with no hint that a third stream exists. Mend bridges with one commented cast in its
client wrapper.

**Suggested surface.** Widen `IoStream` to `"pty" | "stdout" | "stderr"` (the server already accepts
it) and mention in the `scrollback` doc that PTY-backed processes ride `"pty"` — a types-and-docs
release, no server change.

## 2026-08-01 · 0.8.1 · Plural mounts with read-only — the plan's original shape, plus `:ro`

**Implemented at the source** — [sealant#120](https://github.com/sealant-sh/sealant/pull/120)
(pending review/release): `CreateOptions.mounts` → `spec.sources.mounts` → `-v host:container:ro`,
same allowlist, container paths checked against the working directory and `/run/sealant`, recorded
on the attempt snapshot. No sealantd change needed (the daemon verifies only its primary mount
contract). The PR also fixes the 2026-07-25 allowlist env-name drift (the SDK doc now names
`SEALANT_MOUNT_ALLOWED_STORE_ROOTS`).

- **Needed:** two decided features (plan §17, 2026-08-01) — per-project extra mounts (sibling repos,
  experiments folders) and reference clones of dependency sources — both mount additional host
  directories into a workspace beside the primary worktree, read-only by default. Read-only is
  load-bearing: it keeps the reviewable change exactly worktree-versus-base and lets one shared
  reference clone serve many concurrent workspaces.
- **Today:** `CreateOptions` takes exactly one `source: { kind: "mount", path }`, always read-write,
  at the working directory. No `mounts` array anywhere in the blueprint (`workspace-blueprint.ts`
  has a single-source union; `sources.inputs` is git-URL build inputs, not runtime binds), and the
  docker adapter never emits `:ro` (`workspaceMountArgs`, docker-runtime-adapter.ts). Plan §8.1.A
  originally asked for `mounts: [{ path, source }]` plural; the singular shipped.
- **Suggested:** `mounts: [{ hostPath, mountPath, readOnly }]` for additional mounts (primary source
  semantics unchanged), `:ro` in the docker adapter, allowlist coverage for the extra roots, and the
  full mount set recorded on the workspace so a consumer can state what the agent could see. Full
  shape: plan §8.1.G.

## 2026-08-01 · 0.8.1 · `openForward` exists in the daemon but has no API/SDK surface

**Implemented at the source** — [sealant#151](https://github.com/sealant-sh/sealant/pull/151)
(pending review/release): `workspace.forward(port)` returns a duplex byte stream over one held
WebSocket (`GET /v1/workspaces/:id/forward?port=N`, scope `workspace:exec`), host fixed at loopback,
`{"t":"eof"}` carrying TCP half-close, nothing-listening = HTTP 502 pre-upgrade. The listen/unlisten
observation follow-ons below remain platform futures Mend does not need for the explicit-declaration
Services design.

- **Needed:** dev-server preview (plan §8.1.H / §17, 2026-08-01): a browser on the host or on a
  paired device reaches a server listening inside a workspace container. Mend terminates a host
  listener on private interfaces and needs a byte pipe to `container:port`.
- **Today:** the primitive is fully built in sealantd — `openForward`/`closeForward`
  (`sealant-protocol` command.rs, `sealant-network` forward.rs: direct-tcpip from inside the
  container, raw conduit bypassing the telemetry bus) — but its only consumer is the SSH gateway's
  `direct-tcpip` handler. Zero surface in the Core HTTP API or `@sealant/sdk`; workspace containers
  run on the default bridge with no published ports, so there is no other sanctioned path in.
- **Suggested:** a public SDK surface, e.g. `workspace.forward(port)` returning a duplex byte stream
  (WS-bridged like `session.attach`). Two follow-ons that complete the feature: sealantd observing
  listening sockets (it is PID 1) and emitting typed listen/unlisten record events so ports are
  discovered by observation, and a record event when a forward opens (the fact, not the bytes) so
  reachability stays on the evidence trail.

## 2026-07-25 · 0.7.1 · Worker needs `SEALANT_CREDENTIALS_KEY` too — released compose only gives it to the api

- **Needed:** a claude-harness workspace with connected-account credentials, on a self-host install.
- **Today:** in 0.7.x the worker decrypts credential refs at build time, but the released compose
  sets `SEALANT_CREDENTIALS_KEY` only on the api. The build fails with
  `credentials-key-unconfigured` (an excellent, actionable error — keep that). Local compose patched
  to pass the same key to the worker.
- **Suggested:** add the key to the worker service in the released compose.

## 2026-07-25 · 0.7.1 · Sealantd's secret scrub ate the platform's own credential injections (fixed in sealantd 0.6.1)

- **Needed:** the injected `CLAUDE_CODE_OAUTH_TOKEN` visible inside harness/PTY processes.
- **Today:** Core injects connected-account credentials as container env
  (`planCredentialInjections`), but sealantd's boot passthrough dropped every secret-looking key
  before spawning harness children — so builds succeeded and the harness still launched
  credential-less. Codex only worked because its injection is a file (`~/.codex/auth.json`). Fixed
  at the source in sealantd#38 (v0.6.1): the documented contract keys survive the scrub, plus a
  generic `SEALANT_HARNESS_ENV_KEYS` declaration for future providers. Local worker pinned via
  `SEALANT_SEALANTD_IMAGE` until Core bumps its default (`buildkit-builder.ts` pins 0.6.0).
- **Suggested for Core:** bump the sealantd pin to 0.6.1, and set `SEALANT_HARNESS_ENV_KEYS` in the
  runtime adapter whenever it plans env-kind credential injections, so the next provider needs no
  daemon release.

## 2026-07-25 · 0.7.1 · Env-injected claude credential doesn't authenticate the interactive TUI

- **Needed:** `mend claude` dropping the user into an authenticated Claude Code TUI.
- **Today:** with sealantd 0.6.1 the injected `CLAUDE_CODE_OAUTH_TOKEN` reaches the harness and
  headless `claude -p` authenticates with it — but the interactive TUI's first-run onboarding
  ignores the env var and still shows "Select login method". Verified fix: seed
  `~/.claude/.credentials.json` (claudeAiOauth shape, accessToken from the env) plus
  `~/.claude.json` `{"hasCompletedOnboarding":true}` before launch — the TUI then opens straight to
  the trust-folder dialog, authenticated. Mend's session engine now wraps claude launches in exactly
  that seed (guarded: only when the token is present and no state file exists).
- **Suggested:** make the claude injection file-kind like codex's `auth.json` — write both files in
  `planCredentialInjections` — so every consumer gets an authenticated TUI without knowing Claude
  Code's onboarding internals.

## 2026-07-25 · 0.7.0 · Mount allowlist env name drift: docs say one name, the server another

- **Needed:** enable mount-sourced workspaces on a self-host install.
- **Today:** the SDK's `WorkspaceMountSource` docs name `SEALANT_WORKSPACE_MOUNT_ALLOWED_ROOTS`; the
  0.7.0 api rejects with "set `SEALANT_MOUNT_ALLOWED_STORE_ROOTS`". Setting both works.
- **Suggested:** pick one (and add it to the released compose with a commented example).

## 2026-07-25 · 0.8.1 · ✅ Terminal data plane shipped: WS attach, held daemon connection, ~1ms echo

**Adopted immediately.** The per-request session verbs made a keystroke cost auth + DB + 3 HTTP
calls + a fresh `docker exec` spawn, with echo riding a 250ms journal poll — measured 100–300ms+ per
keypress. Fixed at the source (sealant#116/#118, v0.8.0/v0.8.1): `GET /v1/sessions/:id/attach`
upgrades to a WebSocket, auths once, holds ONE daemon connection, and bridges the daemon's reliable
attach channel; SDK surface `session.attach({from})`. Mend's `/api/tty` is now a WS bridge over it
and the CLI holds one socket. Measured through the full chain (CLI wire → Mend WS → SDK attach WS →
api → held daemon connection → PTY `cat` → back): **median 1.0ms, p95 1.4ms, max 4ms, 10KB paste
3.5ms** (n=30). The `docker exec` spawn moved to once per attach. Remaining follow-ups: the api
still reaches the daemon via docker-exec (socket-dir transport needs `SEALANT_ALLOWED_PEER_UIDS`
parsing in sealantd — currently unimplemented there — plus the worker passing the allowlist env),
and the SSE/polling output route is now legacy for terminals.

## 2026-07-25 · 0.7.0 · Session transport in the api is docker-exec only — and the failure is a process crash

- **Needed:** `POST /v1/sessions` working on the released compose topology.
- **Today:** the api's only wired transport is `SealantRuntimeDockerExecLive`
  (`docker exec -i <container> socat - UNIX-CONNECT:/run/sealant/control.sock`), but the api image
  has no docker binary and the compose gives it no socket — and the spawn failure escapes as an
  unhandled `error` event that **kills the api process** (clients see "other side closed"). The
  ssh-gateway already solves this exact reachability problem with the shared read-only
  `/run/sealant/sockets` dir and no Docker access. Local unblock (patched into `~/.sealant`): mount
  a static docker CLI + `/var/run/docker.sock` + `group_add` the docker gid into the api — which
  grants the api host-root-equivalent power the gateway design deliberately avoids.
- **Suggested:** a socket-dir transport for the api like the gateway's (unix-connect via
  `/run/sealant/sockets`, no Docker), and guard the spawn path (`child.on("error")`) so a missing
  binary is a 502, never a process exit.

## 2026-07-25 · 0.7.0 · A PTY session's run never settles after the session exits

- **Needed:** supervision keyed on `run.wait()` / the record settling when the session's process
  exits — a session IS backed by a run, per the model.
- **Today:** the record faithfully carries `exit code=0`, but the run keeps emitting
  `runtimeHeartbeat` indefinitely and `run.wait()` never resolves; `GET /v1/sessions/:id` does
  report `status: "exited"`. Mend works around it by polling session status and settling from there
  (double-settle-guarded), keeping `run.wait()` as a backstop.
- **Suggested:** settle the session's run when the PTY exits (or document that session runs are
  workspace-lifetime and the session status is the authoritative lifecycle).

## 2026-07-25 · 0.7.0 · Mount + credentials: the worker's blueprint parser rejects the combination

- **Needed:** `mend claude` / `mend codex` — a mount-sourced workspace with the caller's connected
  account attached, exactly as the SDK documents ("Credentials and dotfiles options compose
  unchanged" on `WorkspaceMountSource`).
- **Today:** `workspaces.create({ source: { kind: "mount" }, credentials: { claude: true } })`
  queues a build job the worker kills at `parseWorkspaceBlueprint` — ZodError
  `Unrecognized key: "credentials"` — and the workspace reaches `failed` before ready. Without
  `credentials` the same create works. Mend currently omits credentials on launch (harness auth is
  interactive inside the PTY) until this lands.
- **Suggested:** accept the credentials key in the mount blueprint path — or if it is genuinely
  unsupported there, reject at CREATE time with a clear message instead of a failed build job.
- **Root cause (found in Core source):** the 0.7.0 SDK folds `credentials` into `spec.credentials`
  (`sdk/dist/internal/blueprint.js`); the api resolves it into `runtime.credentialRefs`
  (`apps/api/src/routes/workspaces/workspaces.module.ts` ~L1146:
  `body.credentials ?? resolvedSpec.credentials`) **but never removes `credentials` from
  `resolvedSpec`** before persisting the spec for the build job — so the worker's strict
  `parseWorkspaceBlueprint` (`packages/validators/src/workspaces/workspace-blueprint.ts`,
  `z.strictObject`) rejects the root-level key. One-line fix: strip `resolvedSpec.credentials` after
  resolving refs, plus a regression test for create-with-credentials reaching a green build.

## 2026-07-25 · 0.7.0 · ✅ What shipped works — mounts, PTY journal, and file events, verified live

**Adopted immediately** — noting the wins so the trail is honest: `source: {kind:"mount"}`
bind-mounted a store worktree
(`sealantd::boot::mount: "caller-owned mount; clone skipped, contents are never touched"`), writes
persisted after exit; `sessions.open` PTY ran with byte-exact sequence-keyed output; and the record
carried **fileChange events** for the PTY's writes — the 2026-07-08 file-watch gap is fixed for
mounted workspaces.

## 2026-07-25 · 0.5.2 · Workspaces sourced from a caller-provided mount (persistent store worktrees)

- **Needed:** the agent-workbench direction (`MEND-AGENT-WORKBENCH-PLAN.md` §8.1.A) keeps all
  repositories in a Mend-managed central store on the machine (bare repo + one git worktree per
  session) and runs every session in a managed workspace that mounts its worktree. This needs
  workspace creation from a mount instead of a fresh clone: writes land on the store worktree and
  persist after the workspace stops; the workspace never reprovisions or deletes the mounted source;
  record/exec/control semantics stay identical to clone-based workspaces.
- **Today:** `CreateOptions` only takes `repository` (a remote to clone) + `ref` — the workspace
  owns its copy and the work product dies with the container unless pushed. There is no volume/mount
  concept anywhere in the SDK surface.
- **Suggested:** extend workspace creation with a mount source — e.g.
  `workspaces.create({ mounts: [{ path, source }] })` or `source: { kind: "mount", path }` as an
  alternative to `repository` — with the mounted directory treated as caller-owned (persists across
  workspace stop/delete, never cleaned). This deliberately reuses the workspace noun; no new "host
  attachment" primitive is wanted. Clone-based workspaces remain correct for independent
  verification.

## 2026-07-25 · 0.5.2 · Interactive session lifecycle is a Phase-3 stub, and too small for the workbench

- **Needed:** the workbench's session surface (plan §8.1.B): PTY-backed interactive process with
  client attach/detach, streaming from a durable sequence (reconnect after browser/product restart),
  send input, resize, stop/signal, and lifecycle/waiting states. This is the M1 critical path —
  `mend codex` is an interactive supervised PTY, not a one-shot prompt run.
- **Today:** `harness.session()` exists but is marked Phase 3, and `InteractiveSession` is only
  `{ send(input), output(): AsyncIterable<Uint8Array>, close() }` — no resize, no detach/reattach
  semantics, no resume-from-sequence (unlike `run.record.stream({ from })`), no waiting-state
  reporting, and it presumably requires the creating handle (see the 2026-07-08 re-fetched-handle
  entry).
- **Suggested:** grow `InteractiveSession` toward parity with the record surface: durable
  sequence-based `output({ from })`, `resize(cols, rows)`, `signal(...)`, attachability from a
  re-fetched workspace/run handle, and a lifecycle status (`running | waiting | idle | ...`) so a UI
  can show "waiting for input" without parsing terminal bytes.

## 2026-07-25 · 0.5.2 · Connected-account providers are a closed set (claude/codex/github)

- **Needed:** the workbench is bring-your-own-agent — Codex and Claude Code first, but also OpenCode
  and arbitrary commands. Whatever identity those harnesses need must ride the same reference-only
  credential injection.
- **Today:** `WorkspaceCredentialsOptions` is exactly `{ profile, claude, codex, github }`. An
  OpenCode or custom harness has no slot, so it runs unauthenticated or the user bakes secrets into
  dotfiles (which defeats the reference-only model). Noting early, not urgent: the MVP validates
  with Codex and Claude Code, which are covered.
- **Suggested:** let profiles (or a generic `accounts: { [provider: string]: true | string }`) carry
  arbitrary named connected accounts with a declared injection shape (env var / file), so new
  harness kinds don't each require an SDK field.

## 2026-07-15 · 0.5.2 · Release artifact: compose.selfhost.yaml omits `SEALANT_CREDENTIALS_KEY`

- **Needed:** inference on connected accounts working on a stock self-host install — Mend's brief
  compilation and harness credentials both ride on it.
- **Today:** `apps/api` reads `SEALANT_CREDENTIALS_KEY` (inference refuses to run without it, and
  connected-account decryption falls back to a zero key), but the released `compose.selfhost.yaml`
  never passes it to the api service — compose only interpolates `.env` into `${...}` it knows
  about, so even an installer-written key never reaches the container. Found upgrading `~/.sealant`
  to 0.5.2: the local compose only had the key because it was hand-patched; the fresh release
  compose silently drops it. Re-patched locally (api env,
  `SEALANT_CREDENTIALS_KEY: ${SEALANT_CREDENTIALS_KEY:-}`).
- **Suggested:** add the env line to `compose.selfhost.yaml`'s api service (and have `install.sh`
  generate the key, if it doesn't); a release smoke test that exercises one connected-accounts call
  would have caught it.

## ✅ 2026-07-07 · 0.5.0 · Release artifact: api image cannot run inference

**Shipped in 0.5.1** — [sealant#107](https://github.com/sealant-sh/sealant/pull/107): the builder
stages the resolved platform package and the runtime image carries it next to `dist/`.

- **Needed:** `sealant.inference.respond()` working against the published `sealant-api:0.5.0` image
  — Mend's brief compilation depends on it.
- **Today:** the image bundles the API into `dist/` and ships no `node_modules`, but the Claude
  Agent SDK must spawn its vendored native binary; the resolver looks for
  `@anthropic-ai/claude-agent-sdk-{platform}-{arch}/claude` (agent-sdk 0.3.201) via
  `require.resolve` and every inference call fails with `Native CLI binary for linux-x64 not found`.
  Verified: `npm install --no-save @anthropic-ai/claude-agent-sdk-linux-x64` inside the container
  makes inference work end-to-end (a container-local patch — lost on recreate).
- **Suggested:** the runtime stage of `apps/api/Dockerfile` (Core repo) carries the platform
  package, version-locked to the bundled agent-sdk — e.g. copy the resolved package dir from the
  builder stage, or `npm install` it pinned in the runtime stage.

## ✅ 2026-07-07 · 0.5.0 · Release artifact: ssh-gateway env schema broke existing installs

**Shipped in 0.5.1** — [sealant#107](https://github.com/sealant-sh/sealant/pull/107): the
process-env parsers alias the sandbox-era names for a release.

- **Needed:** nothing from Mend's loop (the gateway serves interactive SSH only) — recorded so the
  observation isn't lost.
- **Today:** `sealant-ssh-gateway:0.5.0` crash-loops on a `~/.sealant` compose generated by an
  earlier installer: `Invalid environment variables` at boot — the env schema changed (the old
  compose passes `SANDBOX_SSH_GATEWAY_*`; current validators mention `WORKSPACE_SSH_GATEWAY_*`).
  Fresh 0.5.0 installs presumably pass (the release smoke test was green); upgrades in place break.
- **Suggested:** either accept the old names as aliases for a release, or have the installer/docs
  cover in-place upgrades (regenerate compose on version bump).

## 2026-07-07 · 0.5.0 · Pre-auth owner model: SDK default owns nothing visible

- **Needed:** Mend's SDK calls must see the connected accounts and workspaces the operator created
  through the Sealant web UI.
- **Today:** the SDK's host-local owner defaults to `usr_local`, while the web UI writes rows under
  the signed-in web user's id — so a default-configured SDK sees no connected accounts
  (`InferenceNotFoundError: No claude connected account matches "default"`) until
  `SEALANT_OWNER_USER_ID` is set to the web user's id by hand. Documented in `DEVELOPMENT.md`;
  `compose.yaml` passes it through.
- **Suggested:** noting rather than asking — the internal-config comment already says this
  disappears once auth lands. Until then, surfacing the web user's id somewhere copyable in the
  Sealant UI (or aligning the default owner) would save the next self-hoster the archaeology.
- **Resolved 2026-08-22 (Core `feat/service-principals`):** `SEALANT_SERVICE_KEYS` +
  `POST /v1/users` + `SealantConfig.ownerUserId`. Mend is a service principal and provisions one
  Sealant user per Mend account; `SEALANT_OWNER_USER_ID` is gone from Mend
  (`docs/SEALANT-IDENTITY.md`).

## 2026-07-08 · 0.5.1 · No file-change events recorded for harness edits (diff comes up empty)

- **Needed:** the brief's machine facts (`N files · +X / −Y`, the unified diff) and its
  `unrelated change` disposition come from `run.changes` / the record's `fileChange` and
  `fileDiffAvailable` events — the typed file-event taxonomy shipped in 0.5.0.
- **Today:** across a real ~10-minute `opencode` run that demonstrably edited a file and committed
  it (`git diff base..head` shows +92 lines in `FormApi.ts`), the record contained **only**
  `ioChunk` stdout/stderr and `runtimeHeartbeat` events — **zero** `fileChange` /
  `fileDiffAvailable`, and the `ioChunk` payloads are opaque (byte counts + content hash, no text).
  So `run.changes.diff()` is an empty string and `run.changes.files` is `[]` even though a real
  change landed. The file-watch telemetry is not capturing the harness's edits. Interim workaround:
  `@mend/sealant` reads the real diff from git (`git diff base..head` via `workspace.exec`) instead
  of trusting `run.changes`; this needs the workspace still alive at brief-compile time.
- **Suggested:** record `fileChange` / `fileDiffAvailable` / `fileSnapshotCompleted` events for
  edits the harness makes (the taxonomy exists; the watcher isn't firing for these writes), so a
  recording-grounded diff is available without a post-hoc git read. Separately, exposing byte-exact
  `ioChunk` text through the read surface would let the brief quote what the agent actually printed.

## 2026-07-08 · 0.5.1 · Re-fetched workspace handles cannot start a harness

- **Needed:** follow-up and verification runs start in a workspace that outlives the handle that
  created it (Mend's supervisor holds no handles across settles or restarts): fetch by id, start a
  harness.
- **Today:** `workspaces.get(id).harness.start(...)` throws
  `This workspace handle has no harness; use the handle returned by workspaces.create().` — only the
  creating handle carries the harness's invoke knowledge. Mend works with the public `/effect` ops
  instead (`createRunOp` with `harnessId` + a hand-assembled `command` from
  `harness.buildRunCommand`), which duplicates the facade's command construction at every consumer.
- **Suggested:** let a harness be attached to a fetched handle — `workspaces.get(id, { harness })`
  or `workspace.harness.with(harness).start(...)` — or move run-command construction fully
  server-side (the SDK's own harness.ts notes that migration is planned).

## 2026-07-07 · 0.5.0 · `/effect` exports the ops, not the composition layer

- **Needed:** Mend consumes the workspace/run object model Effect-natively: workspace ready-waiting,
  harness start, the record read surface (`commands()`/`transcript()`), and the resumable
  `record.stream({ from })` as a `Stream`. With 0.5.0 those still exist only behind the Promise
  facade — `dist/effect/run-harness.js` and friends are real but typed against unexported facade
  internals, and `@sealant/sdk/effect` exports only the api client, the flat operation effects, and
  `makeSdkRuntime`.
- **Today:** `@mend/sealant` runs flat calls (connection check, `inferenceRespondOp`) on the Effect
  core with typed contract errors, but keeps `Effect.tryPromise` around the facade for the stateful
  handles — a deliberate split, documented in `packages/sealant/src/client.ts`, rather than
  duplicating the facade's reconstruction/polling logic.
- **Suggested:** export the composition layer Effect-natively — e.g. a `Workspaces`/`Runs` service
  pair whose record surface returns `Stream`/`Effect` values — so Effect consumers never touch the
  Promise boundary.

## ✅ 2026-07-06 · 0.4.0 · Inference on connected accounts (no workspace)

**Shipped in 0.5.0** — `sealant.inference.respond()` (facade) and `inferenceRespondOp` (`/effect`):
server-side via the official agent SDKs on account references, caller-executed tool loop over
`sessionId`, JSON response format. Adopted as `@mend/inference`'s shipped `sealantProviderLayer`;
the dev-only direct layer remains for development.

- **Needed:** Mend's interface inference — brief compilation, run/failure summaries,
  reviewer-comment routing — must run model calls on the user's connected subscriptions (PRODUCT.md:
  "Mend hosts no inference"). These are short, tool-calling inference loops behind the interface,
  not code runs.
- **Today:** the only model-access path in the SDK is a harness inside a workspace
  (`workspace.harness.run/start`). Platform-side, the credential infrastructure is fully built
  (encrypted `connected_accounts`, server-side reference resolution, injection planner), but there
  is no inference surface — and `docs/connected-accounts-design.md` (Core repo) deliberately forbids
  raw model-API calls on stored credentials (ToS): internal features must go through the official
  agent SDKs (e.g. Claude Agent SDK with `CLAUDE_CODE_OAUTH_TOKEN`).
- **Suggested:** an inference endpoint on the control plane implemented **via the official agent
  SDKs** on server-resolved credentials — honoring the no-raw-calls rule — exposed as
  `sealant.inference.respond(...)` (+ streaming variant) with tool-calling support, taking the same
  account-reference credential shape as `WorkspaceCredentialsOptions` (`claude: true | "<account>"`,
  `codex: …`, `profile: …`). The design doc's §9 already sketches this as a follow-up. Until it
  ships, Mend hides inference behind an internal `InferenceProvider` service; the dev-only layer may
  call a provider directly, but the shipped default must be Sealant.

## ✅ 2026-07-06 · 0.4.0 · Deterministic exec in a workspace

**Shipped in 0.5.0** — `workspace.exec(argv, options)` returns `{ exitCode, run }` with the exec
recorded as a run record; exit codes are check data, not errors. Exposed as `SealantClient.exec`;
the causal proof (M2) builds on it.

- **Needed:** the causal proof (`base fails · head passes · revert fails`) and re-verification on a
  moved base are fixed command sequences (checkout ref → run repro/tests → record exit codes). They
  should be deterministic executions, not agent-mediated prompts.
- **Today:** the SDK exposes only `harness.run/start` (an agent interprets a prompt) and the Phase-3
  interactive `session()` stub. Platform-side the primitive already exists:
  `execInWorkspace(target, { executable, args, cwd })` in `packages/workspaces/src/sealantd`, and
  the run-exec queue already carries arbitrary `{ executable, args, cwd }` — a harness run is just
  an exec with harness framing. The gap is exposure, not capability.
- **Suggested:** a public endpoint + SDK method `workspace.exec(argv, { cwd?, env? })` returning
  exit code and output, recorded into the run record like any process (or a first-class "check run"
  primitive: a list of commands executed verbatim, one record).

## ✅ 2026-07-06 · 0.4.0 · `@sealant/sdk/effect` subpath not exported

**Shipped in 0.5.0** — the subpath exports the contract-derived `SealantApiClient` (+ layer), the
per-endpoint operation effects with typed contract errors, and `makeSdkRuntime`. `@mend/sealant`'s
flat calls now run on it; the remaining gap is the composition layer (entry above).

- **Needed:** Mend is Effect end-to-end; it wants the SDK's Effect-native core (services, `Stream`s,
  typed errors) instead of wrapping Promises.
- **Today:** README says the Effect core "will be reachable via the `@sealant/sdk/effect` subpath";
  `package.json` `exports` ships only `"."` (the Promise facade). The Effect modules exist in
  `dist/` but are not addressable.
- **Suggested:** export the subpath. Until then `@mend/sealant` wraps the Promise facade in Effect.

## ✅ 2026-07-06 · 0.4.0 · Typed record event taxonomy (the source trail)

**Shipped in 0.5.0** — `TimelineEntry` is a discriminated union of twelve typed kinds (including
`networkRequest`/`networkSourceObserved` for the source trail) with a human `summary` per entry and
an `unknown` forward-compatibility case. Mend's live cards now stream `entry.summary`; the run audit
and source trail (M2) build on the typed kinds.

- **Needed:** the brief's source trail — every source the agent opened, grouped
  `relied on / consulted / contradicted / discarded`, with provenance chips — requires semantic
  events in the record: network fetches (URLs), file reads, tool invocations, with stable typed
  kinds.
- **Today:** the taxonomy largely exists and is typed platform-side — 12 payload kinds in
  `@sealant/telemetry` including `networkRequest` (method/host/path/status) and a dedicated
  `networkSourceObserved`, plus file change/diff/snapshot events. But none of this reaches SDK
  consumers: `TimelineEntry` is `{ kind: string, data: unknown }`, and there is no file-_read_ event
  (only change/diff).
- **Suggested:** expose the typed event schemas through `@sealant/api-contracts` so
  `TimelineEntry.data` is discriminated by `kind` at the SDK surface; consider a file-read/open
  event for a complete local-source trail. Network-source events are already enough to start the
  brief's source trail.

## 2026-07-06 · 0.4.0 · Push events (SSE / control-plane webhooks)

- **Needed:** live mending cards and dispatcher wake-ups without tight polling.
- **Today:** `record.stream({ from })` is poll-backed (README: "SSE later"); resumable from a
  sequence, which covers crash-resume well. No control-plane webhook/event-subscription surface for
  run/workspace lifecycle.
- **Suggested:** SSE for `record.stream`, and a webhook-registration (or server-sent events) surface
  on the control plane for run/workspace lifecycle. Low priority — polling is acceptable at Mend's
  scale.

## 2026-07-06 · 0.4.0 · Workspace lifecycle close-out

- **Needed:** reclaim workspace resources when a run settles (Mend keeps evidence, not workspaces),
  and expire re-verification workspaces aggressively.
- **Today:** `stop()` / `restart()` / `expire()` are typed Phase-3 stubs
  (`SealantNotImplementedError`).
- **Suggested:** none — already planned; noting that Mend wants it by its GitHub milestone so
  long-running self-hosted instances don't accumulate workspaces.
