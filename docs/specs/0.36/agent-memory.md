# Agent memory per person per project

- **Release:** 0.36
- **Status:** on main (mend#461, #472, #502, #528 merged). The capture-mode hand-over is superseded
  by per-person homes, designed in mend#534 (ADR 0016 §6, open, not built). This spec describes
  main; ADR 0016's target is marked where it differs.
- **PRs:** mend#461 (Claude memory, migration 0098), mend#472 (Codex memory), mend#502 (import
  merges, migration 0108), mend#528 (read back only for the home's person, hand-over, joins,
  migration 0111). Related: mend#534 (ADR 0016, open), mend#513 (launch file execs).
- **Decision records:** docs/adr/0009-agent-memory-per-person-per-project.md (decisions 1-10,
  amended 2026-10-02, 2026-10-04, 2026-10-05); docs/adr/0016-per-person-harness-homes.md (mend#534,
  open).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec426e`, sealantd main
  `07ada506a`.

## Why it exists

Every Mend session started with an empty harness home. What Claude Code or Codex learned about a
repository in Friday's sessions was gone on Monday, and the months of notes Claude keeps on the
person's laptop (`~/.claude/projects/<dir>/memory/`) never reached Mend. Everyone who uses more than
one session on a project hits it, every session. Owner decisions of 2026-09-28 and 2026-09-29
(roadmap 0.36: "one agent home per person per project", "import on adoption"). The 0.36 exit
criterion: "A session started on Monday knows what Friday's sessions on the same project learned."

Sharing the whole harness home was rejected (ADR 0009 Context): transcript discovery, logins and
capture-mode saves all break when two sessions share one home. Only the memory is carried.

In capture mode a worktree has one harness home, shared over time and, on a join, at once. Three
review rounds of mend#528 found ways one person's memory was saved as another's (join read-back,
taking turns, Codex summarising other people's conversations, removed sessions, lost executors).
mend#528 is the fix on main.

## What it does

- A person starts a session on a project. Mend writes their stored memory for that project into the
  session's harness home before the agent starts.
- When the agent ends (Stop, exit, mode handoff, any harvest), Mend reads the memory back into that
  person's store for the project.
- A later session of theirs on the project, in any worktree, starts with it. Claude reads it through
  its own `MEMORY.md`; Codex through `~/.codex/memories/` with its feature turned on.
- Other people's sessions never receive it. A steered turn under shared control writes the owner's
  memory (ADR 0009 decision 1).
- `mend memory import` (run inside the checkout) brings this machine's Claude memory for the
  checkout and Codex's summaries of conversations held in it, merged with what Mend has.

CLI, the only surface (web and phone views moved to 0.37):

- `mend memory [--project <p>]`: one line per file,
  `<harness> <name> <size> <updated> · session <8 chars>` or `· imported`. Empty:
  `<project>: no agent memory yet · mend memory import brings this machine's`.
- `mend memory show <name>` prints the file; `<name>` is Claude's by name, `codex:<name>` for
  another harness, `memories_1.sqlite`, or a full path starting with `.`.
- `mend memory rm <name>`: `removed <name> · kept as a version` or `<name>: not in memory`.
- `mend memory import [--dry-run] [--project <p>]`: summary line
  `imported into <project> · 3 added · 41 unchanged · …` (or `would import`), then one line per
  file: `added`, `updated`, `merged`, `kept`, `not added`, `conflict`, `skipped`, each with its
  reason; last line
  `every version replaced is kept · sessions in the project receive it from the next launch` or
  `--dry-run: nothing written`.
- `mend adopt` inside a checkout prints
  `claude memory <n> files on this machine → mend memory import`.

Limits (`packages/domain/src/workbench/agent-memory.ts:39-50`): 2,000 files, 1 MB per file, 16 MB
for Codex's summary database, 32 MB per person per project, paths up to 512 characters.

Codex's memory feature is turned on in every Codex launch Mend shapes (`-c features.memories=true`),
unless the launch names the feature itself.

**In scope.**

- Claude auto memory at `.claude/projects/-workspace-repo/memory/`.
- Codex memory: `.codex/memories/`, `.codex/memories_1.sqlite` (consolidated, WAL folded in),
  `.mend/codex-threads/<id>.jsonl` (imported first lines).
- Carrying the person's own harvested Codex conversations into a Codex session so Codex can
  summarise them (full or stub).
