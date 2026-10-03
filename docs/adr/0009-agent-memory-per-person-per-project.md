# Agent memory: one per person per project

Status: proposed 2026-10-02. Implements the roadmap's 0.36 "one agent home per person per project"
and "import on adoption" (owner decisions of 2026-09-28 and 2026-09-29), by carrying the agents'
**memory** between a person's sessions rather than sharing their whole harness home.

## Context

A coding agent learns about a repository as it works in it. Claude Code writes what it learned to
its auto memory, `~/.claude/projects/<working directory, / and . as ->/memory/*.md`, with a
`MEMORY.md` index it reads at the start of every conversation. On the owner's laptop that directory
holds months of notes per repository.

In Mend each session starts empty. A session's harness home is its own:
`<store>/<project>/sessions/ <id>/harness-home/` in the co-located store, and in capture mode
(ADR 0002) the `harness/` part of its worktree's capture chain. What a session learns stays in that
home, so a session started on Monday knows nothing Friday's sessions on the same project learned.
The memory on the person's laptop never reaches Mend at all.

### Why not share the whole home

The roadmap's wording was one harness home per person per project. Mapping what reads and writes a
harness home today (2026-10-02) showed what sharing one between sessions would break:

- **Which conversation is a session's.** The harvest, the crash harvest, the transcript reader and
  the external-agent observer each take the _newest_ transcript in the home. With two sessions in
  one home they read each other's, record the wrong provider session id on both, and a resume then
  continues the other session's conversation. The observer turns one session's writes into agent
  rows on the other and keeps it "running".
- **Logins.** Relocation keeps what the home already holds over what the platform just injected, and
  the Claude seed writes a login only where none exists. A shared home would keep serving a stale
  login (ADR 0008) to every later session.
- **Capture mode.** Two worktrees' executors would each restore and save the same home, and the
  later save would silently replace the earlier one.
- **Size and noise.** Every session's harvest archive would carry every conversation of that person
  in that project.

Transcripts, logins and per-conversation state are a session's. What should outlive a session is
much smaller: the memory.

### What each harness keeps

- **Claude Code** keys auto memory by working directory. Every Mend session's agent runs in
  `/workspace/repo`, whatever its worktree, so inside Mend the directory is always
  `.claude/projects/-workspace-repo/memory/`: one stable place per home.
- **Codex** keeps memory in `~/.codex/memories/` and `memories_1.sqlite`, built at startup from the
  rollouts already in its home (`codex-rs/memories`, phase 1 and 2). A home that carried only the
  memory would never feed it new rollouts, and the feature is experimental: the owner's own
  `stage1_outputs` table is empty. Not carried yet.
- **pi** and **opencode** have no memory of their own.

## Decision

1. **Mend keeps each agent's memory per person per project,** in Postgres: one row per file, keyed
   by account, project and the file's path in the harness home. Today that is Claude Code's memory
   directory. The person is the session's owner; a turn someone else steers under shared control
   writes the owner's memory, as it spends the owner's login.

2. **Every session receives it at launch,** after the harness home is relocated, in both stores
   (host-side in the co-located store, through exec in capture mode), as skills are:
   - a file the home does not have, or still holds as Mend last delivered it, gets the stored one;
   - a file the session changed since then and Mend has not read back is left as it is;
   - a file Mend delivered and no longer stores is moved aside to `.mend/agent-memory-kept/`, never
     deleted.

   What was delivered is recorded beside it (`.mend/agent-memory-delivered.json`, path to digest).

3. **What a session learned is read back when its agent ends,** with the conversation's harvest:
   from the harness home in the co-located store, from the flushed head capture in capture mode.
   Each file the session added or changed since delivery is saved; a delivered file the session
   deleted is deleted from the store, unless the store changed it in the meantime. When the store
   and the session both changed a file since delivery:
   - a later read of the same session replaces its own earlier save;
   - otherwise text is merged keeping both sides' lines (`git merge-file --union`) against the
     delivered version;
   - anything else takes the session's, and the stored one is kept as a version.

   Every version Mend replaces or deletes is kept (the last twenty per file), so nothing an agent
   wrote is lost to another session's save.

