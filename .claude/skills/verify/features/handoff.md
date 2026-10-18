# Hand off local work

`mend handoff ["prompt"]` copies the branch in a local checkout into a new session: the commits
ahead of the merge base with the project's default branch, the staged, unstaged and untracked files.
The checkout is not written to. Gitignored files, `.env*` files, files over the server's file limit
and files with a git `filter` attribute stay behind, each named, and are at their `HEAD` version in
the session. Without a prompt the workspace is held with no agent; with one, the agent starts on it
and the command returns without attaching. Review is the worktree against the merge base `M`.

## Sub-features

- `handoff-held` hands off with no prompt: a held workspace, `✓ held · idle, no agent`.
- `handoff-unchanged` leaves the checkout byte-identical: every file under it, `.git` included, has
  the same bytes, mode, size, mtime and ctime, and no file appears.
- `handoff-row` shows `handed off from <host>` on the session row (web) and the worktree row (TUI).
- `handoff-review-base` reviews the change from `M`: base `main`, base sha `M`, and exactly the
  files `git diff --name-only M` names plus the travelled untracked files, minus those left out.
- `handoff-split` keeps staged and unstaged apart inside the session.
- `handoff-prompt` starts the agent on a prompt and returns without attaching.
- `handoff-again` hands off the same branch again as `<name>-2`.
- `handoff-foreign-origin` refuses a checkout whose origin is not the project's.

## How to get to it (user POV)

- CLI: `mend handoff ["prompt"] [--with <harness>] [--project <p>] [--yes]`, run inside a local
  checkout of the project's repository.
- Web, TUI, desktop, mobile: no entry point to hand off. The web session line and the TUI's worktree
  and session rows show `handed off from <host>` afterwards.
- VS Code: not drivable yet; the extension rebuild brings it.

## Driving it with verify

Preconditions:

- `mend` is signed in to the instance under test, and `<project>` is adopted from `<repo-url>`,
  whose default branch is `main`.
- `<host>` is the name the CLI's machine gives itself:
  `node -e 'console.log(require("os").hostname().replace(/\.local$/i, ""))'`.
- A local checkout `<clone>` in this state, made with plain git (`<n>` is any text):

  ```sh
  git clone <repo-url> <clone> && cd <clone>
  git switch -c verify/handoff
  printf 'a\n' > A.md && printf 'b\n' > B.md && git add A.md B.md && git commit -qm 'verify: one'
  printf 'c\n' > C.md && git add C.md && git commit -qm 'verify: two'
  printf 'staged\n' >> A.md && git add A.md        # staged
  printf 'unstaged\n' >> B.md                      # unstaged
  rm C.md                                          # deleted in the working tree
  printf 'notes\n' > notes.txt                     # untracked, travels
  printf 'TOKEN=1\n' > .env.local                  # untracked, stays
  head -c 9000000 /dev/zero > big.bin              # untracked, over 8 MiB, stays
  ```

- `<M>` is `git -C <clone> merge-base HEAD origin/main`.

Steps:

- **Fingerprint before.** Run
  `node .claude/skills/verify/scripts/fingerprint.mjs <clone> > <evidence>/handoff-before.txt`.
- **Hand off, held.** Run `mend handoff` in `<clone>`. Stdout reads, line by line:
  `✓ project <project> · main · from origin`,
  `✓ verify/handoff · 2 commits ahead of main · 3 uncommitted files · 1 untracked`,
  `  stays here · gitignored files and .env files: .env.local`,
  `  left out · big.bin · 8.6 MiB, over the 8 MiB file limit`,
  `  bundling 2 commits · 4 files → uploading <size> → creating worktree`,
  `✓ handed off as verify-handoff · your checkout is unchanged · as of <hh:mm:ss>`,
  `  base main <M7> · session <id8>`, `✓ held · idle, no agent`, `  attach · mend attach <id8>` and
  `  watch · <web>/sessions/<id>`. Exit code `0`. Note `<id8>` and `<id>`.
