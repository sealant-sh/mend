# Session capture store: leases per worktree, executor replacement, capture-backed SessionRepository

Status: accepted 2026-09-12; amended 2026-09-13 by decisions 2, 6, 8 and 9 (marked "amended
2026-09-13" below): captures everywhere from day one, dependency trees captured with a per-project
shared cache fed only by Mend-controlled installs, credential files (decision 6, corrected
2026-09-18: the daemon excludes them). Cross-repo: sealantd ADR-0015 (capture engine, pack kinds,
cadence — being amended in parallel; this ADR references it and does not restate the format),
Sealant Core (`capture` workspace source, `microvm` adapter, bridge `stop()`), Mend (everything
below). Supersedes the co-located store invariant of `docs/DEPLOYMENT-STRATEGIES.md` and
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
atomic across files (ADR-0015 accepts the tear; the next capture corrects it). Amended 2026-09-13
(decision 8): there is no co-located mode. The capture store is the only session store on every
tier, `local` included — the bind-mounted worktree is not kept as a degenerate case. The co-located
adapters (`SessionRepositoryLocalLive`, `WorktreeReadsColocatedLive`, `CaptureRuntimeOff`) survive
one release behind `MEND_SESSION_STORE=colocated`, warned at start, for installs that have not
moved; they are scheduled for removal with their tests.

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
session" is amended to say worktree. Amended 2026-09-30: a launch waits before it is refused (see "A
launch waits for the worktree's previous executor" below). Accepted relaxation for later, if
refusing hurts: a second session on a busy worktree may get its own executor holding a read-only
copy that cannot capture; only the lease holder writes. It changes nothing in storage.

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
  `created_at`, `sections.git.{packs, refs, head, fsck}`,
  `sections.workspace.{root, packs, format?, dir_packs?}`,
  `sections.bulk.{root, packs, platform, format?, dir_packs?} | "pending"`,
  `sections.other_bulk?.<platform>` (each a ready bulk section: decision 29), and
  `checkpoint?.{ordinal, sha, ref}` (section formats: decision 28). The capture id is the sha256 of
  the manifest bytes; the manifest does not carry it. Key layout, fixed with ADR-0015:
  `captures/<worktree>/<epoch>/packs/<sha256>` (a git pack's index at `packs/<sha256>.idx`),
  `captures/<worktree>/<epoch>/trees/<sha256>` (dir objects),
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
  session's quotas (bytes: `max(8 GiB, 4× the project's compressed footprint)`, priced once per
  object key — a sized batch past it is refused here with 413
  `{reason: "byte-quota", limit, used, requested}` before any URL is minted, and `capture.register`
  backstops what landed unsized with 409 of the same body — amended 2026-09-14, decision 27;
  requests: 600 `upload.urls` calls per hour of at most 1,000 keys each — amended 2026-09-14,
  decision 25; before it, 2,000 presigned URLs per hour).
- `capture.register`: the CAS; 409 on a stale epoch or a wrong parent; a register that finds the
  chain already at `n` with the same capture id is a lost ack, answered as success.
- `change.summary`: after a `checkpoint` register returns; accepted only against the chain head.
- `lease.heartbeat`: every 10 s; zero rows = lost. The executor pauses its agent (`SIGSTOP`) on any
  409 or after 30 s without a successful heartbeat, and resumes it (`SIGCONT`) if a later heartbeat
  succeeds with the same epoch; it never kills.

Stored objects are write-once (cross-repo decision 19, review 2026-09-28 (6) #9, amended
2026-09-28). Every PUT URL has `If-None-Match: *` signed into it (sealantd already sends the header,
so an upload without it fails the signature). `upload.urls` never mints a URL for a key the bucket
already holds. It reads that object and checks it against its name first: a pack, dir pack, tree or
manifest must hash to its sha256, and a git pack index must checksum to its own trailer and name its
pack's checksum. The key then comes back in `present` (an object that does not match is a 409), but
only to an executor whose `plan.get` listed `present` in `upload_answers` (cross-repo decision 20,
review 2026-09-28 (7) #7, amended 2026-09-28): a daemon from before it requires a URL for every key,
so it gets one write-once PUT URL for the verified key, as before, and reads the 412 of a bucket
that honours the precondition as uploaded. A completed multipart upload never lands over an existing
key. What Mend has already checked about a key's bytes (payload reads, dir packs, pack indexes) is
kept per store identity and only trusted once no URL could replace those bytes
(`BlobStore.replaceableUntil`). The directory store publishes objects read-only. How backends answer
a conditional PUT over an existing key, measured 2026-09-28:

| Backend                  | Conditional PUT / complete over an existing key | What Mend relies on                                                                                                                                                      |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS S3                   | 412 (its documentation; not measured here)      | the bucket refuses                                                                                                                                                       |
| Cloudflare R2            | 412 (its documentation; not measured here)      | the bucket refuses                                                                                                                                                       |
| MinIO RELEASE.2025-09-07 | 412, bytes kept (measured)                      | the bucket refuses                                                                                                                                                       |
| Garage v2.4.1            | 200, bytes **replaced** (measured)              | no URL for a present key; a HEAD before each complete; payload checks not trusted while a URL for the key could still be used (15 min TTL, and 15 min after Mend starts) |

Mend measures this once per bucket with a probe key (`mend-probes/write-once/<uuid>`, deleted
afterwards) and never assumes it. On Garage a URL handed out for a key that was still absent (or a
legacy URL for a present one) can replace the object until that URL expires. So before any upload
URL leaves Mend, the latest expiry under its worktree epoch is recorded (`capture_put_authority`,
migration 0089, with five minutes' allowance for the bucket's clock), and a seal of that epoch does
not stand while such a URL, or one minted before this Mend process started, could still be used
(review 2026-09-28 (7) #8, amended 2026-09-28). Once none can, every object the sealed capture names
is read back — each hashes to its name, and each git pack passes `index-pack --verify` with the
index stored beside it — before the seal stands (`capture_seals.reverified_at`); an object that
reads back as other bytes voids the seal for good (`capture_seals.void_reason`). On a bucket that
refuses overwrites a seal stands as recorded. The cost on Garage: a seal stands up to twenty minutes
after the last URL of its epoch, and a drain whose final answer was lost waits that long.

The manifest and summary travel over the channel; bulk bytes never do. Presigned URLs carry the host
the executor resolves (`MEND_BLOB_STORE_PUBLIC_URL`: the Docker network name of the bucket, the
cluster Service, the R2 S3 endpoint), never `localhost`.

### `SessionRepositoryCapturedLive`

Same port, `packages/sessions/src/session-repository-captured.ts`, selected at the layer boundary by
`DeploymentConfig.sessionStore` (`colocated | captured`, env `MEND_SESSION_STORE`, default
`colocated`; `captured` requires the network session endpoint, as `kubernetes` mode does today,
`packages/store/src/deployment.ts` L15–33). Per operation:

- `createWorktree` = capture 0: the project base's git packs plus an empty workspace class,
  registered with `n = 0` in the transaction that creates the worktree, lease and chain rows. The
  workspace class stays empty of `.git` bookkeeping on purpose (amended 2026-09-14, decision 26):
  the daemon materialises the repository from the git section and, since sealantd
  `fix/capture-tracked-ignored`, protects `.git/index` itself — Mend ships no index for it to keep.
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
  the SDK. Amended 2026-09-13 (how it is built, `packages/sessions/src/hot-pool.ts` "Capture-mode
  standby"), revised the same day for SDK 0.31.0 / sealantd 0.15: a standby is launched with the
  `capture` source and no worktree id, and the channel answers its `plan.get` with the project's
  base plan — the default branch's base pack, an empty workspace class, the shared dependency cache
  for the executor's platform when the request names one — under the placeholder name
  `standby-<hot workspace id>` and a synthetic epoch (the standby row's creation time in ms), which
  the daemon takes from the answer. At claim Mend makes sure capture 0 exists, claims the worktree's
  lease at a fresh epoch with the executor as holder, and the launch calls
  `workspace.capture.replan()`: the daemon asks `plan.get` again with no worktree named, is answered
  the claimed worktree, its epoch and its head, delta-materialises the head over the base on its
  disk and captures under that identity from then on. A standby therefore serves any worktree —
  fresh, joined, picked up — and nothing about the placeholder outlives the replan. (Before the
  revision the same day: the lease was claimed at the standby's synthetic epoch, the placeholder
  stayed an alias of the worktree for the executor's life, and only a worktree at capture 0 from the
  standby's base could be served.)
- Files the co-located store writes beside the mounted harness home (amended 2026-09-25): a pasted
  image and the owner's skills never reached a captured executor, which mounts nothing. They go into
  the live workspace's harness home through `exec` instead, at the same paths: the image when it is
  pasted (`SessionEngine.storePastedImage`; no live workspace answers `SessionNotLive`), the skills
  in `launchInternal` once the harness home is relocated, cold or claimed. The bytes ride argv as
  chunked base64 (`packages/sessions/src/workspace-files.ts`) until the SDK can write a file
  (PLATFORM-FEEDBACK.md, "A file into a workspace").

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

### A launch waits for the worktree's previous executor (amended 2026-09-30)

On alpha a session started 15 s after another in its worktree ended was refused at once
(`worktree leased · … saving before it ends · start again once it has`); the save finished 15 s
later. A save takes 10–60 s on S3 and about 10–20 minutes on Garage, so every quick restart hit
this. A launch now waits instead. While the lease holder is `ending` (it is saving before it ends),
`unreachable` or `lapsed`, the launch looks at it again every 5 s. The session meanwhile reads
`starting · waiting · the previous session in this worktree is saving` (or `… is not answering`,
`… has not confirmed its end`). The launch goes on only on what a retry by hand would go on: the
lease `free`, released once the holder's end was confirmed as above, or `held` by a reachable
executor it joins. Nothing is stopped and nothing is taken for ended. Past the bound (30 min,
`MEND_LAUNCH_LEASE_WAIT_SECONDS`) the launch is refused with `worktree_leased` as before, the
message ending `· waited N min`. An owner's stop while it waits launches nothing
(`launch_cancelled`).

### A launch answers promptly (amended 2026-09-30)

A launch used to hold its HTTP request for its whole course, an image build included (~8 min after a
recipe change). Clients gave up (the CLI at ~5 min, with a false "cannot reach the Mend server"),
and a client that went away interrupted the launch wherever it stood: after the agent started and
before its process row and `running` were written, so a running agent's session read `starting` with
`started_at` null for good. Now every launch verb runs in the engine's lifetime, not the caller's.
`POST /sessions/:id/launch` answers within 30 s: with the launched session, or with the session as
it stands (`starting`). Its summary then says where the launch is:
`waiting · the previous session in this worktree is saving`,
`preparing the workspace · no runtime yet · after an update, building the image takes about 8 minutes`,
or `booting`. Until 2026-10-02 the middle one said `building the workspace image …`, a build Mend
cannot observe. The launch goes on to `running`, or settles `failed` with the reason. The account's
launch slot is held until the launch ends, not until the answer. Mend infers "building" from what
the platform reports: no executor 20 s after the create was accepted. SDK 0.38.0 reports no build
state (PLATFORM-FEEDBACK.md 2026-09-30).

### Stop drains, then terminates

Amended 2026-09-27. Nothing an executor holds is lost to a stop Mend asks for: no compute holding a
session goes away while it holds work product that was not shipped, source and git-ignored bulk
alike, and a resumed session is byte-identical. Only an unannounced hard crash may cost the last
cadence window.

- **Drain.** A stop, an idle stop, a relaunch (a fresh resume replacing the workspace) and a
  replacement ahead of the cap each drain first (`drainThenTerminate`): a **final** flush, record
  what is left on the session, repeat, with no short deadline. A final flush quiesces first:
  sealantd stops admitting processes, ends the running ones, then snapshots the small and the bulk
  class and ships. The executor terminates only on the executor's own `complete: true` with nothing
  pending, fenced or refused; an empty queue alone is not proof. An answer without `complete` (SDK
  0.37.2 cannot ask for the final kind) reads
  `not saved · final flush not reported · workspace kept`; an incomplete one names sealantd's
  reason. A drain that is not forced yields to a process or Service in the workspace before its
  first final flush, never after. While it drains the session reads `stopping · saving · N left`
  (bytes once sealantd reports `pending_bytes`) on the web, in the CLI, on the phone and in Slack,
  and the workspace is kept. The intent is a row on the session, so a restart takes the drain up
  again; a relaunch records the launch it was asked for beside it — the harness, or the exact argv,
  protocol start and opening prompt with a correlation id — so a restart between the terminate and
  the launch finishes it, launching and asking the opening turn exactly once (0077). A shutdown
  interrupts a drain's waiters rather than reading as `kept`. The owner's stop wins over a relaunch
  or a replacement under way: the drain finishes and the executor ends, and nothing launches after
  it, here or after a restart.
- **Channels outlive the session's status.** A stopped session still drains, so its executor's
  channel is registered for as long as a drain runs or it holds the lease, and again on every boot;
  a restart mid-drain never leaves the executor refused.
- **Discard asks for a discarding stop.** The owner's discard sends a stop that does not drain; if
  the platform keeps the workspace anyway, nothing is discarded and the session says so.
- **Executor lost reads as lost; saved reads as saved.** An agent whose executor went away without
  Mend asking (a SIGKILL, `docker stop`, a lost machine) reads what was observed. When the chain's
  last registered capture is the executor's own final one (sealantd takes it after it stopped
  admitting processes and ended the running ones on SIGTERM), taken by this executor, with its bulk
  section captured and nothing Mend read pending after it, the session settles
  `stopped · stopped outside Mend · saved at HH:MM:SS UTC`. Otherwise it settles
  `failed · executor lost · last saved HH:MM:SS UTC · changes after that were not saved`, never
  `completed`, and adds `· N pending at HH:MM:SS UTC` only when Mend read the executor's queue after
  that save. Mend never states a count it did not observe.
- **A stop is not settled while its workspace runs.** A session whose stop drain holds its workspace
  reads `stopping` (with `saving · N left`, or `not saved · … · workspace kept`) and is not settled;
  it settles once the platform reports the workspace terminated or gone.
- **A kept drain backs off.** Every round is a final flush, and a final flush registers captures.
  The reaper looks at a kept drain again after 10 s, doubling to 5 min while nothing about it
  changes (the reason, what is pending, the head, the workspace), and at once when something does.
- **A launch that ran no executor frees the worktree.** When the create never reached the platform,
  the launch's own lease claim is released.
- **Ending means ending.** An executor Mend sent a final flush to admits nothing after it: no join,
  no shell, no resume and no retained-workspace launch goes into it again. The next run is a fresh
  executor.
- **Stall.** A drain that moves nothing for `MEND_CAPTURE_DRAIN_STALL_SECONDS` (or cannot move:
  fenced, refused) is recorded as `not saved · N pending · workspace kept`, the owner is told once,
  and the workspace stays; the next sweep tries again, backing off while nothing changes. A relaunch
  behind it is refused. Only the owner's "discard unsaved and stop" (confirmed in the request,
  recorded as a control event and in the organization's audit log) terminates with captures pending.
- **Idle.** The idle stop holds while captures are pending or bulk is dirty (`capture` hold), then
  stops through the same drain.
- **The cap.** A planned drain starts at `deadline − (lead + margin)`, the deadline from the
  platform once the SDK reports it, else `MEND_EXECUTOR_MAX_SECONDS` counted from the executor's own
  start (not the latest run's), else the 7 h 30 fallback. The lead is the configured drain estimate,
  or what is pending at the executor's observed throughput (bytes uploaded and captures registered
  per second, from its flush answers) when that is longer.
- **The lease** is released only after the platform reports the workspace terminated (a terminal
  status or a 404); unobserved, it lapses with the heartbeats. A release clears the holder; a lapse
  does not. No other executor claims a worktree over a lapsed lease: Mend first confirms the holder
  ended (a terminal status, a 404, or no session row left to register under) and releases it.
- **Removal holds.** Deleting a worktree or a project deletes the rows an executor registers under.
  Both are refused while a drain runs, a drain kept its workspace, an executor was not observed to
  end, or a lease is held; `force` overrides unlanded work, never unsaved work. The session that
  owns an executor stays while another session works in it.
- **Dead means dead.** An executor is dead only on a terminal status or a missing workspace. A Core
  error is `unknown`: no pickup, no fence, look again. An executor that answers with its lease
  expired is paused: a resume waits for it and stops nothing.
- **Handoffs** read the head once the small captures are in; bulk still uploading holds only a stop
  (once sealantd reports `pending_bulk`).
- **Landing** checkpoints only once the executor's captures caught up (a flush that registered what
  it holds, or a known absence of any executor that could hold more) and lands exactly that
  checkpoint's capture. Unknown is never caught up: the landing says so and pushes nothing.
- **Turns and the idle stop** serialize on one per-session lock: a turn asked after the idle stop's
  claim is refused (the next message resumes the session), and a queued turn keeps the claim away.
- **Removal** of a session whose workspace is up is recorded and happens after the workspace has
  gone, so the workspace is never left unaddressable.

What waits on the platform (PLATFORM-FEEDBACK.md 2026-09-27): the runtime deadline, a final flush
that snapshots bulk with a deadline and no 10 s clamp, `pending_bytes` / `pending_bulk` / `refused`
on the status, and Core's reapers draining before they terminate.

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
  materialise budget = 20 min, rounded up). The grace protects uploads in flight, not new
  references: a register and a retention pass meet on the chain's guard (decision 30). CDC packs are
  rewritten when live bytes fall below a threshold; the known-object and known-chunk indexes are
  regenerated per project.
- Promotion into `projects/<project>/packs/` is a server-side copy of git-class and Mend-made bulk
  packs only; harness-home and `.git`-internals classes never promote.
- Amended 2026-09-13 (decisions 2 and 9): dependency trees are **work product** — the bulk class is
  captured per session like any other bytes — and the per-project **shared cache**
  `projects/<project>/cache/<platform>/` is written by exactly one writer, the Mend-controlled
  install job (`packages/jobs/src/dependency-install.ts`): a session Mend launches itself to run the
  project's install command, whose final capture's bulk section is promoted by server-side copy
  (`packages/sessions/src/dependency-cache.ts`). A session capture never promotes into it, so one
  session's dependency tree can never become another's supply chain. Standby executors and cold
  launches read from it; on a platform mismatch or an empty cache the engine runs the install
  command in the workspace before the harness starts. The install command is a per-project setting
  (`projects.install_command`), detected from the base tree's lockfile when unset.

### Placement per tier

| Tier                                                                             | Bucket                                                                                                                                                            | Executor disk                      | Runner                                                                      | Notes                                                                                                                                                                                             |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single machine, Docker bundle (`compose.yaml` → `deploy/docker/compose.v2.yaml`) | Garage on a Docker volume beside `mend-store` (`mend-garage`, ≈ 7.5 MiB idle, measured 2026-09-13); `FsLive` under `~/.config/mend` for `pnpm dev` without Docker | the container's own disk           | the API process; the cache is the store                                     | the only store (decision 8); setup lays Garage out once; executors need the Compose network (Core follow-up)                                                                                      |
| Dev stack (`compose.dev.yaml`, Postgres only today)                              | a `garage` service (single-node mode, bucket `mend`, S3 on 3900)                                                                                                  | Docker                             | API process                                                                 | proves everything with no cloud account                                                                                                                                                           |
| Kubernetes / Talos                                                               | Rook `CephObjectStore` RGW if present, else Garage                                                                                                                | `emptyDir` on node NVMe            | the API Pod with a local-path cache PVC                                     | the RWX `mend-store` claim and `SEALANT_K8S_VOLUME_MAPPINGS` for the store are retired                                                                                                            |
| Cloudflare                                                                       | R2, presigned by the Worker                                                                                                                                       | sandbox disk (`standard-3`, 16 GB) | the `cf` git cell in ops-only mode (`docs/CLOUDFLARE-HOSTED.md` "Git cell") | `SessionObject` hosts the channel and lease alarms; summaries re-key from `changes/<session>/<n>/` to `changes/<worktree>/<n>/`; `keepAlive` while live, SIGTERM flush, `destroy()` only to fence |
| AWS                                                                              | S3 via the gateway endpoint                                                                                                                                       | MicroVM root disk                  | EKS API Pod                                                                 | `microvm` adapter; `/suspend` and `/terminate` flush                                                                                                                                              |

MinIO is not an option: `minio/minio` entered maintenance 2025-12-03 and was archived 2026-04-25
(cited). Garage lacks bucket policies, versioning and conditional writes; the design needs none of
them, because keys are epoch-prefixed, promotion copies and readers verify.

### Security

An executor holds exactly two things: its session token (scope: its own channel routes; lifetime:
the session; revoked at pickup and replacement) and presigned per-key URLs under
`captures/<worktree>/<epoch>/…` with a 15 min TTL. No bucket credentials, no Postgres credentials,
no other epoch's prefix. Its blast radius is its own epoch prefix: a fenced executor's still-valid
URLs name keys the live epoch never reads, and an overwrite inside its own live epoch is self-harm
caught by sha256 at read. Amended 2026-09-13 (decision 6), **corrected 2026-09-18**: decision 6 said
credential files the harness writes into its home (`.claude/.credentials.json`, `.codex/auth.json`)
are captured with the harness-home class, that nothing excludes them on either side, and that a
pickup therefore resumes a logged-in harness without Core re-injecting anything.

That is not what the daemon does. sealantd names those two paths in
`crates/sealant-capture/src/index.rs` (`CREDENTIAL_FILES`, citing its own ADR-0015 open question 2),
filters them out of the capture listing in `roots.rs`, classifies them as `None` in the watcher in
`watch.rs`, and asserts the exclusion in a test. **Credentials are not captured**, and never were on
the daemon side. So the bucket does not hold a session's provider login, and the paragraph about
at-rest encryption and client-side encryption describes a risk this store does not carry.

What follows from the correction, rather than from the decision: because a capture carries no
credential, a pickup depends on the platform injecting the credential into the new workspace again.
Core does inject it at launch (`connected_accounts` → a 0600 file at
`$HOME/.claude/.credentials.json`), but that every pickup path re-injects before the harness reads
it is **unverified** — it needs a forced-kill pickup with an expired access token to prove. Until
then, treat a resumed harness's login as something to observe, not something the chain guarantees.

Whether exclusion is what Mend _wants_ is a separate question, still open: capturing a credential
would survive a pickup without the platform, and would put a refresh token in the bucket. The
daemon's behaviour decides today's answer; changing it is a decision for both repos, not a
documentation edit. The agent's own connected-account tokens are outside Mend's fence either way.

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
- Amended 2026-09-13: an install adopted before captures has worktrees with a directory and no
  chain. They are backfilled on first use: the first capture-mode launch or resume of a session in
  such a worktree registers capture 0 from the directory's current files (a final co-located
  checkpoint of it) rather than from the base, so uncommitted work is carried into the bucket; no
  separate migrate step (`SessionRepositoryCapturedLive.attachWorktree`).

## Open questions

Human decisions from the decision record that touch Mend, unchanged here:

1. ~~Dependency trees: work product or reproducible?~~ Decided 2026-09-13 (decisions 2 and 9):
   captured per session as work product; the shared cache is fed only by Mend-controlled installs; a
   mismatch reinstalls under Mend's control.
2. Cloudflare idle policy: `keepAlive` while a human thinks, or capture-and-destroy on settle and a
   25–40 s cold return?
3. Cadence and retention budget: 2 s / 10 s and 24 h of `auto` captures (≈ $37–50/month of request
   fees at 100 users) or 5 s / 30 s at twice the loss window?
4. ~~Credential files: exclude or capture?~~ Decided 2026-09-13 (decision 6): captured; see
   "Security".
5. Transcripts in a bucket: provider encryption or a Mend-held key; retention of `auto` captures
   holding transcripts; one bucket with prefix isolation or one per tenant.
6. ~~Local mode: shadow captures or the bind mount?~~ Decided 2026-09-13 (decision 8): captures
   everywhere from day one; no co-located mode.
7. ~~Per-project dependency caches shared across users?~~ Decided 2026-09-13 (decision 9): one cache
   per project and platform, written only by the install job.
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
9. A second executor for a leased worktree is refused with `worktree_leased` (409), once a launch
   has waited up to `MEND_LAUNCH_LEASE_WAIT_SECONDS` (default 30 min) for the holder to end
   (2026-09-30).
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
20. (2026-09-13) `MEND_SESSION_STORE` defaults to `captured`; `colocated` is deprecated, warned at
    start, and removed with its adapters and tests in a follow-up release.
21. (2026-09-13) Epochs are strictly increasing per worktree. Revised the same day for SDK 0.31.0: a
    standby claim takes the next epoch like any other claim (`claim`); the synthetic epoch a standby
    booted under is replaced at its replan, and `claimAs` is gone.
22. (2026-09-13) A standby executor's placeholder name is `standby-<hot workspace id>` — the
    identity its base plan is answered under. Revised the same day for SDK 0.31.0: the standby is
    launched with no worktree id, the replan at claim moves it onto the worktree, and the session
    serves no alias.
23. (2026-09-13) The shared dependency cache lives at `projects/<project>/cache/<platform>/` (`root`
    names the bulk root dir object; packs beside it); `packs` rows carry `platform` and a null
    `worktree_id`. Only `dependency-install` writes it.
24. (2026-09-13) Legacy worktrees are backfilled at first capture-mode use, not by a migrate step.
25. (2026-09-14) The request quota counts `upload.urls` calls (600 per session per rolling hour),
    each of at most 1,000 keys; bytes are bounded at register (decision above, 4× the footprint).
    Keys are content-addressed dir objects and packs — the first bulk capture of a Mend-size
    repository is 20,495 dir objects for 134,741 files, shipped 500 keys per call — so a per-key URL
    quota only ever refused a large tree, which is what happened on the cluster.
26. (2026-09-14) Capture 0's workspace class carries no `.git` bookkeeping; the daemon protects
    `.git/index` on its own (sealantd `fix/capture-tracked-ignored`). Mend's own check of a git
    section is `index-pack --verify` plus a connectivity walk of the refs it names, recorded in
    `captures.git_fsck` for `checkpoint|turn|suspend|final` at register and for `auto` at the first
    plan that would restore it; the executor's `fsck` claim is never recorded as verified.
27. (2026-09-14) The byte quota is enforced at `upload.urls`, before a URL is minted, from the sizes
    the call declares: a batch that would take the session past
    `max(MEND_CAPTURE_BYTE_QUOTA_FLOOR = 8 GiB, 4× the project's compressed footprint)` is refused
    whole with 413 `{reason: "byte-quota", limit, used, requested}`, so refused bytes never land. A
    key is priced once — reserved at its declared size, replaced by the size the bucket reports when
    a register names it — so a manifest re-listing an epoch's packs and a retry of a batch cost
    nothing again, and the count grows only with new objects. `capture.register` keeps the check as
    the backstop for keys the daemon sends no size for (its single PUTs) and answers 409 with the
    same body, a refusal of that capture rather than a transport failure. The 512 MiB floor before
    this contradicted decision 2: the first bulk capture of Mend's own `node_modules` is 775 MB
    across 134,103 files (cluster, 2026-09-14), which the executor uploaded in full before a
    register-time 413 it then retried every 5 s. sealantd today classifies the 409 as a conflict and
    the 413 as a protocol error — both stop the shipping pass, neither drops the entry, so the
    worker re-attempts it on every tick (`PLATFORM-FEEDBACK.md` 2026-09-14). Bytes that landed
    before a register refusal are off-chain under a live epoch; the retention pass sweeps them once
    that epoch is fenced by a later claim, not before.
28. (2026-09-27) Chunked sections carry a `format` (sealantd PR #99, "Dir packs"). Format 1, the
    field absent, is one object per directory at `…/trees/<sha256>`, `root` and `child` being keys:
    every capture before this. Format 2 packs a section's dir objects into dir packs — the CDC pack
    container, one entry per dir object, keyed `…/packs/<sha256>` and listed in `dir_packs` — and
    names `root` and `child` by digest; one manifest can hold one section of each, since a capture
    carries the bulk section below it until the next bulk snap. Measured on alpha, a pnpm
    `node_modules` was ≈ 20,860 dir objects, one PUT each (24 minutes); dir packs make it a few.
    Every reader in `captures.ts` reads both; a format above 2 does not decode, so register refuses
    it. Register HEADs, prices and records dir packs like any pack, and checks a format-2 root is a
    digest. Both `plan.get`s answer `manifest_format: 2` (`MEND_CAPTURE_MANIFEST_FORMAT=1` rolls
    executors back to format 1; reading both never switches off), and sealantd writes format 2 only
    for that answer. Retention keeps `dir_packs` through `keysOfSections` and the `packs` rows, and
    keeps every `trees/` object under the prefix of a live format-1 root: a root names its children
    by key under its own epoch prefix, and only the root is on the row, so a carried format-1
    section under a fenced epoch lost its subtree to the sweep before this. The dependency cache
    copies a format-2 section's dir packs as it copies packs and keeps its root.
29. (2026-09-27) A manifest carries the bulk sections captured on other platforms
    (`sections.other_bulk`, keyed by `<os>-<arch>-<libc>`, sealantd PR #101), absent when empty so
    every manifest before it is unchanged byte for byte. Before, an executor answered `"pending"`
    for a head built on another platform dropped that tree from its next capture, and a session
    moved from arm64 to amd64 and back reinstalled on both. `plan.get` answers an executor that
    names its platform the head's `bulk` when it was captured there, else `other_bulk[platform]`
    (its packs, dir packs or format-1 dir objects presigned), else `"pending"` — never another
    platform's tree (`bulkSectionFor`); `other_bulk` itself is answered as stored, since sealantd
    reads what it carries on from the stored head. Register validates every entry like a bulk
    section (keys, format, a format-2 root digest with its dir packs). An entry the parent capture
    already holds, as its `bulk` or in its `other_bulk`, was HEAD-ed, priced and recorded when it
    was first registered and is not asked about again; an entry the parent does not hold is HEAD-ed
    and recorded under its own platform like a bulk section. Retention keeps every pack, dir pack
    and format-1 `trees/` prefix an entry of a live row names, under fenced epochs too. The engine's
    install decision reads the head's tree for the executor's platform the same way, and the
    dependency cache serves a record only for the platform it names and promotes only a head's own
    `bulk`.
30. (2026-09-27) A register acknowledges only a capture Mend can restore, and retention never
    deletes what a register it did not see has named (review 2026-09-27, findings 4, 16, 19).
    - **Register and retention meet on the chain's guard** (migration 0076). Before, retention
      computed its live set, a final capture then registered naming packs only a thinned capture had
      named, and retention deleted them: the new head read `BlobNotFoundError`. Now every register
      reads `worktree_chain.guard` for each chain whose objects it names (its own, and the owner of
      any `captures/<other>/` key) together with `capture_tombstones`, checks the bucket, and lands
      its CAS only while each guard still reads so, bumping each. Retention reads a chain's guard
      before its rows, and tombstones what it would delete in one statement that lands only while
      that guard still reads what it read, bumping it; then it retires the pack rows and deletes the
      bytes, then marks the tombstones deleted. Each statement re-reads the chain row after a
      concurrent writer's lock, so of a register and a condemnation that raced, exactly one lands: a
      register that read before the condemnation misses (`guard_moved`) and reads again; a
      condemnation that read before a register misses and keeps everything until the next pass. A
      register naming a tombstoned key is refused (422 `missing-objects`) while the bytes may still
      be going; once they are gone, a register that sees them uploaded again (a HEAD after the
      tombstone read) lifts the tombstone with its CAS and walks the tree it revives. A format-1
      `trees/` prefix is tombstoned as a key, since a register names the root and not the dir
      objects below it. No advisory lock and no multi-statement transaction: every write is still
      one statement.
    - **Register checks restorability before it acknowledges.** Every chunked section the capture
      brings — one its parent did not hold, or one naming a key it revives — is walked: the root and
      every dir object where the section says (by key in format 1, in the listed dir packs in format
      2), every entry well formed and uniquely named, every chunk in a listed pack (read from the
      packs' trailing indexes by ranged GET, cached by key), chunk sizes adding up to each file's
      size, every hardlink member's canonical path a file of its size inside the class. A failure is
      422 `unrestorable` (or `missing-objects` naming the key); nothing is registered. A section
      carried unchanged from the parent is not walked again: the parent was checked when it
      registered, and as the head it keeps its objects alive. Measured on a synthetic pnpm-sized
      tree (21,211 dir objects, 126,000 files, 32 packs, 3 dir packs, local disk): 0.87 s cold, 0.61
      s warm (`packages/store/test/capture-verify-measure.test.ts`, `MEND_MEASURE_VERIFY=1`).
    - **A hardlink member reads as its canonical member** (`readCaptureFile`): the member carries no
      chunks, and the reader used to stream zero bytes successfully. It now resolves the target from
      the class root (no absolute path, no `..`, no loop), streams the canonical member's chunks,
      and fails the stream when the bytes read differ from the entry's size.
    - **`plan.get` hands a head only to an executor that reads it.** The request carries
      `manifest_format`, the highest section format the executor reads (absent = 1). A plan whose
      workspace or answered bulk section is format 2 is refused to an executor below it — 409
      `manifest-format`, before the claim, so the lease, the epoch and the head are untouched —
      because an older reader takes the digest for a key and can rewrite git state before it fails.
      The answer's `manifest_format` is the configured one capped at what the executor reads, so
      nothing writes format 2 until sealantd says it reads it.
    - **Rolling executors back below format 2.** `MEND_CAPTURE_MANIFEST_FORMAT=1` stops new format-2
      sections; it does not rewrite the heads that hold one, and a bulk section rides unchanged
      until the next bulk snap (`other_bulk` for good). So: (1) set `MEND_CAPTURE_MANIFEST_FORMAT=1`
      and restart Mend; (2) keep a sealantd that reads format 2 running until every session you mean
      to keep has written a capture whose workspace and bulk sections are format 1 (a stop's final
      capture snaps both); (3) only then roll sealantd back. A session whose head still holds a
      format-2 section is not lost: its plan is refused with `manifest-format` before the older
      executor touches anything, and it resumes on a sealantd that reads format 2.
31. (2026-09-28) Deletion owns what it condemned until it is done, a register reads what the bucket
    holds, and a completed final flush is a fact on the chain (review 2026-09-28, findings 1, 12,
    17).
    - **Deletion claims** (migration 0080). The guard orders one register against one condemnation;
      it did not own the delete that follows. Pass A condemned and retired a pack and paused before
      deleting it; pass B, seeing the row retired, swept the same objects from the fenced epoch,
      deleted them and marked their tombstones deleted; the executor uploaded them again and its
      final capture revived them; A resumed and deleted the new head's bytes. Now every condemnation
      holds a claim on each key it tombstones (`capture_deletion_claims`, a fresh token per
      condemnation) until its pass has deleted the bytes and settled the tombstones in one statement
      (`finishDeletion`). A tombstone reads `deleted` to a register only while no live claim is on
      its key, and the register CAS refuses to lift one that has a live claim, so while any pass may
      still delete a key, no register brings it back. A claim lives an hour
      (`DELETION_CLAIM_TTL_SECONDS`) and its pass renews it before its first delete and at least
      every minute after; a renewal after a lapse fails (a register may already have revived the
      key), and the pass then deletes nothing more of that chain and returns the pack rows it
      retired to `uploaded` so the next pass weighs them again. A delete that has not answered in
      five minutes counts as failed. What remains is a delete issued before a lapse that lands more
      than an hour later; nothing here can fence a request the bucket already holds.
    - **Names that are not UTF-8 are bytes in Mend's reader.** sealantd writes such a name, and a
      symlink's text, as a key escaped into `U+10FF80..=U+10FFFF` and carries the bytes in
      `raw_name` / `raw_target` (`tree.rs`). Mend's schema dropped both fields, so its materializer
      wrote the escaped key as the file name (`caf\xe9` became `caf\xf4\x8f\xbf\xa9`) and its
      restorability check accepted the entry. The reader now decodes both fields, implements the
      same key encoding (`keyOfBytes` / `bytesOfKey`), refuses a raw field that is not hex, is not
      one safe name, or disagrees with its key (as sealantd's metadata reader does), and the
      materializer passes byte paths and byte link targets to the filesystem. A store
      sealant-capture wrote (`packages/store/test/fixtures/sealantd-raw-names`, regenerated by its
      `generate` crate) restores byte-identical: names, link texts and a hardlink pair.
    - **Register reads the manifest as stored and walks the worktree metadata.** The channel used to
      validate the request's copy of the manifest and only hash the stored bytes; now it decodes the
      stored bytes, refuses a request whose copy is not that same JSON document (400 `bad-request`),
      and validates and records what the stored copy says. `worktree_meta` (the overlay a restore
      applies whenever the manifest names it) is decoded and checked on every register, carried
      section or not: a format Mend reads (1), packs among the workspace section's own, every chunk
      in one of them (read by ranged GET), the chunks adding up to its `size` and `sha256`, and a
      document that holds to sealantd's `MetaDocument::decode` rules (plain relative paths, raw
      bytes agreeing with their keys, modes, hardlink groups and shared links naming files of the
      document). A failure is 422 `unrestorable` or `missing-objects`.
    - **A completed final flush is a fact on the chain** (cross-repo decision 1; migration 0080).
      sealantd, when a final flush completes (everything shipped, writers stopped), registers a
      sealing capture whose manifest carries `final_seal: {complete: true, epoch, executor}` at the
      top level. The register CAS records it in `capture_seals` (one per worktree and epoch, the
      newest sealing capture of the epoch) in the same statement that lands the capture, so a seal
      exists only for a capture on a chain registered up to it, and only while the lease names that
      executor. The channel passes a seal only when it is `complete`, its `epoch` is the one the
      capture registers under and its `executor` is the executor the session token is scoped to; any
      other seal registers the capture and records nothing (logged).
      `sealedCompletion(worktree, executor, epoch?)` reads it: the only store-side evidence that an
      executor's work is saved, and what Mend attests when it asks Sealant to stop that executor.
    - **`plan.get` negotiates what a manifest means, not only how it is stored.** `manifest_format`
      lets an old reader restore a head whose meaning it ignores. The request now carries
      `manifest_features` (`MANIFEST_FEATURES`: `worktree_meta`, `symrefs`, `other_bulk`,
      `raw_names`, `final_seal`, and since added `git_trees`, `object_format`, `ref_format`,
      `wide_times`); a head holding a feature the executor does not list is refused 409
      `manifest-features` (`missing` names them) before the claim, like a format. `other_bulk` is
      held by a head with a non-empty `other_bulk`, and by any head whose ready bulk section was
      captured on another platform than the one the request names (the executor must carry it).
      `raw_names` is found by walking the answered sections' dir objects, only for an executor that
      does not list it. The answer's `manifest_features` lists every feature Mend reads. Until
      sealantd sends the list (PLATFORM-FEEDBACK 2026-09-28), a head holding any of them is refused
      and one holding none is handed out as before. `raw_names` is also held by an escaped key in
      the git section: a ref name, a symbolic ref or its target, or `head`.
    - **`plan.get` names the executor** (`executor`, session and standby plans): the executor the
      session token was issued for, the value register compares `final_seal.executor` against.
      sealantd writes a seal only when it knows it. It is Mend's session id, the same for every
      executor that session runs; the seal's `epoch` tells them apart.
    - **Ref names a capture escaped are bytes in the runner's cache.** `renderPackedRefs` and the
      cache's `HEAD` write an escaped ref name as the bytes it stands for (sealantd `gitpack.rs`),
      sorted by bytes, and leave out a name whose bytes would break a line.
    - **`cross_links` in the metadata document** (sealantd review 2 #10: an inode both the workspace
      and the bulk class name, no tracked file) is checked as sealantd decodes it: each group two or
      more distinct `{class, member, raw_member?}` members, each a plain non-empty relative path
      whose raw bytes agree with its key.
    - **`sealing`** is a reason an incomplete final flush can give: everything registered but the
      sealing capture (the flush returned at its deadline first). A drain keeps asking; the status
      line says `final seal not confirmed` (it said `not registered` until e2e8, which saw it on a
      seal the store had recorded and withheld: see decision 36).
32. (2026-09-28) One launch per executor, keys never reused, a seal only over what restores (review
    2026-09-28 (3); cross-repo decisions 5, 6 and 9).
    - **The launch is the executor.** The session id and the epoch did not name one executor: a
      claimed standby whose replan answer was lost was drained without regard to Core's answer, and
      the cold executor after it inherited its epoch and its seal. Every create is now asked under a
      key minted before it, and that key is the executor's launch identity: its channel token is
      issued for it (migration 0083: one row per token, a new launch never rotates another's),
      `plan.get` answers `executor: <launch>`, register records `final_seal` only when it names that
      launch (the lease must still name its session), and a stop attests the seal only with the
      runtime recorded for that very launch, never whichever runtime the workspace answers for now.
      A claimed standby is the session's executor, under its own launch, before its replan; a replan
      that fails drains it like any executor, a kept standby refuses the launch, and only an end the
      platform confirmed lets a cold executor start, under a fresh epoch. The launch's tokens are
      revoked when its end is observed, never before.
    - **A lost create answer holds its session too.** A create whose answer is not on the row holds
      every relaunch, the owning session's included: its key is reconciled first (Core's
      `createState`, else `findByIdempotencyKey`). Found, the executor drains as any before anything
      new starts; nothing on record is not proof — Core's `cancelCreate` must say `cancelled` before
      the key clears and the lease is released. Without it the key stays reserved and the session's
      next launch asks the same create again under it (same launch, same token, the claim it still
      holds). An answer Mend does not read is unknown, never none.
    - **A condemned key is never registered again.** Tombstones are permanent: register refuses a
      key retention condemned, deleted or not (422 `missing-objects` naming it), because a pass that
      stalled past its claim can still delete whatever is at that key. sealantd uploads the content
      again under the next key generation (`captures/<worktree>/<epoch>/g<n>/…`); both key forms
      read and register alike.
    - **A seal rests on what Mend observed restore.** Register records a seal only when the git
      section verified (never failed, timed out or unverified) and the worktree metadata document
      names only files and symlinks the worktree tree holds as that kind (and no directory over a
      file); a document naming anything else is refused 422 `unrestorable`. A plan that restores
      older git under a failed head carries no seal.
    - **Snapshot health is never assumed.** An answer without `unreadable` (an older daemon, or SDK
      0.37.2's facade) reads `snapshot health not reported`: not caught up, so a landing waits. A
      suspend flush logs `completed` only when caught up, else `partial · <reason>`.
    - **The git section names its trees (`git_trees`).** sealantd writes `worktree_tree`,
      `index_tree` and `raw_tree` in their own fields for a registrar that lists the feature, and
      `refs` is then the repository's refs whatever their names (a user ref under
      `refs/sealant/capture/` was dropped by every restore). Mend reads the worktree tree from
      `worktree_tree` (else the pseudo-ref of an older capture), verifies every one of the trees as
      a closure tip, checks worktree metadata against `worktree_tree`, and hands a head holding the
      fields only to an executor that lists `git_trees`. Retention keeps git objects by pack: every
      pack the section lists stays while a row names it, so the objects of all three trees do.
    - **Complete means current (decision 7).** sealantd answers `incomplete_reason: "changed"` once
      the disk changed after a final flush; it is not saved, and a drain asks the final flush again.
      A completed answer is never reused for another round: the drain asks again.
    - **A kept executor is not dead (e2e run 5).** Capture mode reads any terminal status but
      `stopped` (`failed`, `cancelled`) as kept: Core retains a capture executor that ended without
      a completed final flush and may boot it again to save it. Its lease and its channel token
      stay; the drain asks Core's stop what it is and reads
      `not saved · executor kept for recovery`; the owner's discard is asked of Core. Only an end
      Core confirms (`stopped`, or no such workspace) takes the executor's channel, revokes its
      token and releases the lease — `docker kill` had lost the last edits and a 1 GiB file three
      times of three when Mend read `failed` as dead and cut off Core's recovery boot. A runtime not
      ready yet (a launch whose worker died after it started) is kept on the kept backoff, never
      flushed every poll. An executor running a final flush Mend did not ask for (a `docker stop`)
      stops the session: `stopping · saving`. `upload.urls` is metered per launch, re-mints of keys
      already handed out are free, and an executor under a drain is not metered at all.
    - **mtimes are nanoseconds.** A dir entry's integer `mtime` is decoded exactly (a bigint from
      its source text) and written back digit for digit; Mend's TypeScript materializer is a reader,
      not a restore path, and lands times to the microsecond Node can set.
33. (2026-09-28) A seal the registrar confirms, checked against the namespace the restore lays down
    (review 2026-09-28 (8); cross-repo decisions 22 and 23).
    - **The register says how its seal stands.** `capture.register` answers
      `seal: {state: "recorded" | "withheld" | "refused", reason?}` whenever the manifest carries
      `final_seal` (sealantd's `SealAnswer`). `recorded`: stored, and standing now. `withheld`:
      stored, but not standing (`write-authority`: an upload URL of its epoch could still replace
      what it names, or one was handed out during its read-back; `verifying`: its objects could not
      be read back); registering the same capture again answers it anew. `refused`: never stands
      (`incomplete`, `epoch`, `executor`, `unrestorable`, `not-recorded`, `void`). sealantd answers
      a FINAL complete only on `recorded`. `plan.get` hands the head's `final_seal` on only while
      that seal stands.
    - **Issuing write authority voids a read-back in progress.** A seal's re-verification mark is a
      compare-and-set against the epoch's recorded write authority in one statement: a URL handed
      out after the read-back began refuses the mark, and the seal stays withheld.
    - **The namespace is the restore's.** Worktree metadata is checked against the workspace class
      written over the raw tree (a name the class holds as anything but a directory removes every
      checkout path below it), the bulk class only where the checkout has no such path, and every
      ancestor of a named path must be a directory or absent.
    - **Every class entry a link names promises its inode.** Its mode and mtime join the tracked
      entries' in connected-inode validation; one group promised two of either is never sealed.
    - **SHA-256 repositories.** The git section's `object_format` (feature `object_format`; absent:
      `sha1`) is decoded and planned. The verifier reads a section's packs in a repository of its
      format with ids of its width; an id of another width, or a format Mend does not read, is
      `unverified`, never `verified` having walked nothing. `workspace.root_links` (the link text of
      a class root that was a symlink; informational) is decoded and planned as written.
    - **A received answer is marked as it arrives.** A flush or status answer marks its evidence
      fence received the moment the SDK returns it, is published before anything is logged, and a
      log that fails changes no evidence.
34. (2026-09-28) Evidence nothing orders is kept, write authority serializes with a seal, links are
    checked over the files the restore lays down (review 2026-09-28 (9); cross-repo decisions 24–26
    and 28).
    - **Every unsaved answer nothing kept was made after is kept.** An executor's evidence holds the
      antichain of its unsaved answers in its own order (`withUnsavedAnswer`,
      `executor_capture_evidence.unsaved_answers`, 0090): an answer made strictly before a kept one
      adds nothing, a kept one made strictly before a new one gives way, and anything incomparable
      stays — a later answer never erases an earlier one merely by arriving later. Answers nothing
      can be ordered against fold into one; past 64 everything folds into one no save covers. A seal
      or an observed `complete: true` stands only over every kept answer, in the engine's
      attestation, the executor end and the repository alike.
    - **Write authority and a seal's acceptance take one lock.** Issuing upload URLs and marking a
      seal re-verified both lock the epoch's `capture_put_authority` row (created with no authority
      when absent; `expires_at` may be null, 0091) and read what they decide on in a statement after
      the lock. Once a seal of the epoch is recorded, `recordPutAuthority` records nothing until the
      caller checked that seal: `upload.urls` asks the bucket again for every key about to get a
      URL, answers a stored one `present` (or refuses it `409 exists` to a launch that does not read
      `present`), and records authority only against the seal it checked. A recorded seal's objects
      never get an overwrite-capable URL.
    - **Links are one set of bytes in what the restore lays down.** A tracked `hardlinks` group and
      a `shared` link's tracked side resolve to the file a complete restore lays down — the
      workspace overlay over the checkout over the bulk class, every ancestor a directory — and
      their bytes are compared there (checkout blobs by id, class members by digest in the same
      format).
    - **The ref backend is the section's.** `sections.git.ref_format` (feature `ref_format`; absent:
      `files`; sealantd 26b4a37) is decoded, planned only to an executor that reads it, and a
      section of a backend Mend does not read is `unverified`. A `reftable` section is walked in a
      repository git initialized with that backend; a section whose HEAD is `refs/heads/.invalid` (a
      reftable repository's `.git/HEAD` stub) is never verified. Symlinks at `.git/HEAD` and under
      `.git/refs/`, with any text, ride the workspace class. Mend's runner cache for reviews stays a
      `files` repository of its own, where `packed-refs` is read.
    - **Reports follow events.** A discard logs the request before the stop, and `discarded` only
      after the platform confirmed the end.
35. (2026-09-28) A seal stands over every epoch it carries, preservation is never refused for
    budget, and a direct answer reads saved only by the executor's evidence (review 2026-09-28 (10);
    cross-repo decisions 26, 29, 30 and 31).
    - **A seal's authority is its whole object graph's.** `capture_seals.scopes` (0092) lists every
      `captures/<worktree>/<epoch>/` prefix the sealed capture's manifest, packs, trees and dir
      packs live under — a pack carried from an earlier epoch, or from another worktree, included;
      its own epoch always. The seal is withheld while upload authority of any of them lives
      (`putAuthorityUntilOver`), and its re-verification mark is a compare-and-set against all of
      them, their rows locked in one order. Once it is recorded, `recordPutAuthority` refuses any
      epoch whose prefix a recorded seal's scopes include until the caller checked those seals:
      `upload.urls` asks the bucket again, and a stored key is answered `present` or refused
      `409 exists`, never handed a URL. Seals recorded before 0092 get every prefix their capture
      names and are read back again.
    - **Issuance re-checks its lease after its bucket reads.** `recordPutAuthority` takes the
      holder: under the lease row (`FOR SHARE`, as a register takes it) and the epoch's authority
      lock it records nothing unless the lease is still live, under that epoch, that holder's
      launch; `upload.urls` then answers the lease error and mints nothing. URLs signed later than
      half the clock margin after their authority was recorded never leave Mend.
    - **Preservation is never refused for budget.** While a session drains, keeps or recovers its
      executor (`CaptureScope.unmetered`), neither `upload.urls` nor `capture.register` refuses
      bytes for the byte quota; the register of a `final` capture is exempt in any scope. Bytes are
      still priced. The ledger is per physical launch: a new executor starts its own, the 512 most
      recently asked about are kept, and a reservation that mints nothing is refunded. The quota
      bounds new work only. Open: a FINAL sealantd runs while Mend has no drain under way (a Core
      deadline) is exempt at register by its kind, but its `upload.urls` calls say nothing of it and
      stay metered until sealantd names the flush on them.
    - **Saved is one decision.** A drain's direct FINAL answer reads `saved` only when the
      executor's evidence does (`captureDrainStep`'s `evidenceSaved`, from `executorEndOfSession`
      confirmed against its evidence version): bound to that executor and epoch, every answer
      published, a save made after every unsaved answer kept. Otherwise the drain goes on as if the
      answer had not completed, and is kept once nothing moved for the window.
    - **Wide times and nested repositories (sealantd round 10).** Manifest feature `wide_times`: a
      dir entry of the answered sections, or a worktree metadata entry, whose `mtime` lies outside
      signed 64-bit nanoseconds. Mend reads every integer mtime as the exact `bigint` of its text
      and writes the same digits; `plan.get` lists the feature and refuses such a head to an
      executor that does not. `.git/worktrees/<name>/…` in the workspace class and the extra git
      pack of nested-repository objects are entries and packs like any other.
36. (2026-09-28) What the eighth end-to-end run found on Mend's side (e2e8, the Docker no-loss run
    on the round-8 heads; findings F2, F4, F7, F8, the seal window on Garage and the status lines).
    - **One read per object per verification pass (F2).** On a bucket that does not refuse
      overwrites every cached proof is void while an upload URL could replace the bytes, and the
      seal's link checks read each class member through a chunk source that fetched every pack of
      its class whole: one sealing register of the Mend repository read ~40 GB for 0.78 GB of packs
      and took 4 m 35 s. A register (and a seal's read-back) now runs as one pass
      (`withCaptureReadPass`): a proof the pass took itself stands for the rest of it, so each pack
      is read whole at most once, dir packs and pack indexes once, and a member's digest reads only
      its chunks' extents, each once. Across passes the voiding stands as decision 19 set it.
    - **Registers are single-flight and answer within 40 s (F2).** A register for the same worktree,
      launch, epoch, n and capture joins the one running, which runs detached from a caller that
      gave up (sealantd times a register out at 60 s and sends it again); seal read-backs likewise.
      Past `REGISTER_ANSWER_BUDGET_MS` the capture registers without the seal, the answer is
      `seal: withheld` (`verifying`), the checks go on, and `recordSeal` records the seal once they
      pass: on the chain's head under that epoch, while the live lease names the same holder and
      launch, with the lease and chain rows held as a register holds them. The executor's re-ask
      reads the outcome; a process that restarted checks again.
    - **PUT URLs live as long as their call needs (the seal window).** Every URL withholds its
      epoch's seal until it expires plus the clock margin; at a flat 15 minutes every Stop on Garage
      waited 20. A call's URLs and the authority recorded for them now live 330 s plus the call's
      declared bytes at 1 MiB/s, capped at 15 minutes; a key of unknown size gets the cap. 330 s is
      sealantd's 5-minute reuse of a URL it holds (`PUT_URL_REUSE`) plus 30 s. The clock margin
      stays 5 minutes: Mend signs, the bucket judges expiry by its own clock, and the two share no
      clock source Mend can name. A typical Stop (a final capture of a few MB) is withheld for about
      10.5 minutes; a Stop right after a large batch still waits out that batch's URLs (up to 20
      minutes), and a restarted Mend still withholds every seal for 15 minutes (a URL the previous
      process minted may live that long).
    - **A capture step past its bound (F1, sealantd's `overdue`).** Mend reads
      `CaptureStatusReport.overdue` from any status or flush answer, records it on the session
      (migration 0093) and says `capture step overdue · <step> · running 17 min · bound 2 min`; such
      an answer never reads saved, caught up or idle. Core's contract and SDK 0.37.2 drop the field
      today (PLATFORM-FEEDBACK.md).
    - **SHA-256 projects (F4).** Capture 0 and a standby's base plan name the store repository's
      object format when it is not `sha1`.
    - **Status lines say what was observed.** `sealing` reads `final seal not confirmed` (it read
      `not registered` while the store held the seal, withheld); a reaper-found lost create whose
      executor the drain ended settles `stopped · launch interrupted · …`; a launch that starts
      clears a `launch …` summary an earlier launch left (F7).
    - **The session channel never ends Mend (F8).** A request whose token lookup fails, or whose
      handler throws, is answered 503; before, a statement timeout was an unhandled rejection and
      Node ended the API.
    - Open: F7 (a claimed standby whose replan failed keeps its pre-claim staging pending under its
      placeholder worktree, which never ships, so the drain stalls and the launch fails after ~12
      minutes until the owner discards) needs sealantd and Core to agree that a placeholder's
      staging holds nothing of the session.
37. (2026-09-28) The eleventh review and the eighth end-to-end run, taken pragmatically (owner:
    common workflows exact and tested; rare layouts refused early or documented on the docs site's
    Known issues page).
    - **A final flush names itself, and is never metered (carried review 10 #6, cross-repo decision
      35).** sealantd sends `"flush":"final"` on `upload.urls` and `capture.register` from the
      moment a final flush begins until its process exits, whoever asked for the flush. Both request
      schemas accept it (any other value is metered as before); a request carrying it skips the byte
      and call quotas whether or not a Mend drain is under way, and the bytes it takes past the byte
      quota are logged (`exemptedBytes`). There is no per-launch cap: a final flush ships what the
      executor's disk holds, under its own epoch prefix, and a first final flush is never refused.
      This closes the open item of decision 35.
    - **SHA-256 repositories are refused.** `Store.adopt` reads the clone's object format
      (`rev-parse --show-object-format`) and refuses a SHA-256 one ("Mend doesn't support SHA-256
      repositories yet."), removing the clone. A project adopted before is refused the same way when
      a session starts on it (`provision`, `ensureWorktree`, `provisionSessionIn`), before anything
      is made. Reftable is not refused: Mend's bare clone is never one, and a session that converts
      its repository to reftable is captured through git (decision 24). The SHA-256 plumbing of
      decision 36 stays. A session that converts its repository to SHA-256 mid-session (e2e8 F3: the
      git section said `sha256` but listed the project's SHA-1 base pack, which failed verification)
      is not supported: its later saves never seal and the executor is kept. Documented, not
      handled; sealantd stops listing packs of another format.
    - **Status lines name only what was observed (e2e8 (i)).** The chain head is a registered
      capture, never a save: `executor not answering · last capture N at … · not confirmed`,
      `stopped outside Mend · last capture N at … · not confirmed` (its own final capture, no
      completed word, no seal),
      `executor lost · last capture N at … · changes after it were not saved`, and a discard's
      `last capture N at …`. `last saved capture N` is said only of a completed final flush or a
      seal. A session whose current executor the platform keeps for recovery reads
      `stopping · retained`, never `running`. A launch that starts clears Mend's verdict on an
      earlier executor's end (`stopped outside Mend …`, `saved at …`, `executor not answering …`) as
      it clears `launch …`; `executor lost …` stays for `picked up · executor replaced`.
    - **A claimed standby that held nothing (e2e8 F7).** sealantd answers the FINAL of a claimed
      standby whose replan failed, and on which no writer was ever admitted, at once: `complete`,
      nothing pending, under its placeholder worktree, epoch and launch; it then exits 76 and Core
      releases it as nothing to save. Mend needs no change: that answer is never read as the
      session's save (its epoch is not the session's lease, and nothing is attested for it), the
      drain reads the workspace gone, and the launch goes on cold under the session's own launch.
    - **Carried format-1 trees are read back at their top level (review 11 #5).** A seal's read-back
      (`storedCaptureProblem`) walks every format-1 dir object of the workspace and bulk classes,
      but an `other_bulk` entry contributes only the keys it lists: its root, packs and dir packs. A
      format-2 section is read back in full through its dir packs; a format-1 section carried from
      another platform has its child dir objects unverified before a seal. Documented, not fixed:
      reaching it takes a format-1 tree, a platform move and an overwrite through a live upload URL
      on a bucket that ignores conditional writes.
    - **The seal window against a runtime deadline (e2e8 F6).** On a bucket that ignores conditional
      writes, a seal waits out every upload URL of its epochs plus the clock margin: about 10.5
      minutes after a small final flush, up to 20 after a large batch, and until 15 minutes after a
      Mend restart. A runtime that ends an executor at a deadline must begin its final flush at
      least that long, plus the flush's own time, before the deadline, or the executor ends unsealed
      (Core's retention keeps it; nothing is deleted). Core's lead is 15 minutes; the only
      time-limited executors are AWS MicroVMs, which use S3 (no wait). Documented; Core unchanged.
38. (2026-09-28) The twelfth review's Mend items.
    - **A seal check that could not finish concludes nothing (review 12 #4).** A seal's checks read
      the bucket through a store that notes every read it failed (`BlobStoreError`: a 503, a
      timeout, a reset). Checks that met one, checks that died, and a record of the seal that failed
      or died (the database away) end `unavailable`, not with a verdict about the capture. The
      register answers `seal: withheld` with the reason `unavailable`, the capture still registers
      without the seal, and the job is dropped, so the executor's next register of the same capture
      checks again and records the seal. A problem observed while the store was failing reads is not
      trusted as one. The recorder settles its job on every exit, including defects and
      interruption, and never leaves one marked `recording` with nothing behind it. Only what was
      observed about the bytes (a missing object, bytes that do not hash to their name, links or
      metadata that would not restore) refuses a seal as `unrestorable`, and that verdict is kept
      for the re-asks. sealantd treats any `withheld` reason as "ask again" (the reason is a free
      code), so no negotiation is needed; its matching change re-asks on the next FINAL after a
      refusal. The same holds for what the register could not observe: a git section the verifier
      could not walk (`unverified`: the runner's cache could not be prepared, the bucket did not
      answer) and a restore tree it could not list withhold the seal as `unavailable` instead of
      refusing it, and the re-ask verifies the git section again (recording the outcome on the
      capture) before its other checks. A section that is `unverified` for good (an object format or
      ref backend Mend does not read) stays withheld, never sealed.
    - **A start in the retained workspace clears the verdict on the earlier look (review 12 #5).**
      The summary-clearing step of a fresh start (decision 37) also runs after a start in a
      workspace a Service or a shell retained. That executor answered and opened the new process, so
      `executor not answering · …` from the earlier agent's end no longer holds. `executor lost · …`
      stays for `picked up · executor replaced`.
39. (2026-09-28) The thirteenth review's Mend item: a git step the Mend host could not finish is no
    fact about the capture (review 13 #1).
    - **`failed` means git rejected the content.** A git section is recorded `failed` only when git
      said something about what it read: `index-pack --verify` rejecting a pack's bytes (a bad
      object, a checksum or trailer mismatch, an index of another pack), a pack whose bytes hash to
      another name, a pack missing from the bucket, or `rev-list --missing=error` naming an object
      no listed pack holds (`gitRejectsContent` in `packages/store/src/git.ts`). Everything else
      leaves the section `unverified` and is checked again: a git run ended by a signal (the OOM
      killer) or with no exit code, Node's own failure (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`, a spawn
      error), stderr naming a local resource (no space, file too large, too many open files, out of
      memory, an I/O error, a file it could not open), words git is not known to say of content, a
      download or staging copy that broke, and the runner cache's own `git init`. The runner reports
      those as `RunnerCacheError`, never `RunnerPackError`. A seal's read-back of its packs follows
      the same rule: a check the host could not finish withholds the seal (`verifying`) and never
      voids it, and a stream that broke while hashing an object is the store not answering, never
      other bytes.
    - **The closure walk is counted, not buffered.** `rev-list --objects` prints 41 bytes an object,
      so a repository of 1.7M objects printed past `git`'s 64 MiB buffer and was killed on every
      verification. The walk runs through `gitQuiet`, which discards stdout as git writes it and
      keeps the tail of stderr.
    - **`unverified` is checked again wherever it matters.** On the next register of the capture and
      on a seal re-ask (`lateSealChecks`, which re-verifies a `failed` row too before it refuses),
      and on every plan whose head is not recorded `verified`.
    - **A plan never lays an older git section under a newer head.** That restored the head's
      reflogs and worktree metadata over an older tree: the last turns' commits were gone,
      `git fsck` refused the repository, and a head that added a file failed to materialize.
      Decision 16 is amended. A plan verifies a head that is not recorded `verified` (a `failed` one
      included, once more). Verified: the head. Not verifiable now, because the host could not
      finish the check: no plan. `plan.get` answers 409 `worktree-leased`, the one answer the
      deployed sealantd waits on and asks again after (1 s doubling to 30 s), touching nothing and
      claiming nothing, and the session reads
      `launch waiting · capture <n>'s git section could not be verified on the Mend host · asked again`
      until a plan goes ahead or the launch starts. Git rejected the head's content: the newest
      capture below it that verifies is planned whole, every section and its checkpoint, under the
      head's identity (so the next register still parents on the real head), and the session reads
      `restored capture <m> · capture <n>'s git section failed verification`. A capture below that
      cannot be verified now stops the search, and the plan waits rather than reach past it to older
      work. A section nothing here can ever verify (a format Mend does not read, no verifier) is
      planned as registered, as before. The reads keep routing a `failed` head to the newest
      verified capture, stamped with the capture they read.
    - **Existing rows.** Why a row failed was never stored, so migration 0094 puts every `failed`
      row back to `unverified` once; the next plan, register or re-ask verifies it again.
    - **Follow-up for sealantd.** The wait reuses `worktree-leased`, so a waiting daemon logs
      "another launch holds the worktree's lease". A distinct reason (for example `plan-unverified`,
      waited on the same way) would let it say why; Mend can answer it once sealantd advertises it.
40. (2026-09-28) The fourteenth review's Mend items: decision 39's plan and verification change,
    corrected (review 14 #1–#4).
    - **Only a plan that lays the head down checks it (#2).** The launch that holds or last held the
      lease (a live or lapsed lease bound to that launch, or an unbound one of its session), asking
      about a head registered under that lease's epoch, restores nothing from the plan: sealantd
      resumes its own disk (a daemon restart, a recovery boot that ships what the disk holds, a
      re-plan). It gets the head as it stands, verified or not, and never waits on a check. A fresh
      launch, a resume's replacement or a claimed standby's replan still verifies and waits. Mend's
      own pre-claim for a launch does not count as its work: the head is from an earlier epoch.
    - **A head git rejects is refused, never replaced (#3).** Decision 39's `restored-older` route
      is removed. sealantd fetches and hash-checks the head's own manifest from `manifest_key` and
      takes only `bulk` from the plan, so another capture's sections under the head's identity were
      not what it restored: the head's own packs had no GET URL and the boot failed part way. Now
      `plan.get` answers 422 `unrestorable` (sealantd reads it as a refusal of the boot; nothing is
      claimed or handed out), and the session reads
      `launch blocked · capture <n>'s git section failed verification · discard or contact the operator`.
      A later plan checks the head once more, and one that goes ahead clears the words.
    - **Plan notices sit beside the summary (#1).** `launch waiting · …` and `launch blocked · …`
      are appended to what the summary says (`·` between), replaced by the next notice, and taken
      off when a plan goes ahead, so `executor lost · …` stays until `observeReplacement` turns it
      into `picked up · executor replaced`. A notice from a launch other than the session's current
      one (its create in flight, else its recorded launch) is dropped.
    - **A missing parent commit is content (#4).** `could not read <40–64 hex>` and
      `failed to traverse parents` join `gitRejectsContent`, only on exit 128 with no signal and no
      host word. Git exiting on its own in words neither list explains (`gitExitUnexplained`: no
      signal, no Node code, no host word) is bounded: the same words on 5 checks of one row in a row
      (`UNEXPLAINED_CHECKS_BOUND`, counted per Mend process) record `failed`, and a plan is then
      refused rather than waiting for good. Signals, host words and the bucket not answering never
      count, so decision 39's host faults stay `unverified`.
41. (2026-09-28) End-to-end run 9's Mend items (F-A, F-B).
    - **Nothing executes in a capture-mode standby before its claim (F-B).** sealantd marks a
      `standby:<id>` launch unclaimed on its first boot, and any writer-admitting control command
      (exec, stdin, sessions, forwards, SFTP, bind mounts, execution start) clears the marker
      (sealantd#121). A capture-mode standby is now provisioned with nothing executed in it: the
      custom image's setup commands and the `mend` helper / git transport install
      (`prepareExecutor`) run at claim, after the replan succeeds, and the workspace note is written
      by the claim path as for every launch. Before a claim Mend only rebinds the standby's socket
      on the host, reads its status, and asks Core's stop; none of these admits a writer. A cold
      launch and a non-capture standby are unchanged.
    - **A `failed` executor whose drain ended is gone (F-A).** Decision 32's "any terminal status
      but `stopped` is kept" is narrowed for `failed` and `cancelled`: `lookupWorkspace` asks Core's
      `workspace.captureDrain()` (read-only), and a drain that ended (`stopped`, `saved`, `gone`,
      `discarded`) with nothing retained reads `gone`, so a `docker stop` outside Mend that saved
      settles `stopped outside Mend · saved at … · capture n` instead of `stopping` for good. Status
      `retained`, a drain still `draining`, `kept` or `stop-failed`, a `retained` record, or an SDK
      without the method stays kept. For Core: an executor that exits 0 after a complete FINAL is
      recorded `failed`; `stopped` would describe it.
42. (2026-09-28) The fifteenth review's Mend item (#1) and two status lines from end-to-end run 9.
    - **Setup commands run only on a worktree laid down fresh (#1).** `prepareExecutor` ran the
      custom image's `setupCommands` after every create, but sealantd materializes the saved
      workspace before the create answers: a cold resume ran `npm ci` over a restored `node_modules`
      and put a patched dependency file back to the published bytes. The owner's decision: setup
      commands run only when the executor lays the worktree down from capture 0 (a worktree's first
      launch, or a chain with no capture past 0). An executor that restores a saved capture (a
      resume, a recovery, a relaunch, a new session in an existing worktree, a standby whose replan
      planned a saved head) runs none of them; the capture already holds what setup produced. A cold
      launch reads the head under its own lease claim, before the create, so nothing registers
      between the read and the executor's plan (`restoredCaptureOf`); a claimed standby uses the
      head its replan reports (`headN`), else the head read under the claim. The `mend` helper and
      git transport install still runs: it writes `/usr/local/bin` and the system git config, never
      the worktree. The session line says `setup skipped · restored from capture <n>` once at start
      (beside `executor lost · …` when that is there; the next start clears it). Captures hold the
      worktree only, so anything setup installed elsewhere is not restored; the docs send that to
      Extra packages or the image. The co-located store is unchanged: setup runs on every launch
      there. A worktree whose capture 0 was backfilled from an older directory (decision 8's attach)
      still runs setup over it.
    - **A seal that lands while Core ends a kept executor is the session's word (run 9 RD).**
      `terminateWorkspace` reported `saved` only for a seal Mend attested on the stop. An executor
      whose worker died before `ready` had no seal when Mend's stop went out; Core's recovery boot
      sealed while it ended it, and the session kept `failed · launch failed: … retained …` alone.
      Once the end is confirmed and nothing was attested, the executor's own standing seal
      (`executorSealOf`, read while the lease still names it) counts, and the session reads
      `failed · launch failed: … · saved at … · capture n`.
    - **A stop that follows the executor's own FINAL reads as that end (run 9 D9).** When a status
      read finds a final flush Mend did not ask for, Mend stops the session; a saved end of that
      stop settled a bare `stopped` (the owner's Stop wording), while sessions whose end Mend
      observed from outside read `stopped outside Mend · saved at … · capture n`. Such a stop now
      reads the same once saved. The owner's Stop is unchanged.
43. (2026-09-28) The sixteenth review's Mend item (#1).
    - **A manifest that was not read never triggers a dependency install (#1).**
      `installDependenciesIfNeeded` read the head's manifest to learn whether this executor's
      platform had a restored dependency tree, and turned any GET or decode error into "no tree":
      one 503 on that read ran `npm ci` over a restored `node_modules` and replaced the user's patch
      with the published bytes before the shell opened. A failed read is now unavailable. Mend logs
      it, runs no installer, and the session line says
      `dependency install skipped · capture <n> manifest unavailable` once at start (the next start
      clears it, as with `setup skipped`). Only a manifest that was read and names no tree for this
      platform, or a worktree with no head yet, runs the install. With the manifest read, the
      install never runs over a restored tree of the same platform: sealantd restores the bulk
      section the head holds for its platform and carries it forward as `bulk` into every capture it
      registers afterwards (`continue_bulk`), so a head read after the restore still names it. What
      the install can replace is a tree spliced in from the project's dependency cache, which is no
      session's work. This is decision 42's rule applied to the automatic install: nothing Mend runs
      before the harness rewrites restored work.
44. (2026-09-28) The seventeenth review's Mend item (#1) and the sweep of what a launch writes into
    the harness home.
    - **Mend's note is a bounded block (#1).** `appendWorkspaceNote` cut `~/.claude/CLAUDE.md` and
      `~/.codex/AGENTS.md` at the first `<!-- mend:mounts -->` line and wrote its note after it, so
      anything the user or the agent wrote below the note was gone at the next resume, after the
      capture had restored it. The note now sits between a `<!-- mend:workspace-note:begin … -->`
      line and a `<!-- mend:workspace-note:end -->` line, and a launch replaces only that block
      (`workspace-note.ts`). Neither marker contains the old one, so a Mend rolled back to the
      open-ended note finds nothing to cut and appends. A file holding the old note is migrated only
      when every line from the marker to the note's end is exactly what one of Mend's generators
      wrote since 2026-08-01 (the fixed lines are frozen in `LEGACY_NOTE`; the mounts are bullets of
      one absolute path with a known suffix). That span becomes the block and what follows it stays.
      When the old note differs by a single line, none of it is removed: the block is appended and
      the old note stays. The docs' Known issues page says to delete it by hand. Absent is the only
      read failure that creates the file. Any other read error, bytes that are not UTF-8, a dangling
      symlink, or markers that do not form exactly one block leave the file untouched and log a
      warning with the reason. A file that already says it all is not written. A write goes to a
      temporary file beside the target and is renamed over it, keeping the mode. A symlink's target
      is written; a file with several hard links is written in place. A separate Mend-owned file
      referenced from the user's was not simpler: Claude Code has `@` imports, but Mend could not
      rely on an include for Codex's `AGENTS.md`.
    - **Every other write a launch makes, checked (sweep).** Harness-home relocation (keeps the
      restored side and drops only what the image, the injection, dotfiles or a native import put in
      `$HOME` this boot, all of which that boot regenerates); the helper, the git transport and the
      git author (Mend-owned paths under `/run/mend` and `/usr/local/bin`, and Mend's keys in system
      git config, below the user's and the repository's own); the default shell profile (written
      only where nothing exists, `set -C`); pasted images (fresh names); native imports (fresh
      session ids); the co-located archive restore (only when no live state); setup commands and the
      dependency install (decisions 42 and 43); plan remotes (sealantd adds them only to a
      repository with no saved `.git/config`). None rewrites user content. Three did, and are fixed:
      - **The claude onboarding seed** read `~/.claude.json` and `~/.claude/settings.json` and
        treated a file it could not parse as empty, so a hand-edited `settings.json` with a trailing
        comma lost its hooks and permissions to three keys at the next launch. It now merges only
        into a JSON object it read, leaves anything else (unreadable, not an object, a dangling
        symlink) as it is, writes nothing when the keys are already there, and writes the credential
        with `wx` only (`harness-seeds.ts`).
      - **The codex trust seed** appended its table to `config.toml` with no leading newline, so a
        last line without one ran into `[projects…]` and the file stopped parsing. The table now
        starts on its own line.
      - **Skills delivery** ran `rm -rf` over every bundle directory before rewriting it and over
        every retired one, so a skill the agent edited in the session, or a directory of its own
        that a library skill came to share a name with, was gone at the next launch. Mend now
        records a digest of each bundle it wrote (`.mend-managed-skills-digests.json`, beside the
        manifest, which a Mend that predates it still reads). A directory goes only when its tree is
        exactly Mend's last delivery or the one about to be written. Anything else is moved whole to
        `.mend/skills-kept/<stamp>/` in the harness home and logged. One program
        (`SKILLS_VACATE_PROGRAM`) does this in both stores, and a directory it could not clear is
        never written into.
45. (2026-09-28) The eighteenth review's Mend items.
    - **Skills delivery keeps what the user set on a skill (#1).** Decision 44's check compared file
      contents only. A delivered skill whose script the user made executable, or that gained an
      empty directory or a hard link, still counted as Mend's delivery, so every resume removed it
      and wrote it again: the script came back 0644, the empty directory and the second link name
      were gone, and the times were reset. `SKILLS_VACATE_PROGRAM` now makes three decisions:
      - A directory whose files are exactly the bundle about to be delivered (contents only) is
        `unchanged`. It is neither removed nor rewritten, and the writer skips its files
        (`skillFilesToWrite`). Modes, times, empty directories and links the user set all stay.
      - A replaced or retired directory is `removed` only when it is one of the accepted trees and
        also matches what Mend's writers produce: every file 0644 with a single link, every
        directory 0755 with at least one file under it, nothing else. Mend cannot know the times it
        wrote, so it does not check them.
      - Anything else is renamed whole into `.mend/skills-kept/<stamp>/`. A rename keeps modes,
        times, empty directories and inodes.

      Removals are now logged as well as keep-asides. Skill bundles carry no modes, so a skill Mend
      writes has 0644 files in 0755 directories in both stores (the co-located writer now sets these
      explicitly). The engine regression runs the emitted `mend-skills` and `mend-write` commands on
      resume over a copy of the saved harness home. The reviewer showed that sealantd restores the
      mode, the nanosecond mtime, the empty directory and both link names exactly.

    - **A temporary file is removed only by the run that created it (#2).** The note writer
      (`workspace-note.ts`) and the claude seed (`harness-seeds.ts`) named their temporary file
      `.<file>.mend-note-<pid>` / `.mend-seed-<pid>` and opened it with `wx`. When a file of that
      name already existed (a restored harness home, a reused PID), the exclusive create failed and
      the cleanup then unlinked that file, which was not theirs. Both now unlink only a temporary
      whose exclusive create succeeded. On `EEXIST` they try another name with a random suffix (up
      to 16 more), and the file that holds the name is left alone.

46. (2026-09-28) The nineteenth review's Mend items, and the rest of its recheck of decision 45.
    - **Relocation merges only what is missing (#1).** The relocation merged each fresh `$HOME`
      harness directory into the restored root with `cp -an source/. root/`. No-clobber kept the
      files, but archive mode copied the source directory's mode and time over the destination. Core
      writes the connected-account credential under `umask 077`, so a restored `.claude` saved at
      0750 read 0700 with the new executor's time after every cold resume. The merge
      (`merge_missing` in `relocateHarnessHomeScript`) now walks the source and copies only the
      entries the root lacks, each with `cp -a`, so a new entry such as the injected credential
      keeps its own modes. It descends where both sides hold a real directory and never writes over
      anything that exists on the root side. A new entry changes its parent's time, so `kept_time`
      records the parent's time with `touch -r` before the entry is created and puts it back after.
      That covers existing descendant directories, the harness directories and the root itself. A
      harness directory the root lacks is copied whole, as before. The program runs under dash, bash
      and busybox `sh`. If a time cannot be read or put back, the relocation fails, and in capture
      mode the launch fails with it.
    - **A lost create's executor reads ended only once its end is observed (#2).** After a saved
      final flush, `terminateWorkspace` can answer `ended: false`: Core took the stop and still
      reports the executor after Mend's wait. `runDrain` returned `terminated` for that as well, and
      the lost-create reaper settled the session
      `launch interrupted · the create's answer was lost · its executor ended`. `runDrain` now
      returns `stop-requested` when the end was not observed. The replacement and the relaunch paths
      treat it as they treated `terminated` before, so neither changes. The reaper leaves the
      session `stopping` with
      `launch interrupted · the create's answer was lost · stop requested · end not observed yet`.
      The row and the lease stay, and the status fold does not settle it. The reaper's pass over
      `stopping` sessions settles it `stopped · … · its executor ended` once Core reports the
      executor gone. The words are written before the status, so a restart between the two writes
      leaves `starting` saying what was observed.
    - **A replaced or retired skill is never deleted (decision 45, recheck).** Decision 45's
      ownership check read contents, modes, link counts and extra entries, but not times. A skill
      whose only change was a file's mtime still counted as Mend's delivery and was deleted on
      retirement. Mend has no record of the times it wrote, so `SKILLS_VACATE_PROGRAM` no longer
      deletes anything. A directory that holds exactly the bundle about to be delivered stays
      `unchanged` and untouched, as before. Every other replaced or retired directory is renamed
      whole into `.mend/skills-kept/<stamp>/`, including one exactly as Mend wrote it. The `removed`
      outcome is gone. `.mend/skills-kept` grows by one directory for each skill a library replaces
      or drops. Nothing prunes it, because pruning would delete what Mend cannot prove is its own.
      The skills guide says to clear it by hand.

47. (2026-09-30) A seal's verification shares the Mend host's thread (alpha, Mend 0.34.2).
    - **What happened.** A session with a 1.57 GB capture (a pnpm `node_modules`, ~21,000 dir
      objects) was stopped. Its final FINAL registered with `final_seal`, `capture.register`
      answered `seal: withheld (verifying)` past its budget, and the seal's checks went on in the
      API process. It sat at 100% CPU for over ten minutes, and login, `/projects`, attach and Slack
      each took 6–10 minutes. The cost was not the payload read. Every member a link names
      (`crossLinksProblem`, `linkTopologyProblem`, `inodeMetadataProblem`,
      `restoreNamespaceProblem`) is looked up from its class root, and each lookup decompressed,
      hashed and decoded every dir object on its path again. A `.pnpm` of a thousand entries was
      decoded once per member. All of that ran in Effect batches of 2,048 operations that gave the
      event loop no turn between them, and whole packs were hashed in one call. A synthetic tree of
      5,000 packages (5,000 cross-class links, one 64 MiB pack) took 55.5 s. HTTP requests to the
      same process waited up to 277 ms each, and the event loop was held up to 166 ms at a time.
    - **Each dir object is decoded once per reader.** A format-2 reader keeps what it decoded, by
      digest, up to 2,000,000 entries. The bytes are the dir packs it already holds, verified
      against the digest on first read. The same checks take 0.73 s.
    - **Verification yields the thread.** `cooperate` yields to the event loop (`Effect.yieldNow`,
      the scheduler's `setImmediate`) once a stretch of work has held the thread for 8 ms. A stretch
      ends when the thread is given up (a `setImmediate` marks it), so work that ends sooner is
      scheduled exactly as before. Every chunk decompressed (`readChunk`), every dir read, every dir
      walked by `verifySectionRestorable`, every pack index merged and every 4 MiB of a whole-object
      hash (`digestSliced`) calls it. Over the same tree, requests are answered within 27 ms and the
      event loop is never held more than 25 ms (`capture-verify-shares-thread.test.ts`). The key
      codec's common case (a UTF-8 name without an escape-range character) no longer encodes
      character by character; the output is the same.
    - **One seal verification at a time.** A seal's checks (`sealJobFor`) and a seal's read-back
      (`sealStandingOf`) take one process-wide permit (`sealVerifications`). A seal waiting for it
      reads `withheld` (`verifying`) to the executor, as a slow one does. The store client sets no
      request timeout, so a read that never answers would hold the permit for good. A verification
      that holds it for 30 minutes (`SEAL_VERIFICATION_LIMIT`) is interrupted and concludes nothing:
      checks end `unavailable` and are dropped, a read-back ends `withheld` (`verifying`), and the
      next ask verifies again.
    - **Proofs a later seal reuses.** A member digest is a proof about the packs its chunks were
      read from, kept across passes (`memberDigestProofs`) and standing only while `proofStands` for
      every one of them. A key read whole and found to be what its name says (`contentVerified`)
      answers `upload.urls`'s check of a stored key while its proof stands. On a bucket that refuses
      overwrites, a second seal over the same sections read 12 ranged GETs of already-proven packs
      and now reads none of them. On one that does not, nothing proven before stands while an upload
      URL could replace the bytes, and every pack is read again. The seal's read-back
      (`storedCaptureProblem`) still reads every key its capture names, whatever was proven before
      (decisions 35 and 37). The first seal over a pack still reads, decompresses and hashes all of
      it, because nothing proves its chunks decode until then. A register takes no payload proof,
      and the proofs live only in this process, so the first seal after a Mend restart reads its
      capture again.
48. (2026-10-02) Upload URLs bound to their bytes: a Stop on Garage seals without the wait.
    - **What waited.** A bucket that ignores `If-None-Match` (Garage) cannot refuse to replace an
      object, so a seal waited until every upload URL of its epochs had expired, plus the 5-minute
      clock margin (decisions 26 and 31): about 10.5 minutes after a small Stop, up to 20 after a
      large one. Garage still ignores `If-None-Match` (v2.4.1; no release adds it).
    - **What Garage does check.** A PUT whose URL signs `x-amz-checksum-sha256` is refused unless
      its body hashes to that value (`InvalidDigest`); without the header it is refused as unsigned,
      with another value as a bad signature (measured on v2.4.1, 2026-10-02). Every capture key but
      a pack index ends in the SHA-256 of its bytes. A URL with that SHA-256 signed in therefore
      writes those bytes or nothing: no write authority.
    - **Negotiated.** An executor that lists `sha256` in `plan.get`'s `upload_answers` (sealantd,
      "Bytes-bound PUT URLs") sends `x-amz-checksum-sha256` on every PUT whose URL signs it, and
      declares in `upload.urls` the SHA-256 of each pack index. On a store that measures as checking
      it (`BlobStore.bindsBytes`: a probe key refused with a checksum-mismatch error, then taken
      with the right checksum), single-PUT URLs are bound: to the digest the key names, or to the
      index's declared one. A declared digest a key's name contradicts is 400.
    - **What still records authority, as before:** a call with any part URL (part bytes are not
      bound), any single PUT not bound (an older daemon, another store, an index declared nothing
      about, a full index registry), every call on S3, R2, MinIO and the directory store.
    - **The seal is still read back.** A bound-only epoch records no authority, so its seal waits
      for nothing; once this process's own window is past, its objects are read back and the seal
      stands (the mark under the scope rows' locks, as always). The wait goes; the read-back stays.
      Three adversarial reviews (2026-10-02, two models) found every hole in a shortcut that skipped
      it, or in pack indexes; this design keeps the read-back.
    - **Pack indexes.** A process-wide registry (`bound-index-digests.ts`) holds the digest every
      bound URL of an index names and until when one could be used (its longest life plus the
      margin, extended after signing). Reserved in the synchronous step that checks it, so two calls
      cannot bind one index to two digests; dead entries go, a full registry binds no more. A seal
      never stands — on any path — while a live binding names other bytes than an index it names
      holds: it is withheld until that URL is dead.
    - **Restarts.** A URL a process before this one minted (bound URLs record nothing) is covered by
      the store's startup window, now its longest life plus the clock margin: seals wait the first
      20 minutes after a Mend start. Superseded the same day by decision 49.
    - **Large objects go as one bound PUT** (2026-10-02, the first Stop on a Garage box): a bindable
      call answers a key it can bind as one PUT up to `BOUND_SINGLE_PUT_MAX_BYTES` (256 MiB), past
      the 16 MiB multipart threshold. A session's first save carries dozens of 40–67 MiB packs, and
      as parts each held the seal for the URLs' life: that Stop waited 10 minutes. sealantd takes a
      single URL for a key it asked parts for. 256 MiB fits the URL's life at the assumed rate.
    - **What remains.** The 20 minutes after a Mend start; a Stop that uploaded through part URLs
      (an object over 256 MiB, or one Mend cannot bind); an executor of an older daemon; the
      read-back's own time, which grows with what a capture names (follow-up: read back only what is
      new since the last standing seal). Decision 49 removes the first and the last, and raises the
      single PUT to 5 GiB.

49. (2026-10-02) A Stop on Garage in seconds: no wait after a restart, nothing read twice.
    - **Measured.** The first Stops on a self-hosted box (an i9-9900K, Garage beside Mend) took 1
      min 58 s with 788 MB of dependencies not yet saved, and 18 minutes right after a Mend restart.
      Of the first: 69 s snapshotting on one throttled core (sealantd), 22 s of seal checks on
      Mend's own thread, 5.7 s reading every pack back a second time, 5 s uploading packs one at a
      time. The owner's verdict: not acceptable.
    - **The restart window goes.** It stood for URLs a process before this one handed out. Each of
      those that could replace an object a seal names is on record: an unbound one in its epoch's
      write authority (`capture_put_authority`, written before the URL leaves), and one bound to a
      pack index in `capture_bound_indexes` (migration 0099, which replaces the in-memory registry
      of decision 48). `sealStandingOf` drops the store's startup term (`BlobStore.startupUntil`)
      when that record is whole for every scope the seal's objects live under (`sealAuthorityOver`):
      each worktree is there with its rows, and the cutover below is past. A scope whose worktree is
      gone took its record with it: the window is waited out as before. Whether the record is whole
      and what it holds are read in one statement, so a worktree removed meanwhile is seen gone or
      seen with its authority. What this process itself minted for a key past the window still
      counts. A multipart complete never replaces a stored object on such a bucket (`completeOnce`),
      restart or not.
    - **The bindings in Postgres.** A reservation takes an advisory lock on the key and the row's
      own lock from its read to its write, so two calls cannot bind one index to two digests and an
      extension made meanwhile is never overwritten with an earlier expiry. The same bytes bound
      again never shorten a binding. An extension that finds no binding fails the call, and no URL
      of it leaves Mend. Bindings dead for an hour are swept with a predicate asked of the row as it
      is deleted, so one renewed meanwhile stays. A binding is never given back, even when its call
      hands out no URL: another call may have signed a URL under that very row since, and the row
      cannot say whose it is. An extension finds only a binding live at the moment of signing: a
      call that stalled past its reservation's life signs nothing, since a seal may have stood over
      other bytes since.
    - **The upgrade, once.** The server before migration 0099 kept its bindings in memory, and a URL
      it bound in its last minutes outlives it. The migration writes a cutover 20 minutes ahead
      (`capture_bound_index_cutover`) when the database already has worktrees. Until then seals wait
      the startup window out as they did. A new install has no such wait.
    - **What an executor said it reads survives a restart too.** An executor plans once, at boot,
      and lists there whether it reads `present` and sends `sha256`. Mend kept that in memory, so
      after a restart every running executor was answered as an older daemon: unbound URLs, and a
      Stop that waited 10.5 minutes (measured on the box, the first Stop after a restart with the
      window gone). It is on record now (`capture_launch_answers`, migration 0100) and read by a
      process that never saw the launch plan.
    - **The read-back reads nothing twice.** `storedCaptureProblem` takes
      `proofs: { sinceMs, usedFromMs }`: an object whose name is its digest, read whole by this
      process at or after `sinceMs` and found to be what its name says, is asked for (`head`) and
      not read again. `sealStandingOf` passes `sinceMs = until`, the latest moment any URL could
      have replaced anything the seal names, and marks the seal re-verified from the earliest read
      the answer rests on (`markSealReverified`), so a URL handed out since voids it under the scope
      rows' locks exactly as before. The manifest, every git pack and every pack index are read each
      time.
    - **A pack's payload proof does not lapse.** `verifyPackPayloads` proved two things at once: the
      stored bytes hash to the key, and every chunk in those bytes decodes. The second is a fact
      about bytes that hash to the key, whatever is stored later, so for a key that names its digest
      it is kept for the life of the process. The first is the read-back's question, asked once
      nothing can replace the object. The same holds for a link member's digest (`digestOf`): every
      chunk read for it is checked against the hash that names it, so the digest is a fact about
      that list of chunk hashes. Before, both lapsed with `proofStands`, and every seal in the 20
      minutes after a start decompressed every pack and hashed every linked member again. A pack
      index key is not such a key: it names its pack's digest, not its own bytes'. It keeps the old
      rule, and a register refuses a chunked section that lists one as a pack. A seal an older
      server recorded over such a capture is void.
    - **Verification leaves Mend's thread, and starts early.** Packs are verified on worker threads
      (`pack-verify-pool.ts`), up to eight at once, at most that many packs in memory whoever asks.
      A register that seals nothing starts verifying the packs it lists in the background, so the
      sealing register that follows waits for what is left. A second asker of a pack under
      verification waits for the first. The background pass is cut off after five minutes, which
      gives its places back and sends its waiters to verify for themselves.
    - **Reviewed.** GPT-6 Astra read the first cut and found five ways a seal could stand over
      replaceable bytes and one hang: the index key rule above, the upgrade, the two reads of a
      scope, the sweep, an extension overwritten, and the unbounded background pass. A second pass
      found two more: a reservation given back under another call's signed URL, and seals recorded
      before the index key rule. A third found a lapsed binding revived by a call that stalled past
      its reservation. Each is fixed as described here, with a test named for it.
    - **sealantd** (its changeset of the same day): a final flush is not throttled, reads small
      files on reader threads, hashes and compresses a large file's parts on them, hashes each pack
      on its own thread, takes SHA-256 from `ring`, and uploads large objects four at a time.
    - **A git pack is copied down once.** The register's verifier copies each new git pack to the
      runner's cache, hashes it to its key and runs `index-pack --verify` beside its index
      (`runner.ts` `installPack`). That is the read-back's check, so it is kept as a proof
      (`rememberGitPackVerified`: the index's SHA-256, when the read began), and the read-back,
      given `proofs`, reads the index stored now and compares it instead of copying the pack down
      again. A pack it must copy down is hashed in the same pass, not streamed twice. Measured on
      the box with a 627 MB pack: 6 s at register and 7.9 s at the seal became 6 s and the time to
      read a 1 KB index (2026-10-03).
    - **What remains.** After a restart, the first seal of each worktree reads every object it names
      once (the proofs are in memory). The walk of the tree and the register's restorability check
      are still one thread each. An executor of an older daemon, an object over 5 GiB, and a scope
      whose worktree is gone wait as decision 48 says.

50. (2026-10-03) A Stop makes one final flush, and reads it.
    - **What waited.** A Stop asked the executor for three small flushes before the drain's final
      one: the stop's own checkpoint (`checkpoint · user-mark`), the harvest barrier of each agent
      it ended (`process-end harvest`), and, for a session with no agent, the settle harvest. Each
      was a snapshot, a ship and a register: 8.6 s of a 25 s Stop on the box, and the `mend stop`
      answer waited for the first of them.
    - **One flush.** When a Stop will drain the workspace (capture mode, and nothing but what it
      ends holds it), the checkpoint and the harvest are put off until the drain's final flush
      (`deferToFinal` in the session engine) and read its head: a checkpoint reads the chain, a
      harvest reads the head capture in the store, so neither needs the workspace. They run once the
      final flush is saved and before the executor is terminated: its lease goes with it, and a
      successor launched after the release could register a newer head under a harvest still reading
      (Astra review, 2026-10-03). The drain's own reading stands for the flush each would have asked
      for: a complete one means `flushed`, a sealed answer the store stood for `flushed` as well, a
      refused one (the executor gone) an unflushed checkpoint and no harvest, as a refused flush
      gave before. Nothing drained (the workspace in use after all): each runs as it did, flush and
      all.
    - **A kept round leaves it.** A round that keeps the executor (`not saved · workspace kept`)
      runs none of it: the drain holds the queue from its first look (`queueHeld`), and the round
      that saves runs it to empty, before that executor goes. Run beside a kept round it would
      outlive the save (a landing holding the checkpoint writer) and read a successor's head after
      the lease went (Astra review, 2026-10-03). A workspace found in use runs it inside the same
      drain, flushing for itself as before, so a drain that follows waits for it. An executor that
      went runs it on the drain's last reading of it, every piece waited for: a FINAL that
      registered the head before it went leaves a readable head. A platform-kept executor runs it
      before Core's stop, which may confirm an end and release the lease.
    - **What runs past its time is owed, not dropped, and never interrupted.** Each piece has
      `deferredWorkLimit` (two minutes) once the flush is saved. A piece past it (a checkpoint
      writer held, a store not answering) runs on: a harvest's writes do not stop with its fiber,
      and a retry beside them could lose what it wrote. The rest is put back, the round reads `kept`
      with the executor saved, and the next round waits for that piece before anything else, then
      runs the rest after its FINAL (which snaps nothing). Nothing a Stop asked for is dropped, no
      piece runs twice, and no lease goes under work still owed. The reading that left a readable
      head is kept for the harvest still owed across those rounds (`deferredEvidence`); one harvest
      of an agent runs at a time, so a piece left running and a recovery sweep's harvest never
      rewrite each other's manifest; and once a round has run the queue to empty and is terminating
      the executor, an end that arrives puts nothing off (`queueClosed`) and flushes for itself, as
      before. That admission is refused at the append itself, never before an async look; a seal the
      store confirmed with no answer from the executor is evidence too; and one consumer runs a
      workspace's queue at a time, a second waiting for it within its limit, so no round declares
      the queue finished while another still runs a piece. A consumer takes one piece at a time,
      forks it in the engine's scope and records it as running in one uninterruptible step, and
      closes an empty queue in that same step, so an interrupted consumer leaves nothing untracked
      and nothing is admitted between the look and the close. The consumer slot is taken and its
      release installed in one uninterruptible step. Where no drain is owed to wait (a workspace
      found in use, an end no drain holds) the consumer runs detached in the engine's scope,
      unbounded, and the caller waits for it within the limit, so a request that gave up leaves
      nothing queued without a consumer. The hold follows the durable intent, so nothing holds the
      queue without a round owed to come back; the drain slot, the stop tail's mark and the consumer
      slot are each taken with their release in one uninterruptible step. A Stop puts its mark off
      in the step that marks and forks its tail, so nothing is put off that no tail will run; a
      discard runs what was put off, every piece waited for, before it releases the lease.
    - **Known gap.** A Mend restart in the seconds between a Stop's answer and its checkpoint's
      write loses that user mark and the change head refresh with it: the restart interrupts the
      piece, and the drain intent that survives carries no record of it. The change is saved and the
      harvest is recovered by the sweep that takes the drain up again. Before this decision the mark
      was written before the answer. Replaying the mark from the drain intent is a follow-up.
    - **Only a Stop.** An agent that ends on its own keeps its flushes before any drain: its end is
      judged (`executor not answering`, `completed`) and its executor looked at before the drain
      begins, and the tests of those judgements say so. Making every end read the drain's final is a
      later change, with those judgements moved after it.
    - **One FINAL per kept round, still.** The drain's own answer no longer stands for a later
      round's (`recentFinals`): with the harvest put off, the drain is the round's one FINAL.
