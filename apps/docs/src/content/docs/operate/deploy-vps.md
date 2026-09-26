---
title: Deploy on a VPS
description: Run Mend on a remote server and connect from your devices.
sidebar:
  order: 1
---

A VPS or home server uses the same [Docker installation](/getting-started/install/) as your own
machine. Run setup on the server over ordinary host SSH. It runs three containers: the Mend
application (web, API and its pinned Sealant runtime), an official Postgres, and Garage, the bucket
that holds every session's captured work. You do not install or choose a Sealant version separately.

## Decide how the server is reached

Mend asks the operator to state how an instance is reached, in `MEND_EXPOSURE`: `loopback` (this
machine only), `private` (a network you control admission to, such as a tailnet, a LAN or a VPN) or
`public`. The default is `private`, and `mend server setup` does not change it, so a server it
installs runs as `private`. Put the server on a private network such as Tailscale before you bind it
to anything but localhost.

`public` refuses to start while an item of the public exposure gate that the server can observe is
open. `mend operator exposure` prints each item, marked `observed`, `carried`, `declared` or `open`.
The repository also holds a Caddy TLS edge overlay (`deploy/docker/compose.edge.yaml`) for a Compose
project you run yourself; setup does not install it and it is not among the release assets. Read
[Exposure and budgets](/operate/exposure/) before exposing a server beyond a private network.

## Set up the server

On the server:

```sh
npm install --global @sealant/mend
mend server setup --bind 0.0.0.0 --url http://your-vps:3105 \
  --origin http://localhost:3105
```

Replace `your-vps` with a hostname reachable from your clients. Without explicit exposure, web and
SSH stay on localhost. Binding `0.0.0.0` opens every IPv4 interface; setup does not configure your
firewall. Plain HTTP on an untrusted network does not protect credentials.

Registration closes after the first account. That account becomes the owner of the instance's
organization and its operator; everyone after it joins through a single-use invitation link from
`mend invite`. Create the first account before anyone else can reach the server. Read
[Organizations](/organizations/overview/) for members, roles and invitations.

Postgres and Garage publish no host port, and no image registry is published. Workspace images are
built and launched in the host Docker Engine through the mounted daemon socket. Workspaces work on
their own disk and capture their work to the bucket; nothing from the host is bind-mounted into
them.

On your laptop, install only the CLI:

```sh
npm install --global @sealant/mend
mend login --url http://your-vps:3105
mend doctor
```

Server lifecycle commands run on the server machine. A remote client URL does not turn
`mend server setup` into a remote provisioning command.

## Connect providers from your laptop

`mend connect` runs on the machine where you run it and stores the credential under your own user on
the server. For Codex it reads the file the Codex CLI wrote; for GitHub it asks `gh` for its token:

```sh
mend connect codex
mend connect github
mend connect claude
```

Claude is different. `mend connect claude` opens a browser login for a Claude login of Mend's own,
kept in a directory Mend holds, so your own Claude login on the laptop stays as it is. It uses the
Claude CLI on that machine. Claude rotates its refresh token, so two copies of one login sign each
other out; `--use-my-login` sends the login this machine already uses instead, and both sides then
share one grant. Run `mend connect claude` again when Mend says the grant expired.

You do not need to log provider CLIs in on the VPS itself. See
[Connect provider accounts](/guides/provider-accounts/).

## Git authentication

The application container does not inherit your laptop's home directory or SSH agent. Each user has
a Mend key of their own, held on the server:

```sh
mend keys init
mend keys show                    # add this public key to your Git account's SSH keys
mend adopt git@github.com:acme/api.git
```

With the key on your Git account, every repository you can reach works, from detached sessions and
the phone too. To limit it to one repository, add it as that repository's deploy key instead.
`mend-key` is the default mode (`mend keys mode`).

Or keep the private key on your laptop and relay signing:

```sh
mend keys mode bridge
mend adopt git@github.com:acme/api.git --auth bridge
```

In bridge mode every attaching `mend` command and the dashboard relay this machine's ssh-agent while
they run; `mend keys share` does the same from a terminal that runs nothing else. `mend-key` works
unattended; `bridge` needs the relay for server-side Git operations. See
[Git access](/guides/git-access/). Adoption takes a network repository URL, never a client or server
folder path. A project is `--private` to you by default; `--shared` makes it visible to your
organization.

## Reach development services and workspaces

A Service runs inside the session's workspace. While `mend attach`, `mend codex`, `mend claude`,
`mend rejoin` or the dashboard is attached to a session on a remote server, every live Service of
that session declared `--http` or `--https` is tunneled to your laptop's loopback, on the Service's
own port when it is free:

```text
web → http://localhost:5173
```

`--no-tunnel` turns this off. For any other Service, or from a terminal that is not attached, bring
it over explicitly:

```sh
mend service connect web --port 43100
curl http://127.0.0.1:43100
```

See [Development services](/guides/services/). The VS Code extension opens session workspaces over
Remote-SSH, using the Mend URL's hostname and the advertised SSH port. SSH setup needs consent and a
usable key. Verify server host keys rather than blindly replacing known_hosts entries. See
[VS Code](/clients/vscode/) and
[workspace SSH](https://github.com/sealant-sh/mend/blob/main/docs/WORKSPACE-SSH.md).

## Pair another device

```sh
mend pair
```

Pairing offers only origins already configured on the server. Use `--url` to select one of those
exact URLs, not to introduce an unconfigured address. No interface discovery adds URLs to the
trusted list.

## Operate it

Run lifecycle commands on the server:

```sh
mend server status
mend server logs --tail 100
mend server restart
mend server upgrade --version VERSION
```

Choose an exact published version. Updating the laptop's CLI or rerunning the POSIX installer does
not upgrade the server. Upgrade stops application writers and saves a private database backup before
activating the target. A post-startup failure keeps the target pin; it never automatically restores
the database or starts older code.

When something misbehaves, `mend doctor --bundle` writes one redacted archive for a bug report: the
CLI and its environment, the local server's configuration (the names of its `.env` keys, never their
values), container logs, and every session with its processes and recorded output. Read it before
you share it. See [Troubleshooting](/operate/troubleshooting/).

`mend uninstall --server` removes the local installation: its containers, every volume it owns
(repositories, captures, the database), its release image and its private configuration. It prints
the plan and asks you to type `delete` first.

### Server defaults

A server installed by `mend server setup` runs with these defaults, which setup does not expose as
options:

- `MEND_TENANCY=single`: one organization. The operator role administers the instance and has no
  default read access to organization content. `multi` refuses to start until every item of the
  multi mode gate passes; `mend operator gate` lists them.
- Budgets on at their default sizes. A budget bounds what a client, an account or an organization
  may ask; it refuses new work and never stops running work.
- Database pool caps of 6 connections for Mend's queries (`MEND_DATABASE_POOL_MAX`), 3 for the job
  queue (`MEND_JOBS_POOL_MAX`) and 3 for sign-in sessions (`MEND_AUTH_DATABASE_POOL_MAX`), plus one
  for `LISTEN`. When Mend and Sealant share one Postgres, both sets of pools must fit under its
  `max_connections`.

Changing them means running the Compose files yourself or deploying on
[Kubernetes](/operate/deploy-kubernetes/). [Server environment](/reference/server-environment/)
lists every variable.

Back up private configuration and Docker volumes as well. Read the
[self-hosting and recovery guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md)
before planned maintenance. [Kubernetes](/operate/deploy-kubernetes/) remains an operator-managed
alternative, not a mode of this setup command.
