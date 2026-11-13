---
title: Run sessions on Boat
description:
  Set up a Mend server whose sessions run in VMs in your own Boat account, from one setup command.
sidebar:
  order: 4
---

Mend can run each session in its own VM in your own [Boat](https://boat.dev) account instead of a
container on the server. The server stays where it is: one machine with Docker that holds your
projects, your logins and every session's saved work. Each Boat VM runs the session's agent and its
Docker, and it reaches the server over HTTPS. The server needs no inbound port for Boat itself.

You give setup one thing from your Boat account: an API key. Setup works out everything else.

A coding agent can follow this page from start to finish. Give it shell access to the server, this
page, and the Boat API key in a file. It never needs to print the key.

## What you need

- A Linux machine with Docker Engine and Docker Compose, where you can run `mend server setup`. Read
  [Install Mend](/getting-started/install/) for the versions.
- A Boat account with an API key (`boat_…`).
- Two public HTTPS addresses that Boat VMs dial: one for session traffic and one for saved work.
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) gives you both with no inbound port and
  no firewall rule. Your own domain and TLS proxy also work.

## Set it up with Tailscale Funnel

These steps use Tailscale on the server. `mend-vm.example.ts.net` stands for the server's MagicDNS
name and `100.70.80.90` for its tailnet address. `tailscale status --self` shows both. Funnel must
be allowed for this machine in your tailnet's access controls.

1. Install the CLI:

   ```sh
   npm install --global @sealant/mend
   ```

2. Forward the two public addresses to the ports setup publishes on loopback. Funnel ends TLS and
   passes the connection through, which the session channel's WebSockets and the bucket's signed
   requests need:

   ```sh
   tailscale funnel --bg --tls-terminated-tcp=8443 tcp://127.0.0.1:13106
   tailscale funnel --bg --tls-terminated-tcp=10000 tcp://127.0.0.1:13900
   ```

3. Put the Boat API key in a file only you can read, then run setup with the key on standard input.
   Mend is served on the tailnet only. Boat VMs reach the two Funnel addresses:

   ```sh
   umask 077
   printf '%s' 'boat_…' > ~/boat-api-key
   mend server setup --yes \
     --bind 100.70.80.90 --url http://mend-vm.example.ts.net:3105 \
     --session-runtime boat \
     --boat-api-key-stdin \
     --session-endpoint-url https://mend-vm.example.ts.net:8443 \
     --blob-store-public-url https://mend-vm.example.ts.net:10000 \
     < ~/boat-api-key
   rm ~/boat-api-key
   ```

   Setup refuses Boat without the key or the two addresses, and its message names the flag that is
   missing. It never takes the key as an argument, so the key stays out of shell history and process
   lists.

4. Read the end of setup's output. For each address it says whether it answered from this machine:

   ```text
   Boat VMs reach this server for session traffic at https://mend-vm.example.ts.net:8443: it answered from this machine (HTTP 404) · observed.
   Boat VMs reach this server for saved work at https://mend-vm.example.ts.net:10000: it answered from this machine (HTTP 403) · observed.
   ```

   Any HTTP status means the forwarding reaches Mend. A line that says an address did not answer
   names the loopback port to forward it to.

5. Open `http://mend-vm.example.ts.net:3105` from a device on the tailnet, create the first account,
   then sign in the CLI with `mend login --url http://mend-vm.example.ts.net:3105`.

6. Adopt a project and start a session. It runs in a Boat VM:
   [Start a session](/getting-started/first-session/).

## Set it up on your own domain, with no Tailscale

On a public server, Mend's own TLS edge can serve Mend and both Boat addresses on port 443, each on
a name of its own. Only ports 80 and 443 need to be open, which the edge needs anyway.

1. Point three DNS names at the server, such as `mend.example.com`, `session.mend.example.com` and
   `files.mend.example.com`, and allow TCP 80 and 443 in its firewall.
2. Install Mend on this machine first and create the first account at `http://localhost:3105`, over
   an SSH tunnel such as `ssh -L 3105:localhost:3105 <server>`. Registration is open until the first
   account exists, so the server is not public before then:

   ```sh
   mend server setup --yes
   ```

