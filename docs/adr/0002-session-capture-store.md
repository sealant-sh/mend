# Session capture store: leases per worktree, executor replacement, capture-backed SessionRepository

Status: proposed 2026-09-12. Cross-repo: sealantd ADR-0015 (capture engine, pack kinds, cadence —
being amended in parallel; this ADR references it and does not restate the format), Sealant Core
(`capture` workspace source, `microvm` adapter, bridge `stop()`), Mend (everything below).
Supersedes the co-located store invariant of `docs/DEPLOYMENT-STRATEGIES.md` and
`docs/KUBERNETES.md` for every remote deployment. Evidence and arithmetic: the 2026-09-12
remote-session-storage decision record (§2.3 components and SQL, §2.4 latency, §2.6 cost, §2.7 lease
settlement); figures below are marked as it marks them: measured, cited, or estimate.

## Context

Mend is code-co-located: the API and the agent's workspace see one POSIX worktree, on this machine
(`local`) or on one RWX claim mounted into every Pod (`kubernetes`, `docs/KUBERNETES.md` "The
invariant"; helm `store.existingClaim: mend-store`, `templates/store.yaml` `ReadWriteMany`).
`SessionRepositoryLocalLive` serves both by resolving identities to store paths and running git
beside the files (`packages/sessions/src/session-repository.ts` L96–153); `worktreeMount` is the
co-location capability and answers a host path (L149–152).

Three facts end that model for remote executors:

- Every shared filesystem tried charges per file operation and git does hundreds of thousands per
  task: on the AWS POC, FSx over NFS put `git worktree add` on `nodejs/node` at 872 s against 2.5 s
  on the MicroVM's local disk, and warm `git status` at 4.8 s against 67 ms (measured, bench
  `20260912-*`). Longhorn and CephFS on the cluster produced the same incident class (uid split,
  root `gc` poisoning, stale sockets: `PLATFORM-FEEDBACK.md` 2026-08-29/30, `docs/BUGS.md`).
- Cloudflare is a hard requirement and has no durable POSIX disk: container and sandbox disk is
  ephemeral (cited, Containers architecture), every request to a container crosses a Worker whose
  body is capped at 100/200 MB (cited, Workers limits). A resident POSIX truth cannot exist there
  and a `git push` of an 804 MiB dependency pack cannot arrive.
- Executors are disposable on every hosted platform: MicroVMs cap at 8 h including suspended time,
  sandboxes are replaced without notice, Pods are evicted. Today a dead executor is a stopped
  session with its last checkpoint intact; work since the checkpoint is gone.

So the executor works on local disk, and the authoritative copy lives somewhere that no executor can
take down. ADR-0015 chose the invariant and put the capture engine in sealantd; it left the receiver
open. This ADR decides Mend's half: where truth lives, who may advance it, how Mend reads it, and
how a dead executor is replaced.

## Decision

### The invariant, and Mend's reading of it

ADR-0015: "Every session has exactly one authoritative work product: its copy in the Mend store. An
executor is disposable compute that holds a local copy of that work product and the session's lease.
Evidence, diffs, checkpoints and review comments are ordered against the record sequence at which
the store was last brought up to date."

Mend's store is a **capture store**: object storage (S3, R2, Garage, Ceph RGW, or a directory) holds
immutable content-addressed captures; Postgres holds the only mutable pointers and advances them by
single-statement compare-and-swap. The store's copy is never live. Every read Mend serves is stamped
"observed at capture n · record seq s"; `auto` captures are labelled partial because they are not
atomic across files (ADR-0015 accepts the tear; the next capture corrects it). `local` mode keeps
the bind-mounted worktree as the degenerate case in which the executor's copy and the store are the
same directory; nothing below changes it.

### The key is the worktree, not the session

The port already says so: "every WORKTREE has exactly one authoritative mutable place … Sessions are
conversations against it (several may be live at once)" (`session-repository.ts` L10–14).
Checkpoints chain per worktree under a per-worktree lock (`engine.ts` `takeWorktreeCheckpoint`
L944–975), a session joins an existing worktree by name (`ensureWorktreeIn` L1193–1204), and the hot
pool serves "ANY worktree — new, joined, or one that already holds sessions" (L1268–1270). A lease
per session would put two executors on one worktree with two diverging copies and no merge.

