# Agent memory: one per person per project

Status: proposed 2026-10-02. Capture mode amended by [ADR 0016](0016-per-person-harness-homes.md)
(2026-10-05): memory lives in each person's own directory of the worktree's home. Implements the
roadmap's 0.36 "one agent home per person per project" and "import on adoption" (owner decisions of
2026-09-28 and 2026-09-29), by carrying the agents' **memory** between a person's sessions rather
than sharing their whole harness home.

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
   writes the owner's memory, as it spends the owner's login. Amended 2026-10-05 by ADR 0016: the
   person is the one the agent process runs as; a steered Claude turn runs in a process started as
   the steerer and writes the steerer's memory, and a steered Codex turn runs with memory off.

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

   Superseded 2026-10-05 by [ADR 0016](0016-per-person-harness-homes.md) §9: in capture mode each
   person has their own saved directory in the worktree's home (`people/<account id>/`), delivery
   writes into it, and read-back runs per process for the person it ran as, so no hand-over, owner
   record or Codex withholding is needed. The hand-over below stays only to migrate a home saved
   before 0.36, and then server-side.

   In capture mode a worktree has one home, which its sessions share over time and, when one joins
   another person's executor (ADR 0002), at once. Amended 2026-10-05, after three reviews found ways
   one person's memory could be saved as another's:
   - **The server decides whose memory the home holds:** the person whose launch made the executor
     holding it, the only launch that delivers into it. The launch records that
     (`agent_memory_homes`) when it hands the home over, as pending, at a chain position not known
     yet. The first flush of that executor after the move that has saved the moved home, under its
     epoch, fills the position in: caught up, or a saved final, or caught up but for named
     unreadable paths that all lie outside the harness home's memory. That is one Mend forces after
     moving another person's memory, started as soon as the home is recorded and run alongside the
     rest of the launch (none once a final flush was sent), or any later one, an agent's end
     included. The record is saved once a capture of that epoch at that position or later is on the
     worktree's chain. An executor lost before that leaves the previous home recorded, which is what
     the restored head holds. Read-backs go by the saved record; a launch into the live executor
     goes by the pending one, which names it. The record outlives the session rows. Only that
     person's sessions read the home back. When the server cannot say, nobody does.
   - **The home's own record (`.mend/agent-memory-owner`) is for a person reading the home:**
     anything running in the executor can write it, so Mend never reads it to decide anything.
   - **A launch hands the home over before delivering:** when the server recorded the home as
     another person's, or as nobody's it can name:
     - the home is first read back into that person's memory. Nobody the server cannot name is
       credited;
     - then every memory path (the memory folders, Codex's summary database, the delivered record,
       files a delivery left staged) moves to `.mend/agent-memory-kept/<stamp>-handover-…`, and the
       owner record names the new person, even when they have nothing stored. The kept set is never
       deleted, so kept sets add up in a worktree people take turns in. They are restored into every
       later executor of the worktree, where anyone working there can read them.

     A hand-over that cannot finish fails the launch, as pi's profile does. A join waits while one
     runs. The launcher's own home costs a few database reads and one write, and nothing in the
     executor. Another person's home also costs the capture read and one `sh` exec on the launch
     path, and one forced capture that no launch or join waits for.

   - **What counts as a Codex is what runs:** a `codex` command line, whatever the session's harness
     is called (`mend run -- codex` too). A wrapped one (`env … codex`, an absolute path, `npx`, a
     shell script) is not recognised.
   - **A Codex in the launcher's own home summarises only their conversations:** before it starts,
     every conversation in its thread index (`state_5.sqlite`) that is not the launcher's is set to
     `memory_mode = 'disabled'`, and the launcher's own that Mend disabled earlier are given back. A
     mode a person chose is never touched. Where that cannot be done (no node, no `node:sqlite`, a
     state database under another name), that Codex starts with its memory off; the conversations it
     starts stay enabled, so a later launch of theirs builds memory from them.
   - **A Codex that joins another person's executor starts with its memory fully off**
     (`features.memories=false`, `memories.generate_memories=false`; a `--enable memories` or
     `--enable memory_tool`, and a `-c`/`--config` naming a memory setting in any form or setting
     the `features` or `memories` table whole, dropped) and changes no thread's memory mode: the
     home owner's selection stands, and the threads it creates are born disabled, so no Codex, the
     joiner's own included, ever builds memory from them.
   - **What a joined agent writes goes to the executor's owner:** it shares their memory files, and
     nobody can tell its lines from theirs. Lines written before the owner's agent ends are saved
     with that read-back. Lines written after it wait for the owner's next read-back of that home:
     when their next agent in that worktree ends, or at the hand-over when someone else launches
     there. They never reach the joiner's memory. Any member with access to the project can join, so
     this is a way to write into another person's memory without their consent; the owner decides
     whether joins should keep it.
   - **Not covered:** a `codex` someone types themselves, or an agent runs, in a session that is not
     a Codex session. Mend withholds other people's conversations only before a Codex session
     starts, so such a Codex can summarise them into the home's memory. Per-person homes would close
     this structurally. Closed by ADR 0016.

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
       shared lines the store's own lines come first, then the machine's. Two files too different to
       align that way (over four million comparisons once a shared start and end are set aside) are
       not merged: no line is ever dropped to make a merge fit.
     - When both versions open with YAML frontmatter, the frontmatter is merged key by key and only
       the body by line. A key both set differently keeps the store's value and the machine's under
       it as a YAML comment (`# from <host>, <date>: description: …`). Only a simple subset is
       merged by key: `key: value` lines with a plain key and a one-line value, and whole-line
       comments, which belong to the key above them and are content like it. Frontmatter outside
       that subset (a quoted key, a block scalar, a nested map, a key written twice) that differs is
       not merged. Line endings are compared as LF; the result keeps the store's.
     - No line is removed after the merge, in `MEMORY.md` or anywhere: a line both sides wrote at
       different places stays twice, and the agent folds it when it next rewrites its memory.
     - Codex's summary database keeps every conversation's newer summary from either side.
     - The last step of every merge compares both inputs, the store's and the machine's, line by
       line as multisets, with the final text. The one exemption: with a last import, as many copies
       of a line as the other side removed since it. A frontmatter value the merge kept as a comment
       counts as there: it is in the file byte for byte after the `# from …:` prefix. A merge that
       misses any other line of either side keeps that side's file whole as a version and says how
       many lines; when it is the machine's, the base stays where it was, so the next import merges
       it and says so again.
     - Anything else (not text, frontmatter not merged, too different to align), or a merge over the
       size limit, keeps the store's file. The machine's is kept as a version, and the next import
       reports it again.
   - A file the store has and the machine no longer sends stays in the store.
   - An import that names a path twice is refused whole (400).
   - Every version an import replaces is kept, the machine's own copy of a merged file too, as for a
     read-back. `--dry-run` asks the server for the same plan and writes nothing, on the machine
     either: it makes no machine id.
   - One rule pins versions, for every version Mend keeps, on every path (import, read-back, a
     session replacing its own earlier save, a binary replacement, a conflict, a removal): a version
     that holds a line, or for a binary file any content, that the file the store holds after that
     step lacks is pinned, and the cap of twenty versions per file never takes it. Codex's summary
     database counts as held when the new one has every summary at a newer valid revision, or at the
     same revision with the same words. One function writes every version and applies the rule; no
     path writes one any other way.

   The same rules apply to a read-back merge. A read-back merge with no shared version (a file the
   session made itself, or a delivered version no longer kept) keeps each shared line once instead
   of repeating the whole file. One that cannot be merged takes the session's, as for a file that is
   not text, and one that does not hold every line of either side keeps that side's file as a pinned
   version.

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
- It builds that memory when a session starts, and again at every turn's start (codex-cli 0.160):
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
- 2026-10-04, after review: the merge never drops a line to succeed. The index keeps each entry
  once, never a delimiter, fence or line inside one; frontmatter is merged by key only within a
  simple subset (no YAML parser is in the tree, and guessing at the rest wrote keys twice or lost a
  block scalar's lines); files too different to align are a conflict rather than a lossy union; and
  any merge that still misses a line keeps the incoming file as a version and holds the base.
- 2026-10-04, second review: the missing-line check is the last step, on the final text, with two
  named exceptions only; code blocks are read after CommonMark (a ``` line inside a four-backtick
  block, a ~~~ block, an unclosed block); and versions that are the only copy of some lines are
  pinned rather than counted in the cap. Pinning, rather than raising the cap or counting pinned
  versions in it, because any finite cap would still evict the only copy after enough saves, and
  these versions are rare: one per conflict or lossy merge, and a repeated one is the same row.
- 2026-10-04, third review: two invariants instead of more cases. The index dedupe is dropped: a
  repeated line in `MEMORY.md` is harmless, as the Consequences already accept, and a lost one is
  not, while every rule that decided which repeats were safe to drop (fences, indented code, lines a
  union moved into or out of a block) found another way to drop a real line. The check is symmetric,
  on both inputs, with base deletions as its only exemption. And pinning is one rule in one
  function, applied to every version on every path, rather than chosen at each call site; the
  same-session replacement and binary paths had kept sole copies unpinned. The cost: a version that
  lost lines to an agent's own edit is pinned too, so the cap now bounds only versions the next file
  holds whole.
- 2026-10-04, fourth review: a summary database row is held only by the same conversation at a
  valid, strictly newer revision, or at the same revision with the same words. A missing row, a
  revision that is not an integer, or a database that does not open is not held; two databases with
  one conversation at one revision in other words are not merged, as one row cannot keep both.
  Migration 0108 (0106 when written; renumbered after main took 0106 and 0107) pins every version
  kept before it: nothing recorded which were the only copy of a line, and memory versions are
  small.