3. Make it public, with Boat:

   ```sh
   mend server setup --yes --edge mend.example.com --exposure public \
     --session-runtime boat \
     --boat-api-key-stdin \
     --session-endpoint-url https://session.mend.example.com \
     --blob-store-public-url https://files.mend.example.com \
     < ~/boat-api-key
   ```

   When the edge runs and both addresses are `https://` names of their own with no port, the edge
   serves them: it gets a certificate for each, sends session traffic to Mend and saved work to its
   bucket. With a port, such as `https://mend.example.com:8443`, your own TLS proxy forwards the two
   addresses to `127.0.0.1:13106` and `127.0.0.1:13900` instead; it must pass streaming HTTP and
   WebSockets for the first, and requests, paths and queries unchanged for the second.
   [Remote workspace endpoints](/reference/server-environment/#remote-workspace-endpoints) describes
   the two listeners.

## Project resources

Sessions on Boat reach a project's [resources](/guides/resources/), such as `@db`, as they do on
Docker. A small gateway on the server's Docker host carries each session's resource traffic, inside
Boat's HTTPS, with no inbound port. Setup preloads the gateway's image, which each Mend version
pins. A session in a project without resources gets no gateway at all.

To run Boat without resources, add `--no-boat-resources`. Sessions in projects that link resources
are then refused with a message that says so. `--boat-resources` turns them back on.

## What setup does

- It keeps the Boat API key in the install's `server.env` only, like the server's other secrets. The
  resources choice is kept in its config.
- It derives the IDs Boat needs from the install's identity: the name it labels this install's Boat
  VMs with, who owns this install's Boat images, and its gateway host. They stay the same across
  reruns, restarts and upgrades. The name is how several installs that share one Boat account each
  find only their own VMs. It is not something Boat shows you. To choose it yourself, pass
  `--boat-deployment-id <name>` (letters, digits and `_ . : -`, up to 128 characters) on the first
  setup, and never change it while Boat sessions exist.
- It writes `compose.boat.yaml`, which hands the settings to Mend and keeps Boat's build journal in
  a volume of its own, `mend_mend-boat-state`.
- It keeps all of this across reruns and `mend server upgrade`. Run setup again with no Boat flag
  and nothing about Boat changes.

## Change it later

| To                                          | Run                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------- |
| Replace the key                             | `mend server setup --yes --boat-api-key-stdin < ~/boat-api-key`                        |
| Let each organization choose Docker or Boat | `mend server setup --yes --session-runtimes docker,boat`                               |
| Run new sessions in Docker again            | `mend server setup --yes --session-runtimes docker --session-runtime docker`           |
| Forget Boat entirely                        | `mend server setup --yes --no-boat --session-runtimes docker --session-runtime docker` |

On a server set up before organizations could choose, `--session-runtime docker` alone still works.
Each worktree keeps the runtime it was created with. Keep Boat set up while sessions on Boat still
exist: `--no-boat` stops them from running. Change the resources choice only while no Boat session
is running.

## Docker and Boat on one server

A small server may not have room for every session on its own Docker, and some organizations may
want Boat while others keep Docker. Offer both with `--session-runtimes docker,boat`. Each
organization's owner then picks Docker or Boat in **Settings · Organization · Defaults**, and an
organization that has not picked gets the server's default, which `--session-runtime` sets. The
server's Docker still runs Mend itself and the gateway for project resources either way; offering
Docker means sessions may run there as well.

An organization's choice applies to its new worktrees. Worktrees that exist keep the runtime they
were created with, so a running Docker session never moves to Boat, or the other way round.

## An organization's own Boat key

The key you give setup is the server's: every organization's Boat sessions run in that Boat account
unless the organization connects its own. An owner of an organization connects one with
`mend boat connect`, which reads the key from a hidden prompt or standard input. Boat checks it
before Sealant keeps it, sealed; Mend keeps only which Sealant Boat account is the organization's.
From then on the organization's new Boat sessions, and its standby workspaces, run in, and are
billed to, that Boat account.

A session that is running stays in the Boat account it started in. Its next start uses the key the
organization has then. `mend boat connect` again replaces the key in the same Boat account, and is
refused when the new key cannot see the VMs or saved images the account holds now.
`mend boat disconnect` first stops the standby workspaces Mend keeps in that Boat account, then
sends new sessions back to the server's key, and says how many standbys it stopped. It is refused
while a session's VM or an image build still holds the account, with the count; the key then stays,
and the standbys warm again in the account. A standby holds no session's work, so Mend ends it
without saving anything, and its VM goes as soon as Sealant ends it. `mend boat status` and
`mend boat check` say what was observed and when. Connecting, replacing and removing the key are in
the organization's audit log.

## Your own Boat key

Anyone in an organization can connect a Boat key of their own, in Settings, Account, or with
`mend boat connect --mine`. It applies in the organization they are acting in, and only there. From
then on the Boat sessions they start in that organization run in, and are billed to, their own Boat
account. A Boat session uses its owner's own key when they have one, otherwise the organization's,
otherwise the server's. The web app's session details ("Runs on") and `mend sessions` say which one
decided, recorded when the session's workspace was created. Someone steering a shared session never
moves it and never spends their own key.

Only the person sees, checks, replaces or removes their own key. An owner sees on Settings,
Organization, Boat, and in `mend boat status`, which members have one, never its details, because
the organization's repositories are checked out in VMs in those members' Boat accounts. The audit
log records "connected their own Boat key".

Mend keeps no standby workspace on a person's own key: a standby would be a VM in their Boat account
that they did not start, and it would hold one of their account's running VMs. Their sessions start
without one; colleagues without their own key keep the project's standbys. A person's key builds its
own image in their Boat account, even when the organization's key is in the same Boat organization,
and that image keeps one of the account's saved snapshot slots; the first session after connecting
waits a few minutes for it.

`mend boat disconnect --mine` removes it the way the organization's is removed: Mend stops any
standby it started in that account first, it is refused with the count while a session's VM or an
image build still holds the account, and running it again after a refusal or a lost answer is safe.
The person's sessions then go back to the organization's key, or the server's.

## When Boat VMs shut down

Each Boat VM is billed while it runs. Mend stops a session after 15 idle minutes, the way the Stop
button does: it saves the session's work first, and the session can be resumed. Every case below
keeps a VM up past those 15 minutes.

| Machine                                                           | Idle when                                                                   | Stays up past 15 idle minutes while                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent session (a conversation from the web, the phone or Slack)   | 15 minutes after its last turn, question, background task or process change | a turn runs; a background task the agent started still runs; a question or approval waits on someone; a Service runs or a port is forwarded, a preview's app included; a shell tab in it has a client attached, was typed into or printed in the last 15 minutes; a person holds its screen; its work is still being saved |
| Terminal session (a shell, `mend run`, an agent in terminal mode) | no client attached, nothing typed and no new output for 15 minutes          | a client is attached, watching or typing; the terminal printed in the last 15 minutes; a person holds its screen; its work is still being saved                                                                                                                                                                            |
| Standby for hot sessions                                          | never: a standby waits for the next session                                 | the project's hot-session count is above 0, for each person who started a session in it in the last seven days                                                                                                                                                                                                             |
| Image build VM                                                    | as soon as the image's snapshot is saved: it is deleted then                | a build runs, for at most 13 minutes; a failed or timed-out build's VM is deleted too                                                                                                                                                                                                                                      |

Containers, Services and background processes alone do not keep a terminal session up. A shell that
ran `docker compose up -d` and went quiet is stopped after 15 minutes. A build or dev server still
printing to the terminal keeps it up. A stopped terminal session comes back with `mend resume`; a
`mend run` command, which has no agent to resume, comes back as a shell with
`mend resume --with shell`.

Some holds have their own end. A preview nobody visits stops after `MEND_PREVIEW_IDLE` (30 minutes
by default), and the session's 15 minutes start then. A quiet shell tab left open in an agent
session holds nothing: the session stops with it. Someone using a terminal session's preview in a
browser does not keep that session up either: only the terminal counts. A project's hot-session
count is 0 unless someone set it, in [Hot sessions](/guides/project-environment/#hot-sessions).

`MEND_PROTOCOL_IDLE_STOP_MINUTES` sets the minutes for both kinds of session, `15` by default. `0`
turns the idle stop off: sessions then run until someone stops them. `mend server setup` does not
set it, and a hand edit of `server.env` is refused, so changing it means running the Compose project
yourself with the variable in an override file, as
[Set them on the Docker install](/reference/server-environment/#set-them-on-the-docker-install)
shows.

A stopped session's VM is deleted, never just paused. The stop saves the session's work first, then
asks Boat to delete the VM. Core waits up to 20 seconds for Boat to confirm the deletion, then
checks a deletion still pending every 30 seconds. Work that cannot be saved keeps the VM: the
session reads `not saved · 3 pending · workspace kept`, and the VM stays up, with no time limit,
until the work is saved or its owner discards it. A build VM left behind when the server restarts
mid-build is deleted by the next cleanup pass, which runs every 30 seconds from the build journal in
the `mend_mend-boat-state` volume. Boat also stops a build VM by itself after 15 minutes.

## Limits

Mend does not keep its own list of what Boat can run: it asks Sealant, and the pages that offer a
choice follow the answer. An environment Boat cannot run is shown as unavailable in the environment
pickers, with Sealant's reason, and saving it is refused. A project Service on a port Boat holds is
refused when it is saved, and so is running or adopting one on that port from the web app or the
CLI. With Sealant 0.40.0-next.870, Sealant reports:

- Boat runs Ubuntu and Nix environments. A new project in an organization on Boat starts on the
  first family Boat runs when the environment it would inherit cannot run there. An existing Arch or
  Fedora environment is kept as it was, and its picker says what to pick instead.
- Boat cannot boot a custom container image, and cannot bind folders from the server: a project's
  server folders say so on its **Folders** page, and its sessions start without them.
- Inside a Boat VM, port 8080 is held by Sealant's agent. Serve your app on another port.
- Dotfiles apply on Boat only in a session that runs each person as their own user, the default
  layout. A session that runs everyone in one shared home (`MEND_HARNESS_LAYOUT=shared`, or an image
  that cannot run per-person users) starts without them, and the session says
  `dotfiles · repo not applied` or `dotfiles · snapshot not applied` with the reason.
- Boat bills a VM by the second while it runs, idle or not. The **Ready workspaces** setting of a
  project on Boat says so, since each ready workspace is a running VM.
- Boat sessions download straight from npm and Docker Hub, not through the server's mirrors.