So the **lease and the capture chain are keyed per worktree**. One executor holds a worktree at a
time. A join, a sibling shell, an editor takeover and a phone pickup all run as another process
inside the lease holder's executor; a request that would need a second executor for a leased
worktree is refused with a stable code (`worktree_leased`, 409). ADR-0015's "one executor per
session" is amended to say worktree. Accepted relaxation for later, if refusing hurts: a second
session on a busy worktree may get its own executor holding a read-only copy that cannot capture;
only the lease holder writes. It changes nothing in storage.

### Postgres schema

Six tables, all in `packages/db/src/migrations.ts` as one migration (`0053_capture_store`, the
existing `"NNNN_name": effect` record convention, raw SQL through `SqlClient`) with drizzle
definitions in `schema/workbench.ts` and repositories under `repos/`. This is the only mutable
state. `changes` already exists (`migrations.ts` L31, `schema/workbench.ts` L148) and names the
reviewable change, so the decision record's `changes` table is `capture_summaries` here.

| Table               | Columns                                                                                                                                                                                                                                                | Role                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `worktree_leases`   | `worktree_id` PK → `worktrees`, `executor_id`, `epoch bigint`, `expires_at timestamptz`                                                                                                                                                                | who holds the worktree; `epoch` is the fencing token                                             |
| `worktree_chain`    | `worktree_id` PK, `head_capture`, `head_n`, `head_epoch`                                                                                                                                                                                               | the chain head; the only pointer that means "truth"                                              |
| `captures`          | `id` (sha256 of the manifest), `worktree_id`, `n`, `parent`, `epoch`, `seq`, `kind` (`auto\|turn\|checkpoint\|suspend\|final`), `manifest_key`, `sections jsonb`, `git_fsck` (`verified\|failed\|unverified`), `created_at`; unique `(worktree_id, n)` | one row per registered capture                                                                   |
| `packs`             | `id`, `key`, `class` (`git\|workspace\|bulk`), `state` (`uploaded\|verified\|live\|retired`), `bytes`, `worktree_id`, `epoch`, `platform`                                                                                                              | pack lifecycle; the indirection compaction updates                                               |
| `capture_summaries` | `capture_id` FK → `captures`, `worktree_id`, `key`, `state` (`claimed\|observed`)                                                                                                                                                                      | the change summary posted by the executor                                                        |
| `store_refs`        | `project_id`, `name`, `sha`, `version`; PK `(project_id, name)`                                                                                                                                                                                        | project refs (`refs/heads/*`, `refs/remotes/origin/*`, `refs/mend/base/*`), written only by Mend |

The lease and chain rows are created with the worktree row and capture 0, in the transaction that
inserts `worktrees`. `checkpoints` gains a nullable `capture_id`; the checkpoint row is inserted
after the register CAS returns, keyed by the capture that carries `checkpoint: {ordinal, sha, ref}`.

Every write is one statement, so it works through transaction-mode pooling and Hyperdrive, which
drop advisory locks, `LISTEN`/`NOTIFY` and per-session settings (cited, Hyperdrive supported
features). In capture mode `CheckpointsRepo.withWorktreeLock` (`pg_advisory_xact_lock`,
`repos/checkpoints.ts` L142–150) is not used; the CAS's `head_n = $n-1` is the serialiser and the
unique `(worktree_id, ordinal)` index stays the backstop.

```sql
-- claim (start, pickup, replacement). A concurrent claimer re-evaluates WHERE after the row lock;
-- the chain learns the new epoch in the same statement, so a stale register cannot land between
-- this claim and the new executor's first register.
with l as (
  update worktree_leases set executor_id=$e, epoch=epoch+1, expires_at=now()+interval '30 s'
   where worktree_id=$w and (expires_at is null or expires_at < now()) returning epoch)
update worktree_chain ch set head_epoch=l.epoch from l where ch.worktree_id=$w returning l.epoch;

-- heartbeat: zero rows = the lease is gone; stop shipping, pause the agent.
update worktree_leases set expires_at=now()+interval '30 s' where worktree_id=$w and epoch=$epoch;

-- register (the only write that advances truth), after HEADing every pack key the manifest names:
-- the CAS joins the live lease row; the captures row exists only if the CAS matched.
with ch as (
  update worktree_chain set head_n=$n, head_capture=$id, head_epoch=$epoch
   where worktree_id=$w and head_n=$n-1
     and $epoch = (select epoch from worktree_leases where worktree_id=$w and expires_at > now())
   returning worktree_id)
insert into captures (id, worktree_id, n, parent, epoch, seq, kind, manifest_key,
                      sections, git_fsck)
 select $id, $w, $n, $parent, $epoch, $seq, $kind, $key, $sections, $fsck from ch; -- 0 rows → 409

-- summary: accepted only against the chain head.
insert into capture_summaries (capture_id, worktree_id, key, state)
 select $capture, $w, $key, 'claimed' from worktree_chain
  where worktree_id=$w and head_capture=$capture;                                  -- 0 rows → 409

-- release (final capture, session end): the next claimer may take it at once.
update worktree_leases set expires_at=now() where worktree_id=$w and epoch=$epoch;
```