- Delivery and read-back in both stores (co-located and capture).
- Capture mode: the server-side record of whose memory a worktree's home holds
  (`agent_memory_homes`), the hand-over between people, Codex thread withholding, a join's Codex
  started with memory off.
- Import from the person's machine, merging against the last import from that checkout on that
  machine.
- Version keeping and pinning.
- `mend memory`, `show`, `rm`, `import`.

**Out of scope.**

- Web and phone views of memory (0.37).
- Saving memory at checkpoints: a conversation open for days saves when its agent ends.
- Transcript import ("bring your previous sessions").
- `mend memory pull` (store to laptop); proposed in mend#502, not built.
- pi and opencode: they keep no memory.
- A `codex` started outside a Codex launch Mend recognises (typed in a shell, run by another agent,
  wrapped in `env`, an absolute path, `npx`, a script): not prepared (ADR 0009 "Not covered").
- Making people in one executor unable to read each other's memory: everyone runs as root (ADR 0016
  §10).

## How it works

### Data

- `agent_memory_files` (migration 0098, `packages/db/src/migrations.ts:2735-2760`): one row per
  `(user_id, project_id, path)`, `encoding` (`utf8`|`base64`), `contents`, `digest` (SHA-256 of the
  bytes), `bytes`, `updated_at`, `updated_by_session` (null for an import). Cascades with the user
  and the project.
- `agent_memory_versions` (0098; `pinned` added by 0108, which pinned every row kept before it):
  `(user, project, path, digest)` primary key. The newest 20 unpinned versions per file are kept;
  pinned ones are never pruned.
- `agent_memory_import_bases` (0108, `migrations.ts:2967-2993`): what the last import from one
  source sent, per path; text keeps its contents, binary only its digest.
- `agent_memory_homes` (0111, `migrations.ts:3029-3058`): one row per worktree, cascades with it.
  Settled `user_id`, `session_id`, `workspace_id`; pending `pending_user_id`, `pending_session_id`,
  `pending_workspace_id`, `pending_epoch`, `pending_n`. Users `ON DELETE SET NULL`.
- Repo: `AgentMemoryRepo` in `packages/db/src/repos/agent-memory.ts`. Each read-back, import and
  removal takes `pg_advisory_xact_lock(hashtext('mend:agent-memory:<user>:<project>'))`
  (`:480-485`). Every version is written by `keepVersion` (`:512-552`), which pins via `isSoleCopy`
  (`:256-275`).

Files in the harness home Mend writes (relative to it): `.mend/agent-memory-delivered.json` (path to
digest), `.mend/agent-memory-owner` (written for people, never read by Mend),
`.mend/agent-memory-incoming/` (staging), `.mend/agent-memory-kept/<stamp>[-handover-<id>]/` (moved
aside, never deleted), `.mend/carried-transcripts`, `.mend/codex-memory-withheld.json`,
`.mend/carried-incoming/` (`packages/sessions/src/agent-memory.ts:32-61`, `codex-memory.ts:558,700`,
`harness-state.ts:217`).

### Launch (cold launch, claimed standby, fresh resume)

`launchInternalBody`, `packages/sessions/src/engine.ts:11840-11991`, in this order:

1. Relocation of `~/.claude`, `~/.codex`, `~/.pi`, opencode dirs onto the harness home (capture
   mode: failure abandons the executor).
2. Skills (capture mode).
3. `handOverAgentMemory` (`engine.ts:9968-10081`), capture mode only. A failure fails the launch
   with code `AGENT_MEMORY_NOT_HANDED_OVER` (`engine.ts:695-697`) and abandons the executor.
4. `deliverAgentMemory` (`engine.ts:9872-9942`), best effort: failure is a warning.
5. `carryCodexConversations` (`engine.ts:10360-10448`), Codex harness only, best effort.
6. `withholdCodexThreads` (`engine.ts:10093-10137`), capture mode and a Codex argv only.
7. pi profile, secret files, repositories, workspace note, dependency install.
8. Argv: `withCodexMemoryOff(argv, { join: false })` when step 6 said memory may not stay on
   (`engine.ts:11960-11962`); then `withHarnessSetup` adds `-c features.memories=true` to a `codex`
   harness argv unless any arg starts with `features.memories` (`harness-seeds.ts:190-196,341-349`).
   `promptArgv` hardcodes the flag for prompts and handoffs (`engine.ts:505-506`).

