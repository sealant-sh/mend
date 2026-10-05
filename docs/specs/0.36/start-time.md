# Start time

- **Release:** 0.36
- **Status:** on main. Every PR below is merged. Not yet measured end to end on the box: an agent is
  measuring now (see the table under "How to verify").
- **PRs:**
  - mend#507 (startup never waits on an executor);
  - mend#513 (a launch writes its files in a few execs);
  - mend#514 (`mend resume` takes the id it is given);
  - mend#515 (the bundled Sealant worker launches four workspaces at once);
  - mend#516 (a relaunch waits for the session's own earlier executor's lease; one judge for lapsed
    leases);
  - sealant#313 (reading a run's changes starts from a refreshed copy of the index; `available` and
    `unavailableReason`);
  - sealant#314 (an exec is read back soon after it ends; `ready()` looks again soon);
  - sealantd#135 (a restore writes files on every core).
- **Decision records:** docs/adr/0002-session-capture-store.md: "A launch waits for the worktree's
  previous executor" (line 338), "A launch answers promptly" (line 353), "Replacement and pickup"
  (line 321) and decision 39. No ADR of its own.
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`. Mend main pins `@sealant/sdk` 0.39.0-next.683, which carries sealant#313 and #314. Core
  main pins sealantd 0.20.0-next.142, which carries sealantd#135.

## Why it exists

On the Docker box (preview 11, 2026-10-04), a new session took about 90 s (90–101 s over 6 samples,
Codex and Claude) from `mend codex` to the agent's first output. A resume took about 62 s (57–67 s).
The owner asked for Docker start time to be cut the way Stop was (release-roadmap memory note,
2026-10-04).

Measured breakdown of the baseline:

| Where                                                                        | New session       | Resume           |
| ---------------------------------------------------------------------------- | ----------------- | ---------------- |
| Docker container start itself                                                | ~7 s              | ~7 s             |
| Skills written into the workspace: 103 execs × ~0.53 s                       | 52.7 s (52–58 s)  |                  |
| Agent memory written: 11 execs                                               | 6.4 s (6.4–8.1 s) | ~6 s             |
| Dependency install (`pnpm install`)                                          | ~14 s             |                  |
| sealantd restore of the head (127,000 files, 2.48 GB, mostly `node_modules`) |                   | 32.8 s (31–40 s) |
| Waiting in Core's build queue behind another launch's restore                |                   | up to 33 s       |

Where the 0.53 s per exec went:

- the SDK waited 500 ms before it first read an exec's run (sealant#314);
- Core rehashed the whole worktree (~330 ms for 1,800 files) at the end of every exec, because a
  restored index's stat data matches no file (sealant#313).

Two incidents ride along:

- **2026-10-03 23:00 UTC, preview 13 never came up on the box.** Mend's boot pass drained a
  session's executor inline, with no Sealant principal, for up to the 600 s stall window. The bundle
  supervisor restarted Mend after 240 s, in a loop. The box was rolled back by hand (mend#507; owner
  memory note "mend-box-vm").
- **2026-10-03, alpha session 8fe91d79.** Four replacement executors in a row each booted into
  sealantd's `plan.get` wait ("another launch holds the worktree's lease") and were retained at
  Core's 120 s readiness budget (`launch-retained`). Mend had read the session's own earlier lease
  as free (mend#516).

The baseline cost every person every session start, on every client.

## What it does

- A person starts a session: `mend codex`, `mend claude`, `mend run -- <cmd>`, the web composer, the
  phone, the desktop app, VS Code, a Slack `@mend`, or a t3 gateway thread. They resume one with
  `mend resume <id>` or Resume in the web app.
- Mend launches the workspace, restores the worktree's head, writes the person's skills, agent
  memory, pi profile, secret files, git author and shell profile into it, installs dependencies if
  needed, and starts the agent.
- The session line reads `starting`, then `starting · booting` while the platform readies the
  workspace. When the worktree's previous executor has not ended, it reads
  `starting · waiting · the previous session in this worktree is saving` (or `… is not answering` /
  `… has not confirmed its end`).
- Expected time: about 25 s to first output for a new session and 25–30 s for a resume (owner note,
  2026-10-04). Not yet measured; see the table below.
- `mend resume <id>` resumes exactly the session named. Before #514, without `--with`, it resumed
  the project's newest settled session.
- A Mend restart (a deploy) brings the HTTP API up within seconds, whatever its sessions' executors
  are doing.

Defaults and settings:

- `WORKSPACE_BUILD_QUEUE_PREFETCH`: the bundled (Docker `mend server setup`) worker gets `4` unless
  the operator set it. Core's own default stays `1`. The same setting governs workspace stops (the
  lifecycle queue).
- `RUN_EXEC_QUEUE_CONCURRENCY`: Core's default `4`, unchanged.
- `MEND_LAUNCH_LEASE_WAIT_SECONDS`: how long a launch waits for the worktree's previous executor,
  default 30 minutes (`CaptureDrainPolicy.leaseWait`).
- No switch turns the faster paths off. The index cache and the parallel restore are always on.

**In scope.**

- Boot: Mend's engine stands once rows are reconciled. Platform work is forked as each session's
  owner.
- Launch file delivery in a few execs (skills, agent memory, pi profile, carried Codex
  conversations, pasted images).
- SDK exec and `ready()` polling backoff.
- Core's working-tree reading from a kept, refreshed index copy, and the `available` /
  `unavailableReason` fields on a run's changes.
- sealantd restore writes on up to 16 threads.
- Bundled worker queue concurrency 4.
- Lease correctness for relaunches, and the single judge of lapsed leases.
- `mend resume <id>` positional parsing.

**Out of scope.**

- The dependency install's own time (`pnpm install`, ~14 s on a new worktree). See
  `automatic-install.md`.
- Image builds after an update (~8 min, `LAUNCH_PREPARING`).
- The restored index's stale stat data that makes the agent's first `git status` slow (a sealantd
  follow-up named in sealant#313).
- `plan.get` answering `worktree-leased` while Mend cannot yet verify the head's git section
  (decision 39). sealantd still logs that as "another launch holds the worktree's lease"; a distinct
  reason is a follow-up (#516 body).
- Kubernetes and MicroVM deployments: they do not get `WORKSPACE_BUILD_QUEUE_PREFETCH=4` from the
  bundle.
- Stop time. See `saves-without-the-wait.md`.

## How it works

### Mend boot (mend#507)

`SessionEngine.resume`, packages/sessions/src/engine.ts:15254. It runs inside the engine layer's
construction, and the HTTP server, the capture channel and the session socket host are built on that
layer.

1. `reconcileStaleRuns()`, then re-attach supervision for every active run (`forkSupervision`).
2. The transcript classification pass is forked (`Effect.forkIn(classifyUnclassifiedSessions)`,
   :15292).
3. For each unsettled session:
   - one re-attached, or `stopping` with no live process, is skipped (the reaper owns it);
   - one with a live process is folded with `sweep: false`;
   - one whose processes all ended is folded inline with `sweep: false`. If that settled it, the
     session joins `bootSwept` (:15244). Its tail (`sweepWorkspace`, or `stopWorkspaceIfUnleased`
     when the row names no workspace) is forked in the engine scope under
     `asSealantUser(ownerUserId)` (:15303–15336);
   - one that never reached a process settles `failed` with "process restarted before the harness
     started".
4. Service forwards are re-bound forked, under `withServiceLifecycle`.
5. Watchers for live PTY agent, shell and Service processes are re-forked under `owned(sessionId)`.
6. Session sockets are bound (`socketHost.start`) for every session that has a live process, a
   forward, or a worktree lease naming it.
7. Last, each live `agent-protocol` row is rehydrated in its own fiber, as the owner. The session is
   marked `recovering` (counted). The fiber runs the rehydrate (or the relaunch behind a failed
   one), then watches the row if it still reads live (:15569–15598).
8. `sweepLeftovers` (:15610) skips `bootSwept` and `recovering` sessions. It re-reads a row after
   the platform answers and acts only on one still settled on the same workspace.

Principals: `asSealantUser(null)` and `owned` on a missing row both run as `{kind: "none"}`, so
every platform call fails `NO_PRINCIPAL` and never falls back to another account
(packages/sealant/src/principal.ts:32).

The bundle supervisor waits up to 240 s for `http://127.0.0.1:3101/api/health`
(scripts/bundle-supervisor.mjs:220) before it restarts Mend.

