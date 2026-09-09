---
title: Deploy on a VPS
description: Run Mend on a private remote server and connect from your devices.
sidebar:
  order: 1
---

A VPS or home server uses the same [Docker installation](/getting-started/install/) as your own
machine. Run setup on the server over ordinary host SSH. It runs the complete Mend application and
separate official Postgres; you do not install or choose a Sealant version separately.

## Reach the server privately

Configure a private network such as Tailscale before exposing the server. On the server:

```sh
npm install --global @sealant/mend
mend server setup --bind 0.0.0.0 --url http://your-vps:3105 \
  --origin http://localhost:3105
```

Replace `your-vps` with a hostname reachable from your clients. Without explicit exposure, web and
SSH stay on localhost. Binding `0.0.0.0` opens every IPv4 interface; setup does not configure your
firewall. Sign-up is open to anyone who can reach Mend, so keep those ports private. Plain HTTP on
an untrusted network does not protect credentials.

Postgres publishes no host port and no image registry is published. Workspace images are built and
launched in the host Docker Engine through the mounted daemon socket.

On your laptop, install only the CLI:

```sh
npm install --global @sealant/mend
mend login --url http://your-vps:3105
mend doctor
```

Server lifecycle commands run on the server machine. A remote client URL does not turn
`mend server setup` into a remote provisioning command.

## Connect providers from your laptop

`mend connect` reads credentials from the machine where you run it and sends them to Mend. Run it
where you already signed into your providers:

```sh
mend connect codex
mend connect github
```

You do not need to log provider CLIs in on the VPS itself.

## Git authentication

The application container does not inherit your laptop's home directory or SSH agent. Choose an
explicit authentication mode for SSH remotes:

```sh
mend keys init
mend keys show                    # register this public deploy key on your Git host
mend adopt git@github.com:acme/api.git --auth mend-key
```

Or keep the private key on your laptop and relay signing:

```sh
mend keys share                   # keep this running in another terminal
mend adopt git@github.com:acme/api.git --auth bridge
```

`mend-key` works unattended; `bridge` needs the relay for server-side Git operations. See
[Git access](/guides/git-access/). Adoption takes a network repository URL, never a client or server
folder path.

## Reach development services and workspaces

A service's host port belongs to the server. Bring it to your laptop's loopback through the
authenticated tunnel:

```sh
mend service connect web --port 43100
curl http://127.0.0.1:43100
```

See [development services](/guides/services/). The VS Code extension opens session workspaces over
Remote-SSH, using the Mend URL's hostname and the advertised SSH port. SSH setup needs consent and a
usable key. Verify server host keys rather than blindly replacing known_hosts entries. See
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

Back up private configuration and Docker volumes as well. Read the
[self-hosting and recovery guide](https://github.com/sealant-sh/mend/blob/main/docs/SELF-HOSTING.md)
before planned maintenance. [Kubernetes](/operate/deploy-kubernetes/) remains an operator-managed
alternative, not a mode of this setup command.