### Retained launch (join, retained resume, follow-up, mode handoff, second session)

`launchInRetainedWorkspace`, `engine.ts:12590-12716`. No hand-over and no delivery. For an argv that
`launchesCodex` (`harness-seeds.ts:229-231`: `codex …` or Mend's `sh -c "… exec codex …"`, any
harness name), capture mode asks `liveHomeOwnerOf` (`engine.ts:10682-10689`): the pending record's
person when it names this executor, else `homeOwnerOf`. Own home: withholding runs, as at launch.
Another person's home (a join), or unknown: `withCodexMemoryOff(argv, { join: true })`, no
withholding.

`withCodexMemoryOff` (`harness-seeds.ts:247-301`): emits `-c features.memories=false`, plus
`-c memories.generate_memories=false` on a join; drops `--enable memories|memory_tool` (both forms)
and every `-c`/`--config` (`-c V`, `-cV`, `-c=V`, `--config V`, `--config=V`) that names
`features.memories`, `features.memory_tool`, `memories.generate_memories`, or sets the `features` or
`memories` table whole (`setsCodexMemory`, `:216-222`). In Mend's `sh -c` prompt script it replaces
the literal `-c features.memories=true`.

### Delivery

`planAgentMemory` (`agent-memory.ts:188-207`) stages every stored, valid file under
`.mend/agent-memory-incoming/`. `AGENT_MEMORY_DELIVER_PROGRAM` (`agent-memory.ts:134-156`,
`node -e`, argv home, incoming, a fresh kept dir, the `[{path,digest}]` list, owner):

- writes the owner record first (when owner is not empty);
- per stored file: `unchanged` when the home already has those bytes; `left` when the home's file
  differs from what was delivered last (`before[path]`) and is present; otherwise copied to
  `<target>.mend-<pid>` and renamed into place, `written`;
- per previously delivered path the store no longer has: absent, nothing; changed since delivery,
  `left`; else renamed into the kept dir, `kept`;
- writes `.mend/agent-memory-delivered.json`, removes `incoming`, exits 1 after any `error`.

Co-located (`engine.ts:9880-9895`): home is `harnessHomePathOf(storePath, session.id)`, per session;
skipped when nothing is stored and no record exists; the program runs on the Mend host
(`materializeAgentMemory`, `agent-memory.ts:230-267`). Capture mode (`engine.ts:9896-9941`): staged
through `writeWorkspaceFiles`, then one exec; skipped on an image already known to have no node
(`nodelessImages`, per process, keyed by the image JSON). Exit 127: `incoming` is removed and
`agent memory not delivered · the image has no node · said once per image` is logged.

### Read-back

Every harvest path ends in `readBackAgentMemory` (`tryHarvest`, `engine.ts:7577-7613`; failure is a
warning, never in the way of the settle). `readBackAgentMemory` (`engine.ts:10702-10727`):

- co-located: reads the session's own home (`readAgentMemoryFromHome`, `agent-memory.ts:323-379`:
  regular files under the roots, links not followed, over-limit paths `skipped`, the database read
  with its `-wal` and consolidated) and credits the session's owner;
- capture mode: `homeOwnerOf(session, session.sealantWorkspaceId)` (`engine.ts:10662-10674`) must
  equal the session's owner, else nothing is read and the log says
  `agent memory not read back · Mend cannot say whose memory the worktree's home holds` or
  `· the worktree's home holds another person's memory`. Then `agentMemoryFromCapture`
  (`engine.ts:10451-10513`) reads the worktree's head capture (not the executor's own capture).

`creditAgentMemory` (`engine.ts:10579-10624`) skips a read whose fingerprint (files and digests,
delivered record, skipped) equals the last one credited for the same person, project and session in
this process (`lastCredited`, `engine.ts:3193`). Otherwise `AgentMemoryRepo.readBack`
(`agent-memory.ts` repo `:650-755`):

- `withinLimits` drops unstorable files into `skipped`; a skipped path is removed from `delivered`
  so it does not read as deleted.
- `planAgentMemoryReadBack` (`:88-123`), per session file with digest D and delivered base B: D = B,
  nothing. No stored row: `save`. Stored digest = D: nothing. Stored digest = B, or stored
  `updated_by_session` = this session: `save` replacing it. Both text: `merge`. Else `save`, stored
  one kept as a version. Per delivered path the session no longer has: `delete` when the stored
  digest still equals the delivered one.
