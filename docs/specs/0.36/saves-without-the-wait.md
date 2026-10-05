# Saves without the wait

- **Release:** 0.36
- **Status:** on main. Every PR below is merged.
- **PRs:** mend#462, mend#464, mend#465, mend#473, mend#474, mend#475, mend#476; sealant#312;
  sealantd#128, sealantd#130, sealantd#132 (the final flush uses every core: part of the same
  measured drop, named in ADR 0002 decision 49).
- **Decision records:** docs/adr/0002-session-capture-store.md, decisions 48, 49 and 50 (lines
  1414–1621). Background: decisions 19, 20, 25–27, 31, 35, 37 and 47 of the same ADR (write-once,
  negotiated answers, write authority, read-back).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`. Mend main pins `@sealant/sdk` 0.39.0-next.683; Core main pins sealantd 0.20.0-next.142
  (sealant#321), which carries sealantd#128, #130, #132 and #135.

## Why it exists

On a self-hosted Mend (Docker executors, the Garage bucket `mend server setup` installs), a Stop
waited for its save far longer than the work it saved:

- About 10.5 minutes after a small Stop, and up to 20 after a large one. Garage ignores
  `If-None-Match` (v2.4.1), so an upload URL Mend handed out could replace a stored object until it
  expired. Mend withheld the seal (the final save's confirmation) until every URL of the epoch had
  expired, plus a 5-minute clock margin.
- 18 minutes for a Stop right after a Mend restart: the store's startup window (20 minutes) stood
  for URLs a previous process had minted.
- 1 min 58 s for a fresh session with 788 MB of dependencies still unsaved: 69 s of single-threaded
  snapshot in sealantd, 22 s of seal checks on Mend's request thread, 5.7 s reading every pack back
  a second time, 5 s uploading packs one at a time (ADR 0002 decision 49).
- 8.6 s of every 25 s Stop went on three small flushes (stop checkpoint, process-end harvest, settle
  harvest) before the final one (decision 50).
- 28 s of a Codex Stop went on reading 33 memory files out of the head capture, each one fetching
  the same 64 MiB pack again (mend#476).
- 4.3 s of every Docker Stop went on `docker rm -f -v` of an already-exited container before Core
  reported `stopped` (sealant#312).

Who hits it: everyone on a self-hosted install (the owner's box, `alpha.mend.run`), on every Stop,
every resume (a launch waits for the worktree's previous executor to save, ADR 0002 "A launch waits
for the worktree's previous executor"), and every handoff. The owner's verdict on 2026-10-02: "2
mins for 200 mb? And 18 mins for bigger files? Not acceptable." ROADMAP 0.36 Must 3 and exit
criterion: "A stop's save takes under two minutes, measured on the box."

Measured on the box (i9-9900K, Garage beside Mend), from the owner's memory notes and the PR bodies:

| Case                                           | Before (2026-10-02) | preview 7 (#473, sd#132) | preview 9 (#470–#477) | preview 10 (+ sealant#312) |
| ---------------------------------------------- | ------------------- | ------------------------ | --------------------- | -------------------------- |
| Fresh session, 200 MB new, 788 MB deps unsaved | 1 min 58 s          | 32.5 s                   |                       |                            |
| Deps saved, small edit, Stop (T2)              | ~10.5 min           | 25 s                     | 16.6 s                | 10–14 s (all Stops)        |
| Mend restart, then Stop (T3)                   | 18 min              | 25 s                     | 19.3 s                |                            |
| 627 MB git pack committed (T4)                 | 18 min              | 46.9 s                   | 35.3 s                |                            |
| Codex one turn, Stop (T5a)                     |                     | 46.8 s                   | 15.7 s                |                            |
| Claude, Stop (T6a)                             |                     |                          | 15.6 s                |                            |

## What it does

- A person stops a session (web Stop, phone Stop, `mend stop <id>`, VS Code, desktop, Slack, the t3
  gateway, or an idle stop).
- Mend answers at once. The session reads `stopping` with the capture line `saving · <n> left`
  (`saving · 12 MB left` once sealantd reports bytes), then `saving · no uploads pending`.
- The executor makes one final flush. Mend checks and seals it, reads it back from the bucket, runs
  the stop's checkpoint and the agent's harvest against the head that flush registered, and only
  then terminates the executor.
- The session settles `stopped` with `saved at HH:MM:SS UTC · capture <n>` (`executorSavedWords`,
  packages/domain/src/workbench/capture-drain.ts:1041).
- On the box this is 10–19 s for an ordinary session.

Nothing new to configure. The behaviour is negotiated: it turns on when the executor's sealantd
lists `sha256` in `plan.get`'s `upload_answers` and the bucket measures as checking a signed
`x-amz-checksum-sha256`. S3, R2 and MinIO refuse conditional overwrites already and never waited.

Settings that still matter:

- `MEND_CAPTURE_MULTIPART_THRESHOLD` (default 16 MiB): keys at or above it go in parts, except on a
  bindable call, where a key Mend can bind goes as one PUT up to 5 GiB.
- `MEND_SESSION_STORE` must be `captured` (the default). Co-located sessions have no save to wait
  for.

**In scope.**

- Upload URLs bound to their bytes on Garage (single PUTs, and pack indexes by declared digest).
- No startup window after a Mend restart when the record speaks for every scope.
- Executor `upload_answers` kept in Postgres across Mend restarts.
- Seal read-back that skips objects this process already verified since nothing could replace them.
- Git pack verification reused from register at the seal.
- Pack verification on worker threads, started early by a non-sealing register.
- One final flush per Stop, with the checkpoint and harvest deferred to it.
- One read pass per harvest and per agent-memory read-back.
- sealantd: unthrottled, multi-core final flush; four large uploads at once; bound PUTs.
- Core: Docker stop in two phases (`end`, record `stopped`, then `remove`) and a remains sweep.

**Out of scope.**

- Start time and restore speed. See `start-time.md`.
- S3 seal proofs at register time (ROADMAP "Not scheduled").
- An agent that ends on its own still flushes for its own harvest before any drain (decision 50
  "Only a Stop"). Only a Stop defers.
- The 4.8 s sealantd bulk re-walk on a final flush with nothing changed (sealantd#133 was
  withdrawn).
- Coalescing concurrent Stops per workspace (decision 50 "Known gap", a follow-up).
- Kubernetes, MicroVM and Cloudflare runtimes: they keep the one-call stop.

## How it works

In the order a Stop on Garage runs.

### 1. The executor says what it reads (launch time)

- sealantd's `plan.get` sends `upload_answers: ["present","sha256"]` (Sealantd
  `crates/sealant-capture/src/registrar.rs:362`, `UPLOAD_ANSWERS`).
- Mend keeps that in memory (`readsPresent`, `sendsSha256`) and on record in
  `capture_launch_answers` (migration 0100, packages/db/src/migrations.ts:2803). Write:
  `noteLaunchAnswers` (packages/db/src/repos/capture-store.ts:1158). Rows not planned for 60 days
  are deleted on every write.
- A process that never saw the plan reads it back (`recallUploadAnswers`,
  packages/sessions/src/capture-channel.ts:1196). Before 0100, every running executor read as an
  older daemon after a restart, and its Stop waited 10.5 minutes.

### 2. The bucket is measured (once per process)

In packages/store/src/blob-store.ts:

- `probeRefusesOverwrite` (:848): two conditional PUTs on `mend-probes/write-once/<uuid>`. A 412 on
  the second means the bucket refuses overwrites. The answer is remembered; a failed probe answers
  false and is asked again.
- `probeBindsBytes` (:890), exposed as `BlobStore.bindsBytes`:
  - only on a bucket that does not refuse overwrites;
  - a PUT on `mend-probes/bound/<uuid>` with another body's `ChecksumSHA256` must fail
    `InvalidDigest` or `BadDigest`;
  - the right checksum must then succeed;
  - the probe key is deleted either way;
  - a failed probe answers false, is not remembered, and is asked again.

### 3. `upload.urls` (each ship, including the final flush)

`uploadUrls`, packages/sessions/src/capture-channel.ts:1891:

1. `requireWorktree`, `requireLease(epoch)`, the per-call key cap and the request quota. A final
   flush and an unmetered (drain, kept, recovery) scope are never refused by the quota.
2. Keys outside the caller's epoch prefix, or not capture object keys, are dropped.
3. `bindable` (:1939–1940) = the launch reads `present` AND sends `sha256` AND `bindsBytes`.
4. Each wanted key is `HEAD`ed. A stored key is verified against its name (`verifyStored`); a launch
   that reads `present` gets it answered `present` with no URL.
5. Planning (:1993–2021). A key goes as one PUT when any of these holds:
   - its size is unknown;
   - it is below the threshold;
   - it is `boundable`: bindable, sized, at most `BOUND_SINGLE_PUT_MAX_BYTES` (5 GiB, :743), and its
     name gives its SHA-256 (`contentDigestOfKey`) or the request declares one in `sha256`;
   - it is a stored key answered with a legacy URL.

   Anything else goes in parts of 16 MiB.

6. Binding (:2024–2069):
   - a pack, tree or manifest key is bound to the digest its name says;
   - a declared digest that is not 64 lowercase hex, or that contradicts the name, is 400;
   - a pack index (`.idx`, whose name gives its pack's digest, not its own) is bound to its declared
     digest through `reserveBoundIndex` (capture-store.ts:1185). That takes an advisory lock on the
     key and `FOR UPDATE` on the row. A live binding to other bytes answers 409 `exists` ("was
     handed a URL for other bytes"). The same bytes never shorten the binding. Bindings dead for an
     hour are swept, 200 at a time.
7. Bound indexes are `HEAD`ed again (:2071–2105). One stored since the first look is answered
   `present`, gets no URL, and its binding stays (mend#464; never given back, decision 49).
8. `unbound` (:2108) is true when the call is not bindable, or has any part URL, or any single PUT
   without a binding.
   - Unbound: write authority is recorded before any URL leaves (`recordPutAuthority`, :2162). Its
     expiry is the URL lifetime (`putUrlTtlSeconds`: 5 min 30 s plus the declared bytes at 1 MiB/s,
     capped at 15 min) plus `PUT_URL_CLOCK_MARGIN_SECONDS` (5 min). The record is refused when a
     seal over the epoch's objects is recorded; then every key is asked of the bucket again.
   - Bound: no authority is recorded.
9. URLs are presigned (:2236–2257). `presign(key, "PUT", ttl, size, digest)` signs
   `x-amz-checksum-sha256` only when `bindsBytes` (blob-store.ts:1128–1156). A bound URL is not
   noted in the store's in-memory `minted` map, so `replaceableUntil` does not count it. After
   signing, a bound index's binding is extended (`extendBoundIndex`, capture-store.ts:1232). If the
   binding is gone or lapsed, the call dies and no URL leaves.
10. An unbound call that signed its URLs more than half the clock margin after recording authority
    dies, and no URL leaves.

### 4. sealantd uploads

- `put_if_absent` (Sealantd `crates/sealant-capture/src/sink.rs:757`):
  - hashes a pack index and declares it (`declare_sha256`);
  - sends `x-amz-checksum-sha256` only when the URL signs it (`signs_checksum_sha256`, :998);
  - gives one PUT the time its length needs (`single_put_time`);
  - reads 412 as already present.
- `put_multipart` (:823) declares an index's SHA-256 before the multipart mint (sealantd#130). When
  Mend answers one URL instead of parts, it makes one PUT.
- A URL is reused for up to 5 minutes (`PUT_URL_REUSE`, registrar.rs:1981).
- The final flush (sealantd#132):
  - is not throttled;
  - reads, hashes and compresses small files on reader threads (`readahead.rs`, at most 128 MiB of
    results waiting);
  - hashes and compresses a large file's parts on those threads;
  - hashes each pack's SHA-256 on its own thread with `ring`;
  - uploads objects at or over the multipart threshold four at a time.

### 5. Register and seal checks (Mend)

- Packs are verified on worker threads (`packages/store/src/pack-verify-pool.ts`,
  `PACK_VERIFY_WORKERS = min(8, availableParallelism − 1)`, :32). A register that seals nothing
  starts verifying its packs in the background, cut off after 5 minutes (`PACK_WARM_UP_LIMIT`,
  capture-channel.ts:746, used at :2900). The sealing register then waits only for what is left.
- The register's git verifier (`installPack`, packages/store/src/runner.ts:371) copies each new git
  pack down, hashes it, runs `index-pack --verify`, and keeps a proof: `rememberGitPackVerified`
  (:438), with the index's SHA-256 and the read time.
- Seal checks and seal read-backs share one process-wide permit (`sealVerifications`,
  capture-seals.ts:107), bounded at 30 minutes (`SEAL_VERIFICATION_LIMIT`).

### 6. Whether the seal stands

`sealStandingOf`, packages/sessions/src/capture-seals.ts:167:

1. A void seal is void. A capture that lists a pack index as a chunk pack voids the seal.
2. `storeUntil` is the max of `replaceableUntil(key)` over every listed key. That is 0 on a bucket
   that refuses overwrites, which stands at once.
3. `startupUntil` is the process start plus 15 min plus 5 min. `sealAuthorityOver(scopes, now)`
   (capture-store.ts:1129) reads, in one statement:
   - the latest `capture_put_authority.expires_at` across the scopes;
   - whether every scope's worktree row exists;
   - the 0099 cutover.

   `spokenFor` is true when every worktree exists and `now >= cutover`. When `spokenFor` holds and
   `storeUntil <= startupUntil`, the startup window is dropped (:222).

4. `until` = max(`storeUntil`, the recorded authority).
5. `boundIndexHold` (:123) reads every live binding among the listed `.idx` keys and hashes the
   stored bytes. A binding naming other bytes keeps the seal `withheld`, code `write-authority`.
6. While `now < until`: `withheld`.
7. A seal already re-verified at or after `until` stands.
8. Otherwise it is read back (`storedCaptureProblem`, packages/store/src/captures.ts:3724), with
   `proofs = { sinceMs: until, usedFromMs: at }`:
   - an object whose name is its digest, read whole by this process at or after `sinceMs`, is only
     `HEAD`ed;
   - a git pack with a `rememberGitPackVerified` proof at or after `sinceMs` and the same object
     format is `HEAD`ed. Its stored index is read and compared with the verified index's SHA-256. A
     different index means the full check;
   - the manifest, every other git pack and every pack index are read in full;
   - `usedFromMs` is lowered to the earliest proof used.
9. Other bytes → void, for good. Unreadable → `withheld` (`verifying`), asked again.
10. `boundIndexHold` again. Then `markSealReverified` from `min(at, usedFromMs)`. That is a
    compare-and-set under the scope rows' locks; a URL handed out since voids the mark and the seal
    stays `withheld`.
11. Read-backs are single-flight per (store, worktree, epoch, capture, until).

### 7. Postgres records (migration 0099, migrations.ts:2776)

- `capture_bound_indexes(key PK, sha256, until)`.
- `capture_bound_index_cutover(only_row, until)`. Written once, now + 20 min, only when worktrees
  already exist. Until then seals wait out the startup window. This covers bindings the pre-0099
  server held only in memory.
- `capture_put_authority`: existing, unchanged.

### 8. The Stop (session engine)

packages/sessions/src/engine.ts.

1. Three places put work off:
   - the Stop's own entry (:13400–13425) defers its `user-mark` checkpoint and change-head refresh,
     in the same uninterruptible step that marks and forks its tail. When `endsAtFinal` is false,
     the mark is taken at once, flush and all;
   - the ended agent's tail (:8193) defers its process-end checkpoint and harvest;
   - the settle sweep of a session with no agent (`sweepWorkspace`, :7676) defers its settle
     harvest.
2. When `endsAtFinal` holds (:3861: capture mode, not discarding, the queue not closed, and no live
   process lease or open forward on the workspace), the checkpoint, the change-head refresh and the
   harvest are appended with `deferToFinal` (:3666). Admission is refused once the queue is closed.
3. The drain (:4400ff):
   - writes the durable intent (`beginCaptureDrain`) and holds the queue (`queueHeld`);
   - checks whether the workspace is in use. If it is, the deferred work runs detached with `none`
     (each piece flushes for itself) and the drain ends `in-use`;
   - records `markFinalFlush`, then asks one FINAL (`observeCaptureFlush … "final"`).
4. Saved (the FINAL completed and the evidence reads saved, or the answer was lost and the store's
   seal stands for it):
   - `runDeferred(workspace, reading, deferredWorkLimit=2 min, closeWhenEmpty=true)` (:4660) runs
     each piece in the engine's scope, one at a time, under one consumer slot;
   - a piece past 2 minutes is left running (`deferredRunning`), the rest put back, the round
     recorded `kept` with `saved · the stop's checkpoint or harvest has not finished`, and the next
     round waits for it first;
   - only when the queue is empty and closed is the executor terminated.
