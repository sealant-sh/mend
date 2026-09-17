---
title: Teams and project scope
description: Share projects with a group of accounts on one Mend, and decide who sees what.
sidebar:
  order: 7
---

A team is a named group of accounts on one Mend. Every project has a scope, and scope is what Mend
checks whenever an account opens a project, its sessions, a terminal, a Service, or a review:

- **Only you** — a personal project. Nobody else on the Mend sees it.
- **A team** — visible to that team's members.
- **Everyone here** — visible to every account on the Mend. This is what every project was before
  scope existed, so existing projects keep it after an upgrade when the Mend has more than one
  account. On a Mend with a single account, existing projects become that account's personal
  projects.

Seeing a project is the working permission: anyone who sees it can start sessions, attach to a
colleague's terminal, tunnel a Service, review the change, and edit the project's setup. Removing a
project or changing its scope needs more: the owner of a personal project, an owner of the team a
team project belongs to, or any account for an instance-wide project.

A project outside your scope answers "not found" everywhere — the API, the terminal, the event
stream — the same way another account's paired device does.

## Create a team

Open **Teams** in the web app and choose **New team**. You become its first owner. A team keeps at
least one owner; the last owner cannot leave or step down until someone else is made an owner.

Owners rename the team, add and remove members, change roles, mint and revoke invite links, and
delete the team. A team with projects still scoped to it cannot be deleted; move them first. Members
work in the team's projects and can leave.

## Add people

Two ways, both from the team's page:

- **Add by email.** For an account that already exists on this Mend.
- **Invite link.** For anyone. The link works once and expires after seven days. Whoever opens it
  signs in, or registers, and takes the seat. Bind the link to an email when it must not be
  forwarded; then only the account with that email can accept it. The link is shown once — Mend
  stores only a hash of it.

## Scope a project

When you adopt a repository, the adoption form asks who it is visible to; the default is only you.
From the terminal:

```sh
mend adopt git@github.com:acme/api.git --team platform
mend adopt git@github.com:acme/dotfiles.git            # only you
mend adopt git@github.com:acme/shared.git --everyone
```

Change it later from the project's **Setup** page under **Visible to**. The store copy never moves;
only who can reach it changes.

## What stays yours

Provider accounts, the Mend git key, your git access choice, dotfiles, your skill library, and
paired devices belong to your account, whatever teams you are in. A session you start in a shared
project runs as you — with your provider accounts and dotfiles — and a colleague who attaches to it
works inside that same workspace.
