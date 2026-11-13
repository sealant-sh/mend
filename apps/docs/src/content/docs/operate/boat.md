---
title: Run sessions on Boat
description:
  Set up a Mend server whose sessions run in VMs in each organization's own Boat account, with no
  Boat key on the server.
sidebar:
  order: 4
---

Mend can run each session in its own VM in a [Boat](https://boat.dev) account instead of a container
on the server. The server stays where it is: one machine with Docker that holds your projects, your
logins and every session's saved work. Each Boat VM runs the session's agent and its Docker, and it
reaches the server over HTTPS. The server needs no inbound port for Boat itself.

Turning Boat on takes no Boat key. You tell setup where sessions may run and give it the two public
addresses Boat VMs dial. Then an owner of each organization connects the organization's Boat key in
**Settings · Organization · Boat**, or with `mend boat connect`. That organization's Boat sessions
run in, and are billed to, that Boat account. Sealant keeps the key sealed.

A coding agent can follow this page from start to finish. Give it shell access to the server and
this page. It never handles a Boat key.

## What you need

- A Linux machine with Docker Engine and Docker Compose, where you can run `mend server setup`. Read
  [Install Mend](/getting-started/install/) for the versions.
- Two public HTTPS addresses that Boat VMs dial: one for session traffic and one for saved work.
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) gives you both with no inbound port and
  no firewall rule. Your own domain and TLS proxy also work.
- For each organization that runs sessions on Boat, a Boat account and an owner who connects its key
  once the server is up.

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

3. Run setup. Mend is served on the tailnet only. Boat VMs reach the two Funnel addresses:

   ```sh
   mend server setup --yes \
     --bind 100.70.80.90 --url http://mend-vm.example.ts.net:3105 \
     --session-runtime boat \
     --session-endpoint-url https://mend-vm.example.ts.net:8443 \
     --blob-store-public-url https://mend-vm.example.ts.net:10000
   ```

   `mend server setup` with no flags asks the same questions: pick **Boat** where sessions run, and
   it asks for the two addresses. Setup refuses Boat without them, and its message names the flags.

4. Read the end of setup's output. For each address it says whether it answered from this machine,
   then what to do next:

   ```text
   Boat VMs reach this server for session traffic at https://mend-vm.example.ts.net:8443: it answered from this machine (HTTP 404) · observed.
   Boat VMs reach this server for saved work at https://mend-vm.example.ts.net:10000: it answered from this machine (HTTP 403) · observed.
   New organizations' sessions run on Boat until an owner chooses otherwise in Settings, Organization, Defaults.
   Each organization's Boat sessions run in its own Boat account: an owner connects the organization's Boat key in Settings, Organization, Boat, or with mend boat connect, and that account pays for them.
   ```

   Any HTTP status means the forwarding reaches Mend. A line that says an address did not answer
   names the loopback port to forward it to.

5. Open `http://mend-vm.example.ts.net:3105` from a device on the tailnet, create the first account,
   then sign in the CLI with `mend login --url http://mend-vm.example.ts.net:3105`.