5. Gone (the executor went): the queue runs on the last reading with no limit (`limit=null`), then
   `tidyAfterGone`.
6. Kept by the platform: the queue runs before Core's stop.
7. Every lease release under a workspace first runs `owedBeforeRelease` (:3771).
8. A harvest and an agent-memory read-back from a capture run in one read pass (`inOneReadPass`,
   :6832; call sites :6604, :7226, :10004, :10724). Each section's dir packs, indexes and packs are
   fetched once.
9. The deferred-work limit is `CaptureDrainPolicy.deferredWorkLimit` (2 minutes,
   packages/sessions/src/capture-runtime.ts:143).

### 9. Core terminates the executor

sealant#312, Core.

- `RuntimeAdapter.keepsRemains` (packages/workspaces/src/runtime/runtime-adapter.ts:401) is true for
  Docker (docker-runtime-adapter.ts:772).
- `stopRuntime` (packages/workspaces/src/worker/process-workspace-stop.ts:299–352), inside
  `removeUnderDeletion` and uninterruptible:
  1. `stop("end")`: `docker stop -t <grace>` (none when fenced), `docker kill`, then inspect. Still
     running fails the stop; gone is `not-found`.
  2. `markStopped`: Mend sees `stopped` here.
  3. `stop("remove")`: `rm -f -v`, the sidecar and the network. A failure is logged, not fatal.
  4. `markRemoved` writes `workspace_runtime_instances.removed_at` (migration
     `20261003093819_stop_remains_removed`).
