# Agent memory

Claude Code and Codex write what they learn about a repository to their memory. Mend keeps that
memory per person per project: every agent session a person starts on the project receives their
memory, and what the agent learned is saved back when it ends. A person brings what their own
machine already knows with `mend memory import`, lists it with `mend memory`, prints one file, and
removes one; every version Mend replaces is kept on the server. Other people's sessions never see
it.

## Sub-features

- `memory-import-plan` shows what an import would do (`--dry-run`) and writes nothing.
- `memory-import` brings this machine's Claude memory, and Codex's summaries of this repository's
  conversations, into the project, reporting each file as added, merged, updated, kept, not added,
  conflict or skipped.
- `memory-list` lists the person's memory for the project: harness, file, size, when and by what it
  last changed.
- `memory-show` prints one file (`codex:` prefix for Codex's).
- `memory-remove` removes one file; the last version stays on the server.
- `memory-delivery` writes the memory into each new agent session's harness home and reads it back
  when the agent ends.
- `memory-adopt-hint` says, on `mend adopt` inside a checkout, how many Claude memory files this
  machine keeps for it.
- `memory-pre-release-note` shows on a session page the memory from before 0.36 that no person was
  credited with.

## How to get to it (user POV)

- CLI: `mend memory [list] [--project <p>]`, `mend memory show <file> [--project <p>]`,
  `mend memory rm <file> [--project <p>]`, `mend memory import [--project <p>] [--dry-run]`. Without
  `--project`, the project is the one whose checkout holds the current directory.
- CLI: `mend adopt` with no URL, run inside a checkout, prints
  `  claude memory <n> files on this machine → mend memory import` (`1 file` for one) when Claude
  keeps memory for it here. Given a URL, it says nothing about memory.
- Web: no memory view. A session page shows `memory from before 0.36, not credited · <n> files` only
  on an upgraded server whose shared-home memory could not be credited; a fresh instance never shows
  it.
- TUI, desktop, mobile, VS Code, Slack: no memory surface.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and `<project>` is adopted from `<repo-url>`.
- `<scratch>` is an empty directory the run made. Clone the project locally:
  `git clone <repo-url> <scratch>/checkout`. Its origin is what ties the directory to `<project>`.
- Fake this machine's Claude memory for that checkout, away from the real one: set
  `CLAUDE_CONFIG_DIR=<scratch>/claude` and `CODEX_HOME=<scratch>/codex` for every
  `mend memory import` below, compute `<key>` as `<scratch>/checkout` with every character that is
  not a letter or digit replaced by `-`, and write
  `<scratch>/claude/projects/<key>/memory/MEMORY.md` holding `- verify: the map's memory line\n`.
- `mend memory --project <project>` prints
  `<project>: no agent memory yet · mend memory import brings this machine's`.
- The Claude launch used below needs `mend connect claude` against this instance. Import, list, show
  and remove need no connected provider.

- **Plan.** From `<scratch>/checkout`, run
  `CLAUDE_CONFIG_DIR=<scratch>/claude CODEX_HOME=<scratch>/codex mend memory import --dry-run`.
  Stdout is `claude memory · <scratch>/claude/projects/<key>/memory · 1 file`,
  `would import into <project> · 1 added`, `  added     MEMORY.md` and `--dry-run: nothing written`.
  Exit code `0`. `mend memory --project <project>` still reports no memory.
- **Import.** Run the same command without `--dry-run`. Stdout shows the same first line, then
  `imported into <project> · 1 added`, `  added     MEMORY.md` and
  `every version replaced is kept · sessions in the project receive it from the next launch`.
- **Import again.** Run it once more. The summary reads `imported into <project> · 1 unchanged` with
  no file rows.
- **List.** Run `mend memory --project <project>`. One line starts `claude  MEMORY.md`, with its
  size, `YYYY-MM-DD HH:MM` and `· imported`.
- **Show.** Run `mend memory show MEMORY.md --project <project>`. Stdout is exactly
  `- verify: the map's memory line`.
- **Import refusals.** From `<scratch>` (not a checkout), run `mend memory import`. Stderr is
  `mend: run mend memory import inside the repository's checkout`. Exit code `1`. From the checkout,
  with `CLAUDE_CONFIG_DIR=<scratch>/empty CODEX_HOME=<scratch>/empty`, stderr is
  `mend: neither claude nor codex keeps memory for <scratch>/checkout on this machine`. Exit code
  `1`.
- **Delivered at launch.** Run
  `mend claude "Change nothing." --name verify-memory --project <project> --detach` and note
  `<id8>`. In a tmux session run `mend shell <id8>`, then
  `cat ~/.claude/projects/-workspace-repo/memory/MEMORY.md`. It prints the imported line.
- **Read back at the end.** In that shell, run
  `printf -- '- verify: added in the session\n' >> ~/.claude/projects/-workspace-repo/memory/MEMORY.md`,
  leave the shell, and run `mend stop <id8>`. After it settles, `mend memory --project <project>`
  shows `MEMORY.md` with `· session <id8>`, and `mend memory show MEMORY.md --project <project>`
  prints both lines.
- **Remove.** Run `mend memory rm MEMORY.md --project <project>`. Stdout is
  `removed MEMORY.md · kept as a version`. Run it again: `MEMORY.md: not in memory`. The list prints
  the empty line from the preconditions.
- **Proof.** Keep every `mend memory` transcript with exit codes, the `mend shell` capture
  (`tmux capture-pane -p`) showing the delivered file, and the `mend stop` transcript.

## Gotchas

- `mend memory import` reads this machine's real `~/.claude` and `~/.codex` unless
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` point elsewhere. Always point them at scratch directories, or
  the run uploads the operator's own memory.
- A real import (not `--dry-run`) writes a `machine-id` file into the CLI's config directory, beside
  `cli.json`. Later imports from the same checkout merge against what this one sent.
- The project comes from the current directory's checkout (its origin) unless `--project` names one.
  Run the import from the clone, not from `<scratch>`.
- Mend stores Claude memory files and Codex summary files. Delivery is separate from which harness
  uses those formats: fresh shared-home workspace launches deliver the owner's stored memory even
  for `mend run`, pi or opencode. In per-person homes, delivery runs at agent starts for a personal
  session that has never had shared control. Ownership and shared-control history govern whose
  memory can be delivered and saved back. Memory delivery itself needs no connected provider.
- Read-back happens when the agent ends, not on a timer. A session left open saves nothing until it
  stops.
- `mend memory <word>` with any word other than `show`, `rm` or `import` lists, rather than refusing
  the unknown word.
- A name alone is Claude's file; prefix Codex's with `codex:` (`codex:MEMORY.md`).
- There is no web or phone view of memory. ADR 0009 lists web and phone views as later work. Product
  gap; only the CLI is drivable.
- Mend has no pi or opencode memory format to import or save back. Their launches can still receive
  the person's stored Claude and Codex files; that does not show that either harness reads them.