### The launch, and where each fix lands

`launchInternalBody`, engine.ts:11081, in order:

1. **Lease wait.** `awaitWorktreeHolder(session, reusedCreateKey)` (:11268, defined :3461). It calls
   `leaseHolderWorkspace(session, ownLaunch)` (:3327) every `leaseWaitInterval` (5 s), up to
   `leaseWait` (30 min).
   - **#516.** A lease bound to a launch of this same session other than `ownLaunch` (the create
     this launch asks again) is a holder like any other (`ownEarlierLaunch`, :3333–3337). Before,
     any lease naming the session read `free`.
   - A live lease's executor is the lease's own (`leaseExecutorWorkspace`, :3204). That is the row's
     workspace only when the row names that very launch (`executorLaunchOf`). Otherwise it is null:
     no confirmed end, so the lease is held.
   - A lapsed lease is decided only by `judgeLapsedLease(holder, lease, asking)` (:3282):
     - `dead` when there is no holder row, or `resolveLeaseExecutor` (:3224) answers `none`, or the
       resolved workspace's `workspaceState` is `dead` with no unanswered create;
     - `resolveLeaseExecutor` asks Core `findWorkspaceByKey(launchId)`, then
       `fenceWorkspaceCreate(launchId)` (a launch id is the create's idempotency key, `standby:<id>`
       included). It answers `unknown` while the lease is live, a create of the holder's is in
       flight here (`creatingExecutors`), another gated launch of the holder is under way, the
       holder's row has an unanswered create key, or Core does not answer.
   - The judge is the only decider at five sites:
     - `flushLeaseHolder` (:2845);
     - `launchUnresolved` (:3160);
     - `leaseHolderWorkspace`;
     - `captureHolds` (:5011);
     - the reaper's lapsed branch.
   - `dead` with work still owed reads `ending`. Otherwise the lease is released epoch-scoped and
     the launch reads `free`.
   - `releaseLeaseOfWorkspace` (:3950) releases a launch-bound lease only while the row names that
     workspace under that very launch.
   - An unusable claimed standby gives its own claim back at once (`(S, standby:<entry>)`,
     epoch-scoped).
