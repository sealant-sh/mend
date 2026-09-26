---
title: Install Mend
description: Install the CLI, then explicitly set up a three-container Mend server.
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

- Node.js 22 or newer for the CLI. The TUI, the dashboard `mend` opens in a terminal, requires
  Node.js 26 or newer.
- For the server, a local Docker daemon with client/server API 1.45 or newer and Docker Compose v2.
- Disk space for repositories, session captures, images, databases, and backups.
- For access from another device, a network path you choose: a private network you control admission
  to, or a TLS edge in front of Mend. Read [Exposure](/operate/exposure/).

Docker Desktop and OrbStack must pass the same capability checks as Docker Engine. Physical macOS
and installed VS Code acceptance are recorded separately in the
[validation checklist](https://github.com/sealant-sh/mend/blob/main/docs/MACOS-VALIDATION.md). Linux
checks are not evidence that MacBook-to-Mac-Mini operation has been verified.

## Install only the CLI

```sh
npm install --global @sealant/mend
```

This installs only the CLI. It does not install Docker, create a server, or start a service.

## Set up the server

On the server machine:

```sh
mend server setup
```

At idle, three product containers run:

- The complete Mend application, including its pinned Sealant API/worker/SSH runtime. Sealant's job
  queue runs in Postgres; workspace images are built and launched in the host Docker Engine through
  the mounted daemon socket.
- Official Postgres, with separate Mend and Sealant databases and users.
- Garage, an S3-compatible object store that holds every session's captures: the worktree files and
  harness state that workspaces upload as they work.

You manage the Mend version. There is no separate Sealant installation or version choice for this
Docker setup. Session workspaces may create additional containers. Repositories, session captures,
database data, and SSH identity persist in Docker-managed volumes.

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

> Binding `0.0.0.0` exposes web and SSH on every IPv4 interface. Registration closes after the first
> account, so create that account before anyone else can reach Mend. The application has
> administrative Docker socket access. Configure your firewall or private network yourself; setup
> does not do it for you.

Plain HTTP does not protect credentials on an untrusted network. Use an encrypted private network or
a TLS edge. A setup install runs with `MEND_EXPOSURE` at its default, `private`: a network you
control admission to. Setup cannot set another exposure and does not install the Caddy edge overlay,
which lives in the repository only. Read [Exposure](/operate/exposure/) for the modes, the public
exposure gate, and what Mend observes beside what you declare.

## Create your Mend account

Open `http://localhost:3105` and create an account. The first account on an instance becomes the
owner of its organization and the instance's operator. Registration then closes. The next page, Git
access, asks how Mend reaches your repositories: with a key of yours held on the server, or through
the ssh-agent on your machine. Read [Configure Git access](/guides/git-access/).

Then sign in from the terminal:

```sh
mend login --url http://localhost:3105
```

For a remote server, use its configured URL instead. `mend login` opens the authorization page.
Compare its code with your terminal before approving. The CLI receives its own revocable device
token; it does not ask for your password in the terminal.

Everyone else joins by invitation. An owner runs `mend invite` (or uses Settings on the web) and
shares the printed one-time `/join/<token>` link; whoever opens it creates an account in the
organization. Read [Organizations](/organizations/overview/).

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
`mend doctor --bundle` writes one redacted diagnostic archive to attach to a bug report; read
[Troubleshooting](/operate/troubleshooting/).

## Operate and upgrade

```sh
mend server status
mend server logs --tail 100
mend server stop
mend server start
mend server restart
```

Stop stops Mend, Postgres, and Garage without deleting volumes. Restart restarts Mend and keeps
Postgres and Garage running. These operations interrupt connections; workspace containers remain.

Setup reruns preserve the server pin, secrets, and data. Updating the CLI does not upgrade the
server. To change the server, explicitly choose a published version:

```sh
mend server upgrade --version VERSION
```

Upgrade validates the target, stops application writers, and saves a private database backup before
target activation. A failure after target startup retains the target pin and recovery files. There
is no automatic database restore or downgrade. Back up Docker volumes and private configuration too;
the SQL dump is not a backup of repositories, session captures (the `mend-garage` volume), or SSH
identity.

The [self-hosting guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md) covers
offline assets, port selection, ownership conflicts, locks, and upgrade recovery. The retired host
installer is not an automatic migration path into this volume-backed deployment.

## Uninstall

```sh
mend uninstall
```

Choose everything, the server only, or this machine's files only. The plan is printed before
anything is removed; taking the server down deletes its volumes (repositories, the `mend-garage`
session captures, the database) and asks for the word `delete`. Data volumes go only when they carry
this installation's identity label. Workspace containers are listed, not removed.

## Next steps

1. [Connect provider accounts](/guides/provider-accounts/).
2. [Adopt a project](/getting-started/adopt-project/).
3. [Configure its session environment](/guides/project-environment/).
4. [Start a session](/getting-started/first-session/).