- Runtimes without `keepsRemains` get one `stop()` call as before.
- `removeStoppedRemains` (reconcile-runtime-exits.ts:458) runs on every full exit-reconciler poll.
  It takes up to 20 instances recorded `stopped`, with no `removed_at`, ended more than 5 minutes
  ago, not retained. A capture-sourced (or unknown-source) one is taken only when the ledger
  recorded its deletion `deleted`, or it was discarded. It asks `remove` by resource id and
  reference.

### Restart behaviour

- Mend restart mid-Stop:
  - the durable drain intent survives and the sweep takes the drain up again;
  - the in-memory deferred queue does not survive. The harvest is recovered by the sweep; the stop's
    user-mark checkpoint and change-head refresh are lost (decision 50 "Known gap");
  - executor answers survive (0100); bound index bindings survive (0099);
  - the startup window is waived only when `spokenFor` holds.
- Core worker lost between `end` and `remove`: the container has exited, its row is `stopped`, and
  the remains sweep removes the rest after 5 minutes.
- sealantd restart: a new boot plans again and lists its answers again.

## Happy path

Alice runs Mend on the box (`https://alpha.mend.run`, Docker executors, Garage). Her project `mend`
has its `node_modules` saved in the background already.

1. Alice runs `mend claude` in `~/Developer/mend`, asks for a small README fix, and the agent edits
   one file.