4. **Import from the person's machine is the CLI's,** run from inside the repository:
   `mend memory import` reads `~/.claude/projects/<this checkout's path>/memory/`. Transcripts
   ("bring your previous sessions") are a later step: a transcript needs its paths rewritten for
   `/workspace/repo` to resume. Logins, goals, logs and caches are never read. Amended 2026-10-04:
   an import merges what both sides have, as a read-back does.
   - **Mend records what it last imported from each checkout on each machine** (the import's source:
     the CLI's machine id, kept in its config directory, and the checkout's path), file by file: a
     text file's contents, a binary file's digest. That is the shared version the next import from
     there merges against.
   - A file the store does not have is added, unless the store removed it since the last import from
     there and the machine still has it as it was then: that file is not added again.
   - A file one side changed since the last import takes that side's.
   - A file both changed since then, or any file that differs with no last import, is merged:
     - Text keeps both sides' lines, three-way (`git merge-file --union`) against the last import
       when there is one. With none, each line the two share is kept once, in place, and between two
       shared lines the store's own lines come first, then the machine's.
     - When both versions open with YAML frontmatter, the frontmatter is merged key by key and only
       the body by line. A key both set differently keeps the store's value and the machine's under
       it as a YAML comment (`# from <host>, <date>: description: …`).
     - An index (`MEMORY.md`) keeps each line once.
     - Codex's summary database keeps every conversation's newer summary from either side.
     - Anything else, or a merge over the size limit, keeps the store's file. The machine's is kept
       as a version, and the next import reports it again.
   - A file the store has and the machine no longer sends stays in the store.
   - Every version an import replaces is kept, the machine's own copy of a merged file too, as for a
     read-back. `--dry-run` asks the server for the same plan and writes nothing.

   The same frontmatter rule applies to a read-back merge, and a read-back merge with no shared
   version (a file the session made itself, or a delivered version no longer kept) keeps each shared
   line once instead of repeating the whole file.

5. **People can see and remove it.** `mend memory` lists the files for the current project,
   `mend memory show <file>` prints one, `mend memory rm <file>` removes it. The API serves the same
   to the web app and the phone.

## Consequences

- A session started on Monday reads, through Claude's own `MEMORY.md`, what Friday's sessions saved.
- A session's harness home keeps everything else as it is today: per session in the co-located
  store, per worktree in capture mode, with resume and harvest unchanged.
- Memory is read back when an agent ends. A conversation that stays open for days saves its memory
  when it ends, not before; saving at checkpoints is a follow-up.
- Two sessions writing the same memory file at once both keep their lines. A merge can repeat a line
  both wrote; the agent reads and rewrites its memory as it goes.
- pi and opencode gain nothing. Codex gains its memory as the next section decides.

## Codex

Amended 2026-10-02, on the owner's choice: carry the memory folder and the conversations Codex needs
to build it.

### How Codex keeps memory (codex-cli 0.159)

- The feature is `memories`, stable and off by default.
- Codex keeps one memory for everything it does, in `~/.codex/memories/`:
  - `MEMORY.md` and `memory_summary.md`;
  - `raw_memories.md`, `rollout_summaries/` and `skills/`;
  - a git baseline it diffs against.
- It builds that memory when a session starts:
  - It takes up to two past conversations that have been quiet for 6 hours and are under 10 days
    old, from the threads in its state database.
  - It summarises each one with a model call on the session's login.
  - It records the summaries in `memories_1.sqlite` (`stage1_outputs`).
  - An ephemeral agent then merges them into the folder. An ephemeral agent writes no rollout of its
    own.
- A fresh home's state database lists every rollout in `sessions/` the first time it opens.

### Decision

6. **Codex's memory is on in every Codex session Mend starts:** `-c features.memories=true` on the
   terminal, `app-server` and follow-up launches. A launch that names the feature itself keeps its
   own setting.
7. **It travels as agent memory, as Claude's does:** the folder `.codex/memories/` and the summary
   database `.codex/memories_1.sqlite`. The database is stored as one file: at read-back its
   write-ahead log is folded in with `VACUUM INTO`. A copy that does not open as a database, or
   fails SQLite's integrity check, is not stored. It is not taken as deleted either, so the last
   good one stays. The WAL is never stored on its own, because a database and a log from two
   different sessions do not make a database. The summary database's limit is 16 MB, and a person's
   total in a project is 32 MB. Without the database, every session would summarise the same two
   newest conversations again and never get past them.
