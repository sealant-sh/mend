# Repositories in a session

A session has its own worktree at `/workspace/repo`. From inside the session's workspace, a person
in a shell, or the agent, can add any other project of the store as a repository of the session (ADR
0011): `mend repo add <project>` makes a worktree of that project on a branch of its own
(`mend/<worktree>`), clones it in, and links it at `/workspace/repos/<name>`. The session page lists
each repository with its state (`adding`, `ready`, `failed`, `missing`) and how it is saved, and the
review page names the session's other repositories beside the main change. Today a repository's
files are saved with the main worktree, so its own change stays at its start and Mend says so.

## Sub-features

- `repo-projects` lists what can be added (`mend repo projects`).
- `repo-add` adds a project as a repository and follows it from `adding` to `ready` or `failed`.
- `repo-list` lists the session's repositories with their state (`mend repo list`, bare
  `mend repo`).
- `repo-refusals` refuses the session's own project, an unknown or invisible project, a bad or used
  name, a taken worktree name, a project with no origin, and a private project in a shared session.
- `repo-session-card` shows the `Repositories` card on the session page.
- `repo-review-line` shows the `repositories ·` line on the review page.
- `repo-removal-hold` makes a worktree that holds an added repository refuse removal until it is
  forced.

## How to get to it (user POV)

- Inside a session's workspace: `mend repo add <project> [--as <name>] [--worktree <name>]`,
  `mend repo list` (or `mend repo`), `mend repo projects`. This `mend` is the helper every workspace
  has, not the CLI on the user's machine; the user reaches it through `mend shell <session>`, the
  web or desktop terminal, or by asking the agent.
- Web: the session page's `Repositories` card (`/sessions/<id>`), and the `repositories ·` line
  under the review page's header (`/changes/<id>`).
- CLI on the user's machine: no `mend repo` command. `mend worktrees rm` names added repositories in
  its refusal.
- TUI, desktop, mobile, VS Code, Slack: no entry point beyond their terminals into the workspace.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>`, the browser and the CLI are signed in as the same person.
- Two projects adopted by that person from network origins on the same Git host: `<project>` from
  `<repo-url>` and `<other>` from `<other-repo-url>`, both private (the default) or both shared. The
  session's git access can clone `<other-repo-url>`.
- A live session in `<project>`: run `mend run --project <project> -- sleep 1800` in its own PTY and
  note `<id>`, `<id8>` and `<worktree>` from its `✓ worktree` and `✓ base … · session <id8>` lines.
- A shell in its workspace: `mend shell <id8>` in a tmux session
  (`tmux new-session -d -s repo -x 200 -y 50 'mend shell <id8>'`). The screen shows
  `✓ shell in <harness> session <id8> · <branch> · detach: Ctrl+]`, then a prompt.

- **Empty card.** Go to `<web>/sessions/<id>`. Under `Repositories` the card reads
  `none beside /workspace/repo · mend repo add <project> in the session adds one`.
- **Empty list.** In the shell, run `tmux send-keys -t repo 'mend repo list' Enter`. The pane shows
  `no repositories beside /workspace/repo · mend repo add <project> adds one`.
- **Projects.** Run `tmux send-keys -t repo 'mend repo projects' Enter`. One line names `<other>`,
  its default branch and its origin. `<project>` is not listed.
- **Own project refused.** Run
  `tmux send-keys -t repo 'mend repo add <project>; echo exit=$?' Enter`. The pane shows
  `mend: <project> is this session's own project · it is at /workspace/repo` and `exit=1`.
- **Unknown project refused.** Run
  `tmux send-keys -t repo 'mend repo add no-such-project; echo exit=$?' Enter`. The pane shows
  `mend: no project named "no-such-project" · mend repo projects lists what can be added` and
  `exit=1`.
- **Add.** Run `tmux send-keys -t repo 'mend repo add <other>; echo exit=$?' Enter`. The pane shows
  `adding <other> · /workspace/repos/<other> · branch mend/<worktree> · cloning`, then, once the
  clone ends, one row: `<other>`, `/workspace/repos/<other>`, `mend/<worktree>`,
  `ready · saved with the main repository`, and `exit=0`. The session page's `Repositories` card
  (reload it if it has not changed) shows `/workspace/repos/<other> · mend/<worktree>` with the
  state word `adding`, then `ready`, and the line
  `<other> · base <base> · no checkpoints beyond start · saved with the main repository`.