Retry rule: a register whose CAS finds `head_n = $n` with the same capture id is a lost ack, not a
conflict. Project refs move only through `store_refs` with `version = $seen`; executors hold no
statement and no URL that can move them.

### The capture store in `packages/store`

- `blob-store.ts`: a `BlobStore` port — `put`, `get`, `head`, `list`, `presign` — with `FsLive` (a
  directory; `local`, tests, the single-machine fallback) and `S3Live` (S3, R2, Garage, Ceph RGW
  through `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner`, `catalog:` versions). Configured
  by `MEND_BLOB_STORE` (`dir:///path` or `s3://bucket`, endpoint and credentials from the usual
  `AWS_*` variables) and `MEND_BLOB_STORE_PUBLIC_URL`, the host presigned URLs name.
- `captures.ts`: the manifest and directory-object codec, the CDC pack reader, `plan(head)`,
  `materialize(capture, class, dir)`, `verify(pack)`. The manifest is ADR-0015's ("Capture format");
  Mend reads these fields and no others: `worktree_id`, `n`, `parent`, `epoch`, `seq`, `kind`,
  `created_at`, `sections.git.{packs, refs, head, fsck}`, `sections.workspace.{root, packs}`,
  `sections.bulk.{root, packs, platform} | "pending"`, and `checkpoint?.{ordinal, sha, ref}`. The
  capture id is the sha256 of the manifest bytes; the manifest does not carry it. Key layout, fixed
  with ADR-0015: `captures/<worktree>/<epoch>/packs/<sha256>` (a git pack's index at
  `packs/<sha256>.idx`), `captures/<worktree>/<epoch>/trees/<sha256>` (dir objects),
  `captures/<worktree>/<epoch>/manifests/<capture-id>`; summaries at `changes/<worktree>/<n>/…`;
  promoted content at `projects/<project>/...`, written only by Mend. A manifest lists every pack a
  section needs across epochs, so a new epoch reads prior-epoch packs (sha256-verified) but never
  writes under a prior prefix and never skips an upload because a prior epoch holds the bytes.
- `runner.ts` (`GitOpsRunner`): a bare-repo cache per project
  (`<MEND_STORE_ROOT>/_cache/runner/ <project>/repo.git`, LRU by project); before every operation it
  writes `packed-refs` from `store_refs` plus the checkpoint refs of `captures`, fetches any
  git-class pack the operation's refs need, and runs today's `Store` bodies unchanged with
  `GIT_DIR=<cache>`: `diffRange` (`store.ts` L746), `diffFileFacts` (L861), `changedFiles` (L807),
  `listTreeFiles` (L889), `headSha` (L898), `listBranches` (L663); blame and log, which `Store` does
  not have today, are added on the runner. `checkpointFromCapture` replaces the temp-index
  checkpoint (L720–744: `add -A` / `write-tree` / `commit-tree` /
  `update-ref refs/mend/checkpoints/<scope>/<n>` under `GIT_INDEX_FILE`), which now runs inside the
  executor. `diffWorktree` (L788), `worktreeMatchesCommit` (L762) and `listWorktreeFiles` (L875) are
  served from the head capture's git class; `UNTRACKED_RENDER_LIMIT = 200` (L786) caps the summary
  as it caps the render today. `adopt` (L499), `refreshFromOrigin` (L641) and `cloneReference`
  (L905) stay as they are wherever Mend has a disk; on Cloudflare they run in the ops container
  against the cache.

