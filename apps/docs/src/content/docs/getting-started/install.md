---
title: Install Mend
description: Install the CLI, then explicitly set up a two-container Mend server.
sidebar:
  order: 2
---

Install the CLI on each device. Set up the server on the machine that will keep your projects.

## Choose where Mend runs

| Deployment                                 | Shape                                     | Use it when                                  |
| ------------------------------------------ | ----------------------------------------- | -------------------------------------------- |
| Your own machine                           | Local Docker server                       | Server and client share a machine            |
| [VPS or home server](/operate/deploy-vps/) | The same Docker setup on a remote machine | Work should continue when your laptop sleeps |
| [Kubernetes](/operate/deploy-kubernetes/)  | Operator-managed Helm deployment          | You already operate a cluster                |

`mend server setup` currently provisions Docker, not Kubernetes.

## Requirements

- Node.js 22 or newer for the CLI. The optional terminal dashboard requires Node.js 26.
- For the server, a local Docker daemon with client/server API 1.45 or newer and Docker Compose v2.
- Disk space for repositories, worktrees, images, databases, and backups.
- A trusted private network for access from another device.

Docker Desktop and OrbStack must pass the same capability checks as Docker Engine. Physical macOS
and installed VS Code acceptance are recorded separately in the
[validation checklist](https://github.com/sealant-sh/mend/blob/main/docs/MACOS-VALIDATION.md). Linux
checks are not evidence that MacBook-to-Mac-Mini operation has been verified.

## Install only the CLI

```sh
npm install --global @sealant/mend
```

Or download and inspect the POSIX bootstrap:

```sh
curl -fsSL https://mend.sealant.dev/install.sh -o /tmp/mend-install.sh
less /tmp/mend-install.sh
sh /tmp/mend-install.sh
```

Both methods install only the CLI. Neither installs Docker, creates a server, nor starts a service.

## Set up the server

On the server machine:

```sh
mend server setup
```

At idle, two product containers run:

- The complete Mend application, including its pinned Sealant API/worker/SSH runtime. Sealant's job
  queue runs in Postgres; workspace images are built and launched in the host Docker Engine through
  the mounted daemon socket.
- Official Postgres, with separate Mend and Sealant databases and users.

You manage the Mend version. There is no separate Sealant installation or version choice for this
Docker setup. Session workspaces may create additional containers. Repositories, worktrees, harness
state, database data, and SSH identity persist in Docker-managed volumes.

## Network boundary

Web and SSH bind to localhost by default. Postgres has no published host port, and no image registry
is published. Private access must be configured explicitly:

```sh
mend server setup --bind 0.0.0.0 --url http://mend-host:3105 \
  --origin http://localhost:3105
```

Use your server's reachable private hostname. The primary URL and additional exact origins govern
authentication, CORS, WebSockets, pairing, and advertised URLs. Incoming forwarding headers and
interface discovery cannot add trust.

> Keep the instance private. Binding `0.0.0.0` exposes web and SSH on every IPv4 interface. Sign-up
> remains open to anyone who can reach Mend. The application has administrative Docker socket
> access. Configure your firewall or private network yourself; setup does not do it for you.

Do not expose this default installation to the internet. Plain HTTP does not protect credentials on
an untrusted network. Use an encrypted private network or properly configured HTTPS.

## Create your Mend account

Open `http://localhost:3105`, create an account, then sign in:

```sh
mend login --url http://localhost:3105
```

For a remote server, use its configured private URL instead. `mend login` opens the authorization
page. Compare its code with your terminal before approving. The CLI receives its own revocable
device token; it does not ask for your password in the terminal.

## Connect providers

Run these where your credentials live, usually your laptop:

```sh
mend connect claude
mend connect codex
mend connect github
mend accounts
mend doctor
```

Use only the providers you need. Signing in to Mend and connecting a provider are separate actions.
See [provider accounts](/guides/provider-accounts/) and [Git access](/guides/git-access/).

## Operate and upgrade

```sh
mend server status
mend server logs --tail 100
mend server stop
mend server start
mend server restart
```

Stop stops both product containers without deleting volumes. Restart keeps Postgres running. These
operations interrupt connections; workspace containers remain.

Setup reruns preserve the server pin, secrets, and data. Updating the CLI does not upgrade the
server. To change the server, explicitly choose a published version:

```sh
mend server upgrade --version VERSION
```

Upgrade validates the target, stops application writers, and saves a private database backup before
target activation. A failure after target startup retains the target pin and recovery files. There
is no automatic database restore or downgrade. Back up Docker volumes and private configuration too;
the SQL dump is not a backup of repositories or SSH identity.

The [self-hosting guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md) covers
offline assets, port selection, ownership conflicts, locks, and upgrade recovery. The retired host
installer is not an automatic migration path into this volume-backed deployment.

## Uninstall

```sh
mend uninstall
```

Choose everything, the server only, or this machine's files only. The plan is printed before
anything is removed; taking the server down deletes its volumes (repositories, worktrees, the
database) and asks for the word `delete`. Workspace containers are listed, not removed.

## Next steps

1. [Connect provider accounts](/guides/provider-accounts/).
2. [Adopt a project](/getting-started/adopt-project/).
3. [Configure its session environment](/guides/project-environment/).
4. [Start a session](/getting-started/first-session/).
