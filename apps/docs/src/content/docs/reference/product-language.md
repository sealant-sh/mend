---
title: Product language
description: Use Mend's product nouns and factual status language consistently.
sidebar:
  order: 3
---

Use these terms in the interface, documentation, and support material.

## Work

| Term                 | Availability | Meaning                                                                                                                |
| -------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Machine**          | Current      | A developer-controlled computer or devbox running Mend and Sealant                                                     |
| **Project**          | Current      | A repository adopted into Mend's central store                                                                         |
| **Worktree**         | Current      | A durable named checkout in the store; owns its change, chain, and review                                              |
| **Session**          | Current      | One supervised coding-agent conversation inside a worktree                                                             |
| **Process**          | Current      | One agent, shell, or Service execution that belongs to a session                                                       |
| **Change**           | Current      | A repository comparison, one per worktree, against its base                                                            |
| **Checkpoint**       | Current      | A hidden Git snapshot in the worktree's chain, with record positions                                                   |
| **Service**          | Current      | An explicitly declared development process or forwarded port in a session                                              |
| **Secret file**      | Current      | A file a person keeps in Mend, encrypted, written into every session they own, never captured                          |
| **Agent memory**     | Current      | What a person's Claude Code or Codex learned on a project, carried into their next sessions                            |
| **Handoff**          | Current      | A copy of the branch in a person's checkout, uncommitted files included, as a new session; the checkout is not changed |
| **Mode switch**      | Current      | Moving a session's agent between a terminal and a conversation                                                         |
| **Context item**     | Planned      | A file, document, note, URL, or previous session summary                                                               |
| **Context pack**     | Planned      | An editable selection of context items for recurring work                                                              |
| **Context snapshot** | Planned      | The immutable context supplied to one session                                                                          |
| **Session summary**  | Planned      | An editable end-of-session summary promoted into durable context                                                       |
| **Workspace**        | Sealant      | The environment where session processes run                                                                            |
| **Run**              | Sealant      | A process execution with a durable platform record                                                                     |
| **Harness**          | Sealant      | Claude Code, Codex, opencode, pi, or another agent command that Mend supervises                                        |

Do not call a process a session. A session can contain several agent processes over time plus
supporting shells and Services.

Handoff means only what `mend handoff` does. The session row says where the work came from:
`handed off from dana-mbp`. Moving an agent between a terminal and a conversation is a mode switch,
and the planned end-of-session summary is a session summary. Neither is a handoff, though the mode
switch keeps its released route, `POST /sessions/:id/handoff`.

Do not call a session a worktree. A worktree holds many sessions over its life, several can be live
at once, and it survives every one of them. Deleting a session leaves the worktree, its change, and
its checkpoints standing; removing a worktree is its own explicit act.

## Workspaces and people

| Term                               | Meaning                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Per-person workspace**           | A workspace where each person who runs anything gets their own Linux user and home, and runs on their own logins. The default                                |
| **Per-person home**                | One person's home in a per-person workspace: their logins, memory, secret files and deliveries, written as them                                              |
| **Workspace that shares one home** | A workspace where every process runs as root in the home of the person who started it (`MEND_HARNESS_LAYOUT=shared`, or an image that cannot run per person) |
| **Launcher**                       | The person whose launch started a workspace. Remote-SSH into a per-person workspace runs as them                                                             |
| **npm mirror**, **Docker mirror**  | The read-through package and image caches beside the Mend server that sessions are pointed at                                                                |

Write "per-person workspace" and "a workspace that shares one home", as the product does. A
per-person workspace is not isolation: everyone in it has passwordless `sudo`. Do not call it
private, sandboxed or isolated. See [Per-person workspaces](/operate/per-person-workspaces/).

## Organizations

| Term                    | Meaning                                                                                                                                                                                                                                                        |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Organization**        | The tenant. It owns its members, projects, folders, reference repositories and audit log. An account belongs to one or more, with a role in each, and each sign-in acts in one at a time                                                                       |
| **Active organization** | The one organization a sign-in acts in. With several, a person switches it per sign-in (`mend org switch`)                                                                                                                                                     |
| **Owner**               | An organization role that also invites and removes people, changes roles and project visibility, and runs recovery                                                                                                                                             |
| **Member**              | An organization role that works in the projects it can see                                                                                                                                                                                                     |
| **Operator**            | An instance role that administers the machine and has no default read access to organization content                                                                                                                                                           |
| **Invitation**          | A single-use link that adds someone to an organization. Registration is closed after the first account                                                                                                                                                         |
| **Folder**              | A directory Mend keeps for an organization, which projects select for their sessions. It replaces host mounts                                                                                                                                                  |
| **Private**             | A project visible to its creator only. The default                                                                                                                                                                                                             |
| **Shared**              | A project visible to its whole organization                                                                                                                                                                                                                    |
| **Shared control**      | A session setting that lets others who can see the session send turns. In a per-person workspace each turn spends its sender's own login; in a workspace that shares one home, the owner's. Only the owner turns it on, and only the owner types in a terminal |

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

## Access keys