6. Connect the organization's Boat key, as an owner: open **Settings · Organization · Boat**, or run
   `mend boat connect` and paste the key at the hidden prompt.
   [Connect an organization's Boat key](#connect-an-organizations-boat-key) says what the key needs.

7. Adopt a project and start a session. It runs in a Boat VM:
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
     --session-endpoint-url https://session.mend.example.com \
     --blob-store-public-url https://files.mend.example.com
   ```

   When the edge runs and both addresses are `https://` names of their own with no port, the edge
   serves them: it gets a certificate for each, sends session traffic to Mend and saved work to its
   bucket. With a port, such as `https://mend.example.com:8443`, your own TLS proxy forwards the two
   addresses to `127.0.0.1:13106` and `127.0.0.1:13900` instead; it must pass streaming HTTP and
   WebSockets for the first, and requests, paths and queries unchanged for the second.
   [Remote workspace endpoints](/reference/server-environment/#remote-workspace-endpoints) describes
   the two listeners.

4. Connect the organization's Boat key, as in step 6 above.

## Project resources

Sessions on Boat reach a project's [resources](/guides/resources/), such as `@db`, as they do on
Docker. A small gateway on the server's Docker host carries each session's resource traffic, inside
Boat's HTTPS, with no inbound port. Setup preloads the gateway's image, which each Mend version
pins. A session in a project without resources gets no gateway at all.

To run Boat without resources, add `--no-boat-resources`. Sessions in projects that link resources
are then refused with a message that says so. `--boat-resources` turns them back on.

## What setup does

- It keeps no Boat key unless you give the server one of its own (below).
- It derives the names Boat needs from the install's identity: the name it labels this install's
  Boat VMs with, who owns this install's Boat images, and its gateway host. They stay the same
  across reruns, restarts and upgrades, and Sealant keeps the first two itself once it has started
  with them. The name is how several installs that share one Boat account each find only their own
  VMs. It is not something Boat shows you. To choose it yourself, pass `--boat-deployment-id <name>`
  (letters, digits and `_ . : -`, up to 128 characters) on the first setup, and never change it
  while Boat sessions exist.
- It writes `compose.boat.yaml`, which hands the settings to Mend and keeps Boat's build journal in
  a volume of its own, `mend_mend-boat-state`.
- When the server's default for new organizations is Boat, the server's own default environment is
  Ubuntu, which Boat runs, instead of Arch, until its operator saves another. Organizations that
  follow the server start with an environment their sessions can run.
- It keeps all of this across reruns and `mend server upgrade`. Run setup again with no Boat flag
  and nothing about Boat changes.

## The server's own Boat key

A server can also have a Boat key of its own. It is optional. Every organization that has no key
connected then runs its Boat sessions in that key's Boat account, and that account pays for all of
them. Leave it out and each organization pays for its own Boat sessions with the key its owner
connects; an organization with no key connected starts no Boat session and says so.

Give the server its key on standard input, never as an argument, so it stays out of shell history
and process lists. Setup keeps it in the install's `server.env` only:

```sh
mend server setup --yes --boat-api-key-stdin < ~/boat-key.txt
```

For a personal Boat key that can bill more than one Boat organization, add
`--boat-organization <id or name>` to say which one pays. `--no-boat-api-key` drops the server's
key; organizations without a key of their own then stop starting Boat sessions until an owner
connects one. Earlier configurations of the server, which setup keeps as they were, still hold the
old key, and setup says where they are: revoke that key in Boat if nothing else uses it.

A server that an earlier setup gave its own key keeps it, and keeps working after
`mend server upgrade` with nothing to do.

## Change it later

| To                                          | Run                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Give the server its own key, or replace it  | `mend server setup --yes --boat-api-key-stdin < ~/boat-key.txt`              |
| Drop the server's own key                   | `mend server setup --yes --no-boat-api-key`                                  |
| Let each organization choose Docker or Boat | `mend server setup --yes --session-runtimes docker,boat`                     |
| Run new sessions in Docker again            | `mend server setup --yes --session-runtimes docker --session-runtime docker` |
| Forget Boat entirely                        | `mend server setup --yes --no-boat`                                          |

`--no-boat` forgets Boat's settings and the server's own key, takes Boat out of the runtimes the
server offers, and runs new sessions on Docker. On a server set up before organizations could
choose, `--session-runtime docker` alone still works. Each worktree keeps the runtime it was created
with. Keep Boat set up while sessions on Boat still exist: `--no-boat` stops them from running.
Change the resources choice only while no Boat session is running.

## Docker and Boat on one server

A small server may not have room for every session on its own Docker, and some organizations may
want Boat while others keep Docker. Offer both with `--session-runtimes docker,boat`. Each
organization's owner then picks Docker or Boat in **Settings · Organization · Defaults**, and an
organization that has not picked gets the server's default, which `--session-runtime` sets. The
server's Docker still runs Mend itself and the gateway for project resources either way; offering
Docker means sessions may run there as well.

An organization's choice applies to its new worktrees. Worktrees that exist keep the runtime they
were created with, so a running Docker session never moves to Boat, or the other way round.

Before the switch takes effect, Mend asks Sealant what the new runtime runs and lists what it would
not run: the organization's own environment, each project whose environment it cannot start, each
Service on a port it holds (Boat holds 8080), and projects with server folders it cannot bind. An
owner sees every project they can see by name, and a count of other members' private projects. The
owner can move the environments to one the runtime runs in the same step: Mend's default packages on
the first OS family it runs, Ubuntu on Boat. A project's own packages are not kept, and its next
session builds the new environment, which takes a few minutes the first time. Services and server
folders stay as they are. The owner can also switch without moving anything; the list then stays on
**Defaults** with the same move. When Sealant cannot be read, Mend says it could not check, and
switching is still allowed. Each move is in the organization's audit log.

Clients read the same list with
`GET /api/organization/settings/session-runtime/impact?sessionRuntime=boat` and move environments by
adding `moves` to `PUT /api/organization/settings/session-runtime`:
`{ "sessionRuntime": "boat", "moves": { "organizationDefault": true, "projects": ["<id>"] } }`. A
request without `moves` switches and moves nothing.

## Connect an organization's Boat key

An owner of an organization connects its key in **Settings · Organization · Boat**, or with
`mend boat connect`, which reads the key from a hidden prompt or standard input. Boat checks it
before Sealant keeps it, sealed; Mend keeps only which Sealant Boat account is the organization's.
From then on the organization's new Boat sessions, and its standby workspaces, run in, and are
billed to, that Boat account.

A session that is running stays in the Boat account it started in. Its next start uses the key the
organization has then. `mend boat connect` again replaces the key in the same Boat account, and is
refused when the new key cannot see the VMs or saved images the account holds now.
`mend boat disconnect` first stops the standby workspaces Mend keeps in that Boat account, then
sends new sessions back to the server's own key, or, on a server without one, stops them starting on
Boat, and says how many standbys it stopped. It is refused while a session's VM or an image build
still holds the account, with the count; the key then stays, and the standbys warm again in the
account. A standby holds no session's work, so Mend ends it without saving anything, and its VM goes
as soon as Sealant ends it. Connecting, replacing and removing the key are in the organization's
audit log.

The key needs these Boat permissions: `exec`, `file.write`, `host`, `sandbox.create`,
`sandbox.delete`, `sandbox.read`, `sandbox.resume`, `sandbox.stop`, `snapshot.read` and
`snapshot.write`, plus `account.read`, so Mend can read the wallet and the key itself. Boat's `ci`
preset is not enough: its `sandbox.delete-own` does not count as `sandbox.delete`. Sealant refuses a
key that it can see lacks one, and names the ones missing. The Boat page in **Settings ·
Organization · Boat** shows the command that makes a suitable key, for a Boat organization
(`boat --org <organization> api-key create …`) or for your personal account
(`boat --org personal api-key create …`; without `--org personal`, the Boat CLI makes the key for
whichever wallet `boat org switch` chose last).

When Sealant checks the key (on connect, on replace and on **Check now** or `mend boat check`) it
asks Boat, read-only, who the key is, which wallet it bills, whether that wallet can start a VM now,
how many VMs run and are allowed, how many saved snapshot slots are used, and the key's permissions
and expiry. The page and `mend boat status` show the last answer, with when it was observed, and say
what needs doing: a key that expires within fourteen days, a missing permission, a wallet that
cannot start, every snapshot slot used. Each fact Boat did not show is marked not observed, with
Boat's reason. When Boat does not answer a check, Mend says so and keeps the last report.

Boat does not show a Boat organization's key its own permissions or expiry, so for that kind of key
those two facts are always not observed. Run `boat --org <organization> api-key list`, or open the
API Keys tab in Boat's dashboard, to see them.

## When a Boat session does not start

When Boat refuses to start a session's VM, or does not answer, the session ends with
`launch failed ·` and one sentence that says what happened, then who can fix it and what to do. The
first line stands alone, so the dashboard's one line says enough. Who can fix it depends on whose
Boat key the launch spent. With the organization's own key, a key or account problem is for an owner
of the organization. With the server's own key, it is for the person who runs the Mend server, and
an owner can connect the organization's own key instead. When Boat asked to wait, the sentence says
until when, and when Boat sent a billing link, the sentence carries it.

Boat's own error code and request id are never in the sentence. The server log has them on a line
that starts with `boat refused ·`, for Boat's support.

A session that Sealant refused before anything ran in Boat reads `launch refused ·` instead: no Boat
key connected for the organization and none on the server, no resource gateway, or an environment
Boat cannot run. With no key anywhere, it reads:

```text
launch refused · This organization's sessions run on Boat, and it has no Boat key connected, so nothing was started.
An owner of this organization connects the organization's Boat key in Settings, Organization, Boat, or with mend boat connect. Then start the session again.
```

What a session in an organization with its own key reads, for each reason Boat gives:

<!-- boat-failure-words:start -->

- **key-refused**: Boat does not accept the organization's Boat key: Boat does not know it, or it
  was revoked, so this session's VM did not start. An owner of this organization creates a new key
  using the command in Settings, Organization, Boat and replaces the key there. Then start the
  session again.
- **key-expired**: The organization's Boat key has expired, so Boat refused it and this session's VM
  did not start. An owner of this organization creates a new key using the command in Settings,
  Organization, Boat and replaces the key there. Then start the session again. Boat keys last 90
  days unless made to last longer; the command on the Boat page makes one that lasts a year.
- **permission-missing**: The organization's Boat key lacks the Boat permission sandbox.create, so
  this session's VM did not start. An owner of this organization creates a key with every permission
  Mend needs using the command in Settings, Organization, Boat and replaces the key there. Then
  start the session again.
- **sandbox-outside-key**: The organization's Boat key is limited to some Boat VMs, and Mend's are
  not among them, so this session's VM did not start. An owner of this organization creates a key
  that is not limited to some VMs using the command in Settings, Organization, Boat and replaces the
  key there. Then start the session again.
- **organization-mismatch**: The organization's Boat key belongs to a different Boat organization
  than the one it was asked to bill, so this session's VM did not start. An owner of this
  organization creates a key for the Boat organization that should pay using the command in
  Settings, Organization, Boat and replaces the key there. Then start the session again.
- **account-suspended**: Boat has suspended the Boat account of the organization's Boat key, so this
  session's VM did not start. An owner of this organization, or whoever manages that Boat account,
  sorts it out with Boat. Then start the session again.
- **billing-required**: The Boat wallet of the organization's Boat key needs paying before Boat
  starts another VM, so this session's VM did not start. An owner of this organization, or whoever
  manages that Boat account, pays or tops it up in Boat. Then start the session again.
- **running-limit**: The Boat account of the organization's Boat key is running as many VMs as its
  Boat plan allows, so this session's VM did not start. Stop a Boat session that is no longer needed
  and start the session again. An owner of this organization, or whoever manages that Boat account,
  can also raise the plan's limit in Boat.
- **member-cap**: The Boat organization that the organization's Boat key bills has reached its
  member limit, so this session's VM did not start. An owner of this organization, or whoever
  manages that Boat account, adds seats or frees one in Boat. Then start the session again.
- **rate-limited**: Boat is limiting how often VMs start in the Boat account of the organization's
  Boat key, so this session's VM did not start. Start the session again in a minute. Nothing needs
  changing.
- **trial-restricted**: The Boat account of the organization's Boat key is on a Boat trial that does
  not allow this, so this session's VM did not start. An owner of this organization, or whoever
  manages that Boat account, moves it to a paid Boat plan. Then start the session again.
- **no-machine**: Boat had no machine free when asked, so this session's VM did not start. Start the
  session again in a few minutes. Nothing needs changing.
- **snapshot-allowance-full**: Every saved snapshot slot of the Boat account of the organization's
  Boat key is used and its wallet cannot pay for another, so this session's VM did not start. An
  owner of this organization, or whoever manages that Boat account, tops up the wallet or deletes
  saved snapshots it no longer needs in Boat. Then start the session again.
- **no-answer**: Boat did not answer, so this session's VM did not start. Start the session again in
  a minute. If it keeps happening, the person who runs this Mend server can read what Boat answered
  in the server log.
- **refused**: Boat refused for a reason Mend does not recognise, so this session's VM did not
start. The person who runs this Mend server can read Boat's own reason and request id in the server
log, to fix it or to give Boat's support.
<!-- boat-failure-words:end -->

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
asks Boat to delete the VM. sealant waits up to 20 seconds for Boat to confirm the deletion, then
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