2. **Create and ready.** `sealant.createWorkspace`, then the SDK's `ready()`.
   - **sealant#314.** `ready()` polls at 100 ms, doubling to 1 s
     (packages/sdk/src/facade/workspace.ts:92–93, :404–445). It was a fixed 2 s.
   - **mend#515.** Core's build queue consumer runs `WORKSPACE_BUILD_QUEUE_PREFETCH` jobs at once
     (Core apps/worker/src/workers/workspaces.ts:332). The lifecycle (stop) consumer reads the same
     value (:387). The bundle sets it to `4` unless the operator set it (`workerQueueEnvironment`,
     scripts/bundle-supervisor.mjs:135, used :182). A launch holds its job until its executor is
     ready, restore included.
3. **Restore (sealantd boot).**
   - **sealantd#135.** The materializer's walk makes directories and collects files. `write_files`
     (crates/sealant-capture/src/materialize.rs:1357) writes them on
     `restore_writers() = min(available_parallelism, 16)` threads (:491), or 4 when unknown.
   - Each file is staged as `.<name>.capture-tmp` (created 0600, never truncating an existing name),
     then given its mode and renamed into place.
   - The first failure stops the rest. Files already written are entered in the index either way.
   - Symlinks, hardlink members, the sweep and directory metadata follow the writes, unchanged.
   - Boot logs `capture head materialized` with `elapsed_ms`
     (crates/sealantd/src/boot/capture.rs:489).