- `merge` loads the base text from `agent_memory_versions` by digest (null when pruned or never
  kept), then `mergeAgentMemoryText` (`:303-346`): frontmatter on both sides merged key by key
  (`mergeFrontmatterLines`, simple `key: value` subset; differing outside it is `unmergeable`), body
  by `git merge-file -p --union` with a base (`mergeTextUnion`, `agent-memory.ts:385-402`), or
  `unionLines` without one (alignment limit 4,000,000 cells, `agent-memory-merge.ts:34`). LF
  compared, store's line endings kept. `lostLines` checks both sides against the final text.
- Unmergeable: the session's file is saved, the stored one kept (pinned when it is the sole copy). A
  merge that lost session lines keeps the session file as a version.

### Capture mode: whose home it is

- **Hand-over** (`engine.ts:9968-10081`), every capture-mode launch through `launchInternalBody`,
  marked in `memoryHandovers` (per process) while it runs:
  1. `recordedHomeOf` (`:10634-10654`), which settles a pending record whose position is placed and
     whose epoch has a capture at `n` or later on the chain.
  2. `from`: the settled record; else `latestExecutorOf` (`:10550-10571`, the newest session whose
     launch made an executor that ran a process, excluding the pending executor); else the
     worktree's other sessions: none, the launcher; all one other person, that person; mixed,
     nobody.
  3. `from` is the launcher: write the pending record, return. A few DB reads and one write.
  4. Else, when `from` names a person: read the head capture and credit it to them
     (`from.sessionId ?? "handover:<launch session>"`). Read or save failure fails the launch.
  5. `handOverAgentMemoryExec` (`agent-memory.ts:92-106`, plain `sh`): each of
     `AGENT_MEMORY_HANDOVER_PATHS` (`:55-61`: the three roots, `memories_1.sqlite` with `-wal` and
     `-shm`, delivered record, owner record, `incoming`) that exists is moved to
     `.mend/agent-memory-kept/<ISO stamp>-handover-<8 hex>/`; any failed move exits 1 and fails the
     launch; then the owner record is written, even when nothing was moved.
  6. `recordPendingHome(worktree, {launcher, session, workspace}, lease epoch)` with `pending_n`
     null (`repo :1016-1034`). No lease: only a warning, no record.
  7. A forked `suspend` flush (`CHECKPOINT_FLUSH_TIMEOUT` 20 s), skipped once a final flush was
     sent.
- **Placing**: `observeCaptureFlushFenced` (`engine.ts:2463-2524`) reads the pending record before
  asking; an answer of that executor under the pending epoch with `headN` that `placesMemoryHome`
  (`engine.ts:684-693`: caught up, a saved final, or caught up but for named unreadable paths all
  outside the memory paths, `unreadableOutsideMemory`, `agent-memory.ts:69-83`) sets `pending_n`
  once (`notePendingHomePosition`, conditional on `pending_n IS NULL`, `repo :1036-1054`).
- **Join wait**: `awaitWorktreeHolder` (`engine.ts:3461-3523`) loops while the lease is `held` and
  `memoryHandovers` holds the worktree, up to `leaseWait` (default 30 min).

### Codex

- **Carry** (`engine.ts:10360-10448`, `codex-memory.ts:126-174,515-555,567-609`): the owner's other
  Codex sessions on the project (capture mode: other worktrees only); per conversation its latest
  harvested revision; live ones excluded. Full: idle 6 h to 10 days, not summarised at that
  revision, interactive source (`cli`, `vscode`, `atlas`, `chatgpt`), memory mode null or `enabled`,
  newest first, at most 4, 8 MB gzipped, no rollout over 64 MB read. Stubs: every summarised
  conversation whose memory is on, up to 512, first line at the summary's time. Each id is appended
  to `.mend/carried-transcripts` before its file appears; a file already there that is not listed is
  `own` and left; a listed one is replaced only by a later mtime.