Callers keep their names and move behind the runner: `apps/api/src/routes/workbench.ts` (five
`diffRange`, three `worktreeMatchesCommit`, three `diffFileFacts`, two each of `listWorktreeFiles`,
`diffWorktree`, `changedFiles`, one `listTreeFiles`), `routes/worktrees.ts` (`diffWorktree`),
`packages/jobs/src/review-prep.ts` L72 (`changedFiles`), `packages/inference/src/session-tools.ts`
L105–106 and `tour-composer.ts` (`diffWorktree`, `changedFiles`).

### Session channel routes

Five routes join the table in `packages/sessions/src/session-channel.ts` (L110–153 today: recipes,
services, `POST /session/stop`, and the `CONNECT /git/transport` tunnel L167–179): `plan.get`,
`upload.urls`, `capture.register`, `change.summary`, `lease.heartbeat` — sealantd's `Registrar` port
(ADR-0015 "Ports and crate layout"). Authentication is the tunnel's: bearer `MEND_SESSION_TOKEN`
plus `MEND_SESSION_ID`, hash-verified before the session is resolved (L291–332), the unix socket's
mount boundary in `local` mode (`session-socket.ts`). sealantd's names for the same material are
`SEALANT_CAPTURE_ENDPOINT` (= `MEND_SESSION_ENDPOINT`) and secret `SEALANT_CAPTURE_TOKEN` (=
`MEND_SESSION_TOKEN`); Core delivers both through the secret env channel beside `MEND_SESSION_ID`,
and `SEALANT_WORKSPACE_SOURCE=capture` selects the source. One token, two names;
`session_channel_tokens` stays the only store of its hash. The epoch is a request field on every
call, never part of the token. Per route:

- `plan.get`: the head manifest plus GET URLs for materialise.
- `upload.urls`: PUT URLs for a key list, minted only under the caller's epoch prefix, only after
  the lease predicate (`epoch = $epoch and expires_at > now()`) passes, **15 min** TTL, within the
  session's quotas (bytes: 4× the project's compressed footprint; requests: 2,000 URLs per hour).
- `capture.register`: the CAS; 409 on a stale epoch or a wrong parent; a register that finds the
  chain already at `n` with the same capture id is a lost ack, answered as success.
- `change.summary`: after a `checkpoint` register returns; accepted only against the chain head.
- `lease.heartbeat`: every 10 s; zero rows = lost. The executor pauses its agent (`SIGSTOP`) on any
  409 or after 30 s without a successful heartbeat, and resumes it (`SIGCONT`) if a later heartbeat
  succeeds with the same epoch; it never kills.

The manifest and summary travel over the channel; bulk bytes never do. Presigned URLs carry the host
the executor resolves (`MEND_BLOB_STORE_PUBLIC_URL`: the Docker network name of the bucket, the
cluster Service, the R2 S3 endpoint), never `localhost`.

### `SessionRepositoryCapturedLive`

Same port, `packages/sessions/src/session-repository-captured.ts`, selected at the layer boundary by
`DeploymentConfig.sessionStore` (`colocated | captured`, env `MEND_SESSION_STORE`, default
`colocated`; `captured` requires the network session endpoint, as `kubernetes` mode does today,
`packages/store/src/deployment.ts` L15–33). Per operation:

- `createWorktree` = capture 0: the project base's git packs plus an empty workspace class,
  registered with `n = 0` in the transaction that creates the worktree, lease and chain rows.
- `resetWorktree` = a new capture 0 from the requested base, refused while a lease is live.
- `renameBranch` = a `store_refs` write plus a `plan.get` refresh for the executor.
- `checkpoint` = ask the lease holder over the channel for a `checkpoint` capture and await its
  register CAS; the returned `{ref, sha}` come from the manifest's `checkpoint` field.
- `removeWorktreeForce` = release the lease, mark the chain ended; packs retire by retention.
- `worktreeMount` → `undefined`. Callers already treat absence as a capability gap
  (`docs/DEPLOYMENT-STRATEGIES.md`).

Engine changes, by function (`engine.ts` at `ade9996`):

- `provisionWorkspace` (L2428–2660): `source: { kind: "capture" }` instead of `standby` (L2626),
  which Core lowers to `SEALANT_WORKSPACE_SOURCE=capture`; no `workspaceMounts` for the store, the
  socket dir or the harness home (L2491–2500); `SEALANT_CAPTURE_ENDPOINT` rides `env` and
  `SEALANT_CAPTURE_TOKEN` rides `secretEnv` (L2650) beside `MEND_SESSION_TOKEN`.
