---
title: Mac mini and VS Code
description:
  Run Mend on a Mac mini and use it from VS Code on a laptop, over a LAN, a tailnet or an https
  edge.
sidebar:
  order: 2
---

This guide sets up one shape end to end: the Mend server on a Mac mini, installed with
`mend server setup`, and VS Code with the Mend extension on a MacBook. The MacBook reaches the mini
over the same LAN, a private network such as a tailnet, or the public internet through an https
edge. From VS Code you sign in, see projects and sessions as they change, open a session's terminal
and type in it, start sessions, review changes, and open a session's workspace over Remote-SSH.

What runs where:

| Machine  | Runs                                                                                    |
| -------- | --------------------------------------------------------------------------------------- |
| Mac mini | Docker Desktop or OrbStack, and in it Mend, Postgres, Garage and the session workspaces |
| MacBook  | VS Code, the Mend extension, Microsoft's Remote - SSH extension, `ssh`                  |

Two ports matter: the web and API port (`3105` by default) and the workspace SSH gateway (`2222` by
default). The extension uses the first for everything except Remote-SSH, which uses the second.

## 1. Prepare the Mac mini

- Install [Docker Desktop](https://docs.docker.com/desktop/setup/install/mac-install/) or
  [OrbStack](https://orbstack.dev). Apple silicon runs Mend's `arm64` images natively: Mend,
  Postgres, Garage and every workspace, whichever OS family it is built on, Arch Linux included.
- Docker Desktop is an app that runs when a person is logged in. For a server, turn on **Start
  Docker Desktop when you sign in** (Settings → General) and automatic login for the mini's user
  (System Settings → Users & Groups). After a power cut, Mend comes back when Docker does.
- Keep the mini awake: System Settings → Energy → **Prevent automatic sleeping when the display is
  off**, or `sudo pmset -a sleep 0 disksleep 0`. While a Mac sleeps, OrbStack and Docker Desktop
  pause their VM. That includes a MacBook's lid-closed Maintenance Sleep, which wakes only briefly
  for network traffic. Builds stall, every session's connection drops, and the VM's clock wakes up
  behind (by hours, after a long sleep) until OrbStack or Docker Desktop restarts. The extension
  says `Mend at … did not answer within 30 s` and the view reconnects once it answers. Turn on
  **Wake for network access** in the same pane too (`sudo pmset -a womp 1`), so a laptop on the
  tailnet can wake it. `mend doctor` on the mini says when it still sleeps on its own, and when the
  server's clock is off from the machine running doctor.
- Give the Docker VM room for workspaces: Settings → Resources, at least 8 GB of memory.
- Keep `~/.config/mend` under your home directory. Setup bind-mounts a file from it into Postgres,
  and Docker Desktop shares only `/Users` (and a few system paths) with its VM by default. A
  configuration directory elsewhere fails setup with
  `bind source path does not exist: …/generations/gen-…/postgres-init.sh`; add the path under
  Settings → Resources → File sharing, or leave `XDG_CONFIG_HOME` unset.
- Install Node.js 22.13 or newer (the TUI, the dashboard `mend` opens in a terminal, needs 26 or
  newer), then the CLI: `npm install --global @sealant/mend`.

## 2. Choose how the laptop reaches the mini

| Path                          | URL the laptop uses               | Encrypted            | Setup flags                                                                            |
| ----------------------------- | --------------------------------- | -------------------- | -------------------------------------------------------------------------------------- |
| Same LAN                      | `http://mac-mini.local:3105`      | no                   | `--bind 0.0.0.0 --url http://mac-mini.local:3105`                                      |
| Tailnet (Tailscale)           | `http://mac-mini:3105` (MagicDNS) | yes, by the tailnet  | `--bind 0.0.0.0 --url http://mac-mini:3105`                                            |
| Public, through an https edge | `https://mend.example.com`        | yes, TLS at the edge | `--edge mend.example.com --ssh-bind 0.0.0.0 --exposure public --declare workspace-ssh` |

The exposure you declare is `private` for the first two (the default, a network whose admission you
control) and `public` for the third. Mend reports what it observes beside what you declared; it does
not decide whether the mini is fit to expose. Read [Exposure](/operate/exposure/).

Plain `http://` on a LAN sends the token and everything you type across that network unencrypted.
Prefer a tailnet. The extension says so before you sign in to a plain-http server on another
machine.

Whatever you choose, the laptop must use **exactly** the URL given to `--url`, or one named with
`--origin`. The browser's sign-in approval is a request from that origin; any other name for the
same machine (an IP instead of `mac-mini.local`, the MagicDNS name instead of the tailnet IP) is
refused: the API answers `403 Origin not allowed`. Name every alternative with `--origin`:

```sh
mend server setup --bind 0.0.0.0 --url http://mac-mini:3105 \
  --origin http://mac-mini.local:3105 --origin http://localhost:3105
```

### Binding to one address

`--bind` takes a literal address. `0.0.0.0` publishes on every interface of the mini and leaves
admission to the network and the macOS firewall. A specific address (the mini's tailnet IP,
`100.x.y.z`) publishes there alone, but Docker cannot publish on an address that is not up when the
container starts: if Tailscale connects after Docker Desktop, Mend fails to start with
`cannot assign requested address`. Use `0.0.0.0` with the tailnet's access rules, or start Tailscale
at login before Docker.

### Behind an https edge

`--edge <host>` runs Caddy on ports 80 and 443 and keeps Mend's own port on loopback. The edge
carries HTTPS only, so workspace SSH needs its own publish: `--ssh-bind 0.0.0.0` (or a private
address). Without it, Remote-SSH from the laptop cannot connect. SSH published beside a public edge
is an item of the [exposure gate](/operate/exposure/), `workspace-ssh`: Mend cannot see who reaches
the port, so with `--exposure public` setup asks you to state it with `--declare workspace-ssh`,
once you have tried the port from each network that should not reach it. The gateway admits
registered keys only, and a workspace only for its launcher.

Before login, the gateway holds each connection to limits modelled on sshd's. A connection has 60 s
to log in and 6 attempts. One source may have 10 connections not yet logged in, and may make 60
lookups a minute of keys nobody holds. A source is an IPv4 address or an IPv6 /64, as the gateway
sees it. Rootful Docker keeps each client's own address for IPv4; rootless Docker, Docker Desktop
and docker-proxy for IPv6 clients hide it, and every client then shares one source's limits.
Removing a key in Settings → Workspace SSH or with `mend ssh keys remove` ends the connections
opened with it within a minute.

The DNS name must point at the mini, and 80 and 443 must reach it from the internet (port forwarding
on the router). A fresh install refuses `--edge`: set up on localhost, create the first account,
then add the edge:

```sh
mend server setup                                   # http://localhost:3105, loopback only
# open http://localhost:3105 on the mini and create the first account
mend server setup --edge mend.example.com --ssh-bind 0.0.0.0 --exposure public --declare workspace-ssh
```

From a LAN or tailnet install (`--bind 0.0.0.0`), say both that the web port goes back to loopback
and where the origin now is; setup keeps every flag you leave out, and refuses an edge beside a
non-loopback `--bind`:

```sh
mend server setup --bind 127.0.0.1 --url https://mend.example.com --edge mend.example.com \
  --ssh-bind 0.0.0.0 --exposure public --declare workspace-ssh
```

`--origin` replaces the saved list of alternate origins when you give it, so name every one you want
to keep.

## 3. Install the server

On the mini, for the tailnet path:

```sh
mend server setup --bind 0.0.0.0 --url http://mac-mini:3105
```

Setup picks the Docker context (OrbStack's `orbstack` or Docker Desktop's `desktop-linux`), mounts
the daemon-side socket `/var/run/docker.sock` into Mend (not the client's
`~/.docker/run/docker.sock`), and waits until Mend answers at the URL. From the acceptance run
(Linux, the server in its own Docker daemon, the URL a tailnet address; on the mini the context is
`orbstack` or `desktop-linux`):

```text
Using Docker context "st-vscode-dind" (unix:///home/…/dind-run/docker.sock)
Starting Mend 0.36.0-next.656 containers; Docker waits up to 120s for them to report healthy
Capture store bucket mend is laid out in Garage
Mend 0.36.0-next.656 is reachable at http://100.101.141.6:34131
Open http://100.101.141.6:34131, create the first account, then run: mend login --url http://100.101.141.6:34131
```

Quitting Docker Desktop or OrbStack with a live session stops its workspace within 60 s. What the
workspace had not saved stays on its disk and is recovered once the server is back.

Open the URL on the mini and create the first account before anyone else can reach it: registration
is open until then, and closes after it.

### The firewall

With the macOS firewall on (System Settings → Network → Firewall), the first published port asks
whether Docker (`com.docker.backend`, or OrbStack) may accept incoming connections. Allow it. With
**Block all incoming connections** set, nothing reaches Mend from the laptop.

From the laptop, both ports must answer:

```sh
curl -s http://mac-mini:3105/api/health    # {"status":"ok",…}
nc -vz mac-mini 2222                        # succeeded
```

## 4. Install the extension on the laptop

Install Microsoft's **Remote - SSH** extension, then **Mend by Sealant** (`sealant-sh.mend`) from
the Extensions view (see [VS Code extension](/clients/vscode/#install)). Run **Mend: Connect to
server** and enter the URL exactly as setup was given it. Choose **Sign in with the browser**. VS
Code shows a code; the browser opens `http://mac-mini:3105/authorize`, signed in as you. Approve
when it shows the same code. The extension keeps its token in VS Code's secret storage (encrypted in
VS Code's own storage, with the key in the macOS Keychain), and lists itself under Settings →
Devices as `VS Code on <laptop>`.

If you already ran `mend login --url http://mac-mini:3105` on the laptop, the extension uses that
sign-in and there is nothing to do.

The Mend view now lists your projects and sessions. It follows the server's event stream: a session
started from the phone or a terminal appears without a refresh.

## 5. Work

- **Start a session**: **+** in the view, then **Workbench** or an agent. VS Code opens the new
  session's workspace.
- **The session's terminal**: **Mend: Open terminal** on a live session. It uses the web port, not
  SSH, so it works on every path above.
- **Review**: **Mend: Review change** opens the change in Mend's review in your browser.
- **The workspace in VS Code**: opening a session asks once to **Set up workspace SSH**. Setup
  registers a key and writes one block at the start of `~/.ssh/config`:

  ```text
  # >>> mend workspace ssh mend-ws-100-101-141-6-dd87a7898d5b5466eab01a1b (managed) >>>
  Host mend-ws-100-101-141-6-dd87a7898d5b5466eab01a1b
    HostName 100.101.141.6
    Port 37925
    HostKeyAlias mend-ws-100-101-141-6-dd87a7898d5b5466eab01a1b
    IdentityFile "/home/…/.config/mend/ssh/id_ed25519"
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
  Host *
  # <<< mend workspace ssh mend-ws-100-101-141-6-dd87a7898d5b5466eab01a1b <<<
  ```

  That is the block the acceptance run's setup wrote; on the laptop the key is
  `/Users/<you>/.config/mend/ssh/id_ed25519`. The host name is the one in your Mend URL; the server
  supplies the port. Remote-SSH then connects as `ws-<workspace id>@mend-ws-…`, and VS Code opens
  `/workspace/repo` inside the workspace, a Linux container on the mini. The workspace id is not the
  container's name; `mend ssh <session>` prints the exact command for one session.

The key is a dedicated `~/.config/mend/ssh/id_ed25519`, or a key from your SSH agent when one is
loaded at setup. The gateway's host key is accepted on first connection
(`StrictHostKeyChecking accept-new`, under the alias in `known_hosts`) and refused if it changes. It
lives in a Docker volume on the mini, so reinstalling Docker or removing Mend's volumes changes it.

With per-person workspaces (the default), each person's processes run as their own Linux user, and
Remote-SSH opens a workspace only for the person who launched it: whoever's session started the
running workspace, which is not always the owner of the session you open. A session started in a
worktree where another person's session already runs joins their workspace, so it is theirs to open
over Remote-SSH, your own session included, and starting another session there does not change that.
To open the workspace yourself, launch it: once the running workspace stops, whoever launches the
next one opens that one. The extension says so before Remote-SSH would refuse you. It also offers
the session's terminal when the server would let you in: always for your own session, and for
someone else's only while its owner has shared control on, read-only. The Remote-SSH login is the
launcher's own Linux user (`m` and 8 characters), on their home and logins, so an agent they start
in its terminal runs as them. A server whose Sealant cannot bind the person (an older Core) logs in
as root instead, and the session line says `Remote-SSH: root, Core can't bind your person`.

## Troubleshooting

| What you see                                                                           | Why, and what to do                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cannot reach Mend at http://mac-mini:3105. connect ECONNREFUSED …`                    | Nothing listens there: setup bound loopback (no `--bind`), Docker is not running, or the port differs. On the mini: `mend server status`.                                                                                               |
| `Cannot reach Mend at … connect EHOSTUNREACH …` or `… did not answer within 30 s`      | The mini is asleep, off the network, or the firewall drops the port. Wake it; check the firewall and `pmset`.                                                                                                                           |
| `mend doctor`: `this server's clock is … min behind this machine's`                    | The Docker VM slept with the Mac and its clock has not caught up. Restart OrbStack or Docker Desktop, then keep the mini awake (step 1).                                                                                                |
| `Cannot reach Mend at … getaddrinfo ENOTFOUND mac-mini.local`                          | The name does not resolve from the laptop. Use the tailnet name or the IP, and add it with `--origin`.                                                                                                                                  |
| Signing in or approving in the browser fails; the API answers `403 Origin not allowed` | The URL the laptop uses is not `--url` or an `--origin`. Rerun setup with `--origin <that URL>`.                                                                                                                                        |
| `… Run Mend: Connect to server to sign in.`                                            | The token was revoked or belongs to another server. Connect again.                                                                                                                                                                      |
| Remote-SSH: `Connection refused` or a timeout on port 2222                             | SSH is not published beyond loopback. With an edge, add `--ssh-bind 0.0.0.0`; otherwise check `--bind` and the firewall.                                                                                                                |
| Remote-SSH: `Permission denied (publickey)`                                            | The key in the managed block is not registered: run **Mend: Set up workspace SSH**. Or someone else launched the running workspace (your session may have joined it): only they can open it until it stops and you launch the next one. |
| Remote-SSH: `REMOTE HOST IDENTIFICATION HAS CHANGED`                                   | The gateway's host key changed (volumes removed, reinstall). Verify it on the mini, then remove only the alias: `ssh-keygen -R mend-ws-…`.                                                                                              |
| Setup: `bind source path does not exist: …/postgres-init.sh`                           | The configuration directory is outside Docker Desktop's file sharing. See step 1.                                                                                                                                                       |
| `This Mend deployment exposes no workspace SSH gateway.`                               | The server reports no gateway; check `mend server status` and the logs.                                                                                                                                                                 |

## Checked, and not yet checked

`scripts/vscode-remote-acceptance.mjs` runs this shape end to end on Linux: the packaged server in
its own Docker daemon (as Docker Desktop runs one in a VM), its ports forwarded from a tailnet
address only, and the extension inside VS Code under a virtual display. On 2026-10-10 every step
passed against `0.36.0-next.656`: the browser sign-in, a session created elsewhere reaching the view
within a second, a Workbench session, the Remote-SSH block used by `ssh`, typing in the session's
terminal over `/api/tty`, and review showing the terminal's edit. Then, in a real Remote-SSH window
(VS Code's server installed in the workspace): editing a file, running a command in its integrated
terminal (it ran as `root`: that build predates Remote-SSH as the launcher, mend#641), and opening a
server on the workspace's loopback from this machine through the forwarded port; back in Mend, the
session's own terminal read the edited file and the review listed it.

From outside, over the public internet, against an `https://` edge (`alpha.mend.run`, set up with
`--edge alpha.mend.run --ssh-bind 0.0.0.0 --exposure public --declare workspace-ssh`, 2026-10-10):
`mend ssh setup` wrote the block and registered a key; a session ran in 7.4 s; `ssh` to
`alpha.mend.run:2222` answered in about a second; SFTP put and got files; and a real VS Code
Remote-SSH window opened `/workspace/repo` in 19 s (its server install included), edited a file, ran
its terminal and forwarded a port, and Mend's review listed every file written. That server predated
mend#641, so the login was root.

On a MacBook with Apple silicon and OrbStack (0.36.0-next.754, 2026-10-10), one machine played both
parts: setup on loopback and then on a tailnet, a shell session and `mend run`, `ssh` into a shared
and a per-person workspace through the published port, a Remote-SSH window (its x64 server installed
as the person's own user), and `mend uninstall --all`. On that release the Arch workspaces still ran
`x86_64` under Rosetta; Sealant 0.39.0-next.721 builds them for `arm64`. Docker Desktop's port
forwarding, file sharing and firewall prompt, the Keychain, and sleep are described here from their
documentation; the
[macOS checklist](https://github.com/sealant-sh/Mend/blob/main/docs/MACOS-VALIDATION.md) covers
them.
