---
title: Hand off local work
description:
  Copy the branch in your own checkout, with its staged, unstaged and untracked files, into a new
  Mend session, without pushing it and without changing the checkout.
sidebar:
  order: 6
---

`mend handoff` starts a session from the state of a checkout on your machine. Run it inside the
checkout. Mend copies the branch as it is into a new worktree: the commits ahead of the merge base
with the project's default branch, the staged files, the unstaged files and the untracked files. An
agent, or you from another device, carries on from there. Nothing is pushed to origin.

## Before you start

You need:

- a working Mend login and a server at Mend 0.36 or later;
- a checkout whose `origin` is the project's origin. A fork is refused. When no project matches, the
  CLI offers to adopt `origin`;
- `origin/<default branch>` in the checkout, as `git fetch origin` last left it. The CLI never
  fetches.

## Hand off with a prompt

```sh
mend handoff "finish the tests"
```

```text
✓ project newsroom-api · main · from origin
✓ fix/login · 2 commits ahead of main · 3 uncommitted files · 1 untracked
  stays here · gitignored files and .env files: .env.local
  left out · assets/demo.mov · 212 MiB, over the 8 MiB file limit
  bundling 2 commits · 4 files → uploading 1.2 MiB → creating worktree
✓ handed off as fix-login · your checkout is unchanged · as of 10:42:05
  base main 3e73da3 · session 3f2a1c0d
✓ running · claude on your prompt
  attach · mend attach 3f2a1c0d
  watch · http://localhost:3105/sessions/3f2a1c0d-…
```

The agent starts on the prompt and the command returns. `mend attach` opens the session in this
terminal, and the web app, the dashboard and the phone list it like any other session. `--with`
picks the agent: `claude` (the default), `codex`, `opencode` or `pi`.

When the agent does not start, the handoff is still there and the CLI says what happened to the
prompt:
`… · the prompt was not sent · mend claude --worktree fix-login starts claude in the handoff`. The
command exits with code 1.

## Hand off without a prompt

```sh
mend handoff
```

Mend holds the workspace with a shell and no agent, and the last block reads
`✓ held · idle, no agent`. A hold still coming up reads `  starting · the hold is still coming up`.
The session row reads `idle · handed off from dana-mbp`, where `dana-mbp` is the name of the machine
you handed off from, and `mend sessions` names the machine the same way. Attach to it, start an
agent in it later, or open it from another device.

When the hold fails, the block reads `! not held · failed · <why>`, the command exits with code 1,
and `mend resume <session> --with shell` opens the workspace with a shell.

## What travels and what stays

| In your checkout                                     | In the session                                  |
| ---------------------------------------------------- | ----------------------------------------------- |
| Commits ahead of the merge base                      | The same commits, on the worktree's branch      |
| Staged files                                         | Staged, in the index                            |
| Unstaged changes, deletions included                 | Unstaged, in the working tree                   |
| Untracked files that git does not ignore             | Untracked                                       |
| Edits under `assume-unchanged` or `skip-worktree`    | Unstaged, like any other edit                   |
| Files a sparse checkout leaves out                   | At their index version, as in your index        |
| Gitignored files                                     | Not copied                                      |
| `.env*` files, staged, untracked or gitignored       | Not copied; the CLI names them                  |
| Files over the file limit, in the index or on disk   | Not copied; the CLI names them with their size  |
| Files with a git `filter` attribute, such as Git LFS | Not copied; the CLI names them and the filter   |
| A `.env*` file a commit ahead added or changed       | Travels in its commit; the CLI names the commit |

A file that does not travel is at its `HEAD` version in the session, or absent when `HEAD` has none,
so review shows no change for it and never shows it deleted. The file limit is 8 MiB unless the
server sets `MEND_BUDGET_HANDOFF_FILE_BYTES`. A `.env*` file inside a commit cannot be left out
without rewriting the commit, so it travels and the CLI says so:

```text
  travels in a commit · .env.local (1a2b3c4)
```

The CLI checks every commit ahead, merge commits included, so a file that one commit added and a
later one deleted is still named, and so is one that only a merge brought in. File names travel byte
for byte, including names that are not UTF-8.

## Your checkout stays as it was

The handoff reads the checkout and writes nothing to it. No file, index, ref, log or object changes,
and no lock file appears. Git runs against copies of `HEAD` and the index, every object it writes
goes to a scratch repository in your temporary directory, and no hook, clean filter or fsmonitor
runs. `GIT_DIR` and other `GIT_*` variables in your environment are ignored, and so are replace
refs. A partial clone is never fetched from: when it lacks an object the handoff reads, the CLI
refuses and names the `git log -p` that fetches it. The snapshot is cut once, at the time the CLI
prints (`as of 10:42:05`): work you do while the bundle uploads stays in the checkout.

## In the session

The worktree's branch starts at your `HEAD`. Inside the session, `git status` shows the same split
you had: staged changes in the index, unstaged changes in the working tree, untracked files
untracked. Review shows the change from the merge base with the default branch, so it is exactly
`git diff <merge base>` in your checkout plus the untracked files, minus what stayed behind. The
base reads `main 3e73da3`, and a newer `main` on the server does not move it.

## Hand off again

Each `mend handoff` is a new session. Handing off the same branch again makes a new worktree, and
the CLI says which one came before:

```text
✓ handed off as fix-login-2 · fix-login is your earlier handoff · your checkout is unchanged · as of 11:03:10
```

When the name belongs to something that is not your earlier handoff of the branch, the line says
only that it was taken: `✓ handed off as fix-login-2 · fix-login was taken · …`.

A detached `HEAD` hands off too, as `handoff-<sha>`:
`✓ detached at 9c1e2f3 · even with main · 1 uncommitted file`.

## When the CLI refuses

Each refusal ends with `nothing was created`. A refusal after the CLI adopted the repository ends
with `nothing was handed off · <project> stays adopted` instead.

| The CLI says                                                       | What to do                                        |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| `this checkout's origin is … · newsroom-api's is …`                | Hand off from a clone of the project's origin     |
| `this checkout has no origin/main · run git fetch origin, then …`  | Run `git fetch origin`                            |
| `non-interactive · pass --yes to adopt … and hand off`             | Pass `--yes`, or run it in a terminal             |
| `N unmerged paths · finish or abort the merge, then hand off`      | Finish or abort the merge                         |
| `handoff not sent · the bundle is … · the server's limit is …`     | Ask the operator about `MEND_BUDGET_BUNDLE_BYTES` |
| `handoff not sent · something in front of the Mend server refused` | Ask the operator to raise the proxy's body limit  |
| `this Mend server (0.35.1) does not take handoffs · upgrade it, …` | Upgrade the server                                |
| `TMPDIR is …, inside this checkout`                                | Set `TMPDIR` to a directory outside the checkout  |
| `this partial clone lacks objects a handoff reads`                 | Run the `git log -p` it names, then hand off      |

When the connection ends without an answer, or a proxy answers 502, 503 or 504, the CLI sends the
same bundle again, twice at most. The server recognises a bundle it already took and answers with
the same session: `✓ already handed off as fix-login`.