- `launchInternal` (L3045–3140): no `bindWorkspace` (L3128) and no linked-project bind in capture
  mode; sealantd materialises the head capture, claims the lease, then the harness starts.
- `takeWorktreeCheckpoint` (L944–975): keeps its shape, drops the advisory lock in capture mode,
  delegates the four git commands to the executor through `sessionRepo.checkpoint`.
- `harvestHarnessState` (L1400–1470): the `exec tar | base64` archive path is retired.
  `harvestFromHarnessHome` (L1584): reads the workspace class of the head capture, streamed — a 76
  MB codex rollout must not be buffered (a 128 MB Worker isolate later).
- `resumeSession` (L3915–3931): `agentIsLive` (L3825) folds process rows and the active run, so
  "already live — attach" holds until the platform observes the death; in capture mode the check is
  lease-aware: a live lease is attach, an expired lease is a pickup, never `session_active`.
- New fibers: lease heartbeat (every 10 s against a 30 s expiry), reaper (expiry → confirmed
  platform termination → replacement claim), replacement-before-cap (≈ 7 h 30 on MicroVMs).
- `hot-pool.ts` and `claimHotSession` (L5351): a standby executor pre-materialises the project base
  and the arch-matched dependency cache; the fingerprint (`hot-pool.ts` L16–63) gains the bulk
  `platform` (`<os>-<arch>-<libc>`) and keeps the base ref out, as it does today; a claim applies
  the delta from the head capture. Join and sibling = a second process in the lease holder, through
  the SDK.

### Replacement and pickup

Death is detected by heartbeat expiry (≤ 30 s) or earlier by a platform probe. Before any
replacement claim Mend confirms termination through the platform (`TerminateMicrovm` then
`GetMicrovm`; `sandbox.destroy()`; Pod delete; `docker inspect` through the SDK locally) and revokes
the session token, as replacement does today (`docs/KUBERNETES.md`). Only then does it claim
(`epoch + 1`), launch anywhere with the head plan, materialise, restore the harness home section
into `$HOME` (the existing relocation, L3300–3330) and resume by provider session id
(`nativeResumeArgv`, L3235). Pickup prefers the newest capture whose git section verifies
(`git_fsck = 'verified'`). Death, the 8 h cap (replacement at ≈ 7 h 30, gated on `capture.shipped`),
sandbox replacement and cross-platform moves are one path; a platform move with a different
architecture reinstalls dependencies under Mend's control (12–15 s, measured). A lost heartbeat on
the executor pauses the agent's process group and a later good heartbeat resumes it; nothing is
killed, so a 30 s Mend outage costs nothing. The lease fences the store, not the world: an agent's
own `git push` or `gh pr create` with a connected-account token is not fenced by a Postgres row.
Stated, not hidden.

### Review

The review page, tours, comments and the `read`/`suggest` passes read the posted change summary
first, stamped **claimed**, and never a live tree. A summary is accepted only for a capture that is
the chain head when `change.summary` arrives; one whose capture never landed is refused and dropped.
A head without a summary renders "compute it" on a runner, never an error. An async job in
`packages/jobs` (`summary-observe`) recomputes the summary on a runner from the capture's git class
and stamps it **observed** before the approve control enables; landing always recomputes. Landing
materialises the checkpoint's git class into a runner cache and pushes with Mend's server-side
credentials (the Mend key or the bridge), never from an executor.

### Retention and compaction

- `checkpoint | suspend | final` captures are kept for the session's life. `auto | turn` are
  thinned: all for 24 h, then one per hour, then checkpoints only.
- Liveness is computed from `captures` rows reachable from `worktree_chain.head_capture` through
  `parent`, plus project base captures — never from objects found in the bucket. A manifest whose
  CAS never ran is off-chain and is swept with its epoch prefix.
- Packs retire through the `packs` table after a **30 min** grace (15 min URL TTL + 5 min
  materialise budget = 20 min, rounded up). CDC packs are rewritten when live bytes fall below a
  threshold; the known-object and known-chunk indexes are regenerated per project.
- Promotion into `projects/<project>/packs/` is a server-side copy of git-class and Mend-made bulk
  packs only; harness-home and `.git`-internals classes never promote.

### Placement per tier

