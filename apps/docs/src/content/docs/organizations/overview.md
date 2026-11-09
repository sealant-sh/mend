---
title: Organizations and members
description:
  Who belongs to a Mend instance, what each role can do, who sees a project, who steers a session,
  and how to recover an account without email.
sidebar:
  order: 1
---

An organization is the tenant in Mend. It owns its members, its projects, its
[folders](/organizations/folders/), its reference repositories and its audit log. An account belongs
to one or more organizations, with a role in each, and every project belongs to one organization.
See [Several organizations](#several-organizations).

## Tenancy modes

`MEND_TENANCY` sets how many organizations an instance holds. It takes `single` (the default) or
`multi`.

- `single`: one organization exists. Most installs run this way, for one person or one team.
- `multi`: several organizations share one instance and cannot see or affect each other.

Both modes run the same authorization checks. `single` only fixes the number of organizations at
one.

Starting with `MEND_TENANCY=multi` is refused until the multi mode gate passes. Items this build
already carries answer from the code, configuration items answer from the environment, and
`operator-present` counts the operator accounts. At start, an open item stops startup, which names
each open item with what would satisfy it. The operator reads the same list at any time, as it is
when asked, so `operator-present` passes as soon as the first account exists:

```sh
mend operator gate
```

| Item                               | Satisfied when                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------- |
| `cross-organization-authorization` | Carried by this build.                                                                  |
| `per-account-resources`            | Carried by this build: signers, push devices and GitHub identity belong to one account. |
| `folders-reach-workspaces`         | Carried by this build (captured workspaces need sealantd 0.16.0 or newer).              |
| `daemon-declares-sizes`            | Carried by this build (sealantd 0.16.0 or newer).                                       |
| `source-policy`                    | `MEND_SOURCE_POLICY=tenant`                                                             |
| `source-address-pinning`           | `MEND_SOURCE_POLICY=tenant`                                                             |
| `transport-bound-to-origin`        | `MEND_GIT_TRANSPORT_BIND_ORIGIN` unset or `true` (the default)                          |
| `upload-length-binding`            | `MEND_CAPTURE_REQUIRE_SIZES=true` with an S3-compatible `MEND_BLOB_STORE` (`s3://…`)    |
| `raw-service-ports`                | `MEND_SERVICE_HOSTS` lists loopback addresses only (the default is `127.0.0.1`)         |
| `operator-present`                 | At least one account holds the operator role                                            |

`GET /api/health` reports the tenancy mode and the gate as `tenancyGate`: whether it passed, and the
ids of the open items. Every variable is listed in the
[server environment reference](/reference/server-environment/).

An instance can move from `single` to `multi` once the gate passes; its organization becomes the
first of several. Starting with `MEND_TENANCY=single` is refused while more than one organization
exists.

## The first account

Registration is closed. The first account registered on an empty instance becomes the owner of its
organization and the operator of the instance. After that, the only way in is an
[invitation](#invite-people). Someone who opens the sign-up form without one is told that
registration is by invitation.

In `multi`, the operator creates each further organization and invites its first owner; that owner
invites the rest. See [Operator commands](#operator-commands).

## Roles

An organization has two roles, `owner` and `member`. The instance has one more, `operator`, which
sits outside every organization.

A member can:

- adopt projects, and see the organization's shared projects and their own private ones;
- start sessions and review changes in the projects they can see;
- change the setup of projects they created;
- list the organization's folders and references, and select them for projects they manage.

An owner can also:

- invite people, remove them and change their roles;
- make a project private or shared, and change the setup of any project they can see;
- remove any project they can see;
- create, fill and remove folders, and add, refresh and remove reference repositories;
- turn off shared control on any session, and stop any session they can see;
- issue a password reset link for a member, and take over a project whose creator was removed;
- set the organization's defaults and connect its [Slack app](/integrations/slack/).

An organization keeps at least one owner. Mend refuses to remove or demote the last one.

The operator administers the machine: the instance's own defaults, organizations, host paths, and
recovery when an organization has no owner who can sign in. The operator has no default read access
to organization content. The role does not make its holder a member of every organization, and it
opens no project, session or change there. Each operator act on an organization is recorded in that
organization's audit log.

`mend members` prints the name of the organization you are in and one row per member: name, email,
role and the day they joined. The row marked with an arrow is you.

## Invite people

An owner creates an invitation from the terminal:

```sh
mend invite
mend invite --role owner
mend invite --email sam@acme.dev --days 3
```

| Option              | Meaning                                               |
| ------------------- | ----------------------------------------------------- |
| `--role <role>`     | `member` or `owner`. Default: `member`                |
| `--email <address>` | Only an account with this email address may accept it |
| `--days <n>`        | Days until the link expires. Default: 7, at most 30   |

Or from **Settings → Invitations** on the web: enter an optional email, pick the role, and choose
**New link**. The web link expires after seven days.

Mend sends no email. The command and the page print a link, once, for you to hand over. The link
works once and joins the organization you are in when you create it. Whoever opens it at
`/join#<token>` sees the organization name, the role and the expiry date. Someone without an account
creates one and joins with that role. Someone already signed in to this Mend joins with the account
they have. Bind the link to an email address when it must not be forwarded.

The token follows the `#`, which a browser never sends to a server, so no proxy or edge in front of
Mend logs it. A link issued by an older version, `/join/<token>`, still works: the page moves the
token after the `#` before it loads anything.

Open invitations are listed under **Invitations** with **Revoke** beside each. Accepted, revoked and
expired ones are counted under it.

A signed-in person accepts a link as the account they are signed in with. Accepting adds the
organization to that account and moves that browser's sign-in to it. An invitation never creates a
second account for someone who is signed in. A link bound to another email address is refused. A
person with an account who is signed out signs in, then opens the same link again.

## Several organizations

In `MEND_TENANCY=multi`, one account can belong to several organizations. It holds its role in each
one separately: owning one organization grants nothing in another. In `single` there is one
organization, and nothing about switching shows.

An account joins another organization in one of two ways:

- An owner of that organization hands over an [invitation](#invite-people), and the person opens it
  while signed in.
- The operator adds the account directly, by email, with
  `mend operator org add-member <org> <email> [--role member|owner]`. The account must already
  belong to an organization on this Mend. The addition is recorded in that organization's audit log.

### One organization per sign-in

Each sign-in acts in one organization at a time. A browser, the CLI and a paired phone each keep
their own, so the web can be in one organization while the CLI is in another. Everything a sign-in
shows belongs to its organization: projects, sessions, Now, settings, members, invitations, folders,
references, Slack, Executor and the audit log. Something in another organization answers as a
missing one does, even to a member of both. Tabs of one browser share a sign-in, so they share one
organization.

A new sign-in starts in the organization the account switched to last, or else in the one it joined
first, and keeps it until you switch that sign-in.

An [access key](/guides/automation/) is not a sign-in: it acts in the organization it was created
in, whichever organization your sign-ins switch to, and it cannot list, switch, leave or join
organizations.

### Switch organizations

On the web, the header names the organization you are in. Choose another one from its menu. Mend
opens Now in the organization you chose.

From the terminal:

```sh
mend org
mend org switch globex
```

`mend org` prints the organization this CLI's sign-in acts in and your role there, then one row per
organization, the active one marked with an arrow:

```text
Acme · owner · 2 organizations
▸ Acme    owner   joined 2026-09-01
  Globex  member  joined 2026-11-08
```

`mend org switch <name|id>` moves this CLI's sign-in only; the web and your other devices stay where
they are. Names match without regard to case. Every other `mend` command acts in the organization
the CLI's sign-in has.

The mobile app, the VS Code extension and the desktop app have no switcher yet. They act in the
organization their sign-in has. To use one in another organization, switch on the web or the CLI
first, then sign the app in again: its new sign-in starts in the organization you switched to last.

Switching is personal and is written to no organization's audit log. When you switch, the sign-in's
open event streams and terminal connections close, and the client reconnects in the new
organization.

### What follows you

Your own provider logins, dotfiles, skills, SSH-agent signer, push devices and Git access follow you
into every organization you belong to. Projects, folders, references, settings, the Slack app,
Executor and Executor links, the audit log and budgets stay with each organization. Someone who
needs their logins kept apart uses a separate account for each organization.

### Leave an organization

```sh
mend org leave globex
```

Or leave from Settings on the web. Leaving asks first; `mend org leave <name|id> --yes` answers for
a script. Your sessions in that organization are checkpointed and stopped, and you lose access to
its projects. Your account and your other organizations stay as they are, and a sign-in that was in
the organization you left moves to another of yours.

Mend refuses to let you leave when you are the organization's last owner (make someone else an owner
first), or when it is your only organization (ask one of its owners to remove you instead).

## Project visibility

Every project is `private` or `shared`.

- `private`: only its creator sees it. This is the default.
- `shared`: every member sees it, starts sessions in it and reviews its changes.

The creator picks when adopting. On the web, the adopt form offers **only you** or **everyone in
&lt;organization&gt;**. From the terminal:

```sh
mend adopt --private
mend adopt --shared
```

After adoption, only an owner changes visibility, from the **Visibility** section at the top of the
project's **Configuration** page. Making a shared project private drains other members' warm
workspaces; their running sessions keep running until they end.

A private project is never saved inside a worktree others can open. Inside a session,
`mend repo add` adds a private project only from a session in another private project of the same
creator; from a shared project it is refused, and it is not listed. See
[Several repositories in one session](/guides/repositories-in-a-session/).

A project, session or change you cannot see answers exactly as a missing one does. Project names are
unique within an organization, not across the instance.

## Who steers a session

A session runs as its owner, the account that started it: that account's provider logins, Git access
and dotfiles. In a [per-person workspace](/operate/per-person-workspaces/) each process runs as the
person who started it, as their own Linux user, so a steered turn runs as its sender. Anyone who can
see the project can see the session, read its record, review its change and draft review comments.

Steering means sending turns, answering approvals, interrupting, and sending review comments back to
it. By default only the session's owner steers. Other viewers see
`Only <owner> steers this session. You can read the record and review the change.`, and their review
comments stay on the change until the owner sends them.

The owner can turn on shared control for one session, with the **Shared control** switch on the
session page or from the terminal:

```sh
mend session share 3f2a on
mend session share 3f2a off
```

A prefix of the session id is enough. Turning it on asks first, in words true to the session's
workspace. In a [per-person workspace](/operate/per-person-workspaces/):

```text
Turn on shared control?
Each turn runs on its sender's login. From now until this session ends, the agent uses no one's personal memory or instructions. The conversation so far, including what your agent loaded before, becomes visible to whoever steers.
```

In a workspace that shares one home:

```text
Turn on shared control?
Everyone who can see this project can send turns, answer approvals and interrupt. Each turn runs on your provider logins and Git access, whoever sends it. In a terminal, it can use your MCP servers too. A conversation already running keeps your MCP servers until its agent restarts.
```

**Turn on** or **Keep it off**. `mend session share <session> on --yes` answers for a script.

While shared control is on, everyone who can see the project steers the session. The session line
reads `runs as <owner> · shared control on` for everyone else. Every turn, approval, interrupt,
terminal attach and stop is recorded with the account that did it.

Whose login a steered turn spends depends on the workspace:

- **In a [per-person workspace](/operate/per-person-workspaces/)**, the default, each turn runs on
  its sender's own login, as the switch says. A sender with no login for the session's provider is
  refused (`Connect Claude to steer this session.`).
- **In a workspace that shares one home**, every act spends the owner's provider logins and Git
  access, and the agent keeps the owner's memory and instructions. Each turn the owner paid for
  someone else says so (`billed to Alice's default`). A workspace shares one home when:
  - it is the first workspace on a new image, before Mend knows whether the image can run per
    person;
  - the operator set `MEND_HARNESS_LAYOUT=shared`;
  - it runs a custom base without `sudo`;
  - its Docker host sets no-new-privileges;
  - its runtime is a Cloudflare sandbox.

  See [What a workspace needs](/operate/per-person-workspaces/#what-a-workspace-needs).

### Steering in a per-person workspace

The conversation stays one thread that everyone drives. When the next turn's sender is not the
person the agent runs as, Mend hands the conversation to an agent process of the sender's user, on
their login.

- **Neutral context.** From the moment shared control is turned on, the agent runs with neither
  person's personal memory nor personal instructions, only the project's: its `CLAUDE.md` or
  `AGENTS.md`, its `.claude/` or `.codex/` settings and `.mcp.json`. Nothing it learns is saved to
  anyone's memory. A session once shared stays that way after shared control is turned off, until
  the session ends. What the owner's agent loaded before sharing stays in the history steerers read.
- **A new sender waits.** Before the hand-over, Mend waits for the previous sender's turn and
  background work to finish, and stops nothing. Everyone sees the waiting line:
  `Waits for Alice's 2 background tasks, 1 sub-agent and a goal to finish before Bob's turn starts.`
  The person the agent runs as, and the session's owner, can end that work from the waiting line.
  The sender or the owner can withdraw the waiting turn. Turns keep their order.
- **Questions go to the person the agent runs as.** A permission prompt or a question from the agent
  is answered only by them, since the answer continues a turn on their login. Anyone else reads
  `Only Alice can answer this; send a turn instead.`
- **Turning it off** cancels the steerers' queued turns:
  `Shared control was turned off, so this turn was not sent.`
- **Automatic landing** follows the owner's own turns only.
- **opencode sessions are one person's.** Shared control is refused for them:
  `opencode sessions are one person's. Shared control is not available for them; start your own session in this worktree.`

The limits are in [Known issues](/reference/known-issues/#shared-control).

Only the session's owner turns shared control on. The owner or an organization owner turns it off.
Deleting, renaming or switching the session between terminal and conversation stays with its owner
even while control is shared.

### Terminals stay with the owner

Only the owner types in a session's terminal, opens a shell or runs a command in its workspace, even
while control is shared. A terminal runs on one provider login, and keystrokes have no turn boundary
at which Mend could switch it to someone else's. In a per-person workspace the Shared control switch
on a terminal session changes nothing in it: its agent keeps running as the owner, with the owner's
memory and instructions. The same holds for a command, so starting a Service is the owner's too; a
steerer can restart and stop the Services already running.

Under shared control, anyone else who can see the project attaches to the terminal to read it. Mend
streams the output to them and drops their keystrokes and resizes. The control log records their
attach as `terminal-watch`, the owner's as `terminal-attach`. Every client draws the terminal
read-only for them and says:

`This session runs in a terminal. Only <owner> types here; they can continue it as a conversation.`

Starting the agent in a terminal with someone's words is typing too. Mend refuses a launch, a resume
or a review follow-up from anyone but the owner when it would start a terminal. In a conversation,
the same requests are turns, and any steerer sends them.

To let others steer a Claude or Codex terminal session, the owner continues it as a conversation, by
picking it up in the mobile app (or **continue as conversation** in the desktop app). Neither app is
published with 0.36; both run from source. The conversation runs in the same workspace, and others
send it turns while control is shared.

## Remove a member or change a role

Owners manage people in **Settings → Members**. Each row has **Make owner** or **Make member**,
**Reset password** for members, and **Remove…**. An owner's own row offers **Leave…**.

Removal is per organization: removing someone from one organization leaves their other organizations
alone. It takes effect as follows, as the confirmation states:

- Their live sessions are checkpointed, then stopped. The work so far stays reviewable.
- Their private projects stay in the organization, hidden. An owner can take one over.
- When this was their only organization, the account is deactivated and its devices signed out, and
  their workspace SSH keys are removed. A key the platform does not remove now, Mend keeps trying
  until it does. Links already handed out keep their remaining lifetime.
- When they belong to another organization, the account, its sign-ins, its devices and its SSH keys
  stay. A sign-in that was in this organization moves to another of theirs. Their access keys for
  this organization are revoked; their keys for their other organizations keep working.

Every agent, shell and Service of theirs ends, including in workspaces other people started. A
workspace they started is retired: the sessions of others working in it stop with
`stopped · the workspace creator is no longer an organization member · start again in a workspace of your own`,
and it saves through the normal Stop. Their open connections close, and their Slack link is deleted.
A browser they still have open in the organization goes to Now in another of their organizations,
or, when this was their only one, to the sign-in page, which says
`This account no longer belongs to an organization on this Mend. Its sessions are being stopped; their work so far is kept.`

Projects whose creator was removed appear under **Settings → Projects without a creator**. **Take
over…** makes you the creator. A private project stays hidden from everyone until an owner takes it
over, and the takeover is recorded in the audit log.

## Audit log

Owners read **Settings → Audit log**, newest first, kept indefinitely. It records invitations
created, revoked and accepted; members the operator added and members who left; role changes and
removals; visibility changes; project takeovers; folders and references added or removed; shared
control turned on or off; password reset links issued; changes to the organization's defaults; Slack
app connections, replacements, removals and settings, Slack links, channel defaults and sessions
started from Slack; checkouts handed off into a worktree with `mend handoff`, with the session;
workspace SSH keys registered and removed, with each key's fingerprint, including the keys removed
with a member and how many of those were still owed when the removal answered; and what the operator
did to the organization (creating or renaming it, granting an owner, issuing a reset link).

Settings pages refresh on their own when membership, roles, invitations, folders or references
change.

## Organization defaults

The workspace environment and the automation switches resolve project, then organization, then
instance. Owners set the organization's values in Settings, under **Workspace environment ·
&lt;organization&gt;** and **Defaults · &lt;organization&gt;**. Each switch offers **Instance**,
**On** or **Off**; **Instance** follows the operator's default. Members read the values and where
each came from. See
[Where defaults come from](/guides/project-environment/#where-defaults-come-from).

## Recover an account without email

Mend sends no email, so recovery is a link someone hands over.

- An owner chooses **Reset password** on a member's row in **Settings → Members**.
- The operator issues a link for any account:

  ```sh
  mend operator reset-link sam@acme.dev
  ```

The link opens `/reset#<token>`, works once and expires after a day. An older `/reset/<token>` link
still works. Setting a password with it signs the account out everywhere.

When an organization's owners are gone or locked out, the operator brings one back:

```sh
mend operator grant-owner acme sam@acme.dev
mend operator org invite-owner acme --email sam@acme.dev
```

`grant-owner` makes an existing member an owner. `org invite-owner` prints a one-time link that
makes whoever opens it an owner. Both are recorded in the organization's audit log. In `multi`,
`mend operator org add-member acme sam@acme.dev --role owner` makes an account of another
organization an owner of this one too.

## Operator commands

Every `mend operator` command refuses an account without the operator role.

| Command                                                    | What it does                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `mend operator org list`                                   | One line per organization with its member and owner counts            |
| `mend operator org create <name>`                          | Create an empty organization. `MEND_TENANCY=multi` only               |
| `mend operator org rename <org> <name>`                    | Rename an organization                                                |
| `mend operator org invite-owner <org> [--email <address>]` | Print a one-time owner invitation                                     |
| `mend operator org add-member <org> <email> [--role <r>]`  | Add an account of another organization. `MEND_TENANCY=multi` only     |
| `mend operator grant-owner <org> <email>`                  | Make an existing member an owner                                      |
| `mend operator reset-link <email>`                         | Print a one-time password reset link                                  |
| `mend operator gate`                                       | The multi mode gate, item by item                                     |
| `mend operator exposure`                                   | Exposure as declared and observed; see [Exposure](/operate/exposure/) |

`org list` says when an organization has no owner.
