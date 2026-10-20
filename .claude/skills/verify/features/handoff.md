# Hand off local work

`mend handoff ["prompt"]` copies the branch in a local checkout into a new session: the commits
ahead of the merge base with the project's default branch, the staged, unstaged and untracked files.
The checkout is not written to. Gitignored files and uncommitted `.env*` files stay behind; the
`.env*` ones are named. Files over the server's file limit and files with a git `filter` attribute
are left out, each named; a tracked one is at its `HEAD` version in the session. A `.env*` file
committed on the branch travels with its commit, and the CLI names it. Without a prompt the
workspace is held with no agent; with one, the agent starts on it and the command returns without
attaching. Review is the worktree against the merge base `M`.

## Sub-features

- `handoff-held` hands off with no prompt: a held workspace, `✓ held · <status>, no agent`, where
  `<status>` is the session status the server answered with.
- `handoff-unchanged` leaves the checkout byte-identical: every file under it, `.git` included, has
  the same bytes, mode, size, mtime and ctime, and no file appears.
- `handoff-row` shows `handed off from <host>` on the worktree and session lines (web project page),
  the Now card (web), the worktree row (TUI), and the session's row in `mend sessions` (CLI). The
  TUI session row carries it after the session's state, where a narrow pane can cut it.
- `handoff-review-base` reviews the change from `M`: base `main`, base sha `M`, and exactly the
  files `git diff --name-only M` names plus the travelled untracked files, minus those left out.
- `handoff-split` keeps staged and unstaged apart inside the session, the same file included.
- `handoff-prompt` starts the agent on a prompt and returns without attaching.
- `handoff-again` hands off the same branch again as `<name>-2`, and names the earlier handoff.
- `handoff-foreign-origin` refuses a checkout whose origin is not the project's.

## How to get to it (user POV)

- CLI: `mend handoff ["prompt"] [--with <harness>] [--project <p>] [--yes]`, run inside a local
  checkout of the project's repository.
- Web, TUI, desktop, mobile: no entry point to hand off. Afterwards the web project page shows
  `handed off from <host>` on the worktree's fact line and on each session line in it, the Now card
  shows it after the base, and the TUI shows it on the worktree row and the session row.
- VS Code: not drivable yet; the extension rebuild brings it.

## Driving it with verify

Preconditions:

- `mend` is signed in to the instance under test, and `<project>` is adopted from `<repo-url>`,
  whose default branch is `main`. On a verify stack, `verify-fixture` already is: a clone of
  `<repo-url>` finds it by its origin.
- `<host>` is the name the CLI's machine gives itself:
  `node -e 'console.log(require("os").hostname().replace(/\.local$/i, ""))'`. On a verify stack, run
  it as a step: every step shares the session Docker daemon's hostname.
- A local checkout `<clone>` in this state, made with plain git (`<n>` is any text):

  ```sh
  git clone <repo-url> <clone> && cd <clone>
  git config user.name verify && git config user.email verify@verify-stack.invalid
  git switch -c verify/handoff
  printf 'a\n' > A.md && printf 'b\n' > B.md
  printf 'ignored.log\n' > .gitignore && printf 'PORT=3000\n' > .env.example
  git add A.md B.md .gitignore .env.example && git commit -qm 'verify: one'
  printf 'c\n' > C.md && git add C.md && git commit -qm 'verify: two'
  printf 'staged\n' >> A.md && git add A.md        # staged
  printf 'unstaged\n' >> A.md                      # unstaged, same file: index differs from both
  printf 'unstaged\n' >> B.md                      # unstaged only
  rm C.md                                          # deleted in the working tree
  printf 'notes\n' > notes.txt                     # untracked, travels
  printf 'ignored\n' > ignored.log                 # gitignored, stays
  printf 'PORT=4000\n' > .env.local                # untracked .env file, stays
  head -c 9000000 /dev/zero > big.bin              # untracked, over 8 MiB, stays
  ```

- `<M>` is `git -C <clone> merge-base HEAD origin/main`. Record `git -C <clone> rev-parse HEAD`,
  `git -C <clone> diff --name-only <M>` (`.env.example`, `.gitignore`, `A.md`, `B.md`) and
  `git -C <clone> status --porcelain=v2 --untracked-files=all` now, before the first fingerprint.

Steps:

- **Fingerprint before.** Run
  `node .claude/skills/verify/scripts/fingerprint.mjs <clone> > <evidence>/handoff-before.txt`. On a
  verify stack the script is not in the inner home: copy it there with a step first.
- **Hand off, held.** Run `mend handoff` in `<clone>`. Stdout reads, line by line:
  `✓ project <project> · main · from origin`,
  `✓ verify/handoff · 2 commits ahead of main · 3 uncommitted files · 1 untracked`,
  `  stays here · gitignored files and .env files: .env.local`,
  `  travels in a commit · .env.example (<commit7 of verify: one>)`,
  `  left out · big.bin · 8.6 MiB, over the 8 MiB file limit`,
  `  bundling 2 commits · 4 files → uploading <size> → creating worktree`,
  `✓ handed off as verify-handoff · your checkout is unchanged · as of <hh:mm:ss>`,
  `  base main <M7> · session <id8>`, `✓ held · <status>, no agent`, `  attach · mend attach <id8>`
  and `  watch · <web>/sessions/<id>`. Exit code `0`. Note `<id8>`, `<id>` and `<status>`.
- **Fingerprint after.** Run the same command into `<evidence>/handoff-after.txt`, then
  `diff <evidence>/handoff-before.txt <evidence>/handoff-after.txt`. It prints nothing and exits
  `0`.