- **Fingerprint after.** Run the same command into `<evidence>/handoff-after.txt`, then
  `diff <evidence>/handoff-before.txt <evidence>/handoff-after.txt`. It prints nothing and exits
  `0`.
- **Second view.** Run `mend worktrees --project <project> --json`. The worktree `verify-handoff`
  has `"baseRef": "main"`, `"baseSha": "<M>"` and one session `<id>`.
- **Web row.** Run `await page.goto("<web>/sessions/<id>")`, wait for the heading, and read the
  session line: it reads `idle · handed off from <host>`. Keep an ARIA snapshot and a screenshot.
- **TUI row.** Run `tmux new-session -d -s mend-handoff -x 200 -y 50 'mend ui'`, select `<project>`,
  then `tmux send-keys -t mend-handoff 2`. `tmux capture-pane -p -t mend-handoff` shows
  `verify-handoff` with the line under it starting `from main · handed off from <host>`, and the
  session's facts line contains `handed off from <host>`.
- **Review base and files.** Open the review from the session page (`Review the change`). The line
  under the heading ends its counts with `· base main`, and the sidebar's file buttons are exactly
  `A.md`, `B.md` and `notes.txt`. Compute the expectation independently in `<clone>`:
  `git -C <clone> diff --name-only <M>` lists `A.md` and `B.md`, `notes.txt` is the one travelled
  untracked file, and `.env.local` and `big.bin` were left out. In the TUI review screen (`v` on the
  session) the header reads ` <branch> · worktree vs <M, 12 characters> · 3 files …`.
- **Staged and unstaged in the session.** Run
  `mend run --project <project> --worktree verify-handoff -- git status --porcelain=v1 -uall`.
  Stdout lists `M  A.md`, ` M B.md`, ` D C.md` and `?? notes.txt`, and nothing for `.env.local` or
  `big.bin`.
- **Hand off again.** Run `mend handoff` in `<clone>` once more. The handed-off line reads
  `✓ handed off as verify-handoff-2 · verify-handoff is your earlier handoff · your checkout is unchanged · as of <hh:mm:ss>`.
- **With a prompt** (needs `mend connect claude`). Run `mend handoff "say hello"` in `<clone>`.
  After the handed-off lines, stdout reads `✓ running · claude on your prompt`, and the command
  exits `0` without attaching (no terminal is taken).
- **Foreign origin.** Run `git clone <repo-url> <fork>`, then
  `git -C <fork> remote set-url origin https://github.com/someone/fork.git`, then `mend handoff` in
  `<fork>`. Stderr reads
  `mend: this checkout's origin is https://github.com/someone/fork.git · <project>'s is <repo-url> · nothing was created`;
  exit code `1`. `mend handoff --project <project>` in `<fork>` refuses the same way.
- **Proof.** Keep every `mend handoff` transcript (command, stdout, stderr, exit code), both
  fingerprints and their empty `diff`, the `mend worktrees --json` output, the web snapshot and
  screenshot, the tmux captures and the `git status` from the session.

## Gotchas

- The fingerprint covers the whole checkout, `.git` included. Run nothing else in `<clone>` between
  the two fingerprints: `git status` and editors refresh the index, which changes its mtime.
- The CLI never fetches. A checkout without `origin/main` is refused with
  `this checkout has no origin/main · run git fetch origin, then hand off again · nothing was created`.
- The merge base is the checkout's, against `origin/main` as it was last fetched. A newer `main` on
  the server does not move the review base.
- `big.bin`'s size line comes from the server's terms. With `MEND_BUDGET_HANDOFF_FILE_BYTES` set on
  the stack, the limit and the line change with it.
- An older server is refused with
  `this Mend server (<version>) does not take handoffs · upgrade it, then hand off again · nothing was created`.
  A stack built from this branch cannot reach that path; the CLI tests cover it.
- Without a terminal and with no adopted project matching, the CLI refuses with
  `non-interactive · pass --yes to adopt <host/path> and hand off · nothing was created`. Adopt
  first, or pass `--yes`.
- The handed-off lines print dim labels; strip ANSI codes before matching when stdout is a TTY.
