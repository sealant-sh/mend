---
title: Organizations and members
description:
  Who belongs to a Mend instance, what each role can do, who sees a project, who steers a session,
  and how to recover an account without email.
sidebar:
  order: 1
---

An organization is the tenant in Mend. It owns its members, its projects, its
[folders](/organizations/folders/), its reference repositories and its audit log. Every account
belongs to exactly one organization, and every project belongs to one organization.

## Tenancy modes

`MEND_TENANCY` sets how many organizations an instance holds. It takes `single` (the default) or
`multi`.

- `single`: one organization exists. Most installs run this way, for one person or one team.
- `multi`: several organizations share one instance and cannot see or affect each other.

Both modes run the same authorization checks. `single` only fixes the number of organizations at
one.

Starting with `MEND_TENANCY=multi` is refused until the multi mode gate passes. The server computes
the gate at start: items this build already carries answer from the code, and configuration items
answer from the environment. When an item is open, startup stops and names each open item with what
would satisfy it. The operator reads the same list at any time:

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

`GET /health` reports the tenancy mode and the gate as `tenancyGate`: whether it passed, and the ids
of the open items. Every variable is listed in the
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

`mend members` prints your organization's name and one row per member: name, email, role and the day
they joined. The row marked with an arrow is you.

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
works once. Whoever opens it at `/join/<token>` sees the organization name, the role and the expiry
date, creates an account, and joins with that role. Bind the link to an email address when it must
not be forwarded.

Open invitations are listed under **Invitations** with **Revoke** beside each. Accepted, revoked and
expired ones are counted under it. A signed-in account that already belongs to another organization
cannot accept a link; the page says so and offers to sign out.

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
project's **Setup** page. Making a shared project private drains other members' warm workspaces;
their running sessions keep running until they end.

A project, session or change you cannot see answers exactly as a missing one does. Project names are
unique within an organization, not across the instance.

## Who steers a session

A session runs as its owner, the account that started it: that account's provider logins, Git access
and dotfiles. Anyone who can see the project can see the session, read its record, review its change
and draft review comments.

Steering means sending turns, answering approvals, interrupting, typing in its terminal, and sending
review comments back to it. By default only the session's owner steers. Other viewers see
`Only <owner> steers this session. You can read the record and review the change.`, and their review
comments stay on the change until the owner sends them.

The owner can turn on shared control for one session, with the **Shared control** switch on the
session page or from the terminal:

```sh
mend session share 3f2a on
mend session share 3f2a off
```

A prefix of the session id is enough. While shared control is on, everyone who can see the project
steers the session, and every act spends the owner's provider logins and Git access. The session
line reads `runs as <owner> · shared control on` for everyone else. Every turn, approval, interrupt,
terminal attach and stop is recorded with the account that did it.

Only the session's owner turns shared control on. The owner or an organization owner turns it off.
Deleting, renaming or handing off the session stays with its owner even while control is shared.

## Remove a member or change a role

Owners manage people in **Settings → Members**. Each row has **Make owner** or **Make member**,
**Reset password** for members, and **Remove…**. An owner's own row offers **Leave…**.

Removing someone takes effect as follows, as the confirmation states:

- Their live sessions are checkpointed, then stopped. The work so far stays reviewable.
- Their private projects stay in the organization, hidden. An owner can take one over.
- The account is deactivated and its devices signed out. Links already handed out keep their
  remaining lifetime.

Their open connections close, and their Slack link is deleted. A browser they still have open goes
to the sign-in page with a notice.

Projects whose creator was removed appear under **Settings → Projects without a creator**. **Take
over…** makes you the creator. A private project stays hidden from everyone until an owner takes it
over, and the takeover is recorded in the audit log.

## Audit log

Owners read **Settings → Audit log**, newest first, kept indefinitely. It records invitations
created, revoked and accepted; role changes and removals; visibility changes; project takeovers;
folders and references added or removed; shared control turned on or off; password reset links
issued; changes to the organization's defaults; Slack app connections, replacements, removals and
settings, Slack links, channel defaults and sessions started from Slack; and what the operator did
to the organization (creating or renaming it, granting an owner, issuing a reset link).

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

The link opens `/reset/<token>`, works once and expires after a day. Setting a password with it
signs the account out everywhere.

When an organization's owners are gone or locked out, the operator brings one back:

```sh
mend operator grant-owner acme sam@acme.dev
mend operator org invite-owner acme --email sam@acme.dev
```

`grant-owner` makes an existing member an owner. `org invite-owner` prints a one-time link that
makes whoever opens it an owner. Both are recorded in the organization's audit log.

## Operator commands

Every `mend operator` command refuses an account without the operator role.

| Command                                                    | What it does                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| `mend operator org list`                                   | One line per organization with its member and owner counts            |
| `mend operator org create <name>`                          | Create an empty organization. `MEND_TENANCY=multi` only               |
| `mend operator org rename <org> <name>`                    | Rename an organization                                                |
| `mend operator org invite-owner <org> [--email <address>]` | Print a one-time owner invitation                                     |
| `mend operator grant-owner <org> <email>`                  | Make an existing member an owner                                      |
| `mend operator reset-link <email>`                         | Print a one-time password reset link                                  |
| `mend operator gate`                                       | The multi mode gate, item by item                                     |
| `mend operator exposure`                                   | Exposure as declared and observed; see [Exposure](/operate/exposure/) |

`org list` says when an organization has no owner.