2. In the web app she presses Stop on the session. The request answers at once. The session row
   reads `stopping` and the capture line reads `saving · 3 left`, then
   `saving · no uploads pending`.
3. On the box, sealantd logs `admission closed; every writer terminated for the final capture`, then
   `capture staged … kind=Final`, `final seal staged`, and
   `final capture complete: everything on this disk is registered`.
4. Mend logs `capture seals: read back { marked: true, readBackMs: <~1000> }`, then
   `session engine: capture flush · final · completed · observed`, then
   `capture drain · saved · terminating`, then `agent memory · read back`, then
   `worktree lease released`.
5. No `capture seals: … withheld until it expires` line appears for this seal.
   `capture_put_authority` holds no row with a future `expires_at` for this epoch.
6. About 10–19 s after the Stop, the session reads `stopped` with
   `saved at 12:25:52 UTC · capture 14`.
7. Bob, a member of the same organization, resumes his own session on another worktree of the same
   project at the same moment. His launch does not wait on Alice's save (another worktree, another
   lease).
8. Alice restarts the Mend container (`docker restart mend-mend-1`), waits for healthy, and stops a
   second session. That Stop also settles in under 20 s: no `withheld` line naming the startup
   window.

## Invariants

1. A seal on a bucket that does not refuse overwrites stands only after every object it names was
   read back, or proven by this process since the last moment any URL could have replaced it, and
   was found to be what its name says.