- **Withholding** (`CODEX_WITHHOLD_PROGRAM`, `codex-memory.ts:721-757`): own threads = provider
  session ids of the launcher's sessions in the worktree plus what this launch carried. In one
  `BEGIN IMMEDIATE` transaction on `.codex/state_5.sqlite` (busy timeout 5 s): every non-own
  `enabled` thread to `disabled` and listed in `.mend/codex-memory-withheld.json`; own threads Mend
  withheld earlier back to `enabled`. Prints `memory-off …` (memory forced off for this launch,
  `join: false`) when another `state_N.sqlite` exists, the `threads` table lacks `memory_mode`, or
  there is no state database and a rollout in `sessions/` or `archived_sessions/` is not own. Exit
  127 (no node) or 3 (no `node:sqlite`, after a retry with `--experimental-sqlite`) also forces it
  off (`codexMemoryMayStayOn`, `:760-761`).

### Import

CLI `memoryImport` (`apps/cli/src/main.ts:2442-2490`, `apps/cli/src/agent-memory.ts`):
`claudeMemoryDirFor` tries two key spellings of the repo root under `$CLAUDE_CONFIG_DIR` or
`~/.claude/projects/`; files over 1 MB are left out with a note. Codex: a summary database of only
this repository's conversations (by thread cwd, memory on), each unselected, plus each one's first
line under `.mend/codex-threads/` (`.jsonl.zst` read too). Source id `<machine-id>:<repo root>`
(machine id in `<mendCliHome>/machine-id`, `~/.config/mend/` by default, made 0600 on the first real
import, never on `--dry-run`); label = hostname, sanitised, 64 chars.

API (`apps/api/src/routes/agent-memory.ts`, `packages/api-contracts/src/agent-memory.ts`):
`GET /projects/:id/memory`, `GET|DELETE /projects/:id/memory/file?path=`,
`POST /projects/:id/memory/import`, `POST /projects/:id/memory/import/plan`. Each needs read access
to the project (`ProjectAccess.project`) and acts on the caller's own memory only. A path named
twice: 400 `AgentMemoryImportInvalid`.

`planAgentMemoryImport` (repo `:179-200`) per file: no stored row and base digest = file digest,
`removedInMend`; no stored row, `add`; same digest, `unchanged`; base = file, `keepStored`; base =
stored, `update`; both text, `merge` (three-way against the base text, else no shared version);
Codex database with the same encoding, `mergeDatabase` (`mergeCodexDatabases`,
`codex-memory.ts:264-335`, newer `source_updated_at` per thread; null on schema mismatch, a
non-integer revision, or the same revision with other words); else `conflict`. A merge that lost
machine lines keeps the machine file as a version and does not move the base. Bases are recorded
only with a source and never on a dry run (`apply`, repo `:824`).

## Happy path

Anna and Maria are members of org Acme, project `mend` (shared), server in capture mode.

1. Anna, on her laptop inside `~/src/mend`: `mend memory import --dry-run`. Output:
   `claude memory · /home/anna/.claude/projects/-home-anna-src-mend/memory · 12 files`,
   `would import into mend · 12 added`, twelve `added` lines, `--dry-run: nothing written`. No
   `~/.config/mend/machine-id` exists afterwards.
2. `mend memory import`: `imported into mend · 12 added`. `mend memory` lists 12 `claude` rows, each
   `· imported`.