| Tier                                                                             | Bucket                                                                                                       | Executor disk                      | Runner                                                                      | Notes                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single machine, Docker bundle (`compose.yaml` → `deploy/docker/compose.v2.yaml`) | Garage on a Docker volume beside `mend-store`; `FsLive` under `~/.config/mend` for `pnpm dev` without Docker | the container's own disk           | the API process; the cache is the store                                     | bind mount stays the default; captures are opt-in here                                                                                                                                            |
| Dev stack (`compose.dev.yaml`, Postgres only today)                              | a `garage` service (single-node mode, bucket `mend`, S3 on 3900)                                             | Docker                             | API process                                                                 | proves everything with no cloud account                                                                                                                                                           |
| Kubernetes / Talos                                                               | Rook `CephObjectStore` RGW if present, else Garage                                                           | `emptyDir` on node NVMe            | the API Pod with a local-path cache PVC                                     | the RWX `mend-store` claim and `SEALANT_K8S_VOLUME_MAPPINGS` for the store are retired                                                                                                            |
| Cloudflare                                                                       | R2, presigned by the Worker                                                                                  | sandbox disk (`standard-3`, 16 GB) | the `cf` git cell in ops-only mode (`docs/CLOUDFLARE-HOSTED.md` "Git cell") | `SessionObject` hosts the channel and lease alarms; summaries re-key from `changes/<session>/<n>/` to `changes/<worktree>/<n>/`; `keepAlive` while live, SIGTERM flush, `destroy()` only to fence |
| AWS                                                                              | S3 via the gateway endpoint                                                                                  | MicroVM root disk                  | EKS API Pod                                                                 | `microvm` adapter; `/suspend` and `/terminate` flush                                                                                                                                              |

MinIO is not an option: `minio/minio` entered maintenance 2025-12-03 and was archived 2026-04-25
(cited). Garage lacks bucket policies, versioning and conditional writes; the design needs none of
them, because keys are epoch-prefixed, promotion copies and readers verify.

### Security

An executor holds exactly two things: its session token (scope: its own channel routes; lifetime:
the session; revoked at pickup and replacement) and presigned per-key URLs under
`captures/<worktree>/<epoch>/…` with a 15 min TTL. No bucket credentials, no Postgres credentials,
no other epoch's prefix. Its blast radius is its own epoch prefix: a fenced executor's still-valid
URLs name keys the live epoch never reads, and an overwrite inside its own live epoch is self-harm
caught by sha256 at read. Known credential files are excluded from the harness-home class and
re-injected by Core at launch (open question below). The agent's own connected-account tokens are
outside Mend's fence.

## Considered options

- **POSIX store plus a sync engine** (ADR-0015's first receiver). On Cloudflare there is no durable
  POSIX disk, so it becomes this design plus a second receiver; and a file mirror of a full clone
  into a shared bare repo rewinds other worktrees' refs and tears the index from its objects
  (measured: `git commit` fails after a mid-commit snap).
- **Stateful git server.** The 804 MiB dependency pack cannot cross a Worker (413); a capture is two
  pushes into two repos, atomic per push only; the lease check in `pre-receive` runs before the ref
  lock. On Cloudflare it becomes this design.
- **Keep the shared filesystem.** 872 s for one `worktree add` and the incident class of
  2026-08-29/30; and it does not exist on Cloudflare at all.

## Consequences

- Loss on executor death is the small-class cadence: 2 s quiet / 10 s maximum while dirty plus one
  small upload ≈ 2–12 s (estimate). The bulk class is registered independently and reproducible.
- Cold start is bytes at an unmeasured transfer rate: ≈ 25–40 s Mend-size, ≈ 30–55 s
  `nodejs/node`-size at 50–100 MB/s (estimate; R1 in the decision record measures it). Hot-pool
  start and pickup ≈ 10–15 s (estimate). Warm runner git ops are today's numbers (diff 3 ms, status
  5 ms Mend; 16–17 / 67 ms node, measured).
- Storage: ≈ 5 GB per 100 Mend sessions against ≈ 314 GB of worktrees (measured sizes, per-session
  figure an estimate); one dependency cache per architecture adds ≈ 815 MB per project.
- Cost: executor compute is 60–90 % of every bill and independent of this decision; the storage tier
  is 1–2 %. Cloudflare's lack of a suspend state adds ≈ $5/user/month idle or a cold return
  (estimate, decision §2.6).
