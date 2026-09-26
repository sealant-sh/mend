---
title: Git access
description:
  Choose how the Mend server authenticates clone, fetch, and push, and who your workspaces commit
  as.
sidebar:
  order: 8
---

Remote Git operations run on the Mend server. Session workspaces do not receive SSH keys or Git
credentials.

Your Git access is per user. **Settings → Git access** sets the mode for projects you adopt: **A
Mend key on your git account** (`mend-key`, the default) or **Your machine's key** (`bridge`).
`mend keys mode` does the same from the terminal. A project's **Setup** page can override the mode
with `mend key`, `bridge`, or `ambient`, and `mend adopt --auth` overrides it for one adoption.

## Your Mend key

Each Mend user has one ed25519 key, generated and held on the server and never copied into a
workspace or the database. Create it with **Create my Mend key** under Settings → Git access, or
from the terminal:

```sh
mend keys init
mend keys show
```

Add the printed public key to your Git account's SSH keys. Every repository your account can reach
then works, including from detached sessions, the phone, and the hot pool. For access to one
repository only, add the key as that repository's deploy key instead, and grant it write access only
when sessions need to push.

```sh
mend adopt git@github.com:acme/api.git --auth mend-key
```

The key acts as you and nobody else on the same server: a session signs with its owner's key.

## SSH-agent bridge

Bridge mode keeps the signing key on your machine. The server's Git operations sign through the SSH
agent there, so a hardware key never leaves your desk.

```sh
mend adopt git@github.com:acme/api.git --auth bridge
```

When your mode is `bridge`, every attaching `mend` command and the dashboard share your machine's
agent for as long as they run. `mend keys share` does the same on a machine that is not running one;
`Ctrl+C` stops it. The server takes one signer per account at a time, and a newer share replaces the
older one.

Git transport bytes travel to the Mend server, while SSH signing requests travel back to the shared
agent. Hardware-key touch happens on the machine holding the key. While no signer is connected, Git
for bridge projects does not wait: the base is not fetched, and pushes fail with a message that says
so. The project's Setup page shows `signer connected · <machine>` or `no signer connected`.

## Ambient credentials

Ambient mode uses whatever Git and SSH setup exists where the Mend server process runs. In the
Docker deployment that is the application container, which ships no credentials and does not inherit
your laptop's home directory or SSH agent, so ambient mode reaches only public remotes there. It
fits a source checkout you run as your own user, where the host already has the right SSH agent, key
files, credential helper, or GitHub CLI setup.

Verify access where the server runs before adoption:

```sh
git ls-remote git@github.com:acme/api.git
```

## Git inside a workspace

Mend points the workspace's system Git config at a transport shim (`core.sshCommand`). Plain
commands still work:

```sh
git fetch
git push
```

The shim carries the SSH transport over the session socket. The Mend server resolves the project's
current authentication mode, signs as the session's owner, and opens the remote connection. No SSH
credential enters the container. The socket carries Git's own remote commands only
(`git-upload-pack`, `git-receive-pack`, `git-upload-archive`).

The shim signs only for the project's own origin host. A fetch or push to another host is refused
with
`this session's Git access is bound to <origin host>; pushes and fetches to <host> run without Mend's signer`.
An operator on a machine they alone use can set `MEND_GIT_TRANSPORT_BIND_ORIGIN=false` to let the
shim sign for any host, for mirrors and forks.

In a captured workspace (the default store) the repository is built from captures and has no remote
of its own. Mend names the project's `origin` for the workspace, and a password in an adopted HTTPS
URL is removed before it gets there.

Mend records the remote operation and its outcome. Changing the project's auth mode applies to the
next Git operation without rebuilding the workspace.

## Git author

Commits the agent makes in your workspaces name your Git author. Until you set one, it is the name
and email you registered with. Change it under **Settings → Git author**, or from the terminal:

```sh
mend git-author "Anna Example" anna@example.com
mend git-author --clear
```

`mend git-author` with no arguments prints the current author and where it comes from. `--clear`
returns to your account's name and email.

Mend writes the author into each workspace as system Git config before the agent starts. A `user`
section in your [dotfiles](/guides/dotfiles/) `.gitconfig` or in a repository's own config still
decides. Sessions launched after a change commit as the new author.

## Where Mend's own Git may reach

Adoption, reference repositories, and dotfiles clone from a URL someone typed, with the server's
network position. `MEND_SOURCE_POLICY` decides which addresses those clones may reach:

- `operator` (the default) fits one team's own machine: private networks are allowed, the cloud
  metadata service never is, and loopback or link-local addresses only for the operator;
- `tenant` refuses private, reserved, and local addresses, and unauthenticated `git://`, unless
  `MEND_SOURCE_ALLOWED_HOSTS` (a comma-separated list) names the host. Loopback and the metadata
  service can never be allowed.

Read [Server environment](/reference/server-environment/) for every server variable.

## GitHub connected accounts are separate

`mend connect github` supplies a GitHub token to `gh` and compatible API clients inside workspaces.
It does not choose how the server clones, fetches, or pushes the repository.

[Landing a change](/guides/land-a-change/) uses both: the push goes over the project's Git access,
and the pull request is opened or updated as your connected GitHub account.

Use [provider accounts](/guides/provider-accounts/) for GitHub API access. Use a Git auth mode for
repository transport.

## Common failures

**Permission denied** means the selected identity cannot access the remote. Test ambient access, add
your Mend public key to your Git account, or verify that the shared agent holds an authorized key.

**Host key verification failed** means the remote's host key changed since the Mend server first saw
it: every mode accepts a first-contact key and refuses a changed one. Verify the new key out of
band, then fix the `known_hosts` entry where the server's Git runs. Do not disable host-key checking
in a workspace.

**No signer connected** means bridge mode has no machine sharing its agent. Run any attaching `mend`
command, or `mend keys share`, on the machine holding the key.

**Git access is bound to** another host means the workspace tried to reach a remote other than the
project's origin. See [Git inside a workspace](#git-inside-a-workspace).
