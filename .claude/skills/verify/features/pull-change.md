# Pull a change

`mend pull` brings a session's change into a local clone of the project without pushing anything.
Mend commits the session's latest checkpoint the way a landing does, sends the commits from the
session's base to it as a git bundle, and the command fetches that bundle into a local branch named
like the session's branch (`mend/<worktree>`). The working tree, the index and the checked-out
branch are not touched; the user switches to the branch when they want it. It runs before the
change is landed and without access to origin, and it refuses in plain words when the clone is not
the project's.

## Sub-features

- `pull-fetch` fetches a session's change into the clone as `mend/<worktree>` and prints the
  commits.
- `pull-again` pulls again: the branch fast-forwards, or reads `already here` when nothing moved.
- `pull-not-a-clone` refuses outside a git repository.
- `pull-wrong-origin` refuses a clone whose remotes do not include the project's origin, unless
  `--force`.
- `pull-checked-out` refuses while the target branch is the one checked out.
- `pull-too-large` refuses a bundle over the server's size limit, with its size.

## How to get to it (user POV)

- CLI: `mend pull <session> [--force] [--project <p>]`, run inside a local clone of the project's
  repository. `<session>` is a prefix of the session id or the worktree's name; settled sessions
  count.
- Web, TUI, desktop, mobile, VS Code, Slack: no entry point. Pulling is a terminal command only.

## Driving it with verify

Preconditions:

- `mend` is signed in to the instance under test, and `<project>` is adopted from `<repo-url>`.
- A settled session in `<project>` holds a change, from
  `mend run --project <project> -- sh -c 'printf "verified\n" > VERIFY.md'`. Note its worktree name
  `<worktree>` and branch `<branch>` from the `✓ worktree <worktree> · branch <branch>` line, and
  `<id8>` from the `✓ base … · session <id8>` line.
- A fresh clone of the same origin: `git clone <repo-url> <clone>`. Its checked-out branch is the
  default branch, not `<branch>`.
- An empty scratch directory outside any git repository (`<scratch>`, for example from
  `mktemp -d`), and a second one with `git init` and no remotes (`<bare-init>`).

- **Outside a repository.** Run `mend pull <worktree> --project <project>` with `<scratch>` as the
  working directory. Stderr reads
  `mend: <scratch> is not a git repository · run mend pull inside a clone of the project`; exit
  code `1`.
- **Wrong clone.** Run the same command in `<bare-init>`. Stderr reads
  `mend: <project>'s origin is <repo-url> · this clone has no remotes · run mend pull in a clone of it, or pass --force`;
  exit code `1`. Nothing is fetched (`git -C <bare-init> branch` lists nothing new).
- **Pull.** Run `mend pull <worktree> --project <project>` in `<clone>`. Stdout reads
  `  pulling <branch> · <project> · session <id8> · origin is the project's origin`, then
  `✓ fetched <branch> · <sha7> · <n> commit(s) on <base7> · created`, one indented
  `<sha7> <subject>` line per commit (at most ten, then `    … <k> more`), and
  `  switch to it git switch <branch>`. Exit code `0`.
- **Second view.** Run `git -C <clone> log --oneline <base7>..<branch>`. It lists the same commits,
  and `VERIFY.md` is in the tip (`git -C <clone> show <branch>:VERIFY.md` prints `verified`).
  `git -C <clone> status --short` and `git -C <clone> branch --show-current` are what they were
  before the pull.
- **Pull again.** Run the same `mend pull` in `<clone>`. The `✓ fetched` line now ends
  `· already here`; exit code `0`.
- **By id prefix.** Run `mend pull <id8>` in `<clone>`. It picks the same session and prints the
  same `✓ fetched` line.
- **Checked out.** Run `git -C <clone> switch <branch>`, then `mend pull <worktree> --project <project>`.
  Stderr reads
  `mend: nothing fetched · <branch> is checked out here · switch to another branch first; mend pull does not touch the working tree`;
  exit code `1`. Switch back to the default branch afterwards.
- **Proof.** Keep every `mend pull` transcript (command, stdout, stderr, exit code) and the
  `git log`, `git show`, `git status` and `git branch --show-current` output from `<clone>`.

## Gotchas

- The clone must have a remote whose host and path match the project's origin; ssh, https and
  scp-style spellings compare equal. `--force` bypasses the mismatch refusal; Mend still computes
  the remote match. The `pulling` line ends `· remotes not checked (--force)` only when no remote
  matches. With a match it ends `· <remote> is the project's origin`, even under `--force`.
- The clone needs the session's base commit. A base it lacks is refused with
  `this clone lacks the change's base <sha7> · fetch it from origin, then run mend pull again`.
- `mend pull` is not `mend land`. It never pushes, and it never moves the session's branch on the
  server. For the change's owner it takes a checkpoint first; anyone else gets the latest
  checkpoint there is.
- An existing local branch of the same name only fast-forwards. A branch moved locally since the
  last pull is refused with git's own words after `nothing fetched ·`.
- A session with no change yet is refused with `nothing to pull · <branch> holds no change yet`.
- A bundle over `MEND_BUDGET_BUNDLE_BYTES` is refused with
  `bundle not sent · <size> (<bytes> bytes) · the server's limit is <limit> (MEND_BUDGET_BUNDLE_BYTES) · nothing was fetched`.
  A disposable repository stays far under the default; this branch is hard to reach without a
  lowered limit.
- A worktree name that exists in two projects is refused with
  `"<worktree>" names a worktree in 2 projects; pass --project`. Pass `--project` in every scripted
  run.
- The `pulling` line is printed dim; strip ANSI codes before matching when stdout is a TTY.
