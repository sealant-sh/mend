---
title: Install Mend
description:
  Install the CLI, then set up a three-container Mend server by answering a few questions.
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

- Node.js 22.13 or newer for the CLI. The TUI, the dashboard `mend` opens in a terminal, requires
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

This installs only the CLI. It does not install Docker, create a server, or start a service. To try
the next release before it ships, read [Try a preview](/getting-started/try-a-preview/).

## Set up the server

On the server machine, in a terminal:

```sh
mend server setup
```

Setup asks a few questions, one at a time, and says in a line what each choice means. Enter takes
the answer in brackets.

- **How will people reach this Mend?** Just this machine, your private network or Tailscale, or the
  public internet with HTTPS.
- For **Tailscale**, setup reads `tailscale status` and offers this machine's MagicDNS name and
  tailnet address. When Tailscale Serve already forwards an https name to Mend's port, it offers
  that name as a browser origin too. A name with Funnel on is public: setup says so, offers it with
  No as the answer, and not at all on a fresh install. Setup never changes Tailscale's own settings.
- For a **private network**, setup offers only this machine's private addresses: the tailnet, a LAN
  or VPN address, carrier-grade NAT space. A public address is never one of them. When the machine
  has no private address, setup says so and installs on this machine; reach it through a tunnel or
  Tailscale, or choose public HTTPS.
- For **public HTTPS**, it asks for your domain, then says where the domain resolves from this
  machine and whether something already listens on ports 80 and 443.
- For a private network or public HTTPS, it asks whether VS Code Remote-SSH should reach sessions
  from other machines, and where workspace SSH is published. On a public install it also asks
  whether you checked who can reach that port.
- Whether to turn on the **T3 Code gateway**, whether to keep the **mirrors** as they are, and
  whether the server holds **one organization or several**.

Setup never asks which address to bind: that follows from your answers. Each line that starts with
`Observed:` is something setup looked at on this machine, not a judgment about who can reach it.
Setup ends with what it will do and the same command with flags, and changes nothing until you say
yes:

```text
Setup will install:
  reached          your network, at http://mend-box.tailc79e49.ts.net:3105 (listening on 100.94.101.28)
  exposure         declared private
  workspace SSH    published on 100.94.101.28:2222, beyond this machine
  T3 Code gateway  off
  organizations    one organization (single)
  mirrors          npm on, 10g · Docker Hub on, 20g
  extra origins    https://mend-box.tailc79e49.ts.net:8443
Same as: mend server setup --bind 100.94.101.28 --url http://mend-box.tailc79e49.ts.net:3105 --origin https://mend-box.tailc79e49.ts.net:8443 --exposure private
Apply? [Y/n]
```

Run it again to change something. Setup shows what is saved, then lets you keep it, change one
thing, or go through every question. Turning on the T3 Code gateway on a public install looks like
this:

```text
Currently: public HTTPS at alpha.mend.run, VS Code SSH from other machines on, T3 gateway off.
  …
What would you like to do?
  1. keep it as it is · setup checks this install and starts it again
  2. change something · pick it, answer, done
  3. go through every question
  1-3 [1]: 2

What should change?
  1. how people reach it · the public internet, over HTTPS at alpha.mend.run (the edge, Caddy, on 80 and 443)
  2. VS Code Remote-SSH from other machines · published on 0.0.0.0:2222, beyond this machine
  3. the T3 Code gateway · off
  …
  1-7 [1]: 3
…
Turn on the T3 Code gateway? [y/N] y

Change something else? [y/N]

What changes:
  T3 Code gateway: off → on, at 127.0.0.1:3120
Same as: mend server setup --t3-gateway
Apply? [Y/n]
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

### With flags

Scripts and CI pass flags instead. The `Same as:` line is the flag command for what you answered,
and `mend help server setup` lists every flag. On an existing install, each flag changes only what
it names and setup keeps the rest, so `mend server setup --t3-gateway` turns the gateway on and
leaves everything else as it was. Setup prints `This run changes:` and one line per change before it
applies. `--declare <item>` adds a statement to the saved ones, `--undeclare <item>` takes one back,
and `--declare none` clears them all.

With no terminal and no flags, setup refuses a fresh install instead of guessing how the server is
reached, and names the flags that say it. `mend server setup --yes` takes the defaults: this machine
only, at `http://localhost:3105`.

## Network boundary

Web and SSH bind to localhost by default. Postgres has no published host port, and no image registry
is published. Private access must be configured explicitly: answer "my private network or Tailscale"
to setup's first question, or pass the flags yourself:

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
a TLS edge. Setup runs the edge for you once the first account exists: answer "the public internet,
with HTTPS", or pass the flag:

```sh
mend server setup --edge mend.example.com
```

Caddy then listens on ports 80 and 443 of every interface, obtains and renews a certificate for
`mend.example.com` and proxies to Mend, whose own port stays on loopback. The browser origin becomes
`https://mend.example.com`. For a certificate to be issued, the name's DNS must point at this
machine and both ports must reach it from the Internet. `mend server status` says whether Caddy
holds one. A fresh install refuses `--edge`: until the first account exists, registration is open to
whoever reaches the origin first, so set up on localhost, create the account, then add the edge. The
questions say the same on a fresh install and set up on this machine first.

Setup also takes the posture the server declares, `--exposure loopback|private|public` and
`--tenancy single|multi`, and keeps the edge and the posture across reruns and upgrades. Without the
flags a server it installs runs as `private` and `single`. `public` needs the edge and an existing
first account. Read [Exposure](/operate/exposure/) for the modes, the public exposure gate, and what
Mend observes beside what you declare.

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

Each backup is a full dump under `~/.config/mend/backups/upgrade-UUID/` and can run to gigabytes.
After the new version answers health, the upgrade keeps the newest two completed backups, its own
included, removes older completed ones, and prints each removal with the space it freed:

```text
Removed upgrade backup /home/me/.config/mend/backups/upgrade-3f2c… · 2.4 GiB
Upgrade backups · removed 1 · 2.4 GiB freed · kept 2 (--keep-backups 2)
```

Choose the count with `--keep-backups N`; `--keep-backups 0` keeps every backup. A failed upgrade
removes nothing. A backup that 0.36 or later recorded as pending (its upgrade never saw a healthy
target), or whose dump is incomplete, is always kept and listed; remove it yourself once its
recovery no longer needs it. Directories Mend did not write are left alone.

Backups written by releases before 0.36 carry no outcome. The first upgrade on 0.36 or later treats
each one whose dump is whole as completed and keeps only the newest N, including the backup of an
old upgrade that failed after its target started. Copy any you want to keep out of
`~/.config/mend/backups/` first. Their removals end in `· from before 0.36, no recorded outcome`.

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