- **Files are there.** Run
  `tmux send-keys -t repo 'git -C /workspace/repos/<other> status -sb' Enter`. The pane shows
  `## mend/<worktree>`.
- **Name taken.** Run `tmux send-keys -t repo 'mend repo add <other>; echo exit=$?' Enter` again.
  The pane shows
  `mend: this session already has a repository named <other> · mend repo list shows it` and
  `exit=1`.
- **List.** Run `tmux send-keys -t repo 'mend repo list' Enter`. The same row as the add printed.
- **Review line.** The session needs a change for its review page. In the shell, run
  `tmux send-keys -t repo 'printf "verified\n" > /workspace/repo/VERIFY.md' Enter`, then choose
  `Mark checkpoint` on the session page
  (`await page.getByRole("button", { name: "Mark checkpoint" }).click()`) and follow
  `page.getByRole("link", { name: "Review the change" })`. Under the review header, the line reads
  `repositories · /workspace/repos/<other> ready · nothing of its own to review yet`. The path is
  plain text, not a link, while the repository has no checkpoints of its own.
- **Removal hold.** End the shell (`tmux send-keys -t repo 'exit' Enter`; the pane shows
  `✓ shell ended`), stop the session (`mend stop <id8>`), and wait until
  `mend sessions --project <project> --all --json` shows its `status` settled (not `starting`,
  `running`, `waiting`, `idle` or `stopping`) and `capture` null or with a null `line` (a stop saves
  the workspace first). Then run `mend worktrees rm <worktree> --project <project>`. Stderr carries
  the server's refusal, which includes
  `This worktree holds 1 repository added with mend repo add, saved only with it · <path>/<other> on mend/<worktree> · Mend cannot see whether it holds commits or edits that are not on origin, and removal deletes it. Push what you need from a session in this worktree before removal, or pass force=true to remove it anyway.`,
  then `  mend worktrees rm <worktree> --project <project> --force removes it anyway`. Exit code
  `1`.
- **Proof.** Capture the session page's `Repositories` card while `adding`, if observed, and once
  `ready`, and the review page's header with the `repositories ·` line (`ariaSnapshot()` and
  screenshots). Keep the tmux transcript (`tmux capture-pane -p -S - -t repo`) and the
  `mend worktrees rm` transcript with its exit code.

## Gotchas

- `mend repo` exists only inside a workspace. On the user's machine `mend repo add` answers
  `mend: unknown command "repo" · mend help lists them`. `help.ts` does not list it, and nothing on
  the web, TUI, desktop or mobile adds a repository: the in-workspace helper is the only entry
  point.
- The `Repositories` card's title is a plain paragraph, and its rows have no list or region role.
  The state word is plain text. Assert with `getByText` on the path and the state.
- The review line names each repository by path; it links to the repository's own change only once
  that change has checkpoints beyond its start, which does not happen today (its files are saved
  with the main worktree).
- `adding` can finish before the session page is read, especially after the CLI add returns. Report
  that state as not observed and retain the action transcript and the resulting `ready` card; the
  final card alone does not prove the transient state.
- The add follows the clone for up to 30 minutes and prints
  `still adding · mend repo list shows it when done` past that. A large repository can take minutes;
  wait for the row, not a fixed sleep.
- The clone runs through the session's git transport, which is bound to the main project's origin
  host. An `<other>` on a different host fails with the transport's own words and the row reads
  `failed`.
- A private project cannot be added to a session of a shared project, nor to another person's
  project; the refusal says why. Adopt both projects the same way.
- The worktree the add makes is named after the session's worktree. If `<other>` already has a
  worktree of that name, the add is refused; pass `--worktree <name>`.
- A session with no live workspace cannot add one. Keep the `sleep 1800` session running for the
  whole recipe and stop it by id afterwards.
- `--force` on `mend worktrees rm` deletes the nested repository with the worktree. Do not force it
  in a run that still needs `<other>`'s worktree.
- Detaching a `mend shell` with `Ctrl+]` leaves the shell running, and a running shell keeps the
  session live: the removal is then refused as live. End the shell with `exit`.
- A worktree whose workspace is still saving refuses removal with
  `not removed · saving · 1 session · …`, and `--force` does not lift that. Wait for the save.
