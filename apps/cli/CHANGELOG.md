# @sealant/mend

## 0.29.0

### Minor Changes

- `mend doctor` reports Mend's Claude grant, and `mend connect claude` notices a dead one. Claude
  reports `loggedIn` from what it stored, so a grant whose refresh token is gone or past its own
  28-day expiry still reads healthy; connecting now detects that and logs in again once. Doctor adds
  a `grant` line while Mend keeps a grant of its own: when it expires, that it is signed out, or
  that it cannot be read, each with `mend connect claude` beside it. Nothing is printed for someone
  who connected with `--use-my-login`, because there is no grant of Mend's own to report.
- `mend connect claude` gets Mend a Claude login of its own. Claude rotates its refresh token, so
  two copies of one login fight and whichever refreshes second is signed out; Mend refreshes on a
  schedule, which made your laptop the loser. It now logs in once against a directory Mend keeps
  (`$XDG_CONFIG_HOME/mend/claude-grant`, 0700), checks that Claude really read that directory,
  refuses a grant that is the one this machine already holds, and reports whether your own login
  survived. `--use-my-login` connects the shared login deliberately, and says what it costs.
- The session harness home stops handing out its credential. The mode keeper re-opens read bits
  every 15 seconds so the store-side reader can see harness state, and it was doing that to the
  provider credential the platform injects as well — leaving a refresh token good for weeks
  world-readable on the store. Credentials are now exempt, on the first pass and in the loop.
  Nothing store-side reads them: no harness lists a credential among the paths the harvest collects.
- `mend connect claude` sends the Claude grant alone. The credential document Claude Code writes
  holds `mcpOAuth` beside `claudeAiOauth` — refresh tokens for whichever MCP servers that machine
  authorized — and the whole file used to travel to the platform and into every workspace. Only the
  `claudeAiOauth` section leaves the machine now, the CLI says what it held back, and Mend's API
  narrows the same way so a hand-rolled client cannot widen it
  (`docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md`).
- f51da1f: Add budgets: what one client address, one account and one organization may ask of an
  instance. A request body is refused before it is decoded (1 MiB; 24 MiB on the routes that take a
  file), a WebSocket frame over 1 MiB closes its socket, requests are counted per minute per address
  and per credential with a tighter window for sign-in attempts, and an account holds a bounded
  number of unsettled sessions, launches starting at once, event streams, terminals, tunnels and key
  bridges. A refusal is `429` (or `413`) with the budget's name, and never stops a running session
  or closes an open connection. Every limit is a `MEND_BUDGET_*` variable, `0` turns one off, and
  `docs/operations/budgets.md` lists them. `sessions.create` and `sessions.launch` gain the
  `BudgetExceeded` error.
- b02b45e: Folders and reference repositories reach captured workspaces, and the multi mode gate
  passes. A captured workspace binds no host path, so each folder a project selected now travels
  with the session plan as a gzipped archive — a folder as `tar` of its contents, a reference as
  `git archive HEAD`, the tree an agent reads without the history behind it. sealantd 0.16.0 lays
  each one down beside the worktree, at `/workspace/home/<name>` and `/workspace/ref/<name>`, the
  same paths a co-located install bind-mounts.

  An archive is keyed by its own sha256 under the session's epoch prefix, so a re-plan of unchanged
  content writes nothing, the executor only ever holds URLs under its own prefix, and capture
  retention sweeps the archives with the fenced epoch. A source is a copy: writes inside a session
  stay in that session, because the archives land outside every capture root. A folder that cannot
  be archived is left out with a warning rather than costing the session its start, and one archive
  is capped at 64 MiB — the ceiling the daemon enforces too.

  Both gate items that waited on the platform are in: sealantd declares the length of every upload
  it asks a URL for, and lays down the plan's sources. With the source policy, upload length
  binding, loopback service ports and an operator present, `MEND_TENANCY=multi` no longer refuses to
  start. It requires sealantd 0.16.0 or newer, which the gate's detail names, and which the operator
  pins.

