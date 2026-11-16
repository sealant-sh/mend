---
title: Install Mend
description: Install the CLI, then set up a Mend server by answering a few questions.
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
- Disk space for repositories, session captures, images, databases, and backups. The two mirrors
  setup runs beside Mend take up to 30 GiB more by default (npm 10g, Docker Hub 20g), and each
  leaves 5 GiB free on its disk.
- For access from another device, a network path you choose: a private network you control admission
  to, or a TLS edge in front of Mend. Read [Exposure](/operate/exposure/).

Docker Desktop and OrbStack must pass the same capability checks as Docker Engine. On a machine with
more than one Docker engine (Docker Desktop and OrbStack on one Mac), `--context <name>` (or
`DOCKER_CONTEXT`) picks the engine; without either, a fresh install on a terminal asks which one,
and an existing install stays on the context its data is on. For a Mac mini serving laptops, read
[Mac mini and VS Code](/operate/mac-mini-vscode/). Physical macOS and installed VS Code acceptance
are recorded separately in the
[validation checklist](https://github.com/sealant-sh/mend/blob/main/docs/MACOS-VALIDATION.md). Linux
checks are not evidence that MacBook-to-Mac-Mini operation has been verified.

## Install only the CLI

```sh
npm install --global @sealant/mend
```

This installs only the CLI. It does not install Docker, create a server, or start a service. To try
the next release before it ships, read [Try a preview](/getting-started/try-a-preview/). On NixOS or
with home-manager, add the CLI from Mend's flake instead. Read
[Install Mend with Nix](/operate/nix/).

## Set up the server

On the server machine, in a terminal:

```sh
mend server setup
```

Setup asks a few questions, one at a time, and says in a line what each choice means. Enter takes
the answer in brackets.

- **Which Docker should Mend run in?** Asked first, and only when more than one Docker engine on
  this machine answers: Docker Desktop beside OrbStack, colima, Rancher Desktop, a rootless Docker.
  Each choice says what it is, its socket, and whether a Mend server or Mend's volumes are already
  there; the current Docker context is the answer in brackets. With one engine, setup says which one
  it uses and asks nothing. A context on another machine (SSH or TCP) is listed, not offered: Mend
  runs in a Docker engine on this machine. `--context <name>` or `DOCKER_CONTEXT` answers it for
  you.
- **Allow user namespaces?** Asked next, only on a Docker host whose kernel refuses unprivileged
  user namespaces (Ubuntu 23.10 and later, 24.04 LTS included), where no session can start:
  `Allow them now? [Y/n]`. A yes writes `/etc/sysctl.d/60-mend-rootless-docker.conf`, marked so
  `mend uninstall --all` removes it again; `--allow-userns` answers for a script. See
  [Every session fails to launch on Ubuntu](/operate/troubleshooting/#every-session-fails-to-launch-on-ubuntu).
- **How will people reach this Mend?** Just this machine, your private network or Tailscale, or the
  public internet with HTTPS.
- For **Tailscale**, setup reads `tailscale status` and offers this machine's MagicDNS name and
  tailnet address. When Tailscale Serve already forwards an https name to Mend's port, it offers
  that name as a browser origin too. A name with Funnel on is public: setup says so, offers it with
  No as the answer, and not at all on a fresh install. Setup never changes Tailscale's own settings.
- For a **private network**, setup offers only this machine's private addresses: the tailnet, a LAN
  or VPN address, carrier-grade NAT space. A public address is never one of them. When the machine
  has no private address, setup says so and installs on this machine; join it to a tailnet, or
  choose public HTTPS.
- For **public HTTPS**, it asks for your domain, then says where the domain resolves from this
  machine and whether something already listens on ports 80 and 443. When the domain does not
  resolve from this machine, Enter at `Apply?` changes nothing, and setup says why.
- For a private network or public HTTPS, it asks whether VS Code Remote-SSH should reach sessions
  from other machines, and where workspace SSH is published. On a public install it also asks
  whether you checked who can reach that port.
- Whether to turn on the **T3 Code gateway**, whether to keep the **mirrors** as they are, and
  whether the server holds **one organization or several**.

Setup never asks which address to bind: that follows from your answers. Each line that starts with
`Observed:` is something setup looked at on this machine, not a judgment about who can reach it.
Before anything is pulled, setup checks that Mend's web and SSH ports are free where they are to be
published. When one is taken it says what holds it (`another Mend, 0.27.4, answers there`, or
something else) and offers the next free port. Setup ends with what it will do and the same command
with flags, and changes nothing until you say yes:

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

On a Mac with both Docker Desktop and OrbStack, the engine question looks like this:

```text
Mend's server, its data and every session's workspace live in the Docker engine you choose, and stay there: another engine later means a new install.

Which Docker should Mend run in?
  1. desktop-linux (the current context) · Docker Desktop · socket /Users/you/.docker/run/docker.sock · nothing of Mend's here yet
  2. orbstack · OrbStack · socket /Users/you/.orbstack/run/docker.sock · nothing of Mend's here yet
  1 or 2 [1]: 2
```

Pick the engine you keep running on that Mac: Mend's own Mac runs used OrbStack, and Docker Desktop
works when it starts at sign-in ([Mac mini guide](/operate/mac-mini-vscode/)). Your choice goes into
the command setup prints (`--context orbstack`), and `mend doctor` and `mend uninstall` use the same
context from then on.

Run it again to change something. Setup shows what is saved, then lets you keep it, change one
thing, or go through every question. It keeps the Docker engine it was installed in and says so:
moving to another engine is a new install, `mend uninstall --server` and then `mend server setup`
there. Turning on the T3 Code gateway on a public install looks like this:

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

The T3 Code gateway lets T3 Code's desktop, mobile and web apps pair with this Mend: in T3 Code, add a Remote link with its address and a code from mend pair. T3 Code's SSH mode is not for Mend: it starts T3 Code's own server on this machine.
Behind the edge, its port stays on 127.0.0.1:3120, as Mend's own does; the edge can serve it on a host of its own.
Turn on the T3 Code gateway? [y/N] y

T3 Code always uses a server's root path, so the edge cannot serve the gateway under alpha.mend.run. Serve it on a host of its own?
  1. yes, on a host of its own · such as t3.alpha.mend.run, whose DNS points here as alpha.mend.run's does; Caddy gets its certificate
  2. no, not through the edge · it stays on 127.0.0.1:3120: this machine, or a tailnet through Tailscale Serve
  1 or 2 [2]: 1
The gateway's host [t3.alpha.mend.run]:
Observed: t3.alpha.mend.run resolves to 203.0.113.7, as alpha.mend.run does.

Change something else? [y/N]

What changes:
  T3 Code gateway: off → on, at https://t3.alpha.mend.run through the edge (its port on 127.0.0.1:3120)
Same as: mend server setup --t3-gateway-origin t3.alpha.mend.run
Apply? [Y/n]
```

On a private install the same question says where T3 Code reaches the gateway: on the address Mend's
web port is published on, such as `http://mend-box.tail1234.ts.net:3120` over Tailscale, with no
tunnel.

At idle, five product containers run:

- The complete Mend application, including its pinned Sealant API/worker/SSH runtime. Sealant's job
  queue runs in Postgres; workspace images are built and launched in the host Docker Engine through
  the mounted daemon socket.
- Official Postgres, with separate Mend and Sealant databases and users.
- Garage, an S3-compatible object store that holds every session's captures: the worktree files and
  harness state that workspaces upload as they work.
- The [npm mirror](/operate/npm-mirror/) and the [Docker mirror](/operate/docker-mirror/), caches
  that sessions download packages and Docker Hub images through. Neither publishes a host port;
  `--no-npm-mirror` and `--no-docker-mirror` turn them off.

With `--edge`, a sixth runs: Caddy, the TLS edge.

You manage the Mend version. There is no separate Sealant installation or version choice for this
Docker setup. Session workspaces may create additional containers. Repositories, session captures,
database data, and SSH identity persist in Docker-managed volumes.

### With flags

Scripts and CI pass flags instead. The `Same as:` line is the flag command for what you answered,
and `mend help server setup` lists every flag. On an existing install, each flag changes only what
it names and setup keeps the rest, so `mend server setup --t3-gateway` turns the gateway on and
leaves everything else as it was. Setup prints `This run changes:` and one line per change before it
applies. `--declare <item>` adds a statement to the saved ones, `--undeclare <item>` takes one back,
and `--declare none` clears them all. A rerun with `--port` moves a saved plain-http `--url` that
names the old port to the new one; an `https` URL, or one whose port is implicit, stays as it was. A
web or SSH port that something else holds is refused with flags, naming `--port` or `--ssh-port`.
After starting, setup waits for health from the server it started, by version and instance id, so
another Mend answering on the same port is said as one.

With no terminal and no flags, setup refuses a fresh install instead of guessing how the server is
reached, and names the flags that say it. `mend server setup --yes` takes the defaults: this machine
only, at `http://localhost:3105`.

## How people reach the server

Setup decides two things, and its flags keep them apart:

- `--bind` is where Mend listens on the server. It decides who can connect at all.
- `--url` is the address people type. Browsers, `mend login`, pairing and every link Mend sends use
  it. Mend does not listen on it. Something has to lead from that address to where Mend listens: the
  network itself, Mend's edge, or HTTPS you run.

Setup's first question, "How will people reach this Mend?", sets both for you. The flags are for
scripts, and for HTTPS you run yourself, which the questions don't offer yet.

### Where Mend listens

| `--bind`                                              | Who can connect                                                                               |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `127.0.0.1`, the default                              | Programs on the server itself, a proxy running there included                                 |
| A tailnet, LAN or VPN address, such as `100.70.80.90` | Every device on that network                                                                  |
| `0.0.0.0`                                             | Every network the server is on. On a server with a public address, that is the whole internet |

Setup never configures a firewall. A fresh install refuses a public address for `--bind`.

### Mend's ports

| Port   | What uses it                                                 | Where it listens                         |
| ------ | ------------------------------------------------------------ | ---------------------------------------- |
| `3105` | The web app and API: browsers, the `mend` CLI, the phone app | `--bind`                                 |
| `2222` | Workspace SSH: `mend ssh` and VS Code Remote-SSH             | `--ssh-bind`, which defaults to `--bind` |
| `3120` | The [T3 Code gateway](/integrations/t3code/), when it is on  | `--bind`, or `127.0.0.1` behind the edge |

Postgres, Garage and the mirrors publish no port. `--port` and `--ssh-port` move the first two.

So `--bind 127.0.0.1` keeps all three ports on the server. Whatever leads people to `--url` reaches
the web port only, unless you give the other two a way in as well.

### Four ways to set it up

| Setup                     | Flags                                            |
| ------------------------- | ------------------------------------------------ |
| Just this machine         | `--yes`                                          |
| Your network or Tailscale | `--bind 100.70.80.90 --url http://mend-box:3105` |
| Mend's edge               | `--edge mend.example.com`                        |
| HTTPS you run             | `--url https://mend.example.com`                 |

#### Just this machine

Everything stays on `127.0.0.1`. Use it when the server and the person using it share a machine, or
reach it over an SSH tunnel: `ssh -L 3105:127.0.0.1:3105 your-server`, then open
`http://localhost:3105`.

- The web app: `http://localhost:3105`, on the server.
- Workspace SSH: `127.0.0.1:2222`, on the server.
- T3 Code: `http://127.0.0.1:3120`, on the server.

#### Your network or Tailscale

All three ports listen on the server's address on that network, so every device on it reaches all
three with no tunnel. Answer "my private network or Tailscale", or pass the flags:

```sh
mend server setup --bind 100.70.80.90 --url http://mend-box:3105 \
  --origin http://localhost:3105
```

Use the server's private address and a name your devices resolve. `--origin` adds another exact
browser origin, here localhost on the server itself. Mend's URL and its origins decide sign-in,
CORS, WebSockets, pairing and the links Mend sends. Forwarded headers and the addresses Mend finds
on the machine never add to them. Plain HTTP doesn't protect sign-ins from others on the same
network, so prefer an encrypted network such as a tailnet.

- The web app: `http://mend-box:3105`.
- Workspace SSH: `mend-box:2222`.
- T3 Code: `http://mend-box:3120`.

#### Mend's edge

Mend runs Caddy for you. Caddy listens on ports 80 and 443 of every interface, gets and renews a
certificate for your domain, and forwards to Mend on `127.0.0.1`. The domain's DNS must point at the
server, and both ports must reach it from the internet. Answer "the public internet, with HTTPS", or
pass the flag:

```sh
mend server setup --edge mend.example.com
```

A fresh install refuses `--edge`, because until the first account exists anyone who reaches the
domain can create it. Set up on this machine first, create the account over an SSH tunnel, then add
the edge ([deploy on a VPS](/operate/deploy-vps/#behind-a-tls-edge) shows the order). The edge
serves T3 Code only on a name of its own (`--t3-gateway-origin t3.mend.example.com`), and it never
carries workspace SSH.

- The web app: `https://mend.example.com`.
- Workspace SSH: `127.0.0.1:2222` on the server, unless you publish it with `--ssh-bind <address>`.
- T3 Code: `https://t3.mend.example.com` with `--t3-gateway-origin t3.mend.example.com`, otherwise
  `http://127.0.0.1:3120` on the server.

#### HTTPS you run

You run the proxy yourself on the server, such as nginx, Caddy or a Cloudflare Tunnel. It holds the
certificate and forwards to Mend's port on `127.0.0.1`:

```sh
mend server setup --url https://mend.example.com
```

Point the proxy at `http://127.0.0.1:3105`, and pass WebSockets through. The full list of what it
must do is in [your own reverse proxy](/operate/exposure/#your-own-reverse-proxy). Until the first
account exists, anyone who reaches the URL can create it, so create yours soon after setup.
Tailscale Serve is the same setup: `tailscale serve --bg --https=443 http://127.0.0.1:3105`, with
`--url https://<this machine>.<tailnet>.ts.net`.

- The web app: `https://mend.example.com`, through your proxy.
- Workspace SSH: `127.0.0.1:2222` on the server, until you give it a way in.
- T3 Code: `http://127.0.0.1:3120` on the server, until you give it a way in.

Your proxy reaches the web port only. For the other two:

- **T3 Code.** Forward a name of its own, such as `https://t3.mend.example.com`, to
  `http://127.0.0.1:3120`, and use it as the Remote link in T3 Code. It can't go under a path of
  Mend's URL, because T3 Code always uses a server's root path. A port of its own
  (`https://mend.example.com:3120`) works too, but it has to be open in the firewall, and
  Cloudflare's proxy doesn't carry port 3120. With Tailscale Serve, use the port:
  `tailscale serve --bg --https=3120 http://127.0.0.1:3120`.
- **Workspace SSH.** An HTTPS proxy can't carry SSH. To use `mend ssh` or VS Code Remote-SSH from
  other devices, publish it on a private network with `--ssh-bind <tailnet or LAN address>`, or
  carry it with `cloudflared access ssh` through a Cloudflare Tunnel.

Inside Docker, every request from your proxy comes from the Docker bridge's address, so Mend counts
every client in one address budget. A team that runs into it raises the budgets
([budgets](/operate/exposure/#budgets)).

### Exposure

Setup also records how the server is reached, `--exposure loopback|private|public`, and how many
organizations it holds, `--tenancy single|multi`. Both stay across reruns and upgrades. A server
setup installs runs as `private` and `single` unless you say otherwise. `public` needs the edge and
an existing first account. [Exposure](/operate/exposure/) explains the modes, the public exposure
gate, and what Mend checks beside what you declare.

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
shares the printed one-time `/join#<token>` link; whoever opens it joins the organization, with a
new account or, when signed in, the one they have. Read [Organizations](/organizations/overview/).

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

Stop stops the installation's containers (Mend, Postgres, Garage, the mirrors, and the edge when
there is one) without deleting volumes. Restart restarts Mend and keeps the others running. These
operations interrupt connections; workspace containers remain.

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

[Backup and recovery](/operate/backup-and-recovery/) covers offline assets, ownership conflicts,
locks, and upgrade recovery. The retired host installer is not an automatic migration path into this
volume-backed deployment.

## Uninstall

```sh
mend uninstall
```

Choose everything, the server only, or this machine's files only (`--all`, `--server`, `--home`).
While another server command holds the server lock, uninstall refuses with the lock's words. The
plan is printed before anything is removed; taking the server down deletes its volumes
(repositories, the `mend-garage` session captures, the database) and asks for the word `delete`.
Data volumes go only when they carry this installation's identity label. Live sessions are listed in
the plan; uninstall stops their workspaces and removes them with their volumes and networks. If
Docker is stopped, nothing is removed.

In `~/.ssh/config`, uninstall removes only the blocks `mend ssh setup` wrote for the server it
removes and the one this machine is signed in to. Other servers' blocks stay. So does the unscoped
`Host mend-ws` block an older release wrote, because nothing in it says which server it is for:
uninstall names it and how to delete it by hand.

If Docker refuses to remove something, uninstall names it, writes it to `uninstall-left.json`, and
keeps the `mend-store` volume and the identity, so running `mend uninstall` again finishes the job,
and `mend server setup` can reinstall over it. Everything also offers Mend's images (the metadata
guard's busybox among them), the user-namespace sysctl file setup wrote, and, in its own question,
Docker's build cache. When an uninstall stops before those, it says each one was "not reached", and
the next run removes them. The CLI stays until `npm uninstall -g @sealant/mend`.

## Next steps

1. [Connect provider accounts](/guides/provider-accounts/).
2. [Adopt a project](/getting-started/adopt-project/).
3. [Configure its session environment](/guides/project-environment/).
4. [Start a session](/getting-started/first-session/).
