---
title: Several repositories in one session
description:
  Add any other project of the store to a running session, work in it at /workspace/repos/<name> on
  a branch of its own, and know how it is saved.
sidebar:
  order: 3
---

Some work touches more than one repository: a product and the platform it runs on, a service and the
daemon it talks to. A session has its own worktree at `/workspace/repo`. From inside that session,
any other project adopted into the same store can be added as a **repository** of the session: a
worktree of that project, on a branch of its own for this session, at `/workspace/repos/<name>`.
Nothing has to be declared on the project first.

## Adding one

In the session's shell, or asked of the agent:

```sh
mend repo add core
```

Mend makes the worktree, answers, and brings the files in while you go on working:

```text
adding core · /workspace/repos/core · branch mend/fix-login · cloning
core            /workspace/repos/core         mend/fix-login            ready · saved with the main repository
```

`mend repo projects` lists what can be added: the projects of your organization you can see, less
this session's own project and the ones already here. `mend repo list` shows the session's
repositories with their state. Name the directory with `--as <name>` and the worktree with
`--worktree <name>` when the defaults, the project's name and the session's own worktree name, are
not what you want.

The `mend` that runs these is the one every workspace already has. It talks to your own session over
the session's channel, with the token the workspace already holds, and nothing wider.

## What you get

- A **worktree of the other project** in the store, named after your session's worktree, on the
  branch `mend/<name>`, at the project's default branch as Mend holds it. The worktree is the
  durable container: it owns its change, its checkpoints and its landing, exactly as your session's
  own worktree does. The session page lists each repository under Repositories.
- **Git access as yourself.** Every `git` in the workspace goes through the session's transport and
  signs with your credential, the repository included. Push its branch and open a pull request the
  way you would for the main repository.
- **One change per repository.** The main repository's change is unchanged. Each repository's change
  is its own, reviewed on its own page once its chain moves.

## How it is saved

Today the repository's files live inside the main worktree, at `/workspace/repo/.mend/repos/<name>`,
and `/workspace/repos/<name>` is a link to that place. The main worktree's captures carry the
sibling as a nested repository, history included, so a Stop saves it with the session and a resume
brings it back. Its state reads `ready · saved with the main repository`. Two guards keep the main
repository's change clean: Mend keeps nested repositories out of the main repository's snapshots,
and `.mend/` is excluded from its `git status`.

What this does not give yet: the repository's own chain stays at its start, so Mend cannot show a
diff of it, take a checkpoint of it or land it from the review. Its row says
`no checkpoints beyond start · saved with the main repository`. Pushing from the workspace works.
When the capture daemon learns to carry a repository root of its own, the repository moves to
`/workspace/repos/<name>` for real and its change, checkpoints and landing appear in the review;
nothing is cloned again.

## States

| State     | Means                                                                                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adding`  | Mend is bringing the files in                                                                                                                             |
| `ready`   | the files are there, linked at `/workspace/repos/<name>`, saved with the session                                                                          |
| `failed`  | they could not be brought in, with the reason, for example a clone the transport refused, or an add a server restart interrupted, with the directory kept |
| `missing` | a repository that was ready did not come back with a restored workspace, with where it was                                                                |

## Refusals

Mend says why, in these words:

- the session's own project: it is already at `/workspace/repo`
- a project you cannot see, or none by that name: `mend repo projects` lists what can be added
- a name already used in the session, or one that is not a plain directory name
- a worktree of that name already in the other project: pick another with `--worktree`
- a project with no origin to clone from
- a session with no live workspace

A sibling whose origin is on a different host than the main project's origin fails its clone with
the transport's own words: a session's git access is bound to the main project's origin host.

## Linked projects

A project can still declare linked projects in its settings. On a capture-mode server that
declaration is a shortcut for adding the repository at launch, which is on its way. Until then the
declaration changes nothing in a captured workspace, and the agent is no longer told about a
directory it cannot see.