8. **Mend lays conversations down, counting each by its latest harvested revision.** Codex merges
   only summaries whose conversation its state database lists, and a fresh home lists only the
   rollouts in it. So at launch a Codex session receives the person's own Codex conversations on the
   project:
   - **In full:** the ones Codex would summarise and has not summarised at that revision. That
     means:
     - an interactive source (`cli` or `vscode`);
     - memory not turned off for it, which Codex reads, as Mend does, from the last `session_meta`
       line that names a mode;
     - 6 hours to 10 days since its latest revision.

     A conversation whose latest revision is under 6 hours old, or that an agent holds right now, is
     still going and is not carried. Newest first, at most four, at most 8 MB compressed, and no
     rollout over 64 MB is read.

   - **As a stub:** every other one Codex has summarised whose memory is on, in Codex's own order of
     preference, up to 512. A full copy that cannot be prepared keeps its stub. A stub is its first
     line, at the summary's time, so Codex keeps the summary without making it again. A summary
     imported from another machine gets its stub from the line imported with it
     (`.mend/codex-threads/<id>.jsonl`).

   Each file goes under its rollout name, with its time as its modification time, which is the time
   Codex reads.

9. **A carried conversation is never the session's own:**
   - Its id is listed in `.mend/carried-transcripts` before its file appears.
   - A file already at that path that Mend did not carry is left alone and never listed.
   - A carried one is replaced only by a later revision.
   - In capture mode, a session never carries from its own worktree, whose sessions share the home.
   - Every lookup of "this session's conversation" skips the listed ones: the workspace snippet,
     `locateLiveTranscript` (the crash harvest, the transcript reader, the observer) and the
     capture-mode harvest. The capture-mode harvest also prefers the conversation the agent is known
     to hold, else the newest.
   - The co-located archive leaves listed files out.
10. **Import takes Codex's summaries, never its folder.** `mend memory import` sends:
    - a summary database holding only the summaries of conversations whose working directory is the
      repository or inside it, and whose memory is on, each unselected;
    - each such conversation's first line, for its stub. A rollout Codex compressed (`.jsonl.zst`)
      is read too.

    The folder itself mixes every repository and is never imported.

### Consequences

- Codex memory spends model calls on the person's own login when a session starts, as on their
  laptop. Codex skips that work when its rate-limit windows are low.
- A conversation becomes memory in a later session, six or more hours after it ended.
- Carried conversations show in that session's `codex resume` list. They are the person's own, on
  the same project.
- The state database lists a home's rollouts only the first time it opens, so a resumed session
  learns only from what was carried at its first launch.
- Two Codex sessions ending at once: the later read-back's summary database replaces the earlier
  one, which is kept as a version. What the earlier one summarised is summarised again later.
- The database and its log are copied file by file, from the home or from a capture. Two live Codex
  sessions of the same person sharing a worktree's home can therefore yield a copy that is valid but
  mixes two moments, which no integrity check can see. The cost is a summary made twice or a
  selection out of date, never a corrupt file. A snapshot through SQLite inside the workspace would
  close it; the images do not all ship SQLite tooling yet.

## Delivery

- Mend: this ADR; the store, delivery and read-back in the session engine; `mend memory` and
  `mend memory import`; docs. One stack after the pi profile (migration 0098).
- Codex (decisions 6 to 10): the second stack, after the box testing of 0.36.
- Later: web and phone views; saving at checkpoints; transcript import.

## Decision log

- 2026-10-02: memory, not the whole home. The whole home is a session's conversation state, and
  sharing it breaks resume, transcript discovery and login freshness (Context).
- 2026-10-02: Claude only for now. Codex memory is built from rollouts that a memory-only carry
  would not bring, and the owner does not use it.
- 2026-10-02: Codex memory carried. The owner chose to carry the memory folder and the conversations
  Codex builds it from over carrying the folder only, which would never fill, or waiting a release.
- 2026-10-04: an import merges (decision 4). Leaving a file both sides have meant a second machine,
  or a second import after both sides changed, never combined anything, and `MEMORY.md` is the file
  most certain to differ. A note is merged into one file rather than kept beside under a second
  name: Claude finds a note through one index line, a second copy would need a synthesized index
  line and its own merges on every later import, and two drifted versions of the same note mostly
  differ by added lines, which a line merge keeps in place. Frontmatter is merged by key because a
  line union writes a key twice. A conflicting value is kept as a YAML comment, which no parser
  reads, so the frontmatter stays valid. The agent still sees the comment and can fold it in.