4. **Files into the workspace (mend#513).** `writeWorkspaceFiles` (engine.ts:9711) runs
   `writeFilesExecs(files)` (packages/sessions/src/workspace-files.ts:123) sequentially, failing on
   the first nonzero exit with `WorkspaceFileError`.
   - Callers: skills (:9808), pi profile (:9854), agent memory staging (:9910), carried Codex
     conversations (:10425), pasted images (:10745).
   - Contents are deduplicated by bytes (one skill in `.claude`, `.codex` and `.pi` travels once)
     and gzipped at level 9. The base64 is cut into arguments of at most 90,000 characters
     (`WORKSPACE_EXEC_ARG_CHARS`); one exec carries at most 1,000,000 characters
     (`WORKSPACE_EXEC_BATCH_CHARS`), paths excluded.
   - Each exec is `sh -c 'exec node -e <WRITE_PROGRAM> -- "$@"' mend-write <ops…>`. The ops are:
     - `w`: write each path;
     - `s` / `a`: create (exclusively) or append a `.mend-stage-<hex>` staging file beside the first
       path, for a content too large for one exec;
     - `f`: write the staged content to each path, then remove the staging file.
   - Every path's directory is made and set 0755. Each file is written to a `.mend-part-<hex>`
     sibling (created exclusively, 0600), set 0644, and renamed into place. The exec exits 3 if any
     path it wrote is not a file afterwards.
   - Secret files do not use this path: they keep their own 0600 writer
     (packages/sessions/src/secret-files.ts).
   - Each exec (sealant#314, packages/sdk/src/effect/exec-workspace.ts):
     - the run is first read 25 ms after it is registered, then at doubling waits up to 500 ms
       (`FIRST_POLL_MS`, `MAX_POLL_MS`);
     - stdout, stderr and changes are read together once it ends.
5. **Every exec ends with Core's working-tree reading (sealant#313).** `captureChanges` (Core
   apps/worker/src/workers/process-run-exec-job.ts:224) runs `workingTreeChangesScript`
   (packages/workspaces/src/git/working-tree-changes.ts):
   - Snapshots the repository's index with `cp -p` and keys a kept copy by the checksums of the
     absolute git dir and of the snapshot.
   - Uses `$TMPDIR/sealant-index-<repo>-<sum>.<own>` only when all three checksums are numeric and
     the copied bytes match the kept copy's own checksum.
   - Refreshes it with `git update-index -q --refresh`, publishes the refreshed copy by rename, and
     removes older copies for the repository.
   - Runs `git add -A`, `diff --cached` and `--name-status` against the throwaway index, each
     `|| exit 1`.
   - Never writes the repository's own index.
   - A nonzero exit records `changes_read_failed_at` (Core migration
     `20261004135141_run_changes_read_failed`). The SSH gateway's recorder does the same
     (apps/ssh-gateway/src/run-recorder.ts:150–165).
   - `GET /v1/runs/:id/changes` (apps/api/src/routes/runs/runs.module.ts:304) answers
     `available = diff !== null || changedFiles !== null`. When false, `unavailableReason` is one
     of:
     - "reading the run's changes failed";
     - "no reading of the run's changes was recorded";
     - "the run has not ended".
   - The SDK defaults a missing `available` to `true` (an older control plane,
     packages/sdk/src/facade/run.ts:38).
6. Git author, shell profile, secret files, dependency install, harness warm-up, then the agent
   starts.

### CLI (mend#514)

`mend resume <id>` takes its id with `firstPositional(args, ["--with"])` (apps/cli/src/main.ts,
helper in apps/cli/src/shared.ts from #470).

### Concurrency and restart notes

- Four launches (and four stops) run at once in the bundled worker, image builds included.
- Mend restart mid-launch:
  - a cold launch's claim made before `provisionWorkspace` and cut short before its create leaves a
    lease bound to a key no row names;
  - after the claim's 5-minute TTL the lease is lapsed. The next resume, sibling launch, removal,
    landing flush or reaper tick asks Core: `findWorkspaceByKey`, then `fenceWorkspaceCreate`. A
    fenced key reads `dead` and is released;
  - while Core does not answer, the lease is held.
- An ungated launch (`finishPlannedLaunch` in the reaper, `replaceExecutor` → `resumeSession`)
  slower than the 5-minute claim TTL between claim and create can have its key fenced by another
  judge. Its create then fails cleanly; nothing is lost. Accepted in review rounds 4 and 5.
- Kept index copies live in the workspace's `$TMPDIR`, one per git dir. A SIGKILL mid-reading can
  leak a tmp, snapshot or `pub.$$` file, each one index in size.

## Happy path

Alice and Bob use Mend on the box. Project `mend` has its dependencies saved in the store.

1. Alice runs `mend codex` in `~/Developer/mend` at 10:00:00. The CLI prints the session id `3f2a…`.
   The session reads `starting · booting` for a few seconds.
2. sealantd's boot log shows `capture head materialized { elapsed_ms: ≈5000–10000, files: ≈127000 }`
   (target; the baseline was 31–40 s).
3. Mend writes Alice's 33 skills and her memory for `mend` in two or three execs. Core's run list
   for the workspace shows `mend-write` execs, not 103.
4. Codex prints its first output at about 10:00:25 (target).
5. Meanwhile Bob resumes yesterday's session in another worktree (`mend resume 9c1e0a77`). His
   launch does not queue behind Alice's restore: Core's `workspace_attempts` shows his attempt
   started within a second of being queued.
6. Bob runs `mend resume 9c1e0a77` again by mistake while the first resume is still saving the old
   executor. The second launch reads
   `starting · waiting · the previous session in this worktree is saving`, creates nothing, and goes
   on once the old executor's end is confirmed (epoch + 1).
7. The operator deploys a new preview while both sessions run (`deploy-box.yml` with
   `even_if_live`). Mend logs `mend api starting`, `re-attached` for each session, and is listening
   on 3101 within a few seconds. Both sessions keep running, and Alice's protocol session is
   rehydrated in place.

## Invariants

1. Building the session engine never waits on an executor. No flush, drain, rehydrate or platform
   lookup runs inline in `resume`; the engine builds within 5 s over the box's state.
2. Every piece of boot work that reaches the platform runs as its session's owner, or as `none` and
   fails. It never runs as another person and never falls back to an operator account. One person's
   credentials are never spent by or exposed to another.
3. A launch never creates an executor while a lease bound to another launch of the same session is
   live or lapsed and its end is not confirmed. Not by the session itself, and not by anyone else.
4. A lapsed lease is released only when `judgeLapsedLease` says `dead`, and only epoch-scoped. A
   claim made since is never freed by a stale release.
5. No lease is released while work a Stop deferred for that workspace is owed (`workOwed` reads
   `ending`).
6. `releaseLeaseOfWorkspace` never frees a lease bound to a launch other than the one the row names
   with that workspace.
7. When Core does not answer, the lease is held and removal is refused. Not knowing is never read as
   ended.
8. A file Mend writes through exec is either absent or complete at its path. A reader never sees a
   partial file: content goes through a `.mend-part-*` sibling and a rename.
9. Paths written through exec are chosen by Mend and ride as positional parameters. Nothing is
   interpolated into the script.
10. The working-tree reading never writes the repository's own index.
11. A reading that failed is never recorded as "no changes". `available` is false with a reason. The
    kept index may cost time, never correctness: a non-numeric checksum disables it.
12. A restore lays down the same bytes, modes and index as a single-threaded restore. A failure
    leaves no truncated file at a user's path.
13. No loss of work product. None of these changes deletes captured work. A held lease, an unknown
    platform answer, and an unusable standby never let a launch build over an executor that may hold
    unshipped work.
14. Session lines say what was observed
    (`waiting · the previous session in this worktree is saving`, `… has not confirmed its end`),
    never a verdict.
15. `mend resume <id>` resumes the session named by `<id>`, or fails. It never resumes another.

## Edge cases and failure behaviour

- **Mend restarts mid-drain of a just-resumed session** (the 2026-10-03 sequence). The boot folds
  the row inline and forks `sweepWorkspace` as the owner. HTTP comes up at once, and the drain
  finishes in the background.
- **Mend restarts between a launch's claim and its create.** After 5 minutes the lapsed claim is
  judged. Core fences the key and the lease is released. The next resume goes on. A landing is not
  blocked (test "a relaunch's claim cut short by a restart does not hold up a landing"). A removal
  goes once the platform fences (test "removing a session whose first launch was cut short…").
- **Core does not answer `findWorkspaceByKey` or `fenceWorkspaceCreate`.** `unknown`: the launch
  waits until `leaseWait` (30 min), then fails with the lease-wait words. Removal is refused.
  Nothing is released.
- **Another session's lease bound to a launch its row no longer names.** It is a hold: no launch, no
  release, no removal, until Core resolves the key.
- **A claimed standby found dead or half-stamped.** Its own `(S, standby:<entry>)` claim is released
  at once and the launch goes cold, with no 5-minute wait.
- **An exec in a multi-exec staging fails midway.** The `.mend-stage-*` file (base64 text, under the
  harness home) is left behind and nothing sweeps it. The target path is untouched. A retry mints
  new names and writes whole. A leftover inside a skill directory changes its tree digest, so the
  next launch moves that skill aside once and rewrites it.
- **An image with no `node`.** Skills, pi profile and Codex conversations log a warning ("skills
  were not delivered to the workspace") and the agent still starts. Agent memory says "not delivered
  · the image has no node" once per image, and removes what it staged. A pasted image fails with
  `PastedImageError` (`write-failed`).
- **A content past one exec** (a large pasted image, up to the paste limit). Staged across several
  execs, ~1 MB of argv each, within sealantd's 8 MiB frame.
- **`cksum` missing or broken in the image.** The index cache is skipped, the reading starts from
  the snapshot, nothing is kept, and the output is correct but slow.
- **A same-second, same-size edit.** Caught: every copy keeps the index mtime (`cp -p`), so git's
  racy-clean check still rehashes.
- **An unreadable file in the worktree, or ENOSPC on `$TMPDIR`.** `git add -A` fails, the script
  exits 1, the run records `changes_read_failed_at`, and the API answers `available: false`,
  "reading the run's changes failed".
- **Runs from before sealant#313, workspace-session runs, and cancelled runs.** `available: false`,
  "no reading of the run's changes was recorded". An old failed reading that stored `""`/`[]` reads
  `available: true`; it is indistinguishable.
- **Four concurrent launches on a small host.** Each restore uses up to 16 threads, and four run at
  once. CPU and disk contention can slow each one; nothing is lost.
- **An operator set `WORKSPACE_BUILD_QUEUE_PREFETCH`.** Their value wins, including `1`.
- **Older SDK against a newer Core.** The extra fields are ignored. Newer SDK against an older Core:
  `available` defaults to `true`.
- **Permissions.**
  - Resume and relaunch are the owner's, or a steerer's under shared control. The lease logic is per
    session and independent of who asked.
  - Execs run as the session owner's Sealant user.
  - Skills, memory and the pi profile are the owner's (agent memory hand-over between people is
    #528's; see the memory spec).
  - An operator has no new access.
- **Clients.** Start time is the same on every client. Only the CLI had the resume-id bug (#514).
  The phone, web, desktop, VS Code, Slack and the t3 gateway show the same launch-phase words
  (`launchPhaseOf`, packages/domain/src/workbench/launch-phase.ts).

## Known limits

- The dependency install still runs at launch on a new worktree (~14 s on the box).
- A restored index's stat data is stale for the agent's own first `git status` (a sealantd
  follow-up).
- `plan.get` still answers `worktree-leased` while Mend cannot verify the head's git section, and
  sealantd logs it as a lease held by another launch (ADR 0002 decision 39; #516 body).
- The ungated-launch-past-TTL liveness case (start-time review rounds 4 and 5): a create fails
  cleanly and the person starts again.
- Leftover `.mend-stage-*` / `.mend-part-*` files from an interrupted write stay in the harness home
  and travel with its captures.
- File contents (skills, memory, pi profile, carried conversations, pasted images) ride exec argv,
  gzip+base64, and are recorded in Core's exec run record under the session owner, as before #513.
- Core's own default `WORKSPACE_BUILD_QUEUE_PREFETCH` is still 1 (open question in #515). Helm and
  MicroVM deployments do not get 4.

## How to verify

**Tests.**

- Mend `packages/sessions/test/engine.test.ts`, describe "SessionEngine startup never waits on an
  executor (2026-10-03)" (:22080):
  - "finishes while a folded session's executor is still to be drained…";
  - "re-forks the watcher of a live agent process as the session's owner…".
- Mend engine tests for #516:
  - "a resume never creates over a lease of the session's earlier launch whose end nothing confirms
    (alpha 2026-10-03)" (:13705);
  - "another session's lease of a launch its row no longer names is a hold…" (:13753);
  - "a restart between a launch's claim and its create leaves a lease the platform resolves…"
    (:13857);
  - "an unnamed launch the platform finds ended is released…" (:13885);
  - "a fenced create's own lease is released even while the previous executor cannot be read"
    (:13908);
  - "a relaunch's claim cut short by a restart does not hold up a landing" (:13934);
  - "removing a session whose first launch was cut short after its claim…" (:13954);
  - "an unnamed launch the platform cannot resolve stays held…" (:13986);
  - "a claimed standby found dead gives up its claim at once" (:10907).
- Mend `packages/sessions/src/workspace-files.test.ts`: one exec for small files; a whole skills
  library in one exec; staging across execs; a payload named like a staging file; a new exec when
  the next content does not fit; a path given twice.
- Mend `apps/cli/src/main.test.ts` (#514: resume by id without `--with`) and
  `scripts/bundle-packaging.test.mjs` (#515: the worker env defaults to 4; an operator's value
  wins).
- Core `packages/workspaces/src/git/working-tree-changes.test.ts`:
  - stale stat data;
  - same-second edit;
  - unreadable file;
  - force-added file;
  - two repositories in one TMPDIR;
  - non-numeric `cksum`.
- Core `apps/api/src/routes/runs/runs.owner-scope.test.ts`,
  `apps/ssh-gateway/src/run-recorder.test.ts`,
  `apps/worker/src/workers/process-run-exec-job.test.ts`.
- Core `packages/sdk/src/exec-lifecycle.test.ts` (an exec that ends at once resolves under 250 ms;
  doubling to 500 ms) and `packages/sdk/src/workspace-lifetime.test.ts` (`ready()` under a second).
  Core CI has no unit-test job: these run locally only.
- sealantd `cargo test -p sealant-capture`, including the materialize suites; `examples/bench`
  (`materialize (All)`).
- Not covered by tests:
  - real Docker timings;
  - four concurrent restores' contention;
  - the race between `findWorkspaceByKey` and a slow ungated create;
  - Mend's own consumer of `available` (none exists).

**By hand on the box.**

```sh
# new session: time to first output
time mend codex            # in a clone of the project; note when Codex first prints
# resume: time to first output (pass the id; #514)
mend stop <id>; time mend resume <id>
# restore time
ssh -J root@100.94.101.28 root@10.0.0.40 \
  'docker logs $(docker ps --format "{{.Names}}" | grep ^sealant- | grep -v docker | head -1) 2>&1 \
   | grep "capture head materialized"'
# execs per launch (Core): count runs on the workspace with framing exec
# queue wait (Core workspace_attempts): queued_at vs started_at
# boot: deploy over live sessions, then
ssh … 'docker logs --since 5m mend-mend-1 2>&1 | grep -E "mend api starting|re-attached|listening"'
```

**Measured on the box** (to be filled in by the measuring agent; baselines from preview 11,
2026-10-04):

| Case                                              | Baseline           | Measured (preview, date) | Notes                          |
| ------------------------------------------------- | ------------------ | ------------------------ | ------------------------------ |
| New session, `mend codex`, to first output        | ~90 s (90–101 s)   | _TBD_                    |                                |
| New session, `mend claude`, to first output       | ~90 s              | _TBD_                    |                                |
| Resume, to first output                           | ~62 s (57–67 s)    | _TBD_                    |                                |
| Skills delivery (execs / time)                    | 103 / 52.7 s       | _TBD_                    |                                |
| Agent memory delivery (execs / time)              | 11 / 6.4 s         | _TBD_                    |                                |
| One short exec, end to end                        | ~530 ms            | _TBD_                    | expected ~150 ms               |
| Working-tree reading, 2nd exec on                 | ~330 ms            | _TBD_                    | expected ~90 ms                |
| `capture head materialized` elapsed_ms (2.48 GB)  | 31–40 s            | _TBD_                    |                                |
| Queue wait behind another launch                  | up to 33 s         | _TBD_                    |                                |
| Mend API health after a deploy over live sessions | never (240 s loop) | _TBD_                    | preview 15: listening in 0.5 s |

**Signals.**

- Mend log:
  - `session engine: re-attached`;
  - `session engine: capture mode · the worktree's previous executor has not ended · the launch waits`;
  - `… launch waited for the worktree · free|held`;
  - `… the lease's launch made no executor · its create is fenced`;
  - `… the previous holder ended · lease released`;
  - `skills were not delivered to the workspace`;
  - `the boot sweep of a folded session's workspace failed`.
- sealantd: `capture head materialized { elapsed_ms, files, bytes }`.
- Core:
  `Run <id>: reading its changes failed (the working-tree reading exited N); recorded as failed.`
- Session line: `starting · booting`,
  `starting · waiting · the previous session in this worktree is saving`.

## Divergences found while writing

1. packages/sessions/src/engine.ts:9718: `writeWorkspaceFiles` builds `WorkspaceFileError` with
   `path: argv.at(-1)`. Since #513 the last argument of a `w` or `s`/`a` op is a base64 chunk of up
   to 90,000 characters of gzipped file content, not a path. The callers log only `message`, so
   nothing leaks today, but the field is wrong, and any future log of `error.path` would print
   (compressed) skills or memory content.
2. packages/inference/src/live-tools.ts:169–182 and packages/sealant/src/client.ts:1094:
   `read_change` falls back to `runChanges`, which returns `{files, diff}` and drops `available` and
   `unavailableReason`. A reading that failed, or a run with no reading (every workspace-session
   run), reads to Mend's inference as an empty change. That reports "no changes" for something never
   observed. sealant#313 made the distinction available; Mend does not use it.
3. Core packages/sdk/src/facade/workspace.ts:87, :522: `READY_POLL_INTERVAL_MS = 2_000` remains in
   `workspace.events()`, the poll-backed lifecycle stream. Only `ready()` got the backoff. Mend does
   not call `events()` (it calls `ready()`, packages/sealant/src/client.ts:842, :986), so Mend's
   start time is unaffected. Another SDK consumer waiting on `events()` for `status.ready` still
   learns of it up to 2 s late. Intent unclear.
4. scripts/bundle-supervisor.mjs:135 sets `WORKSPACE_BUILD_QUEUE_PREFETCH=4` for the bundle only.
   deploy/helm and the docs' server-environment reference do not mention it, so Kubernetes installs
   keep 1. The #515 body says "Nothing else changes". The same value also raises concurrent stops to
   4 (Core apps/worker/src/workers/workspaces.ts:387), which neither the changeset title nor ROADMAP
   (#530: "launches four workspaces at once") mentions.
5. packages/sessions/src/workspace-files.ts:56–74: the writer sets every written file's directory to
   0755 (`fs.chmodSync(d, 0o755)`), including a directory that already existed with another mode.
   The #513 body says directories were 0755 before, so this is not new. Still, any existing
   directory on a delivered path that a harness created tighter (for example 0700) is widened to
   0755 on every delivery. I did not check which harness directories are created 0700.
6. ROADMAP open PR #530 lists #513, #516 and sealant#313 under "In review". All three merged on
   2026-10-04 23:10–23:11 UTC, so its state line is stale.
