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

You give setup two things from your Boat account: an API key, and the ID of the deployment the VMs
run in. Setup works out everything else.

A coding agent can follow this page from start to finish. Give it shell access to the server, this
page, the Boat deployment ID, and the Boat API key in a file. It never needs to print the key.

## What you need

- A Linux machine with Docker Engine and Docker Compose, where you can run `mend server setup`. Read
  [Install Mend](/getting-started/install/) for the versions.
- A Boat account, with an API key (`boat_…`) and the ID of a deployment.
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
     --boat-deployment-id <deployment-id> --boat-api-key-stdin \
     --session-endpoint-url https://mend-vm.example.ts.net:8443 \
     --blob-store-public-url https://mend-vm.example.ts.net:10000 \
     < ~/boat-api-key
   rm ~/boat-api-key
   ```

   Setup refuses Boat without the deployment ID, the key or the two addresses, and its message names
   the flag that is missing. It never takes the key as an argument, so the key stays out of shell
   history and process lists.

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

## Set it up with your own domain

Point two HTTPS origins at the server, such as `https://mend.example.com:8443` and
`https://mend.example.com:10000`. Your TLS proxy forwards the first to `127.0.0.1:13106` and the
second to `127.0.0.1:13900`. It must pass streaming HTTP and WebSockets for the first, and requests,
paths and queries unchanged for the second. Then run step 3 with those two origins.
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
  deployment ID and the resources choice are kept in its config.
- It derives two IDs Boat needs from the install's identity: who owns this install's Boat images,
  and its gateway host. They stay the same across reruns, restarts and upgrades.
- It writes `compose.boat.yaml`, which hands the settings to Mend and keeps Boat's build journal in
  a volume of its own, `mend_mend-boat-state`.
- It keeps all of this across reruns and `mend server upgrade`. Run setup again with no Boat flag
  and nothing about Boat changes.

## Change it later

| To                               | Run                                                             |
| -------------------------------- | --------------------------------------------------------------- |
| Replace the key                  | `mend server setup --yes --boat-api-key-stdin < ~/boat-api-key` |
| Move to another deployment       | `mend server setup --yes --boat-deployment-id <id>`             |
| Run new sessions in Docker again | `mend server setup --yes --session-runtime docker`              |
| Forget Boat entirely             | `mend server setup --yes --no-boat --session-runtime docker`    |

Each worktree keeps the runtime it was created with. Keep Boat set up while sessions on Boat still
exist: `--no-boat` stops them from running. Change the deployment or the resources choice only while
no Boat session is running.

## Limits

- New projects on Boat start with Ubuntu and Docker inside the session. An Arch project needs its
  environment switched to Ubuntu or Nix first.
- Custom container images and host folder mounts are refused: a Boat VM cannot use them.
- Boat sessions download straight from npm and Docker Hub, not through the server's mirrors.
- Inside a Boat VM, port 8080 is held by Sealant's agent. Serve your app on another port.
