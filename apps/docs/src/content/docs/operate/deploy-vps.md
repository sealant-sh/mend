---
title: Deploy on a VPS
description: Run Mend on a remote server and connect from your devices.
sidebar:
  order: 1
---

A VPS or home server uses the same [Docker installation](/getting-started/install/) as your own
machine. Run setup on the server over ordinary host SSH. It runs the Mend application (web, API and
its pinned Sealant runtime), an official Postgres, Garage (the bucket that holds every session's
captured work), and two caches that sessions download through: an [npm mirror](/operate/npm-mirror/)
and a [Docker mirror](/operate/docker-mirror/). You do not install or choose a Sealant version
separately.

## Decide how the server is reached

Mend asks the operator to state how an instance is reached, in `MEND_EXPOSURE`: `loopback` (this
machine only), `private` (a network you control admission to, such as a tailnet, a LAN or a VPN) or
`public`. The default is `private`. `mend server setup --exposure <value>` declares it and keeps it
across reruns and upgrades. Put the server on a private network such as Tailscale before you bind it
to anything but localhost.

`public` refuses to start while an item of the public exposure gate that the server can observe is
open. `mend operator exposure` prints each item, marked `observed`, `carried`, `declared` or `open`.
`mend server setup --edge <host>` runs a Caddy TLS edge in front of Mend, from the repository's
`deploy/docker/compose.edge.yaml` and `Caddyfile`, and keeps it across upgrades. Read
[Exposure and budgets](/operate/exposure/) before exposing a server beyond a private network.

## Set up the server

On the server, in a terminal over ordinary SSH:

```sh
npm install --global @sealant/mend
mend server setup
```

Setup asks how people reach the server. For a server your devices reach over a tailnet, a LAN or a
VPN, answer "my private network or Tailscale". When Tailscale runs on the server, setup offers its
MagicDNS name and tailnet address, so Mend is published on the tailnet only. Setup never offers a
public address as a private network: on a VPS whose only address is public, it says so and installs
on this machine, so join the VPS to a tailnet, use a tunnel, or choose public HTTPS. A fresh install
refuses `--bind` on a public address for the same reason as `--edge` below. Setup ends with the same
command with flags. A script passes the flags itself:

```sh
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

Postgres, Garage and the mirrors publish no host port, and no image registry is published. Workspace
images are built and launched in the host Docker Engine through the mounted daemon socket.
Workspaces work on their own disk and capture their work to the bucket; nothing from the host is
bind-mounted into them.

### Behind a TLS edge

For a server reached from the Internet, let setup run the edge instead of binding Mend's port beyond
loopback. The order matters: until the first account exists, registration is open to whoever reaches
the origin first, so the account is created on localhost before anything is published. Run setup on
the server and answer "just this machine" (a script runs `mend server setup --yes`). Then create the
account over an SSH tunnel from your laptop:

```sh
mend server setup                                  # on the server: answer "just this machine"
ssh -L 3105:127.0.0.1:3105 your-vps                # on your laptop, then open http://localhost:3105
```

With the account created, run `mend server setup` again, choose "change something", then "how people
reach it", then "the public internet, with HTTPS". Setup asks for the domain, says where it resolves
from the server and whether ports 80 and 443 are free, and asks whether VS Code Remote-SSH should
reach sessions from other machines. The flags for the edge alone:

```sh
mend server setup --edge mend.example.com
```

Caddy obtains the certificate and proxies to Mend, whose own port stays on loopback. The origin is
now `https://mend.example.com`, and `mend login --url https://mend.example.com` signs the laptop in.
The questions also declare the posture as `public`. With flags, declare it yourself:

```sh
mend server setup --exposure public
mend server setup --exposure public --tenancy multi   # for more than one organization
```

Setup refuses `--edge` and `--exposure public` on a fresh install for the reason above, and the
server refuses `public` without an operator account. `mend server status` shows the edge, the
certificate as Caddy's data shows it, and the declared exposure and tenancy beside what the running
server reports. Workspace SSH on port 2222 stays on loopback with the edge.

Each workspace runs its own rootless Docker, which needs unprivileged user namespaces. Ubuntu 23.10
and later (24.04 LTS included) refuse them by default, and then no session can start.
`mend server setup` reads the kernel before its other questions and before it pulls the release (its
probe pulls only the few megabytes of busybox every install needs anyway), and asks:

```text
Sessions cannot start on this host yet: Ubuntu blocks the unprivileged user namespaces each workspace's Docker service needs.
Allowing them writes kernel.apparmor_restrict_unprivileged_userns = 0 to /etc/sysctl.d/60-mend-rootless-docker.conf on the Docker host and applies it now. It lifts that restriction for the whole host, not only for Mend.
Allow them now? [Y/n]
```

On a yes it applies the setting through the Docker socket it already uses and reads the kernel
again. The file it writes starts with `# written by mend server setup; mend uninstall removes it`,
followed by the setting it replaced (`# previous: …`), so `mend uninstall` can remove it and put the
kernel back. `--allow-userns` and `--no-allow-userns` answer for a script. With `--yes` and neither,
setup changes nothing and says to re-run it with `--allow-userns`, so that it writes the file and
`mend uninstall` can undo it. On a no, setup prints the command, and `mend doctor` shows it as
`workspaces`. To allow them yourself, on the server (a file written by hand has no marker, so
`mend uninstall` leaves it):

```sh
echo 'kernel.apparmor_restrict_unprivileged_userns = 0' | sudo tee /etc/sysctl.d/60-mend-rootless-docker.conf
sudo sysctl --system
```

When a later `mend server setup` changes Mend's URL (from `localhost` to a private address, say), it
offers to point this machine's CLI at the new URL; the sign-in carries over. Every other CLI signed
in at the old URL (another account on this machine, another machine) signs in again with
`mend login --url <new>`, which asks for a new browser authorization.

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
sent to the server and not kept on the laptop, so your own Claude login there stays as it is. It
uses the Claude CLI on that machine. Claude rotates its refresh token, so two copies of one login
sign each other out; `--use-my-login` sends the login this machine already uses instead, and both
sides then share one grant. Run `mend connect claude` again when Mend says the login needs
reconnecting.

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

Before you restart or upgrade Docker itself (`systemctl restart docker`, an `apt upgrade` of
docker-ce), run `mend doctor` on the server. A Docker stop waits for each container's own stop
timeout, and systemd kills `docker.service` after 90 s; anything still running then makes Docker's
next start wait for it. Workspaces stop within 60 s, which fits. The `docker` line names a running
container that would not, such as a workspace started by a server older than 0.36: stop its session
first. A host reboot is not affected.

When something misbehaves, `mend doctor --bundle` writes one redacted archive for a bug report: the
CLI and its environment, the local server's configuration (the names of its `.env` keys, never their
values), container logs, and every session with its processes and recorded output. Read it before
you share it. See [Troubleshooting](/operate/troubleshooting/).

`mend uninstall --server` removes the local installation: its live sessions' workspaces, its
containers, every volume and network it owns (repositories, captures, the database), its release
image and its private configuration. It prints the plan and asks you to type `delete` first.
`mend uninstall --all` also removes Mend's images and, when setup wrote it,
`/etc/sysctl.d/60-mend-rootless-docker.conf`, putting back the setting it replaced.

### Server defaults

A server installed by `mend server setup` runs with these defaults:

- `MEND_TENANCY=single`: one organization. The operator role administers the instance and has no
  default read access to organization content. `mend server setup --tenancy multi` declares many,
  and sets `MEND_SOURCE_POLICY=tenant` and `MEND_CAPTURE_REQUIRE_SIZES=true` with it. `multi`
  refuses to start until every item of the multi mode gate passes; `mend operator gate` lists them.
- Budgets on at their default sizes. A budget bounds what a client, an account or an organization
  may ask; it refuses new work and never stops running work. Setup does not expose them as options.
- Database pool caps of 6 connections for Mend's queries (`MEND_DATABASE_POOL_MAX`), 3 for the job
  queue (`MEND_JOBS_POOL_MAX`) and 3 for sign-in sessions (`MEND_AUTH_DATABASE_POOL_MAX`), plus one
  for `LISTEN`. When Mend and Sealant share one Postgres, both sets of pools must fit under its
  `max_connections`.

Changing the rest means running the Compose files yourself or deploying on
[Kubernetes](/operate/deploy-kubernetes/). [Server environment](/reference/server-environment/)
lists every variable.

Back up private configuration and Docker volumes as well. Read the
[self-hosting and recovery guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md)
before planned maintenance. [Kubernetes](/operate/deploy-kubernetes/) remains an operator-managed
alternative, not a mode of this setup command.
