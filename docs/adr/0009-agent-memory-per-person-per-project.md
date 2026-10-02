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
   `mend memory import` reads `~/.claude/projects/<this checkout's path>/memory/` and adds each file
   the store does not have; a file it has with other contents is reported and left. Transcripts
   ("bring your previous sessions") are a later step: a transcript needs its paths rewritten for
   `/workspace/repo` to resume. Logins, goals, logs and caches are never read.

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
- Codex, pi and opencode gain nothing yet. Codex needs its rollouts carried too, which brings back
  the transcript questions above.

## Delivery

- Mend: this ADR; the store, delivery and read-back in the session engine; `mend memory` and
  `mend memory import`; docs. One stack after the pi profile (migration 0098).
- Later: web and phone views; saving at checkpoints; Codex; transcript import.

## Decision log

- 2026-10-02: memory, not the whole home. The whole home is a session's conversation state, and
  sharing it breaks resume, transcript discovery and login freshness (Context).
- 2026-10-02: Claude only for now. Codex memory is built from rollouts that a memory-only carry
  would not bring, and the owner does not use it.
