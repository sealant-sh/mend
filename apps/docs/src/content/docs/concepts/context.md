---
title: Context
description: Understand what session context exists today and what Mend plans to add.
sidebar:
  order: 3
---

Mend's product direction puts project context beside agent sessions and worktrees. The complete
context-pack workflow is not shipped yet, so this page separates current inputs from planned work.

## Available now

A session can start with information and resources that already belong to the project, its
organization, or its owner:

- repository files and instructions such as `AGENTS.md`;
- reference repositories the organization keeps and the project selects, read-only at
  `/workspace/ref/<name>`;
- organization folders the project selects, at `/workspace/home/<name>`, read-only unless the
  project chose otherwise (see [Folders](/organizations/folders/));
- your skill library and the project's, delivered to the harness at launch (see
  [Skills](/guides/skills/));
- project configuration variables and secrets;
- personal provider accounts and dotfiles;
- the previous process record and provider state when a session resumes.

Workspaces work on their own disk, so references and folders reach them as copies laid down beside
the worktree when the workspace starts: a reference as its tree at `HEAD`, without history, and a
folder as its files. A source over 64 MiB is left out with a warning, and the session still starts.
Host folders an operator declares on the machine are not delivered to these workspaces.

A session can also receive context with a turn:

- An image pasted into an attached terminal with `Ctrl+V` is stored in the session's harness home,
  and its path is pasted for the agent to read.
- A session started or followed up from Slack receives the request, then the thread: every message
  up to the mention, at most fifty messages or 20,000 characters, keeping the newest. Messages from
  people in the install's Slack workspace are quoted with their author's name and marked as Slack
  thread context, apart from the request; bots and people from outside the workspace are dropped.
  Screenshots in the request and in those messages are attached the same way as a pasted image. See
  [Slack](/integrations/slack/).

Mend records the workspace and repository state used for the session where the current contracts
allow it, including which references and folders it received. These inputs are configuration and
delivered resources. They are not yet a named, versioned context pack.

## Planned context workflow

The canonical product plan defines four additions:

1. A **context item** is a file, document, note, URL, or previous handoff.
2. A **context pack** is an editable named selection of those items for recurring work.
3. A **context snapshot** freezes the exact selection supplied to one session.
4. A **handoff** turns the end of a session into editable context for later work.

The schema has a place for a session's context snapshot, but sessions are provisioned without one
today. A future session will receive an immutable snapshot even when the reusable pack changes
later. That will make the question "what did this agent know?" answerable from the session itself.

## What not to assume

Mend does not currently provide automatic long-term memory, hidden context selection, or a context
library in the public product. Do not rely on those features until the UI, storage, and session
attachment path ship.

For current work, keep durable instructions in the repository, select references and folders
explicitly, keep reusable instructions as skills, and use the session record when resuming related
work.