| Term           | Availability | Meaning                                                                                                                                                                                                        |
| -------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Access key** | Current      | A named credential a person creates so their own automation can call Mend's HTTP API as them, in the one organization it was created in. It may expire, is shown once, and cannot create or manage credentials |

Do not call an access key an "API key", which is a provider login, or a "token", which is what a
paired device holds. The command is `mend access-keys`; `mend keys` is the person's Mend SSH key.
See [Drive Mend from your own automation](/guides/automation/).

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
| **Automatic landing** | A landing after a completed turn whose request asked for a change, never after a question. On by default from Slack        |

Landing is the publication step, and it is optional. Only the change's owner lands it: the owner of
the worktree's first session. Mend never moves the session's branch, never merges, and never
force-pushes. A landing reports what was pushed and what GitHub last said, in this form:

```text
pull request #412 · open · observed
```

Do not write "ready to merge". See [Land a change](/guides/land-a-change/).

## Screens

| Term           | Availability | Meaning                                                                                                                                    |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **Screen**     | Current      | A graphical display in a session's workspace that the session's agent sees and drives with `screen_look` and `screen_act`                  |
| **Take over**  | Current      | The session's owner taking a screen's input from the agent. Anyone who can see the session can watch its screen; only the owner takes over |
| **Hand back**  | Current      | The owner returning a screen's input to the agent                                                                                          |
| **Screen log** | Current      | The record of what a screen showed and who acted on it                                                                                     |
| **Frame**      | Current      | One observation of a screen in its screen log. Frames are kept for 30 days                                                                 |

Every input to a screen passes through Mend. "Desktop" means the [desktop app](/clients/desktop/):
do not call a screen a desktop. Do not call a frame or the screen log a recording.

## Resources

| Term                  | Availability | Meaning                                                                                                                           |
| --------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| **Resource**          | Current      | A long-running service a project declares in `.mend/mend.toml`, such as Postgres, Redis or any image. Written with its `@`: `@db` |
| **Project resource**  | Current      | One instance of a resource that every worktree in the project can use                                                             |
| **Worktree resource** | Current      | A copy of a resource for one worktree, shared by all its sessions                                                                 |
| **Shared database**   | Current      | The project's Postgres database, used by every worktree set to `shared`. The default                                              |
| **Own database**      | Current      | A worktree's own database on the project's Postgres server, chosen with `own`. `off` gives a worktree no project database         |
| **Project network**   | Current      | How a session reaches a resource by name                                                                                          |
| **Load**              | Current      | Replacing a database's data, after saving the previous data as a dump                                                             |

The same definition can run at both levels at once, and in its worktree the worktree resource wins.
There is no session level. Do not call a resource a Service: a Service is still a process or port a
session declares. See [Resources](/guides/resources/).

## Setup sessions and proof artifacts

| Term               | Availability | Meaning                                                                                                                                                                                                            |
| ------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Setup session**  | Current      | An ordinary session a person chooses to run with Mend's prompt. It proposes a feature map, verification instructions and recipes under `.mend/`, runs on its starter's own agent login, and its result is a change |
| **Proof artifact** | Current      | A selected screenshot or short video of a web app with the change, taken on a session's screen and attached to the change with the checkpoint it captured and when Mend observed it, or an explicit unknown source |

A frame is one observation of a screen, not a proof artifact. Proof artifacts stay as long as the
change; ordinary frames still expire after 30 days. Anyone who can see the change can see its proof
artifacts in Mend. A copy posted to Slack, T3 Code or GitHub follows that service's access rules,
and on a public repository it is public.

A capture says what was observed. Never write that it shows the change works. See
[Set up a project with an agent](/guides/setup-session/) and
[Review proof artifacts](/guides/proof-artifacts/).

## Executor

| Term                        | Availability | Meaning                                                                                                             |
| --------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Executor**                | Current      | The integration gateway from [executor.sh](https://executor.sh) that gives agents tools for services such as Linear |
| **Organization's Executor** | Current      | The one Executor an organization uses: Mend-run, or the organization's own                                          |
| **Mend-run Executor**       | Current      | A private Executor Mend runs for one organization. No browser ever reaches it                                       |
| **Own Executor**            | Current      | An Executor the organization already has, which Mend reaches at its address                                         |
| **Executor link**           | Current      | One person's consent letting Mend call the organization's Executor as them                                          |
| **Mend's member**           | Current      | Who calls run as for someone without an Executor link. It sees only what is shared with everyone                    |
| **service**                 | Current      | Mend's word for what Executor calls an app, such as Linear or Figma                                                 |

Write Executor with a capital E. Never write a bare lowercase "executor" for it: that already means
the machine a workspace runs on. Write an Executor service in lowercase; a Service, capitalised, is
still a process or port a session declares. The person whose link a call uses approves or denies it
in Mend; the agent never approves a call. See [Services through Executor](/guides/executor/).

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
Machine-generated findings are draft comments, never approval or a verdict.

Every finding must link to the session record.

## Keep publication optional

Issues and pull requests are optional references. Do not frame an issue, queue item, branch, or pull
request as the identity of the work. A developer should receive value while the change remains local
and uncommitted. Landing publishes a change when its owner chooses to; it does not define the
project, the session, or the change.