3. Monday, Anna: `mend claude --name auth "read the build notes"`. The server log shows
   `agent memory · handed over` is absent (fresh worktree, launcher's own home) and
   `agent memory · delivered written: 12`. Inside the session,
   `~/.claude/projects/-workspace-repo/memory/MEMORY.md` is her laptop's.
4. Claude adds `build.md` and a line to `MEMORY.md`. Anna stops the session. Log:
   `agent memory · read back saved: 2`. `mend memory` shows `MEMORY.md` and `build.md` with
   `session <8 chars>`.
5. Tuesday, Anna starts `mend claude --name payments`. The new home holds `build.md` and the edited
   `MEMORY.md`.
6. Maria starts a session in worktree `payments` while Anna's runs. It joins Anna's executor.
   Maria's Claude reads Anna's memory (documented); nothing is delivered for Maria. When Maria's
   agent ends, the log says
   `agent memory not read back · the worktree's home holds another person's memory`. Maria's
   `mend memory` is unchanged.
7. Anna's session ends; Wednesday Maria starts a fresh session in `payments`. The hand-over credits
   the head's memory to Anna, moves it to `~/.mend/agent-memory-kept/<stamp>-handover-<id>/`, writes
   the owner record `maria-id`, records Maria pending, and delivers Maria's memory (none). Log:
   `agent memory · handed over credited: the previous person`.
8. `select user_id, pending_user_id, pending_n from agent_memory_homes where worktree_id = …` shows
   `anna`, `maria`, null. Maria's executor's first caught-up flush sets `pending_n`; the next read
   that finds a capture of that epoch at that position on the chain settles it: `maria`, null, null.

## Invariants

1. One person's memory is never saved into another person's store: no read-back or hand-over credits
   a home to anyone but the person `agent_memory_homes` (or, with no record, the legacy rule) names
   for it. When the server cannot name one, nobody is credited.
2. No API route reads, lists or changes another person's memory; every route keys on `CurrentUser`
   and needs visibility of the project.
3. A launch never starts an agent on another person's memory files in a fresh capture-mode executor:
   a hand-over that cannot read, credit or move them fails the launch.
4. No step deletes memory: delivery moves aside (`kept`), the hand-over moves aside, every replaced
   or deleted stored version is written to `agent_memory_versions`, and a version holding any line
   (or binary content) the current file lacks is pinned and never pruned.
5. A file the session changed since delivery and Mend has not read back is never overwritten by a
   delivery (`left`).
6. A path read back but unreadable or over the limits is never treated as deleted.
7. The home's owner record (`.mend/agent-memory-owner`) is never read by Mend to decide anything.
8. The memory record of a hand-over counts only once a capture of that executor's epoch taken after
   the move is on the worktree's chain; an executor lost before that leaves the previous home
   recorded.
9. A Codex that joins another person's executor starts with `features.memories=false` and
   `memories.generate_memories=false`, changes no thread's memory mode, and no memory flag the
   launch argv carries overrides that.
10. A Codex in a launcher's own capture-mode home summarises only the launcher's threads, or starts
    with memory off.
11. A carried conversation is never read as the session's own conversation (harvest, crash harvest,
    transcript reader, observer, capture-mode harvest, co-located archive).
12. Codex memory model calls run only on the session's own login (joins: no memory work at all).
13. An import never deletes a stored file; a dry run writes nothing on the server and nothing on the
    machine.
14. Every merge result holds every line of both inputs, except copies the other side removed since
    the base; when it does not, the side that lost lines is kept whole as a pinned version.
15. Evidence, not verdicts: CLI and log wording states what was done (`added`, `merged`, `kept`,
    `not read back · …`), never a judgment.

## Edge cases and failure behaviour

**Concurrent actions**

- Two sessions of the same person end at once: read-backs serialise on the advisory lock; the second
  merges against the delivered base, keeping both sides' lines.
- A join while the holder's hand-over runs: waits (`memoryHandovers`), up to `leaseWait`. A join
  after the lease is claimed but before the hand-over starts, or after it ends but before delivery:
  starts on the previous person's memory (Claude) or memory-off (Codex). Documented.
- A join's agent writes into the holder's memory files: credited to the holder at their read-back,
  or at the next hand-over. Never to the joiner. Documented; owner decision recorded in ADR 0016.
- Two launches into one worktree: one wins the lease, the other joins or waits.

**Restarts**

- Mend restart mid-hand-over: the launch is lost; the move may or may not have run. Next launch: if
  the record was not written, `from` is unchanged and the head (restored) is credited again; the
  merge sees it as unchanged or a same-session save.
- Mend restart clears `lastCredited` and `nodelessImages`; a repeated credit of the same home by the
  same session id after a restart can replace a merge made in between (see Divergences).
- Executor lost before its first post-move capture registers: record stays pending (`pending_n`
  null), the previous person stays settled, the restored head holds their memory; the next launch
  hands it over again (engine test "an executor lost before it saved its hand-over…").
- sealantd answers a flush `behind` all executor long (quota refusal of the small class, an
  unreadable memory path): the hand-over never settles; read-backs of that executor are skipped (see
  Divergences for the consequence).

**Partial failures**

- Node missing in the image: delivery and withholding cannot run. Hand-over still runs (`sh`).
  Staged files removed. Codex starts with `features.memories=false`.
- Delivery program error on one file: other files proceed, exit 1, warning logged, launch continues.
- Codex database torn or failing `integrity_check`: not stored, not taken as deleted; the last good
  copy stays.