2. A bound URL is handed out only when the executor listed `sha256`, the store measured as binding,
   and the URL signs a SHA-256 that is the key's name or, for a pack index, a binding on record for
   that key.
3. Every upload URL that could replace an object is on record before it leaves Mend: unbound ones in
   `capture_put_authority`, bound pack index ones in `capture_bound_indexes`. No URL leaves if its
   record failed or lapsed.
4. Two live bindings of one pack index never name different digests.
5. A seal never stands while a live binding names other bytes than a pack index it lists.
6. The startup window is waived only when every scope's worktree row exists and the 0099 cutover is
   past, both read in one statement.
7. Nothing a Stop put off is dropped. Every deferred piece runs exactly once, or is still running
   and owed.
8. No worktree lease is released while deferred work is queued, running, or being consumed for its
   workspace (`owedBeforeRelease`).
9. No executor is terminated by a drain before its deferred queue ran to empty and closed.
10. A deferred piece is never interrupted once started.
11. Core never records `stopped` over a running container. A failed `end` fails the stop.
12. The remains sweep never removes the disk of a retained executor, or of a capture-sourced one
    whose deletion the ledger has not recorded final.
13. No loss of work product: no step of this feature deletes captured bytes, a seal or an executor
    that holds unsaved work. A save Mend cannot confirm keeps the executor
    (`not saved · workspace kept`).
