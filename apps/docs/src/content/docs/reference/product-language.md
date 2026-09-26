---
title: Product language
description: Use Mend's product nouns and factual status language consistently.
sidebar:
  order: 3
---

Use these terms in the interface, documentation, and support material.

## Work

| Term                 | Availability | Meaning                                                                   |
| -------------------- | ------------ | ------------------------------------------------------------------------- |
| **Machine**          | Current      | A developer-controlled computer or devbox running Mend and Sealant        |
| **Project**          | Current      | A repository adopted into Mend's central store                            |
| **Worktree**         | Current      | A durable named checkout in the store; owns its change, chain, and review |
| **Session**          | Current      | One supervised coding-agent conversation inside a worktree                |
| **Process**          | Current      | One agent, shell, or Service execution that belongs to a session          |
| **Change**           | Current      | A repository comparison, one per worktree, against its base               |
| **Checkpoint**       | Current      | A hidden Git snapshot in the worktree's chain, with record positions      |
| **Service**          | Current      | An explicitly declared development process or forwarded port in a session |
| **Context item**     | Planned      | A file, document, note, URL, or previous handoff                          |
| **Context pack**     | Planned      | An editable selection of context items for recurring work                 |
| **Context snapshot** | Planned      | The immutable context supplied to one session                             |
| **Handoff**          | Planned      | An editable session summary promoted into durable context                 |
| **Workspace**        | Sealant      | The environment where session processes run                               |
| **Run**              | Sealant      | A process execution with a durable platform record                        |
| **Harness**          | Sealant      | Codex, Claude Code, or another agent command that Mend supervises         |

Do not call a process a session. A session can contain several agent processes over time plus
supporting shells and Services.

Do not call a session a worktree. A worktree holds many sessions over its life, several can be live
at once, and it survives every one of them. Deleting a session leaves the worktree, its change, and
its checkpoints standing; removing a worktree is its own explicit act.

## Organizations

| Term               | Meaning                                                                                                                           |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Organization**   | The tenant. It owns its members, projects, folders, reference repositories and audit log. An account belongs to exactly one       |
| **Owner**          | An organization role that also invites and removes people, changes roles and project visibility, and runs recovery                |
| **Member**         | An organization role that works in the projects it can see                                                                        |
| **Operator**       | An instance role that administers the machine and has no default read access to organization content                              |
| **Invitation**     | A single-use link that adds someone to an organization. Registration is closed after the first account                            |
| **Folder**         | A directory Mend keeps for an organization, which projects select for their sessions. It replaces host mounts                     |
| **Private**        | A project visible to its creator only. The default                                                                                |
| **Shared**         | A project visible to its whole organization                                                                                       |
| **Shared control** | A session setting that lets others who can see the session steer it, spending the owner's credentials. Only the owner turns it on |

Only a session's owner steers it unless they turn on shared control. `MEND_TENANCY` is `single` (the
default) or `multi`; `multi` refuses to start until the multi mode gate passes. See
[Organizations](/organizations/overview/).

## Access

| Term                     | Meaning                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Exposure**             | How an instance is reached, as its operator declares it: `loopback`, `private` (a network they control admission to) or `public`     |
| **Declared**             | What the operator stated and the server cannot check                                                                                 |
| **Observed**             | What the server read for itself                                                                                                      |
| **Open**                 | A gate item that neither a declaration nor an observation covers                                                                     |
| **Public exposure gate** | The report of every item that bears on exposing an instance, each marked observed, carried (the build contains it), declared or open |
| **Edge**                 | The component that terminates TLS in front of the web tier                                                                           |
| **Upgrade ticket**       | The single-use, thirty-second credential a socket or the terminal embed carries in its URL                                           |
| **Budget**               | A bound on what a client, an account or an organization may ask. It refuses new work and never stops running work                    |

Report what was declared beside what was observed. Do not write "tailnet · reachable", "safe to
expose" or "gate passed". See [Exposure and budgets](/operate/exposure/).

## Slack

| Term             | Meaning                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| **Slack app**    | An organization's own install, made from Mend's manifest and connected over Socket Mode (outbound only) |
| **Slack link**   | The explicit join of one Slack user to one Mend account, never made by matching email                   |
| **Slack thread** | A thread sessions report to. `@mend <prompt>` in it is a follow-up                                      |

Mend picks a session's project from the message, then the thread, then the channel default, then the
person's default, and says which one decided. See [Slack](/integrations/slack/).

## Landing

| Term                  | Meaning                                                                                                                    |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Landing**           | One push of a session's change to origin, plus its pull request, recorded against the checkpoint whose tree Mend committed |
| **Landed checkpoint** | The checkpoint a landing committed and pushed                                                                              |
| **Automatic landing** | A landing after a completed turn whose request asked for a change, never after a question                                  |

Landing is the publication step, and it is optional. Only the change's owner lands it: the owner of
the worktree's first session. Mend never moves the session's branch, never merges, and never
force-pushes. A landing reports what was pushed and what GitHub last said, in this form:

```text
pull request #412 · open · observed
```

Do not write "ready to merge". See [Land a change](/guides/land-a-change/).

## Describe status as observation

Use factual states such as:

- running;
- waiting;
- idle;
- completed;
- failed;
- stopped;
- observed;
- declared;
- open;
- not executed;
- attribution unknown.

Write "Completed · observed", not a judgment. Do not write "safe to merge", "ready to merge", "low
risk", "high confidence", "safe to expose", "gate passed", or another judgment that belongs to the
developer.

## Describe inference plainly

Inference has no product noun. Write "Mend uses inference" or "Mend reads the change."
Machine-generated findings are draft comments and proposed checks, never approval or a verdict.

Every finding must link to the session record or include a runnable check that could test it.

## Keep publication optional

Issues and pull requests are optional references. Do not frame an issue, queue item, branch, or pull
request as the identity of the work. A developer should receive value while the change remains local
and uncommitted. Landing publishes a change when its owner chooses to; it does not define the
project, the session, or the change.
