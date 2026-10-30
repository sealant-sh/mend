---
title: Adopt a project
description: Clone a network Git repository into Mend's central store.
sidebar:
  order: 3
---

Adoption creates the Mend-owned repository used for sessions. Agents never run against your existing
checkout.

## Adopt the current repository

From a Git checkout:

```sh
mend adopt
```

Mend reads the checkout's `origin` URL and asks the server to clone that network repository. It does
not upload your local files or uncommitted changes. Without a network origin, supply a Git URL
explicitly.

Mend sends the `origin` URL as it is and never rewrites it. A checkout cloned over HTTPS has an
`https://` origin. On a server from `mend server setup`, Mend's own Git holds no HTTPS credential,
so that adopts a public repository only, and landing a change to it fails at the push. Adopt its SSH
URL with your Mend key or the bridge (see [HTTPS remotes](/guides/git-access/#https-remotes)):

```sh
mend adopt git@github.com:acme/api.git --name api
```

Choose a name explicitly:

```sh
mend adopt --name billing-api
```

You can also adopt from the web: the Projects page has an Adopt a repository button that takes a Git
URL, an optional name, the Git access mode, and who the project is visible to.

## Adopt another source

Supply a network Git URL:

```sh
mend adopt https://github.com/acme/api.git
mend adopt git@github.com:acme/api.git
mend adopt ssh://git@example.com/acme/api.git
```

The server performs the clone. Local paths, Windows paths, `file://` sources, and custom Git remote
helpers are rejected, even if the files exist on the server. There is no folder-adoption mode.

A URL with a login or token in it (`https://oauth2:TOKEN@…`, `https://ghp_…@github.com/…`) is
refused: Mend shows a project's URL to everyone who can see the project. Adopt from the SSH URL with
your Mend key instead. See
[No credentials in repository URLs](/guides/git-access/#no-credentials-in-repository-urls).

A repository that uses SHA-256 object names, or a shallow one (only part of its history, as a
`git clone --depth` copy, a CI checkout or a mirror made from one holds), is refused after the
clone, which is removed:

```text
Mend doesn't support shallow repositories yet. Make the repository complete where it is hosted (`git fetch --unshallow`), then adopt it again.
```

A project adopted from a shallow repository before 0.36 is refused the same way when a session
starts on it, as is one whose store repository has grafts (`info/grafts`), with its own reason. A
shallow checkout on your own machine still adopts in full, since the server clones its `origin` URL.
See [Known issues](/reference/known-issues/).

## Choose Git authentication

`--auth` selects how the Mend host authenticates remote Git operations:

| Mode       | Behavior                                                  |
| ---------- | --------------------------------------------------------- |
| `mend-key` | Use your Mend key, held on the server                     |
| `bridge`   | Relay signing to an SSH agent shared from another machine |

The default is your Git access mode from `mend keys mode`, which is `mend-key` until you change it.
Both sign SSH remotes. The `ambient` mode of earlier releases is gone; see
[No ambient mode](/guides/git-access/#no-ambient-mode).

For a Mend key:

```sh
mend keys init
mend keys show
mend adopt git@github.com:acme/api.git --auth mend-key
```

Each user has one Mend key, held on the server. Add the printed public key to your Git account's SSH
keys and every repository you can reach works, from detached sessions and the phone too. For one
repository only, add it as that repository's deploy key instead, with write access only if sessions
should push or you want to land changes.

For a hardware key that stays on your laptop, adopt with `--auth bridge`. The Mend host sends SSH
signing requests back to your machine's ssh-agent. When your mode is `bridge`
(`mend keys mode bridge`), every attaching `mend` command and the dashboard share the agent on their
own for as long as they run. On a machine that is not running one, share it explicitly:

```sh
mend keys share
```

Press `Ctrl+C` to stop sharing. Read [Configure Git access](/guides/git-access/) for both modes.

## Choose who sees the project

A project is `private` or `shared`:

```sh
mend adopt --private
mend adopt --shared
```

`--private` is the default: only you see the project. `--shared` makes it visible to everyone in
your organization, who can start sessions in it and review its changes. After adoption, only an
organization owner changes the visibility, in the Visibility section of the project's setup page.
Making a shared project private drains other members' warm workspaces; their sessions keep running
until they end. Read [Organizations](/organizations/overview/).

## Store layout

Each project has a bare repository. Worktree files live as chains of captures in object storage:

```text
<store>/<project>/repo.git
bucket: captures/<worktree>/<epoch>/…
```

An install adopted before the capture store also has `<store>/<project>/worktrees/<worktree>/`
directories; the first launch or resume in each one registers its files as the worktree's first
capture. Read [How Mend works](/concepts/how-mend-works/#project-store).

The store copy is canonical for Mend. Your previous checkout remains separate. Use normal Git
commits, fetches, and pushes to exchange work.

New sessions base on the branch tips the store holds. Bring them up to date with origin:

```sh
mend refresh
```

With no argument it refreshes the project the current directory belongs to; `mend refresh <project>`
names one.

## Start the first session

After adoption:

```sh
mend codex
```

The CLI matches the current checkout to an adopted project by original path, remote URL, or project
name. Use `--project <name>` when you need to select one explicitly.

Read [Start a session](/getting-started/first-session/) for launch, detach, reattach, and resume
behavior.

## Remove, Restore and purge

Remove takes a project out of Mend's ordinary lists and T3 Code. Its files, branches, checkpoints,
sessions, records, reviews, settings and secrets are kept indefinitely. Removal still refuses when
work is live, unsaved, not on origin, or blocked by declared resources. There is no project force.

Open **Projects → Removed projects** to Restore it. You see the same project and history again;
nothing starts automatically. If its name has been reused, supply a new name. Preview definitions
come back, but old grants, tickets and routes do not: open a preview again for fresh access.

```sh
mend projects rm <id>
mend projects removed
mend projects restore <id>
mend projects restore <id> --name new-name
mend doctor
```

Anyone who could see a shared project can see its removed metadata. Only an organization owner can
Restore or purge a shared project. A private project's creator can Restore or purge theirs. An
operator has no additional right. A removed scratch project frees your “No project” slot; Restore
makes it your scratch again only if that slot is still empty.

**Purge** deletes retained content for good. Type the exact project name in the purge dialog, or
run:

```sh
mend projects purge <id> --confirm exact-name
```

Assets another project still references are kept. Instance audit and existing backups are unchanged.
If an upload a session started before the removal could still land, purge refuses and says until
when; purge again after that time. If purge stops partway, purge again to finish. A project left
mid-deletion by an older Mend is listed here too; Restore refuses when completeness cannot be
proved.

T3 Code's confirmation currently says project removal cannot be undone. Mend still keeps it; use
Mend's Restore to bring it back. `mend doctor` reports local disk held by removed projects.