14. One person's credentials are never spent by or exposed to another. Upload URLs are minted only
    for the caller's own epoch prefix and lease. Probe objects live under `mend-probes/` and hold no
    session data. A deferred harvest and memory read-back run as the session's owner (the engine's
    scope context). Read-back of agent memory follows #528 (only the person whose memory the home
    holds).
15. Status lines describe what was observed (`saving · 3 left`, `final seal not confirmed`,
    `saved at … · capture 14`), never a verdict such as "safe" or "done".

## Edge cases and failure behaviour

- **An older sealantd executor (no `sha256`).** No URL is bound, authority is recorded, and the seal
  waits until the URLs expire plus 5 min (about 10.5 min). The session reads `stopping` with
  `final seal not confirmed`. Known issues says so.
- **A new seal that carries an older executor's packs** waits for that executor's URLs to expire.
- **A single object over 5 GiB**, or an index with no declared digest past the threshold, goes in
  parts, records authority and waits.
- **The `bindsBytes` probe fails transiently** (Garage unreachable for a moment). That call is
  unbound and records authority; that Stop waits about 10.5 min. A later call probes again.
- **Mend restarts in the 20 minutes after first starting on 0.36** (the cutover): Stops wait out the
  startup window once.
- **Mend restarts while a session is running.** Its executor's answers are read from
  `capture_launch_answers`. Its Stop is bound and does not wait.
- **Mend restarts between a Stop's answer and the checkpoint's write.** The drain resumes from the
  intent. The harvest is recovered by the sweep. The stop's user-mark checkpoint and change-head
  refresh are lost. Accepted, decision 50.
- **A worktree removed while its seal is judged.** `spokenFor` is false and the window is waited
  out. No standing seal over objects whose authority went with the row.
- **Two `upload.urls` calls bind one index at once.** One gets 409 `exists`; the advisory lock
  serializes them.