- Every "live worktree" read in Mend becomes a capture read behind the runner; the compactor,
  retirement, quotas and the observed pass are new subsystems Mend owns. 16–24 engineer-weeks end to
  end (estimate).
- The shared-filesystem incident class disappears by construction; failure modes are rows in
  Postgres, not `dmesg`.
- The hot pool of ADR-0001 stays; nothing worktree-shaped enters its fingerprint, but the executor's
  architecture now does.

## Open questions

Human decisions from the decision record that touch Mend, unchanged here:

1. Dependency trees: work product (captured per session, bulk bytes, cross-session supply chain) or
   reproducible (Mend-controlled installs only, reinstall on mismatch, 12–15 s)?
2. Cloudflare idle policy: `keepAlive` while a human thinks, or capture-and-destroy on settle and a
   25–40 s cold return?
3. Cadence and retention budget: 2 s / 10 s and 24 h of `auto` captures (≈ $37–50/month of request
   fees at 100 users) or 5 s / 30 s at twice the loss window?
4. Credential files: exclude `.claude/.credentials.json` and `.codex/auth.json` and rely on Core's
   re-injection, or capture them?
5. Transcripts in a bucket: provider encryption or a Mend-held key; retention of `auto` captures
   holding transcripts; one bucket with prefix isolation or one per tenant.
6. Local mode: shadow captures from day one, or the bind mount as the only local path?
7. Per-project dependency caches shared across users within an organisation when only Mend-made
   installs may produce them?
8. Interim: is the `cf` branch's "a replaced sandbox is a stopped session with its last checkpoint
   intact" acceptable while this is built?

## Decisions made here

Mend-side details the decision record left open, decided in this ADR:

1. The summary table is `capture_summaries`, not `changes`: `changes` already names the reviewable
   change (`migrations.ts` L31, `schema/workbench.ts` L148).
2. One migration, `0053_capture_store`, in the existing `"NNNN_name"` record of `migrations.ts`;
   drizzle definitions in `schema/workbench.ts`; repositories `repos/capture-store.ts` (leases,
   chain, captures, packs, summaries) and `repos/store-refs.ts`.
3. `captures` stores `manifest_key`, `n`, `parent`, `epoch`, `seq`, `kind` and `git_fsck`; its `id`
   is ADR-0015's capture id (sha256 of the manifest bytes).
4. `checkpoints` gains a nullable `capture_id`; the row is inserted after the register CAS returns.
5. `CheckpointsRepo.withWorktreeLock` (advisory lock) is bypassed in capture mode; the CAS
   serialises.
6. Lease and chain rows are created with the worktree row and capture 0, in one transaction.
7. Lease release is `expires_at = now()` under the holder's epoch; `NULL` means never claimed.
8. Heartbeat every 10 s against the 30 s expiry; the reaper ticks every 10 s.
9. A second executor for a leased worktree is refused with `worktree_leased` (409).
10. `DeploymentConfig` gains `sessionStore: colocated | captured` (`MEND_SESSION_STORE`), orthogonal
    to `mode`; `captured` requires the network session endpoint.
11. Bucket configuration: `MEND_BLOB_STORE` (`dir://` or `s3://`) plus `MEND_BLOB_STORE_PUBLIC_URL`
    for the host presigned URLs name.
12. The runner cache lives at `<MEND_STORE_ROOT>/_cache/runner/<project>/repo.git`, LRU by project;
    on Kubernetes that path is the local-path cache PVC.
13. `SessionRepositoryCapturedLive` lives in `packages/sessions/src/session-repository-captured.ts`
    and is selected at the layer boundary in `apps/api`.
14. The observed recompute is a `packages/jobs` job named `summary-observe`.
15. The dev stack's Garage service runs in single-node mode with bucket `mend` on port 3900.
16. Pickup prefers the newest capture with `git_fsck = 'verified'`; the chain head is unchanged by
    that choice.
17. Blame and log are runner operations; `Store` has neither today.
18. Cloudflare summaries re-key from `changes/<session>/<n>/` to `changes/<worktree>/<n>/`.
19. `SEALANT_CAPTURE_ENDPOINT` / `SEALANT_CAPTURE_TOKEN` are aliases of `MEND_SESSION_ENDPOINT` /
    `MEND_SESSION_TOKEN`: one token row, delivered under both names.