- `git` missing on the server: `mergeTextUnion` concatenates both sides (no line lost; lines may
  repeat).
- Carry: a full rollout that cannot be prepared keeps its stub; carry errors are logged, launch
  continues.

**Odd input**

- A stored path that no longer validates is not delivered.
- A home file that is a symlink: not read back (co-located `Dirent.isFile`; capture
  `kind !== "file"` skipped).
- Import with a path named twice: 400 for the whole import.
- Import over the limits: files over the count or total are `skipped`, counted in the summary.
- Frontmatter outside the simple subset that differs: import `conflict`; read-back takes the
  session's file.
- Two files too different to align with no base: import `conflict`; read-back takes the session's.
- Binary file changed on both sides: import `conflict`, machine copy kept as a pinned version,
  reported again next import.
- A file the store removed since the last import, unchanged on the machine: `not added`.

**Older data**

- Worktrees with executors launched before migration 0111: no record; `homeOwnerOf` falls back to
  `memoryOwnerOfExecutor` (lease holder, else the session whose launch names the workspace) and
  agrees only when the latest executor's owner matches.
- Versions kept before 0108 are all pinned.
- An older CLI sends no `source`: no base recorded, merges have no shared version. Against an older
  server, `--dry-run` gets a 404 and imports nothing.

**Permissions**

- Owner: their own memory only.
- Member with project access: can join another person's worktree (no owner check) and so write into
  that person's memory through the shared files; never reads it through the API.
- Steerer under shared control: their turns write the owner's memory (the agent runs in the owner's
  home).
- Operator: no API access to anyone's memory (project access rules).
- A private project the caller cannot see: 404.

**Clients**

- CLI only. Web, desktop, phone, VS Code, Slack and the t3 gateway have no memory view; sessions
  they start get delivery and read-back the same way, since it is in the engine.

## Known limits