- **An index stored between a call's first `HEAD` and its URL.** Answered `present`, no URL
  (mend#464).
- **A call stalls past its index reservation's life.** `extendBoundIndex` finds no live row, and the
  call dies with "a pack index URL was signed, and its binding is no longer on record · none handed
  out". The executor asks again.
- **A deferred piece runs past 2 minutes** (the checkpoint writer held by a landing, the store not
  answering). The round reads
  `not saved · saved · the stop's checkpoint or harvest has not finished · workspace kept`. The
  executor stays. The next kept-drain round (backoff 10 s doubling to 5 min) waits for the piece,
  sends a FINAL, and runs the rest.
- **The workspace is in use** (a sibling session's agent, a shell, a service forward). Nothing
  defers. Each end flushes for itself as before, and the drain ends `in-use`
  (`capture drain · the workspace is in use · nothing stopped`).
- **A sibling session's Stop in the same workspace, or a Stop refused admission.** It harvests
  inline and can read a successor's head if the lease is released under it. A pre-existing race,
  decision 50 "Known gap".
- **Discard unsaved and stop during a Stop.** Admission is sealed per session (`discardSealed`,
  counted). The discard waits for every Stop tail of that session, waits for the running drain, runs
  the deferred queue with no limit, and only then asks Core for a stop that does not drain.
  Overlapping discards of one workspace by two sessions are not coalesced (see Divergences).
- **The executor goes during the drain.** The deferred queue runs on the last reading with no limit.
  A FINAL that registered before it went leaves a readable head; otherwise the checkpoint is taken
  unflushed and there is no harvest.
- **Core: a daemon refuses `docker kill`.** `removalRefused`, the stop fails, and observations
  resume. A lost reply is unknown and the removal stays issued.
- **Core: `remove` fails after `end`.** `stopped` is recorded, the ledger's deletion is final,
  `removed_at` stays null, and the sweep retries after 5 minutes. The exited container's writable
  layer uses disk until then.
- **Older data.**
  - Stopped Docker rows from before `removed_at` existed are each confirmed once by the sweep.
  - A seal an older server recorded over a capture that lists an index as a chunk pack is voided.
  - `capture_launch_answers` has no row for launches before 0100. Those executors read as older
    daemons until they plan again (that is, until they are replaced).
- **Permissions.** Who may Stop is unchanged: the owner; others only with shared control. An
  operator gets no read access through this path. The capture channel authenticates the executor's
  token, not a person.
- **Clients.** Every client shows the same `captureStatusLine`: web, CLI dashboard and `mend stop`,
  phone, desktop, VS Code, Slack thread reports, and the t3 gateway's thread state. None has a
  Stop-specific path for this feature.

## Known limits

- ADR 0002 decision 48 "What remains" and decision 49 "What remains":
  - older daemons;
  - objects over 5 GiB;
  - scopes whose worktree is gone;
  - after a restart, the first seal of each worktree reads everything once;
  - the tree walk and the register's restorability check are single-threaded.
- Decision 50 "Known gap":
  - a restart between a Stop's answer and its checkpoint loses the user mark;
  - the sibling-Stop and refused-admission races;
  - coalescing Stops per workspace is a follow-up.
- Known issues, "A Stop on Garage can wait for its seal"
  (apps/docs/src/content/docs/reference/known-issues.md:13).
- What remains per Stop after sealant#312 (owner's note):
  - 4.8 s sealantd bulk re-walk with nothing changed;
  - ~1.4 s seal;
  - ~2 s of Core's stop path besides `rm`.
- Mend's single-process assumption is load-bearing for the in-memory `minted` map, the deferred
  queue and the proofs (`contentVerified`, `gitPackVerified`). Helm pins `replicaCount: 1`.

## How to verify

**Tests.**

- Mend `packages/sessions/test/capture-verify.test.ts`:
  - "binds every URL to its bytes, records no authority…" (:3097);
  - index digest pinning (:3129, :3153);
  - a part URL records authority (:3175);
  - a live bound URL holds the seal (:3191);
  - "a restart holds no seal" (:3222);
  - "after a Mend restart a running executor is still answered bound URLs" (:3267);
  - index-as-pack refusal and void (:3314, :3349);
  - binding gone at signing (:3368);
  - index stored after first look (:3396);
  - one bound PUT past the threshold (:3431);
  - older daemon and undeclared index record authority (:3468).
- Mend `packages/store/test/blob-store.test.ts` (probe), `pack-verify-pool.test.ts`,
  `runner.test.ts:256` (read-back reuses the installed pack), `capture-write-once.test.ts:116`,
  `:172` (one pass).
- Mend `packages/db/test/capture-store.test.ts`: bindings, cutover, launch answers.
- Mend `packages/sessions/test/engine.test.ts`:
  - :8428 (a user stop flushes the executor before its workspace goes);
  - :8324–8336 (deferred final registration before harvest);
  - :7848 (HOME relocation harvests the final flush);
  - :15343 (a deferred checkpoint that runs out of time keeps the executor).
- Core `packages/workspaces/src/runtime/docker-runtime-adapter.test.ts`,
  `worker/process-workspace-stop.test.ts`, `worker/reconcile-runtime-exits.test.ts`. The db-backed
  suites need `SEALANT_TEST_DATABASE_URL`; `listStoppedWithRemains` was typechecked, not executed,
  in the PR. Core CI has no unit-test job.
- sealantd `crates/sealant-capture/tests/bound_put.rs` (a local checksum-enforcing server; real
  Garage behind `MEND_TEST_BOUND_URLS`), `ship_multipart.rs`, and `registrar.rs`
  `a_declared_sha256_travels_with_the_mint_of_its_key`.
- Not covered by tests:
  - a real Garage in CI;
  - the restart-between-answer-and-checkpoint gap;
  - two sessions stopping in one workspace;
  - the 60-day `capture_launch_answers` purge against a long-lived executor.

**By hand on the box.** Use the owner's driver at `~/.cache/mend-perf/` (`zsh ./run-all.sh` for
T2–T4, `zsh ./run-agents.sh` for T5/T6), or:

```sh
mend run -- bash          # note the session id
# in another terminal, after the dependency save registered (sealantd log: class=Some(Bulk)):
mend shell <id>   # echo x >> README.md; exit
time mend stop <id>       # then poll:
ssh -J root@100.94.101.28 root@10.0.0.40 \
  "docker exec mend-postgres-1 psql -U mend -d mend -Atc \
   \"select status, settled_at, capture_drain from agent_sessions where id::text like '<id>%'\""
# restart case:
ssh … 'docker restart mend-mend-1'   # wait for healthy, then stop another session
# authority on record for the worktree (empty or past means nothing held the seal):
ssh … "docker exec mend-postgres-1 psql -U mend -d mend -Atc \
  \"select epoch, expires_at from capture_put_authority where worktree_id='<wt>'\""
```

Delete test worktrees afterwards (`mend worktrees rm`, or `DELETE /api/worktrees/<id>?force=true`).

**Signals.**

- Mend log, good:
  - `capture seals: read back { marked: true, readBackMs, restsOnReadsFrom }`;
  - `capture channel: register · timings { gitVerifyMs, sealChecksMs, sealStandingMs }`;
  - `capture drain · saved · terminating`;
  - `worktree lease released`.
- Mend log, waiting:
  - `capture seals: sealed, but an upload URL of its epoch could still replace what it names · withheld until it expires`;
  - `… a bound upload URL names other bytes for a pack index … withheld`;
  - `work deferred to the final flush did not finish in time · left running · executor kept`.
- sealantd: `final capture complete … took_ms`, `capture staged … elapsed_ms`.
- Core: `Workspace stop: run … ended and was recorded stopped; removing its remains failed`, and
  `Runtime exit reconciler: removed the remains of …`.
- Session line: `saving · … left`, then `stopped`, `saved at … · capture n`. Anything else
  (`final seal not confirmed`) is the wait.

## Divergences found while writing

1. apps/docs/src/content/docs/reference/server-environment.md:64 says
   `MEND_CAPTURE_MULTIPART_THRESHOLD` "Captures at or above this size upload in parts". A bindable
   call (Garage + current sealantd) sends any key Mend can bind as one PUT up to 5 GiB
   (capture-channel.ts:1998–2009).
2. packages/db/src/repos/capture-store.ts:1167–1170 deletes `capture_launch_answers` rows not noted
   for 60 days. An executor plans only at boot, and Docker executors have no time limit. A session
   running for more than 60 days, followed by a Mend restart, reads as an older daemon, and its Stop
   waits about 10.5 min. Unlikely, but nothing documents it.
3. packages/store/src/blob-store.ts:890–938: a failed `bindsBytes` probe answers false for that
   call, which then records authority. A Garage hiccup at the first `upload.urls` after a start
   costs that Stop the full wait. Known issues does not list it.
4. packages/sessions/src/engine.ts:3666–3866 and ADR 0002 decision 50: the deferred queue, the
   proofs and the minted map are in memory. A restart between the Stop's answer and the deferred
   checkpoint loses the user mark and the change-head refresh. This is documented, but it is a
   regression from 0.35, where the mark was written before the answer. No replay from the drain
   intent exists yet.
5. packages/sessions/src/engine.ts:3634, :4838, :4926: `discards` is a `Set` keyed by workspace, not
   counted. When two discards of one workspace overlap (two sessions sharing it, or one session
   asked twice), the first to finish removes the workspace from it while the other is still waiting
   on tails or the drain. From then on `endsAtFinal` (:3865) and the drain loop (:4407) no longer
   see a discard. `discardSealed` (:3646) is counted per session, which fixed the same-session case
   Astra pass 14 found (/tmp/astra-oneflush14.md, item 1). The workspace set was left as it was.
   Pass 14's other two P1s are in ADR decision 50's "Known gap": a discard waits only for its own
   session's Stops, and an ordinary drain ignores another session's inline harvest.
6. ROADMAP.md (and open PR #530) lists the saves work as Mend PRs only. sealant#312 and sealantd#132
   are part of the measured 15–19 s but only appear in the Core and sealantd lines. #530's "observed
   15–19 s" predates preview 10's 10–14 s. Wording only.
7. ADR 0002 decision 48 (line 1446) still describes the in-memory `bound-index-digests.ts` registry
   and the 256 MiB ceiling. Both are superseded by decision 49 (0099, 5 GiB). The text says
   "Superseded the same day" for the restart window only, not for the registry file, which no longer
   exists on main.
