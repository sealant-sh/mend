---
title: Secret files
description:
  Files such as ~/.aws/credentials, a kubeconfig or an .npmrc token file, written into every session
  you launch and never captured.
sidebar:
  order: 6
---

A **secret file** is a file you keep in Mend, encrypted at rest, with a path under the home
directory of the workspace and its content. Every session you own receives your secret files before
its agent starts, in every project: `~/.aws/credentials` and `~/.aws/config`, a kubeconfig, an
`.npmrc` token file. They are yours alone. No one else's sessions receive them, and the content
never comes back out of the server.

Project [secrets](/guides/environment-variables/) are environment variables, per project. Secret
files are files, per person. Use a secret file when a tool reads a file and nothing else.

## Keep one

From any directory:

```sh
mend secrets add ~/.aws/credentials --from ~/.aws/credentials
mend secrets add .kube/config --from ~/.kube/config
mend secrets add .npmrc < ~/.npmrc
```

The path names where the file goes in the workspace, relative to its home directory. A path on your
machine under your home names the same place. The content comes from `--from <file>`, or from stdin.
A file already kept at that path is replaced. Binary files are fine. A file is at most 256 KB, and
you may keep up to 64.

The web app's settings page has the same list, with add and remove. The phone shows the list.

## See and remove them

```sh
mend secrets            # each file's path in the workspace, size, and when it last changed
mend secrets rm .npmrc
```

Sessions launched after a change receive the new set. A running session keeps what it has until its
next run in the same workspace.

One exception: on the captured session store a worktree has one workspace, so a session you start in
a worktree where someone else's session is live runs in their workspace. It receives none of your
secret files there, and the session log says so.

## Never captured

Sessions capture their work so nothing is lost: the worktree, its checkpoints, and the harness home
that holds the agent's conversations. A secret file is in none of these:

- It is written into the workspace's own home directory, `~`. The captured roots are the worktree at
  `/workspace/repo` and the harness home at `/workspace/harness-home`. Neither covers `~`.
- A path under a directory sessions do capture is refused when you add it: `.claude`, `.codex`,
  `.pi`, `.local/share/opencode`, `.claude.json` and Mend's own `.mend`.
- Before writing, the workspace checks the path is still a plain path in the home: no symlink at any
  component, and the directory's real location is where its name says. A dotfiles tree that linked
  `~/.aws` into the worktree would turn a secret file into a captured one, so such a file is not
  written, and the session line says so.

The file is also not part of the change, a checkpoint or a transcript harvest, for the same reason:
all three read the worktree or the harness home.

## What Mend does with the content

- The content is sent once, to the server. The server seals it with the machine's secrets key, the
  one project secrets use, and stores it sealed. The key is `secrets.key` under the server's keys
  directory, made on first use with mode 0600.
- No API returns a file's content, in any shape. The list shows path, size and dates.
- At launch, the server unseals the set once and writes each file into the workspace over the
  platform's exec channel, 0600, in a directory made 0700 when missing. The agent then reads the
  file as it would on your laptop.
- A session's logs name the path written, never the content.

A lost key means the stored files cannot be unsealed: add them again.