- Memory saves when the agent ends, not at checkpoints (Known issues "Agent memory is saved when the
  agent ends").
- A join uses the holder's memory and writes into it; a join before the hand-over moves the previous
  person's memory can read it (Known issues "A session that joins someone else's executor uses their
  memory").
- Kept sets in `.mend/agent-memory-kept/` are never deleted, are restored into every later executor
  of the worktree and are readable by anyone working there; they grow one set per turn of people
  (Known issues "A worktree someone else used before you").
- A `codex` Mend does not recognise can summarise other people's conversations; a pre-0.160 rollout
  can be re-enabled by Codex's reconcile; `/new` threads are withheld from the person's own memory
  (Known issues "A `codex` you run yourself in a shared worktree").
- Codex memory builds 6 h after a conversation, two at a time, on the person's login; a resumed
  session learns only from what was carried at its first launch (Known issues "Codex memory builds
  slowly, and on your login").
- Two live Codex sessions of one person sharing a home can yield a database copy that mixes two
  moments (ADR 0009 Codex consequences).
- A merge can repeat a line both sides wrote (ADR 0009 decision log 2026-10-04).
- ADR 0016 replaces the hand-over, owner record, withholding and joiner memory-off flags with
  per-person directories (`people/<id>/`); not built.

## How to verify

**Tests**

- `packages/domain/src/workbench/agent-memory-merge.test.ts`: union, frontmatter, CRLF, alignment,
  property test through `git merge-file`.
- `packages/db/test/agent-memory.test.ts` (Postgres): read-back plans, import plans, dry run equals
  import, pinning, cap eviction, `agent_memory_homes` pending/settled, cascades, migration 0111
  after 0110.
- `packages/sessions/src/agent-memory.test.ts`: delivery outcomes, read-back from a home, Codex
  files, hand-over script.
- `packages/sessions/src/codex-memory.test.ts`: carry plan, stubs, database consolidate/merge/holds,
  withholding program (WAL held open, chosen modes, no index, renamed database).
- `packages/sessions/src/harness-seeds.test.ts:434-700`: memory flag, `withCodexMemoryOff` forms,
  `launchesCodex`.
- `packages/sessions/test/engine.test.ts:3242` (co-located deliver/read back), `:3294` (carry),
  `:9429-10520` (capture mode: joined read-back, withholding, join wait, placing, taking turns, lost
  executor, join flags, own second session before first save, removed session).
- `apps/cli/src/agent-memory.test.ts`, `apps/api/src/routes/agent-memory.test.ts`,
  `apps/api/src/routes/project-access.test.ts`.
- Not covered: a real second machine importing against a running server; memory appearing from Codex
  on the box (needs 6 h idle); an engine test of an answer under another epoch not placing (the test
  world stamps the lease epoch); the same-session replace-after-merge case.

**On the box**

```sh
cd ~/src/<repo> && mend memory import --dry-run && mend memory import
mend claude --name mem-a "write a note about the build into your memory"   # then stop it
mend memory; mend memory show MEMORY.md
mend claude --name mem-b                                                    # new worktree: note present
# second account: start a session in mem-a while the first runs (join), then stop both
psql "$MEND_DATABASE_URL" -c "select worktree_id,user_id,pending_user_id,pending_epoch,pending_n from agent_memory_homes"
psql "$MEND_DATABASE_URL" -c "select path,digest,pinned,saved_at from agent_memory_versions order by saved_at desc limit 20"
```

Inside an executor: `ls -la ~/.mend/agent-memory-kept/ ~/.claude/projects/-workspace-repo/memory/`,
`cat ~/.mend/agent-memory-delivered.json`.

**Signals** (server log, `session engine:` prefix): `agent memory · delivered` (counts),
`agent memory · read back`, `agent memory · handed over` (`credited`, `kept`, `moved`),
`agent memory not read back · …`,
`agent memory not delivered · the image has no node · said once per image`,
`codex conversations carried`, `codex memory off for this launch · …`,
`agent memory · forced capture failed`, launch failure code `AGENT_MEMORY_NOT_HANDED_OVER`.

## Divergences found while writing

1. `packages/db/src/repos/agent-memory.ts:106` with `:697,748`: a read-back merge writes
   `updated_by_session` = the reading session, so a second read-back of the same session (an agent
   ended twice in one executor without a new delivery, or a hand-over credit under the same session
   id after a Mend restart clears `lastCredited`) takes the `save` branch and replaces a merge that
   included another session's lines. Those lines survive only as a pinned version, not in the
   current file. ADR 0009 says "a later read of the same session replaces its own earlier save"; it
   does not say the earlier save may hold someone else's merge.
2. `packages/sessions/src/engine.ts:684-693`, `:10645-10651`: a hand-over whose executor never
   produces a placing answer while its snaps still register (a path inside the memory folders that
   stays unreadable for the executor's life; sealantd carries it forward) never settles. The
   launcher's read-backs are skipped (`homeOwnerOf` null), and the next launch hands over with
   `from` = the previous settled person, crediting the launcher's memory in the head to them.
   mend#528 review round 6 P3-2 was fixed only for unreadable paths outside the memory; not in Known
   issues. (A small-class quota refusal also never settles, but then the head still holds the
   previous person's memory, so nothing is misattributed; the launcher's learning is simply not
   saved.)
3. `packages/sessions/src/engine.ts:9973-9978`: with no lease (`leaseOf` null) the hand-over moves
   the home and writes no record, only a warning. Whether this is reachable after `acceptExecutor`
   is unclear; if it is, the next launch reads the stale record.
4. `packages/sessions/src/codex-memory.ts:35-40`: the interactive sources include `atlas` and
   `chatgpt`; ADR 0009 decision 8 says `cli` or `vscode`.
5. `apps/cli/src/main.ts:2431-2441`: `mend memory show|rm codex:memories_1.sqlite` maps to
   `.codex/memories/memories_1.sqlite` and answers "not in memory"; files under
   `.mend/codex-threads/` are listed with harness `codex` and cannot be named as `codex:<name>`
   either (the first `codex` root is taken). The guide says to name a Codex file as `codex:<name>`.
6. `packages/sessions/src/engine.ts:3193`: `lastCredited` grows for the life of the process (one
   entry per person, project and session, holding every path and digest). Not documented.
7. `packages/sessions/src/engine.ts:10455`: the capture-mode read-back reads the worktree head, not
   the capture of the executor the session ran in; a late harvest after another executor has saved
   reads that executor's home (guarded only by `homeOwnerOf`). Accepted in review as narrow; not in
   the ADR.
8. ADR 0016's status line reads "accepted 2026-10-05, for 0.36" while mend#534 is open and none of
   its delivery items is built; main still runs the hand-over, the owner record and Codex
   withholding, and ADR 0009 on main does not yet carry the "superseded" note.