- 8007722: The CLI speaks organizations: `mend members` lists who belongs, `mend invite` prints a
  one-time link (owners), `mend folder list|create|push|rm` manages organization folders,
  `mend session share <id> on|off` turns shared control on or off, and `mend adopt` takes
  `--private` (the default) or `--shared`. The phone app hides steering actions from someone who
  cannot steer a session and stops retrying a terminal whose access was revoked. Projects adopted
  without a stated visibility, from any client, are private.
- 1224d70: Add an error boundary and a browser header policy. Error messages that leave the API are
  scrubbed of what arrived from below (server paths, internal hostnames, credentials and queries in
  URLs, tokens) while Mend's own words pass through; a defect answers `InternalError` with a
  reference id and its detail goes to the server log under that id. `MEND_ERROR_DETAIL=verbose`
  turns the scrubbing off for debugging a private instance. The web tier now sets a
  Content-Security-Policy (this origin only, no framing), `nosniff`, a referrer policy
  (`no-referrer` on pages whose URL carries a credential), a permissions policy, same-origin opener
  and resource policies, and HSTS when the origin is https. The terminal embed keeps working: the
  phone loads it as a top-level document.
- aedabb8: Add `MEND_EXPOSURE` (`loopback`, `private` (the default), `public`) and the public
  exposure gate. How an instance is reached is the operator's statement, since a server cannot
  observe what is published in front of it; Mend reports what it observes beside it.
  `MEND_EXPOSURE=public` refuses to start while an item Mend can observe is open: https browser
  origins, `Secure` session cookies, trusted proxies set and not wildcarded, every multi mode gate
  item (an operator account included), every budget, URL bearers refused, error redaction on, and a
  session channel that is https or declared private (`MEND_EXECUTOR_NETWORK=private`). Items no
  build can observe (Sealant and the database not reachable from outside, the edge's certificate, an
  independent reassessment recorded with `MEND_EXPOSURE_REASSESSED=<version>`) are reported as open
  or declared and never block a start; the first two close only when the operator, having checked
  from outside, names them in `MEND_EXPOSURE_DECLARED`. What the build contains and the API cannot
  see in effect (invitation-only registration, the web tier's header policy) is reported as carried,
  not observed. `mend operator exposure` prints the report; `/health`, which needs no sign-in,
  carries the declared exposure and how many items are open, never which. The gate reports what was
  observed; it never says an instance is fit to expose.

  Session cookies are now explicitly `HttpOnly` and `SameSite=Lax`, and `Secure` whenever `APP_URL`
  is https. The Helm chart (0.3.0) can render an Ingress to the web Service only, refused without
  TLS or with a browser origin that is not its host, and its NetworkPolicy admits the ingress
  controller's Pods by namespace and label. A Compose install run by hand gains an opt-in TLS edge,
  `deploy/docker/compose.edge.yaml` with a Caddyfile that keeps tickets and tokens out of its log;
  `mend server setup` installs do not apply it yet.

- c56e90d: Report how an instance is exposed, not whether a tailnet was found. The shell's machine
  block and `mend doctor` used to say `tailnet · reachable` or `tailnet · not detected`, inferred
  from an interface address in 100.64.0.0/10: a false alarm on a LAN or public install, and never a
  statement about who can reach the instance. They now say what the operator declared and what the
  server observed, for example `exposure · private · https · via proxy`, and `mend doctor` asks for
  https only when the instance is declared reachable beyond the machine. `GET /api/machine` gains
  `exposure` (declared mode, origin scheme, whether the request arrived through a trusted proxy, the
  kinds of address on the host without the addresses, open gate items); `tailnet` stays for older
  clients.
- 820eb92: Add organization folders: directories Mend keeps under the store, which owners create and
  fill and projects select to mount at `/workspace/home/<name>`, read-only unless chosen otherwise.
  They replace host mounts for everyone but the operator of a single-organization install. Uploads
  are capped at 1 MiB a file and 4 MiB a request, and paths never leave their folder. Project detail
  reports whether this deployment mounts them at all (`mountDelivery`).
- 311953b: Warm hot sessions for each person who recently ran a session in the project and can still
  see it, instead of as the first account, and drain a person's standbys once they lose access.
  Nothing runs as a stand-in account any more: a session with no owner cannot launch or be steered,
  the dependency install runs as whoever changed the install command (or the project's creator), and
  the retired queue's runs act as the operator.
- 4a53432: Owners can remove members, change roles, take over a project whose creator left, and read
  the organization's audit log. Removing a member deactivates the account, revokes its browser
  sessions, paired devices and phones, closes its open terminals, tunnels, key bridge and event
  streams on every server process, and stops its sessions through the normal flush and checkpoint.
  The static token now acts as the operator instead of the oldest account. Invitations, role and
  visibility changes, takeovers, folders and references are recorded in the audit log.
- 2540df0: The multi mode gate is computed. Each item answers from this build, this instance's
  configuration, or the platform work it waits on; `MEND_TENANCY=multi` refuses to start while any
  is open and names each with its fix. `/health` reports whether the gate passes and which items are
  open, and `mend operator gate` shows the details.
- adba99f: Recovery without email. Owners hand a member a one-time password reset link from
  Settings; the operator lists organizations, renames them, invites or grants an owner, and issues
  reset links from `mend operator`. A reset link works once for a day, and setting a password with
  it signs the account out everywhere. Every operator act is recorded in the affected organization's
  audit log.
- 3843b11: Add organizations. Upgrading creates one organization that every existing account joins;
  the oldest account becomes its owner and the instance operator, and every existing project stays
  visible to everyone as a shared project. New projects are shared unless adopted as private, and
  project names are unique within an organization. Registration now closes after the first account:
  owners mint single-use invitation links instead, and an account that could not join an
  organization is deactivated. `MEND_TENANCY` defaults to `single`; `multi` is refused at start
  until the isolation work lands.
- a2cab8c: Give each account its own ssh-agent bridge, so a shared signer only ever signs for the
  account that shared it, and send session notifications only to the session owner's phones.
  Reference repositories belong to the organization: owners add, refresh and remove them with their
  own git access, and a project can select only its organization's references. Calls to the GitHub
  API use the host's `gh` login only for the operator of a single-organization install. Adding host
  mounts is refused in multi mode, and multi mode also refuses raw service listeners off loopback.
- 01ba33f: Enforce project visibility on every route. A project, session, worktree, change, process
  or Service the caller cannot see answers exactly like a missing one, and the check runs before any
  effect. Members see shared projects and their own private ones; project settings are for owners
  and the project's creator; removal is for owners, or the creator of a private project; only owners
  change visibility, and organization owners may stop any session they can see. Machine settings and
  the retired queue are the operator's, and adding host mounts needs the operator role. Live events
  are filtered to what each account can see, and one closing stream no longer silences the others.
- 0e5387b: Runs on Sealant 0.34.0, which bakes sealantd 0.17.0 (sealant-sh/sealantd#86): the
  workspace daemon dials the session channel and every presigned object URL over HTTPS with a
  verified certificate, and refuses to boot otherwise, unless the launch states that the network
  between executor and channel is private. Mend now sends that statement with every capture launch
  as `source.transport`, built from `MEND_EXECUTOR_NETWORK=private`, and hands the daemon the roots
  of a private CA from `MEND_SESSION_ENDPOINT_CA_FILE` (the channel) and `MEND_BLOB_STORE_CA_FILE`
  (the bucket). The packaged bundle states `private` itself, since its Compose network never leaves
  the host. The Helm chart refuses to render a plain-http session channel without
  `exposure.executorNetwork: private` or `sessionChannel.tls.enabled`, and takes the channel's CA
  through `sessionChannel.tls.ca`.

  Upgrade note for the chart: set one of those two values before `helm upgrade`, and roll this Mend
  before or with Sealant 0.34; a Mend older than this release does not send the statement, and its
  workspaces would refuse to boot under the new daemon.

  `@sealant/sdk` and `@sealant/api-contracts` move to 0.34.0, and the bundled server image pins the
  0.34.0 API, worker and ssh-gateway digests.

- 188cd59: A session's owner can turn on shared control, letting anyone who can see the session
  steer it on the owner's credentials; the owner or an organization owner can turn it off. Session
  detail says what the viewer may do (steer, stop, change shared control). Interrupts, terminal
  attaches, shell opens, stops and shared control changes are recorded per session with who did
  them, and shared control changes also go to the audit log. While control is shared, notifications
  also reach whoever sent the latest turn. Removing a member turns off shared control on their
  sessions first.
- 55d0b02: Under `MEND_SOURCE_POLICY=tenant`, git dials exactly the address the source policy
  checked, over HTTPS and ssh, so a name cannot resolve somewhere else between the check and the
  connection. The dotfiles clone at each launch is now checked and pinned too.
- 4e78243: Mend checks where its own git goes. Adoption, reference repositories, dotfiles and
  project refreshes are refused for the cloud metadata service and, except for the operator, this
  machine; `MEND_SOURCE_POLICY=tenant` also refuses private and reserved networks and `git://`
  unless `MEND_SOURCE_ALLOWED_HOSTS` allows them. A workspace's git transport now signs only against
  its project's own remote; `MEND_GIT_TRANSPORT_BIND_ORIGIN=false` restores the old behavior for a
  machine one person uses.
- 14c6486: Add upgrade tickets, so no long-lived bearer rides a URL. A WebSocket opened by a browser
  or the CLI cannot set a header, and neither can a WebView loading a page, so the terminal, service
  tunnel and key bridge sockets and the phone's terminal embed carried the session or device token
  as `?token=`, where every proxy on the way could log it. `POST /api/upgrade-tickets` now mints a
  ticket that is single use, lives thirty seconds, and opens exactly one target with exactly the
  parameters it was minted for; the socket routes take it as `?ticket=`. The CLI (`mend attach`,
  `mend service connect`, `mend keys share`), the desktop app, the phone and the embed page all use
  tickets, and the embed page keeps a renewal ticket in memory so a dropped terminal reconnects for
  up to twelve hours. A ticket is bound to the sign-in or paired device that minted it: signing out
  or revoking the device ends every ticket it minted. `MEND_URL_BEARERS=refuse` answers `?token=`
  with 400; the default, `accept`, keeps clients older than this release working and logs each use.
  A client newer than its server falls back to `?token=` only when the mint answers 404 and
  `/health` does not report `upgradeTickets`.
- 341a001: Capture uploads can no longer store more than they declared. Presigned PUT and part URLs
  sign the declared size, so an S3-compatible bucket refuses any other length; a multipart upload
  must complete with exactly the parts its size implies, and an object whose stored size differs
  from its declaration is removed and refused with `size-mismatch` at complete or register.
  `MEND_CAPTURE_REQUIRE_SIZES=true` also refuses keys sent without a size (today's sealantd sends
  sizes only for multipart keys).
- fb73d6f: Settings shows your organization: members with roles, owners' invitation links, folders
  with their files and uploads, projects a departed member left behind, and the audit log. Owners
  change roles, remove members (the page says what removal does first), take over a departed
  member's project, and page back through the audit log. Invitation links open a join page that
  creates the account; a signed-in account is told which organization it already belongs to. A
  removed account's browser is signed out and told why.
- 289f409: The web app shows each person only the controls they may use. A session page names whose
  credentials it runs on, lets its owner turn shared control on or off (an organization owner can
  turn it off), and shows the record instead of the terminal to someone who cannot steer. Menus, the
  Services card and "Send review to session" follow the same rules. Adoption asks who may see the
  new project, owners change a project's visibility in its setup, managers pick the organization
  folders its sessions mount, and setup sections a viewer cannot change are replaced by a note
  saying who can.

### Patch Changes

- Runs on Sealant 0.35.1 (sealant-sh/sealant#263), which bakes sealantd 0.18.0
  (sealant-sh/sealantd#91, #93). That daemon sets the remotes `plan.get` names, so a captured
  session's repository has its `origin` and `git push` and `git fetch` work inside a session again;
  it also sends the reply to a graceful shutdown before it exits. `@sealant/sdk` and
  `@sealant/api-contracts` move to 0.35.1, and the bundled server image pins the 0.35.1 API, worker
  and ssh-gateway digests.
- Runs on Sealant 0.35.0 (sealant-sh/sealant#259, #260). The platform stores a Claude credentials
  file as its `claudeAiOauth` grant alone, dropping the `mcpOAuth` refresh tokens beside it at
  connect and at sync-back, and a connected account now reports how fresh its credential is:
  `accessExpiresAt`, `refreshExpiresAt`, `lastRefreshAt` and `lastRefreshOutcome`. `@sealant/sdk`
  and `@sealant/api-contracts` move to 0.35.0, and the bundled server image pins the 0.35.0 API,
  worker and ssh-gateway digests.
- Install the `mend` helper and the git transport inside captured workspaces. A captured workspace
  mounts nothing, so the two scripts never arrived while git was configured to use them: `git push`
  and `git fetch` over ssh, and `mend service` commands, failed inside every session on a server
  using the capture store (the default since 0.27.0). The scripts are now written into the workspace
  at provisioning and reach the server over the session endpoint. A workspace where they cannot be
  installed is logged, no longer passed over.
- A captured session's repository has its `origin`. sealantd builds that repository itself, so it
  had no remotes and `git push origin` failed with "'origin' does not appear to be a git
  repository". `plan.get` now names the project's origin for sealantd to set
  (sealant-sh/sealantd#91); a password embedded in an adopted URL is dropped first, so no credential
  enters a workspace. It takes effect with the Sealant release that bakes that daemon; an older one
  ignores the field.
- A workspace's git transport recognises the project's own remote when it names a user. Git hands
  its ssh command `git@host`, and the origin binding compared that whole destination with the
  origin's host, so every push and fetch to an ssh origin was refused as "bound to" another host.
  The user is now set aside the way ssh reads it, after the last `@`.
- 6b0eb97: Allow only a session's owner to steer it, including terminal and Service tunnel access.
  Legacy sessions without an owner continue to use the first account as their owner.
- 2c05944: Runs on Sealant 0.33.1, which bakes sealantd 0.16.0 (sealant-sh/sealant#249). That is the
  daemon release Mend's capture channel now expects: every PUT URL the executor mints is bound to
  the length the PUT sends, which is what `MEND_CAPTURE_REQUIRE_SIZES=true` refuses uploads without,
  and `plan.get`'s `sources` are laid down beside the worktree, which is how a project's folders and
  reference repositories reach a captured workspace.

  `@sealant/sdk` and `@sealant/api-contracts` move to 0.33.1, and the bundled server image pins the
  0.33.1 API, worker and ssh-gateway digests.

## 0.28.0

### Minor Changes

- 6a2c50e: Redesign the dashboard with stacked project, worktree, and session navigation beside a
  larger read-only conversation preview. Keep browsing separate from explicit attach, resume, and
  new-session actions, guard duplicate launches and destructive confirmations, and show launch and
  branch lookup failures.

  Use Ayu Mirage backgrounds and accents with brighter text and independent pane-title colors.
  Support narrow terminals, sanitize recorded output, and preserve readable Unicode wrapping in the
  preview.

### Patch Changes

- 4f00a9c: Adopt Sealant 0.33.0 in the public SDK, bundled service images and AWS deployment
  templates. Pin the AWS workspace-image recipe to the same release and retain the platform's
  runtime-specific Docker errors.

  AWS workspace Docker remains opt-in and requires a separate Docker-capable image with matching
  configuration on API and worker. Updating Mend does not install Docker into retained workspaces or
  change a running AWS deployment. The matching `sealantctl` packaging requirement still applies.

## 0.27.5

### Patch Changes

- 11083ed: Prevent coding-agent transcript data from being lost when a capture executor is replaced,
  and show when ended sessions without an observed transcript are omitted from a project's visible
  count.

## 0.27.4

### Patch Changes

- 5ece5a6: The capture store's byte quota is checked before bytes land, and is sized for captured
  dependency trees. `upload.urls` refuses a batch whose declared sizes would take the session past
  its quota with 413 `{reason: "byte-quota", limit, used, requested}` before any URL is minted; a
  key is priced once (reserved at its declared size, settled at the size the bucket reports when a
  register names it), so re-listed packs and retried batches cost nothing again. `capture.register`
  keeps the check as the backstop for keys uploaded without a size and answers 409 with the same
  body — a refusal of that capture, not a transport failure to retry. The floor rises from 512 MiB
  to 8 GiB per session (`MEND_CAPTURE_BYTE_QUOTA_FLOOR`; chart `captureStore.byteQuotaFloorBytes`),
  above which the 4× footprint rule still applies: on the cluster the first bulk capture of a
  Mend-size `node_modules` (775 MB, 134,103 files) was uploaded in full and then refused at
  register, and the executor retried it every 5 s.
- 1467699: The bundle pins Sealant platform 0.31.2 by digest and the SDK moves to 0.31.2; the
  workspace image carries sealantd 0.15.2. A capture-mode session's flush survives load: the
  daemon's orphan reaper was reaping the capture engine's own `git` children, so `capture.flush` was
  refused with `No child process` for 4% of flushes on a quiet machine and a third of them under an
  orphan storm — the failure that took down Mend's own v0.27.3 packaged acceptance on amd64. A
  capture the control plane refuses on the byte quota is now terminal: the shipper acks the 413 and
  stages over it, where it used to re-attempt the same register every five seconds for the life of
  the session. On Kubernetes a workspace pod's exit is observed from the runtime, so a dead executor
  is seen in seconds instead of reading `ready`, and `stop` on a pod that is already gone returns at
  once — the cluster proof spent most of its 122 s to declare an executor lost inside that wait.
  MicroVM launch material is published whole.

## 0.27.3

### Patch Changes

- 82bad9d: Capture mode, after the first cluster session on a Garage bucket:
  - The capture routes ask the bucket only about capture objects. `capture.register` refuses a
    manifest naming a key that is not `…/packs/<sha256>`, `…/trees/<sha256>` or
    `…/manifests/<sha256>` before any HEAD; `upload.urls` and `upload.complete` drop or refuse such
    keys; a plan presigns object keys alone. Every bucket failure inside a route now names the key.
  - Mend verifies a capture's git section itself (`index-pack --verify` plus
    `git rev-list --objects --missing=error` over the refs it names, on the runner) and records the
    outcome in `captures.git_fsck` — `checkpoint`, `turn`, `suspend` and `final` at register, `auto`
    at the first plan that would restore it. A capture whose pack omits a tree it names is accepted
    and marked `failed`; `plan.get` answers the same head with the git section of the newest capture
    that verifies (ADR-0002 16), and reads come from that capture, stamped.
  - The `upload.urls` request quota counts calls, not presigned URLs: 600 calls per session per
    rolling hour, at most 1,000 keys per call (the daemon batches 500). The old 2,000-URL quota
    refused the first bulk capture of any repository with more than a couple of thousand dir
    objects; bytes stay bounded at register (4× the project's footprint).
  - `review prep` logs a change git cannot read with git's command and stderr, the worktree and the
    chain head's verification state, instead of `Cause([Fail(GitError)])`; the passes are simply not
    queued.
  - `scripts/capture-e2e.sh` kills the executor with SIGKILL explicitly and `docs/KUBERNETES.md`
    states the distinction: a graceful `kubectl delete pod` is a planned stop (`final` capture,
    session `completed`); only a forced delete takes the `executor lost · lease expired` pickup
    path.

- 2c9df83: The bundle pins Sealant platform 0.31.1 by digest and the SDK moves to 0.31.1; the
  workspace image carries sealantd 0.15.1, the daemon with the fixes from the first capture-mode
  session on a cluster. Tracked files win over `.gitignore`: the materialiser keeps `.git/index`
  across its sweep, so a tracked file matching an ignore pattern (`tooling/typescript/core.json`
  under `core.*`) no longer vanishes from the next worktree tree. Stored tips are seeded from refs
  alone, so a pack after boot or replan carries every subtree the replacement executor needs instead
  of a negative it never received. Packs and staging survive a long ship: an unchanged snap discards
  only objects no queued capture still lists, a coalesced capture keeps the other class's dir
  objects, and the shipper mints upload URLs 500 keys per call, matching Mend's per-call quota.

## 0.27.2

### Patch Changes

- 4eee050: The packaged acceptance proves the recorded change from the capture store. Under captures
  the session's branch and worktree live on the executor's own disk and its commits reach Mend as
  captures in the bucket and Postgres, so the old
  `git --git-dir=<store>/repo.git rev-parse <branch>` inside the Mend container answered "unknown
  revision" and failed the v0.27.1 release run. The stage now reads the worktree's checkpoint chain
  and a Review slice whose base-to-checkpoint patch the git runner serves from packs, through the
  public API, and every lifecycle stage (setup rerun, restart, stop/start, upgrade) checks that
  chain and patch survive unchanged. The store volume and the executor's disk are never inspected.

## 0.27.1

### Patch Changes

- e1ebb78: The packaged-server acceptance catches up with captures everywhere (decision 8):
  `mend-garage` is the third external, ownership-labelled volume, the way `mend server setup` claims
  it — v0.27.0's release run refused the volume as unproven and leaked it at cleanup — and the
  session stage no longer looks for a workspace that mounts the store. A capture executor mounts
  nothing from `mend-store` (a store mount is now the failure), the session's change is observed
  from a registered capture (n ≥ 1), and the engine's `capture flush · completed · observed` report
  is required when the run ends. The CLI's setup, upgrade and start carry regression tests for the
  bucket's volume: a fresh install labels all three, an upgrade from a generation without Garage
  claims it under the unchanged identity, and a foreign `mend-garage` is refused with the same
  message as a foreign store or control volume. Capture mode's checkpoints have one writer per
  worktree: the engine serialises a worktree's checkpoints behind a per-worktree permit (the
  advisory lock is bypassed under captures), and the `checkpoints` insert is
  `ON CONFLICT DO NOTHING` — a taken ordinal answers with the row that stands when it records the
  same snapshot, else re-reads the chain and takes the next ordinal. Before this a user mark during
  the run-end checkpoint answered 500 (`checkpoints_worktree_ordinal_idx`, observed in v0.27.0's
  acceptance run).

## 0.27.0

### Minor Changes

- ebbe040: Sessions run on the capture store by default (`MEND_SESSION_STORE=captured`): a session's
  work product is a chain of captures in a bucket, and the executor that made it is disposable. The
  Docker bundle (`mend server setup`) ships Garage as that bucket, single-node on its own
  ownership-labelled volume `mend-garage`, laid out once at setup; an install from before the
  capture store is upgraded in place, and a worktree made before captures is backfilled from its
  files at first launch. Projects gain an install command and a per-project dependency cache, so a
  fresh executor restores `node_modules` and its kin instead of installing them again. The review
  header names the capture the bytes were observed at. The bundle pins Sealant platform 0.31.0 by
  digest, which carries the `capture` workspace source, the Compose-network attach for workspace
  containers, runtime-observed exits and `capture.flush`/`capture.replan`, with sealantd 0.15.0
  inside the workspace image.

## 0.26.0

### Minor Changes

- 8db9e9d: First contact is now a three-step setup instead of a bare sign-in form. The web app asks
  the instance whether any account exists (`GET /api/instance`, public): a fresh install opens on
  registration and says so; one with accounts opens on sign-in. Registration asks for the password
  twice, with a reveal on both fields, and continues to a second step (`/welcome`) that asks how the
  account reaches its repositories — the Mend key is created before that page paints and shown with
  where to add it, or the machine's ssh-agent bridge is chosen instead. The key's comment is now the
  account's email rather than `mend@<host>`; existing keys are relabeled in place on the next
  signed-in read (same key material, same fingerprint). The first-run checklist observes what it
  used to guess: the CLI's sign-in (its token is a device of platform `cli`), connected accounts
  (with the platform's own failure when it cannot be reached), paired phones, and git access — and
  every observation updates live over the event stream when `mend login`, `mend connect`,
  `mend pair` or `mend keys init` runs in a terminal, instead of waiting for a reload.
- 29b87fb: `mend uninstall` removes what Mend put on a machine. It asks for a scope when none is
  given: everything, the server only, or this machine's files only (`--all`, `--server`, `--home`;
  `--yes` skips the confirmation). The plan is printed before anything goes, and the server scope
  requires typing `delete`: it takes the Compose installation down with its volumes, removes the
  external store and control volumes only when their ownership label matches this installation,
  untags the release image, and deletes the private configuration's identity, generations and
  backups. The home scope revokes this terminal's device token first, then removes `cli.json`, the
  workspace SSH key and the managed `~/.ssh/config` block. Files Mend did not create are listed and
  kept; workspace containers are named with the command that removes them, never removed.

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
