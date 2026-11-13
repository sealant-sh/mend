---
title: Run sessions on Boat
description:
  Run each session in its own VM in a Boat account, with Boat keys connected by each organization's
  owner, and keep the server, the projects and the saved work where they are.
sidebar:
  order: 4
---

Mend can run each session in its own VM in a [Boat](https://boat.dev) account instead of a container
on the server's Docker. The VM runs the session's agent, its worktree and its own Docker engine. The
server stays where it is and keeps the rest: your projects, everyone's logins, Postgres, every
session's record and saved work, project resources such as `@db`, and Mend itself. A Boat VM reaches
the server over two public HTTPS addresses. The server needs no other inbound port for Boat.

Turning Boat on takes no Boat key. Each organization's owner connects a Boat key for the
organization, and that Boat account runs and pays for the organization's Boat sessions. Anyone in an
organization can also connect a key of their own, for the Boat sessions they start there. The server
can have a key of its own, for organizations that connected none. Sealant keeps every key sealed;
Mend keeps only which Sealant Boat account belongs to which organization or person.

This page is for the person who runs the server and for an organization's owner. A coding agent can
follow it with shell access to the server. Nothing on this page asks you to put a Boat key in a
command, a file or an environment variable by hand.

## What you need

- A Linux machine with Docker Engine and Docker Compose, where you can run `mend server setup`.
  [Install Mend](/getting-started/install/) lists the versions.
- Two public HTTPS addresses that Boat VMs dial, one for session traffic and one for saved work.
  [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) gives you both with no inbound port.
  Mend's TLS edge on your own domain, or your own TLS proxy, also works.
- For each organization that runs sessions on Boat, a Boat account and an owner of the organization
  to create and connect its key.

## Turn Boat on

### With Tailscale Funnel

These steps use Tailscale on the server. `mend-vm.example.ts.net` stands for the server's MagicDNS
name and `100.70.80.90` for its tailnet address; `tailscale status --self` shows both. Funnel must
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

3. Run setup. Mend is served on the tailnet; Boat VMs reach the two Funnel addresses:

   ```sh
   mend server setup --yes \
     --bind 100.70.80.90 --url http://mend-vm.example.ts.net:3105 \
     --session-runtime boat \
     --session-endpoint-url https://mend-vm.example.ts.net:8443 \
     --blob-store-public-url https://mend-vm.example.ts.net:10000
   ```

   `mend server setup` with no flags asks the same questions: pick **Boat** where sessions run, and
   it asks for the two addresses. Setup refuses Boat without them, and its message names the flags.
   To let each organization choose between this server's Docker and Boat, use
   `--session-runtimes docker,boat`, with `--session-runtime` naming what an organization gets until
   its owner chooses.

4. Read the end of setup's output. It says whether each address answered from this machine, then who
   connects a key:

   ```text
   Boat VMs reach this server for session traffic at https://mend-vm.example.ts.net:8443: it answered from this machine (HTTP 404) · observed.
   Boat VMs reach this server for saved work at https://mend-vm.example.ts.net:10000: it answered from this machine (HTTP 403) · observed.
   New organizations' sessions run on Boat until an owner chooses otherwise in Settings, Organization, Defaults.
   Each organization's Boat sessions run in its own Boat account: an owner connects the organization's Boat key in Settings, Organization, Boat, or with mend boat connect, and that account pays for them.
   ```

   Any HTTP status means the forwarding reaches Mend. A line that says an address did not answer
   names the loopback port to forward it to.

5. Open `http://mend-vm.example.ts.net:3105` from a device on the tailnet, create the first account,
   and sign in the CLI with `mend login --url http://mend-vm.example.ts.net:3105`.

6. As the organization's owner, [create a Boat key](#create-a-boat-key) and
   [connect it](#connect-an-organizations-boat-key).

7. Adopt a project and [start a session](/getting-started/first-session/). It runs in a Boat VM.

### On your own domain

On a public server, Mend's TLS edge can serve Mend and both Boat addresses on port 443, each on a
name of its own. Only ports 80 and 443 need to be open, which the edge needs anyway.

1. Point three DNS names at the server, such as `mend.example.com`, `session.mend.example.com` and
   `files.mend.example.com`, and allow TCP 80 and 443 in its firewall.
2. Install Mend and create the first account at `http://localhost:3105`, over an SSH tunnel such as
   `ssh -L 3105:localhost:3105 <server>`. Registration is open until the first account exists, so
   the server is not public before then:

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

   When both addresses are `https://` names of their own with no port, the edge gets a certificate
   for each and sends session traffic to Mend and saved work to its bucket. With a port, such as
   `https://mend.example.com:8443`, your own TLS proxy forwards the two addresses to
   `127.0.0.1:13106` and `127.0.0.1:13900` instead. It must pass streaming HTTP and WebSockets for
   the first, and requests, paths and queries unchanged for the second.
   [Remote workspace endpoints](/reference/server-environment/#remote-workspace-endpoints) describes
   both listeners.

4. As the organization's owner, [create a Boat key](#create-a-boat-key) and
   [connect it](#connect-an-organizations-boat-key).

### What setup keeps

- No Boat key, unless you give the server one of its own.
- The names Boat needs, derived from the install's identity: the name it labels this install's Boat
  VMs with, who owns this install's Boat images, and its gateway host. They stay the same across
  reruns, restarts and upgrades, and Sealant keeps the first two itself once it has started with
  them. The name keeps several installs that share one Boat account apart. To choose it, pass
  `--boat-deployment-id <name>` on the first setup and never change it while Boat sessions exist.
- `compose.boat.yaml`, which hands these settings to Mend and keeps Sealant's Boat build journal in
  a volume of its own, `mend_mend-boat-state`.
- When new organizations get Boat, the server's own default environment is Ubuntu, which Boat runs,
  until its operator saves another.

Setup keeps all of it across reruns and `mend server upgrade`. A rerun with no Boat flag changes
nothing about Boat.

### Check what the server observed

`mend server status`, run on the server's machine, ends with where sessions run and what was last
observed about Boat. Signed in as the operator on that machine, it also reads the running server:

```text
sessions · offered on this server's Docker and Boat · new organizations run on Boat until an owner chooses · declared
boat address · session traffic at https://mend-vm.example.ts.net:8443 · answered HTTP 404 from this machine · observed 2026-11-13 14:02 UTC
boat address · saved work at https://mend-vm.example.ts.net:10000 · answered HTTP 403 from this machine · observed 2026-11-13 14:02 UTC
boat key · this server has no Boat key of its own · each organization's Boat sessions run on the key its owner connects
boat launch · Sealant lists Boat: a worker reported that it launches Boat VMs · observed 2026-11-13 14:02 UTC
boat gateway · declared on · present on the worker that launches Boat · observed 2026-11-13 14:02 UTC
```

`boat launch` says whether Sealant lists Boat. It does once a worker has reported that it launches
Boat VMs and some Boat key can pay for them; until then, Boat sessions are refused. A line that
needs something done ends with what to do, after an arrow. `mend doctor`, run anywhere the CLI is
signed in, prints the same lines from the server's point of view, then the organization's Boat key
and your own, if you connected one. **Settings · Instance · Exposure** shows them to the operator
under **Where sessions run**. People who do not operate the server see only where sessions run,
their organization's key and their own.

## Boat keys

### Which key a session uses

Mend takes the first key that applies, when the session's workspace is created:

| Key                                                | A new Boat session runs in, and is billed to                                      |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| The session owner's own key in this organization   | Their own Boat account                                                            |
| Else the organization's key, connected by an owner | The organization's Boat account                                                   |
| Else the server's own key                          | The server's key's Boat account                                                   |
| None of them                                       | Nothing: the session is refused and says an owner connects the organization's key |

The session's details in the web app ("Runs on") and `mend sessions` say which key decided: "your
own Boat key" to its owner, "its owner's own Boat key" to anyone else, or the organization's or the
server's. Someone steering a shared session never moves it and never spends their own key. A session
keeps the Boat account it started in until it stops; its next start uses the key that applies then.
Standbys for [hot sessions](#hot-sessions) run on the organization's key or the server's, never on a
person's.

### Create a Boat key

Create the key with the Boat CLI. The Boat page in **Settings · Organization · Boat** shows the same
commands, ready to copy. For a Boat organization, replace the placeholder with its name:

```sh
boat --org <your-boat-organization> api-key create mend --ttl 365d --actions exec,file.write,host,sandbox.create,sandbox.delete,sandbox.read,sandbox.resume,sandbox.stop,snapshot.read,snapshot.write,account.read
```

For your personal account:

```sh
boat --org personal api-key create mend --ttl 365d --actions exec,file.write,host,sandbox.create,sandbox.delete,sandbox.read,sandbox.resume,sandbox.stop,snapshot.read,snapshot.write,account.read
```

Boat shows the key once. Paste it straight into Mend, as the next section shows.

- **Permissions.** The command grants every permission sealant needs to run sessions. One of them is
  `account.read`: with it sealant reads which wallet the key bills, the wallets its Boat account can
  bill, and the key's own permissions and expiry. Boat's `ci` preset is not enough: its
  `sandbox.delete-own` does not count as `sandbox.delete`. sealant refuses a key it can see lacks a
  permission, and names the ones missing. A key connected before sealant needed `account.read`, and
  made without it, keeps its running sessions but starts no new one, and its Boat page says so. Boat
  never adds a permission to an existing key: replace it with one made with the command above.
- **What it bills.** A Boat organization's key bills that organization's wallet, and only that one.
  A personal key can bill your personal Boat account or any Boat organization you belong to. When
  you connect one, sealant pins it to the wallet it bills at that moment (your active Boat wallet,
  the one `boat org switch` chose last), and every request names that wallet from then on, so a
  later `boat org switch` does not move Mend's bill. A key connected before sealant pinned keys is
  pinned by sealant to the wallet it bills, within about a minute of the upgrade; until then it
  starts no new session.
- **Expiry.** Every Boat key expires: after 90 days unless made to last longer, and after a year
  with the command above. From fourteen days before, the Boat page, `mend boat status` and
  `mend doctor` warn, and `mend server status` does the same for the server's own key. An expired
  key starts no session; replace it before then.

### Connect an organization's Boat key

An owner of the organization connects the key in **Settings · Organization · Boat**, or runs
`mend boat connect` and pastes the key at the hidden prompt. Boat checks the key before Sealant
keeps it, and Sealant refuses it with Boat's reason when Boat does not accept it. From then on, the
organization's new Boat sessions and its standbys run in, and are billed to, that key's Boat
account. Members see whether the organization has a key; only owners see its details or change it.
Connecting, replacing and removing the key are in the organization's audit log.

### Connect your own Boat key

Anyone in an organization can connect a key of their own in **Settings · Account**, or with
`mend boat connect --mine`, using a key made with the commands above. It applies in the organization
they are acting in, and only there: the Boat sessions they start in it run in, and are billed to,
their own Boat account, and the organization's repositories are checked out in VMs there. Only that
person sees, checks, replaces or removes it. An owner sees which members have their own key, on
**Settings · Organization · Boat** and in `mend boat status`, never its details. The audit log
records it.

### Give the server a key of its own

The server's own key is optional. With it, every organization that has no key connected runs its
Boat sessions in that key's Boat account, which pays for all of them. Without it, each organization
pays for its own Boat sessions, and one with no key connected starts none.

Give it to setup on standard input, never as an argument. Pipe it from your password manager's CLI
into `mend server setup --yes --boat-api-key-stdin`, or run that command and paste the key, then
press Ctrl+D. Setup reads standard input to its end, and a terminal shows what you paste. Setup
keeps the key in the install's `server.env` only, and Sealant checks it when the server starts and
once a day.

For a personal key, add `--boat-organization <id or name>` to say which Boat organization pays.
Sealant names that organization on every request the server's key makes, so billing does not follow
the key's active wallet.

## Check a key

**Check now** on the Boat page, or `mend boat check`, asks Boat about the key now, read-only; for
your own key, **Check now** in **Settings · Account**, or `mend boat check --mine`. It starts
nothing and costs nothing. Sealant also checks every key when it is connected or replaced, and once
a day. The page and `mend boat status` show the last answer and when it was observed:

- who the key is, and whether it is a Boat organization's key or a personal one
- the wallet it bills
- whether that wallet can start a VM now, and how many VMs run of how many are allowed
- how many of the account's saved snapshot slots are used
- the key's permissions and when it expires

Then they say what needs doing: a key that expires within fourteen days, a missing permission, a
wallet that cannot start a VM, every snapshot slot used. A fact Boat did not show is marked not
observed, with Boat's reason. When Boat does not answer, Mend says so and keeps the last report.

Boat does not show a Boat organization's key its own permissions or expiry, so for that kind of key
those two facts are never observed. Run `boat --org <organization> api-key list`, or open the API
Keys tab in Boat's dashboard, to see them, or run a full check.

### Run a full check

A full check shows that the key can do what a session needs, by doing it once. Run it after you
create a Boat organization's key, whose permissions Mend cannot read, or when a Boat session fails
and the report shows nothing wrong. An owner runs it with **Run a full check** on the Boat page, or
with `mend boat check --full`. Anyone runs it on their own key from **Settings · Account**, or with
`mend boat check --full --mine`.

Sealant starts the smallest VM in the key's Boat account, runs a command in it, publishes a port and
saves a snapshot, then deletes the snapshot and the VM. It uses one VM start, takes about a minute,
and holds one saved snapshot slot for that minute. Boat bills that minute of VM time.

The result lists each step as passed, refused with Boat's reason in the words of
[the table below](#troubleshooting), no answer, or not reached. It says when the check finished and
whether Sealant saw Boat delete everything it made. Sealant keeps the last result, so the page and
`mend boat status` show it after a closed tab. While a check runs, the page says since when and
offers no second one.

If a check stops before it finishes, Sealant removes what it made and reports the check as
interrupted. Until Boat has deleted everything, replacing or removing the key is refused with a
sentence naming the VM or snapshot Boat may still hold, because only the key that made them can
delete them. Wait, or delete them in Boat.

## Where each organization's sessions run

The server offers Docker, Boat, or both (`--session-runtimes`). With both, each organization's owner
chooses in **Settings · Organization · Defaults**, and an organization that has not chosen gets the
server's default (`--session-runtime`). Members see the choice and cannot change it. The server's
Docker still runs Mend and the project resources either way.

A choice applies to new worktrees. A worktree keeps the runtime it was created with, so a running
Docker session never moves to Boat, or the other way round.

### Switch an organization to Boat

When an owner picks Boat in **Settings · Organization · Defaults**, a dialog opens before the switch
takes effect. Mend asks Sealant what Boat runs and lists what it would not run: the organization's
own environment, each project whose environment Boat cannot start, each Service on a port Boat
holds, and projects with server folders Boat cannot bind. An owner sees by name every project they
can see, and a count of other members' private projects.

The owner can move the environments to one Boat runs in the same step. Mend's default packages on
Ubuntu replace them. A project's own packages are not kept, and its next session builds the new
environment, which takes a few minutes the first time. Services and server folders stay as they are.
The owner can also switch without moving anything; the list then stays on **Defaults** with the same
move. When Sealant cannot be read, Mend says it could not check, and switching is still allowed.
Each move is in the organization's audit log.

Clients read the same list with
`GET /api/organization/settings/session-runtime/impact?sessionRuntime=boat` and move environments by
adding `moves` to `PUT /api/organization/settings/session-runtime`:
`{ "sessionRuntime": "boat", "moves": { "organizationDefault": true, "projects": ["<id>"] } }`. A
request without `moves` switches and moves nothing.

### Limits

Mend keeps no list of what Boat can run. It asks Sealant, which reports what each runtime supports,
and every page that offers a choice follows that report. On an organization whose sessions run on
Boat:

- An environment Boat cannot run is shown as unavailable in the environment pickers, with Sealant's
  reason, and saving it is refused with the same reason, from the web app, the CLI or the API.
- A new project starts on an environment Boat runs. An existing environment Boat cannot run is kept
  as it was, and its picker says what to pick instead.
- A project Service on a port Boat holds is refused when it is saved, run or adopted.
- Server folders Boat cannot bind say so on the project's **Folders** page, and its sessions start
  without them.
- The **Ready workspaces** setting shows Sealant's sentence on what an idle Boat VM costs.

With Sealant 0.40.0-next.874, the report says Boat runs Ubuntu and Nix environments, boots no custom
container image, binds no server folders, and holds port 8080 in the VM for Sealant's agent. Two
limits are Mend's own: Boat sessions download from npm and Docker Hub directly, not through the
server's mirrors, and dotfiles apply only where each person runs as their own user, the default
layout.

## Project resources

Sessions on Boat reach a project's [resources](/guides/resources/), such as `@db`, which run on the
server's Docker. A small gateway on the server's Docker host carries each session's resource traffic
inside Boat's HTTPS, with no inbound port. Setup turns it on with Boat and preloads its image, which
each Mend version pins. A session in a project without resources uses no gateway.

To run Boat without the gateway, add `--no-boat-resources`. A Boat session in a project with
resources is then refused with a message that says so; sessions in other projects run.
`--boat-resources` turns it back on. Change it only while no Boat session is running.

## Hot sessions

A project's hot-session count keeps standby workspaces ready, one set for each person who started a
session in the project in the last seven days. On Boat, each standby is a running VM in the Boat
account of the organization's key, or the server's, and Boat bills it by the second while it waits.
A count of 2 for a project three people use keeps six VMs running. The count is 0 unless someone
sets it in [Hot sessions](/guides/project-environment/#hot-sessions). Removing the organization's
key stops its standbys first.

Mend keeps no standby on a person's own key: a standby would be a VM in their Boat account that they
did not start, and it would take one of their account's running VMs. Their sessions start without
one; colleagues without a key of their own keep the project's standbys.

## When Boat VMs stop

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
browser does not keep that session up either: only the terminal counts.

`MEND_PROTOCOL_IDLE_STOP_MINUTES` sets the minutes for both kinds of session, `15` by default. `0`
turns the idle stop off. `mend server setup` does not set it, and a hand edit of `server.env` is
refused, so changing it means running the Compose project yourself with the variable in an override
file, as
[Set them on the Docker install](/reference/server-environment/#set-them-on-the-docker-install)
shows.

A stopped session's VM is deleted, never paused. The stop saves the session's work first, then asks
Boat to delete the VM. Sealant waits up to 20 seconds for Boat to confirm, then checks a deletion
still pending every 30 seconds. Work that cannot be saved keeps the VM: the session reads
`not saved · 3 pending · workspace kept`, and the VM stays up, with no time limit, until the work is
saved or its owner discards it.

## Images and saved snapshots

A Boat VM starts from an image Sealant builds in the same Boat account and keeps there as a saved
snapshot. The first Boat session that needs an image the account does not have yet waits while
Sealant builds it: a build VM starts, prepares the environment, saves the snapshot and is deleted. A
build runs for at most 13 minutes. Later sessions with the same image start from the snapshot. Each
key builds its own images in its own Boat account: a person's own key builds one even when the
organization's key is in the same Boat organization, so their first session after connecting waits
for it. A build VM left behind by a server restart is deleted by the next cleanup pass, which runs
every 30 seconds from the build journal in the `mend_mend-boat-state` volume, and Boat stops a build
VM by itself after 15 minutes.

Each image holds one of the account's saved snapshot slots. The key report shows how many are used
of how many Boat includes; Boat charges for slots beyond those. When every slot is used and the
wallet cannot pay for another, the session that needed a new image says so. Once an hour sealant
removes the images it built that no session can start from any more: it keeps every image used in
the last day, and the image each session stopped in the last 14 days would start from. It also
deletes the images it built in a Boat account when that account's key is removed from Mend.

### After upgrading to sealant 0.40.0-next.880

Three things change once the server runs this sealant:

- **Each key is pinned to a wallet.** A personal key connected before the upgrade is pinned by
  sealant to the wallet it bills, within about a minute. Until then it starts no new Boat session,
  and its sessions already running carry on. A key made without `account.read` is never pinned:
  replace it with one made with the command on the Boat page.
- **Unused images go.** The first hourly pass removes the images sealant built that nothing can
  start from any more, so the saved snapshot count on the Boat page drops.
- **Every Boat image is built once more.** Nix sessions on Boat now start with the shell their
  environment declares, which changes a file inside every Boat image. Each environment's next Boat
  session waits for its image to be built again, once.

## Remove or replace a key

**Replace the organization's key.** Connect the new key on the Boat page or with
`mend boat connect`. It replaces the key in the same Boat account, and is refused when the new key
cannot see the VMs or saved images the account holds now, with how many. Use a key from the same
Boat account. To move the organization to another Boat account, remove the key first, then connect
the new one.

**Remove the organization's key.** **Remove…** on the Boat page, or `mend boat disconnect`. Mend
first stops the standbys it keeps in that Boat account, then asks Sealant to remove the account, and
says how many standbys it stopped. New Boat sessions then use the server's own key, or are refused
on a server without one, and Sealant deletes the images it built in that Boat account. The removal
is refused while a session's VM or an image build still holds the account, with the count: stop
those sessions, then remove it again. A refused removal changes nothing.

**Replace or remove your own key.** In **Settings · Account**, or with `mend boat connect --mine`
and `mend boat disconnect --mine`. Replacing and removing work as for the organization's key:
Sealant deletes the images it built in your Boat account, and a removal is refused while a session's
VM or an image build still holds it. Your Boat sessions then use the organization's key, or the
server's.

**Replace the server's key.** Give setup the new key the same way as the first one, on standard
input with `--boat-api-key-stdin`.

**Drop the server's key.** Run `mend server setup --yes --no-boat-api-key`. Organizations without a
key of their own then stop starting Boat sessions until an owner connects one. Earlier
configurations of the server, which setup keeps as they were, still hold the old key, and setup says
where they are: revoke the key in Boat if nothing else uses it.

**Stop offering Boat.** `mend server setup --yes --session-runtimes docker --session-runtime docker`
runs every organization's new sessions on Docker and keeps Boat set up for the worktrees that still
use it. `mend server setup --yes --no-boat` forgets Boat's settings and the server's key as well;
keep Boat set up while sessions on Boat exist, because `--no-boat` stops them from running.

## Troubleshooting

When Boat refuses to start a session's VM, or does not answer, the session ends with
`launch failed ·` and a sentence that says what happened, then who can fix it and what to do. The
first line stands alone, so the dashboard's one line says enough. Who can fix it depends on the key
the session recorded: an owner of the organization for its own key, the person who runs the server
for the server's key, and the session's owner for their own key. Everyone reads the same sentence,
so a session on its owner's own key names it as "the session owner's own Boat key" and sends only
its owner to **Settings · Account** or `mend boat connect --mine`. When Boat asked to wait, the
sentence says until when, and when Boat sent a billing link, the sentence carries it.

Boat's own error code and request id are never in the sentence. The server log has them on a line
that starts with `boat refused ·`, for Boat's support.

A session that Sealant refused before anything ran in Boat reads `launch refused ·` instead: no Boat
key for the organization and none on the server, no worker that launches Boat, no resource gateway,
or an environment Boat cannot run. With no key anywhere, it reads:

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
  start. The person who runs this Mend server can read Boat's own reason and request id in the
  server log, to fix it or to give Boat's support.
- **wallet not known yet**: The Boat wallet the organization's Boat key bills is not known to
sealant yet, so nothing was started. sealant looks at a key connected before this server's upgrade
within about a minute of it; sessions already running on the key are not affected. Start the session
again in a minute. If it is refused again, the key lacks Boat's account.read permission, which Boat
never adds to an existing key: an owner of this organization creates a key with every permission
Mend needs using the command in Settings, Organization, Boat and replaces the key there. Then start
the session again.
<!-- boat-failure-words:end -->

## Reference

| To                                                    | Do                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Offer Boat as the only runtime                        | `mend server setup --yes --session-runtime boat` with the two address flags                                    |
| Let each organization choose Docker or Boat           | `mend server setup --yes --session-runtimes docker,boat`                                                       |
| Set what an organization gets until its owner chooses | `mend server setup --yes --session-runtime docker` or `--session-runtime boat`                                 |
| Set the two public addresses                          | `--session-endpoint-url <origin>` and `--blob-store-public-url <origin>` on `mend server setup`                |
| Name this install's Boat VMs yourself                 | `--boat-deployment-id <name>` on the first `mend server setup`                                                 |
| Turn the resource gateway off or on                   | `mend server setup --yes --no-boat-resources`, or `--boat-resources`                                           |
| Give the server its own key, or replace it            | `mend server setup --yes --boat-api-key-stdin`, with the key on standard input                                 |
| Name the Boat organization the server's key bills     | `mend server setup --yes --boat-organization <id or name>`; `--no-boat-organization` drops it                  |
| Drop the server's own key                             | `mend server setup --yes --no-boat-api-key`                                                                    |
| Forget Boat entirely                                  | `mend server setup --yes --no-boat`                                                                            |
| See where sessions run and what was observed          | `mend server status` on the server's machine, `mend doctor` anywhere                                           |
| Connect or replace the organization's key             | **Settings · Organization · Boat**, or `mend boat connect`                                                     |
| See the organization's key                            | `mend boat status`                                                                                             |
| Ask Boat about the key now                            | **Check now**, or `mend boat check`                                                                            |
| Prove the key with a throwaway VM                     | **Run a full check**, or `mend boat check --full`                                                              |
| Remove the organization's key                         | **Remove…**, or `mend boat disconnect`                                                                         |
| Connect, check or remove your own key                 | **Settings · Account**, or `mend boat connect --mine`, `mend boat check --mine`, `mend boat disconnect --mine` |
| See which key a session runs on                       | "Runs on" in the session's details, or `mend sessions`                                                         |
| Choose where an organization's sessions run           | **Settings · Organization · Defaults**                                                                         |

[Server environment](/reference/server-environment/#boat) lists every Boat setting in the install's
`server.env`, and [the CLI reference](/reference/cli/) every flag.