- **Second view.** Run `mend worktrees --project <project> --json`. The worktree `verify-handoff`
  has `"baseRef": "main"`, `"baseSha": "<M>"` and one session `<id>`. The project's own JSON
  (`GET <web>/api/projects/<project id>`) carries the worktree's `handoff`: `machine` is `<host>`,
  `head` is the clone's `HEAD` and `mergeBase` is `<M>`.
- **Web rows.** Run `await page.goto("<web>/projects/<project id>")` and wait for
  `page.getByRole("main").getByRole("link", { name: /session <id8> .* handed off from/ })`. The
  worktree's fact line reads `mend/verify-handoff · base main · handed off from <host>`, and the
  session link's name is `session <id8> claude · handed off from <host>`; the status beside it reads
  `Idle`. Then `await page.goto("<web>/")`: the Live card for `verify-handoff · <project>` reads
  `claude · mend/verify-handoff · base main · handed off from <host>`. Keep ARIA snapshots and
  screenshots of both.
- **TUI rows.** Run `tmux new-session -d -s mend-handoff -x 200 -y 50 'mend ui'`, select
  `<project>`, then `tmux send-keys -t mend-handoff 2`. `tmux capture-pane -p -t mend-handoff` shows
  `verify-handoff` with the line under it starting `from main · handed off from <host>`. Press `3`:
  the session row reads `claude <id8> idle` over a facts line starting `created <n> ago`, and the
  pane's width decides whether `handed off from <host>` follows it; report what it shows. No row
  says `agent ended`. Then `mend attach <id8>` under tmux reaches the held workspace's shell: `echo`
  in it answers, and `ps` lists `bash` and no agent. Run `mend sessions`: the row for `<id8>`
  contains `handed off from <host>`.
- **Review base and files.** Open the review from the session page (`Review the change`). The line
  under the heading reads `<M12> → <tip12> · 5 files · +8 −0 · 0 open comments · base main · …`, and
  the sidebar's file buttons are exactly `.env.example`, `.gitignore`, `A.md`, `B.md` and
  `notes.txt`. Compute the expectation independently in `<clone>`:
  `git -C <clone> diff --name-only <M>` lists the first four, `notes.txt` is the one travelled
  untracked file, and `.env.local`, `ignored.log` and `big.bin` were left out.
  `GET <web>/api/changes/<change id>/diff` names the same files and its `change` has `baseSha`
  `<M>`. In the TUI review screen (`v` on the session) the header reads
  `mend/verify-handoff · worktree vs <M, 12 characters> · 5 files …`.
- **Staged and unstaged in the session.** Run
  `mend run --project <project> --worktree verify-handoff -- git status --porcelain=v2 --untracked-files=all`
  and `git rev-parse HEAD` the same way. Its lines end in CRLF: strip the CR before comparing. The
  `1 MM`, `1 .M` and `1 .D` lines for `A.md`, `B.md` and `C.md` equal the clone's, blob ids
  included, `? notes.txt` is there, nothing is listed for `.env.local`, `ignored.log` or `big.bin`,
  and `HEAD` is the clone's. This adds a `run` session to the worktree, so take the rows first.
- **Hand off again.** Run `mend handoff` in `<clone>` once more. The handed-off line reads
  `✓ handed off as verify-handoff-2 · verify-handoff is your earlier handoff · your checkout is unchanged · as of <hh:mm:ss>`.
  A third reads `verify-handoff-3 · verify-handoff-2 is your earlier handoff`: the newest earlier
  handoff is named. The CLI prints the name the server's answer gives as `previous`; an answer whose
  `previous` is null reads `· verify-handoff was taken` instead. Report which.
- **With a prompt.** Run `mend handoff "say hello"` in `<clone>`. After the handed-off lines, stdout
  reads `✓ running · claude on your prompt`, after `  starting · booting` when the server answered
  before the agent ran, then the `attach` and `watch` lines, and the command exits `0` without
  attaching (no terminal is taken). Without `mend connect claude` the session still starts
  `claude "say hello"`; what the agent does then needs the login.
- **Foreign origin.** Run `git clone <repo-url> <fork>`, then
  `git -C <fork> remote set-url origin https://github.com/someone/fork.git`, then
  `mend handoff --project <project>` in `<fork>`. Stderr reads
  `mend: this checkout's origin is https://github.com/someone/fork.git · <project>'s is <repo-url> · nothing was created`;
  exit code `1`. Without `--project` no adopted project matches that origin, so `mend handoff` in
  `<fork>` with no terminal reads
  `mend: non-interactive · pass --yes to adopt github.com/someone/fork and hand off · nothing was created`;
  exit code `1`. `mend worktrees --project <project> --json` lists no new worktree.
- **Proof.** Keep every `mend handoff` transcript (command, stdout, stderr, exit code), both
  fingerprints and their empty `diff`, the `mend worktrees --json` output, the web snapshots and
  screenshots, the tmux captures and the `git status` from the session.

## Gotchas

- The fingerprint covers the whole checkout, `.git` included. Run nothing else in `<clone>` between
  the two fingerprints: `git status` and editors refresh the index, which changes its mtime.
- The session page (`<web>/sessions/<id>`) does not show `handed off from`; the project page and the
  Now card do.
- The inner home has no git identity: without the `git config` line in the preconditions, the
  fixture's first `git commit` fails with `Author identity unknown`.
- Run in the order above, the prompt handoff is the fourth of the branch, so it is named
  `verify-handoff-4`.
- `mend ui` started inside a checkout offers to adopt that checkout's repository. Press Escape.
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
- Keep only the fields a step reads from an API answer. A whole change diff carries the fixture's
  file contents, and the evidence scan reads a line shaped like `TOKEN=` as a credential field: it
  deletes the file and fails the run.
- The handed-off lines print dim labels; strip ANSI codes before matching when stdout is a TTY.
