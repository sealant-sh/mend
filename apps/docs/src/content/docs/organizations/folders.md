---
title: Folders
description:
  Directories Mend keeps for an organization, selected per project and placed beside the worktree in
  each session. Also where reference repositories are managed.
sidebar:
  order: 2
---

A folder is a directory Mend keeps for an organization: reading material, test fixtures, anything an
agent should see beside the worktree without it being part of the repository. Owners create folders
and put files in them. Each project selects the folders its sessions receive. Sessions see a
selected folder at:

```text
/workspace/home/<name>
```

Folders replace host mounts, which handed an arbitrary path on the server to whoever could edit a
project. A folder lives in Mend's store under its organization, and only members of that
organization can list it or select it.

## Create and fill a folder

Owners create folders on the organization's **Settings → Folders and references** page with **New
folder…**, or from the terminal:

```sh
mend folder create fixtures
```

Names use lowercase letters, digits, dots, underscores and dashes, and are unique within the
organization.

Upload a local directory:

```sh
mend folder push fixtures ./test/fixtures
mend folder push fixtures ./test/fixtures --replace
```

`push` sends every file under the directory and keeps paths relative to it. Without `--replace` the
files are added beside what the folder already holds; with it, the folder is emptied first so it
holds exactly that directory. `.git` and `node_modules` directories, symlinks and files over 1 MiB
are skipped, and the command counts what it skipped.

On the web, open a folder's row on **Settings → Folders and references** to list its files. Owners
add files with **Upload files…** or a whole directory with **Upload a folder…**, and remove single
files with **Delete**. The same 1 MiB per-file limit applies. A listing stops at 5,000 files and
says it was truncated.

```sh
mend folder list
mend folder rm fixtures
```

Members can list folders and read their listings. Only owners create, fill or remove them. Mend
refuses to remove a folder a project still selects; deselect it in that project's setup first.

## Select folders for a project

Open the project's **Folders and references** settings page. Set a folder's **Access** to **Read
only** or **Read and write** to give the project's next sessions that folder at
`/workspace/home/<name>`; **Off** leaves it out.

The project's creator or an organization owner makes this choice, like the rest of the project's
setup. Two mounts cannot share a name: Mend refuses a selection whose name is already used by
another mount of the project. The session records which folders it received.

Changes apply to sessions launched afterwards, including a resume into a fresh workspace. A running
workspace keeps what it started with.

## How a folder reaches the workspace

How a folder arrives depends on the session store.

In capture mode (`MEND_SESSION_STORE=captured`, the default), workspaces run on their own disk and
nothing is mounted from the server. Each selected folder travels with the session's plan as an
archive, and sealantd unpacks it beside the worktree at `/workspace/home/<name>` when the workspace
boots. This needs sealantd 0.16.0 or newer. The workspace holds a copy: whatever a session writes
there stays in that workspace and never reaches the folder or other sessions. A folder whose archive
is over 64 MiB is left out of the session, and the server logs a warning. The organization's and the
project's **Folders and references** pages say when the deployment works this way.

In colocated mode (`MEND_SESSION_STORE=colocated`, deprecated), the folder's directory in the store
is bind-mounted into the workspace. A folder set to **Read and write** is then written in place, and
every session that mounts it sees the change.

In either mode the folder sits beside the worktree, never inside it. Nothing written there is part
of the session's reviewed change.

## Host paths

A host path mounts a directory from the server's own filesystem at `/workspace/home/<name>`. It is
kept for the operator of a single-tenant instance: the operator adds one with **Add server folder…**
under **Server folders** on a project's **Folders and references** page, which offers it only when
`MEND_TENANCY=single` and the viewer is the operator. Nobody else can add one.

In capture mode host paths are not delivered at all. The server logs
`capture mode · host mounts not applied` and the session starts without them. Use a folder instead,
which reaches captured workspaces as a copy. Server folders are described under
[Folders](/guides/project-environment/#folders) in Session environments.

## Reference repositories

A reference repository is an upstream Git repository cloned into Mend's store for agents to read. It
belongs to the organization, like a folder, and sessions of a project that selects it see it
read-only at:

```text
/workspace/ref/<name>
```

References are listed under **References** on the organization's **Settings → Folders and
references** page, and each project picks from that list on its own **Folders and references** page.

- An owner adds one with **Add reference…**: a name, the repository URL and an optional ref. Mend
  clones it with that owner's own [Git access](/guides/git-access/), never the server's credentials.
- An owner fetches one again with **Fetch again**, using the fetching owner's Git access, or removes
  it with **Remove reference…**.
- The project's creator or an owner turns a reference on to select it for the project's next
  sessions.

In capture mode a reference travels as its tree at the fetched revision, without Git history, the
same way a folder does. In colocated mode the clone is bind-mounted read-only.

Adding and removing folders and references is recorded in the organization's
[audit log](/organizations/overview/#audit-log).
