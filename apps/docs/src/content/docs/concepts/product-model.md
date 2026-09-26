---
title: Product model
description:
  The machines, organizations, projects, worktrees, sessions, workspaces, processes, and changes
  that make up Mend.
sidebar:
  order: 2
---

Mend organizes work around a project on a machine you control. Issues and pull requests are optional
references, not the identity of the work.

```text
Machine
└── Organization
    ├── Members, folders, references, audit log
    └── Project
        ├── Project setup
        └── Worktrees
            ├── Sessions
            │   ├── Agent, shell, and Service processes
            │   └── Durable records
            ├── Checkpoints
            └── Change
                └── Landings
```

## Current model

### Machine

A machine runs Mend and Sealant. It may be your laptop, a home server, or a remote server. It owns
the project store and launches session workspaces. Its operator states how it is reached, its
exposure: `loopback`, `private` (a network they control admission to, the default) or `public`. See
[Exposure and budgets](/operate/exposure/).

### Organization

An organization is the tenant. It owns its members, projects, folders, reference repositories and
audit log, and every account belongs to exactly one. Owners invite people and manage the
organization; members work in the projects they can see. The operator is an instance role that
administers the machine and has no default read access to organization content. A machine runs one
organization unless its operator turns on multi tenancy, which refuses to start until its gate
passes. See [Organizations](/organizations/overview/).

### Project

A project is a Git repository adopted into Mend's central store. Mend treats a previous checkout as
a Git peer, not as an execution target. A project belongs to an organization and is `private` (its
creator only, the default) or `shared` (its whole organization).

A project also owns the setup used by future workspaces: image, variables, secrets, references,
folders, Services, dotfile policy, hot-session count, Git access, and automation switches. A value
the project leaves on inherit follows its organization's defaults, and one the organization leaves
unset follows the instance's.

### Worktree

A worktree is a durable named place in the project store: its own checkout on its own branch,
created from a chosen base. It owns the change, the checkpoint chain, and their review, and it
outlives every conversation inside it. Removing a worktree is its own explicit act. It is refused
while any session is live, and deleting a session never removes the worktree.

Starting a session with a worktree name that already exists joins that worktree as a new
conversation; requesting a different base for an existing worktree is refused rather than silently
re-basing it.

### Session

A session is one supervised coding-agent conversation inside a worktree. A worktree holds many
sessions over its life, and several can be live at once. A session remains the same Mend session
when an agent settles and later resumes.

A session has an owner, the account that started it; the agent runs with the owner's provider logins
and Git access. Only the owner steers it unless they turn on shared control, which lets everyone who
can see the session send turns, answer approvals and type in its terminal, still on the owner's
credentials. A session records where it was started from: Mend itself (the CLI, web, desktop or
phone) or Slack.

A session can contain several agent processes over its life. Supporting shells and Services belong
to the same session because they can read or change its worktree.

### Process

A process is one running or settled interaction with a session workspace. Current process kinds are:

- `agent-pty` for an interactive agent terminal;
- `agent-external` for a coding agent Mend observed but did not launch, such as one run by hand in a
  shell, an SSH session, or an editor terminal;
- `agent-protocol` for a structured provider adapter, a kind reserved that nothing launches yet;
- `shell` for a supporting terminal;
- `service` for a declared development process.

Process state and session state are separate. A settled agent can leave a workspace retained by a
shell or Service.

### Workspace

A workspace is the Sealant environment where session processes run. Mend creates it for the
session's worktree and resolves the image, environment, secrets, references, folders, accounts, and
dotfiles at creation. Each session has its own workspace. It works on its own disk and captures its
work to the machine's capture store, where the worktree's history lives; nothing is bind-mounted
from the host.

The workspace is an execution environment. The session is the longer-lived product object.

### Change

A change is a repository comparison. The main comparison is the worktree against its base: one
change per worktree, and every conversation inside the worktree contributes to it. It does not
require a commit, issue, or pull request.

A change's owner is the owner of the worktree's first session. Only that owner lands it.

### Checkpoint

A checkpoint is a hidden Git ref paired with observed positions in the process records. The chain
belongs to the worktree: one ordered sequence across every conversation in it, and any two
checkpoints define a reviewable slice, even when different sessions took them. Git supplies the
comparison, and the record positions bound what Mend had observed.

### Landing

A landing is one push of a change to origin, plus its pull request when origin is on GitHub,
recorded against the landed checkpoint: the checkpoint whose tree Mend committed. Later landings add
commits to the same branch and update the same pull request. Mend never moves the session's branch,
never merges, and never force-pushes. A pull request opened outside Mend for the worktree's branch
is adopted as the change's own.

### Service

A Service is a stable, explicitly declared development process or forwarded port associated with a
session. It retains its process-attempt history and endpoint while individual attempts restart.

## Review and landing

Reviewing a change happens beside the session that made it. The review shows the worktree against
its base, or any slice between two checkpoints. You write comments on lines and send them back to
the same session as its next turn. Mend reads the change and writes a description, a tour through
the diff, and suggestions: draft comments and proposed checks, each linked to the record or shipped
with a runnable check, never a verdict. See [Review a change](/guides/review-a-change/).

Landing is the optional publication step after review. The owner lands from the web or with
`mend land`, or turns on automatic landing, which lands after a completed turn whose request asked
for a change and never after a question. Each landing reports what was pushed and what GitHub last
said, for example `pull request #412 · open · observed`. See
[Land a change](/guides/land-a-change/).

## Planned context model

The schemas contain an early context-snapshot shape, but current session provisioning does not
create or attach operational context packs or snapshots.

The product direction defines:

- a **context item**: a file, document, note, URL, or previous handoff;
- a **context pack**: an editable named selection for recurring work;
- a **context snapshot**: the immutable selection supplied to one session;
- a **handoff**: an editable end-of-session summary promoted into durable context.

Read [Context](/concepts/context/) for what sessions can receive today.

## Publication

Publication is optional output from a useful local session. Landing pushes a change and opens or
updates its pull request, but it does not define projects, sessions, or changes, and a change is
reviewable before and without it.
