---
title: Work from another device
description: Reach the same Mend sessions from a browser, VS Code, a phone, or another terminal.
sidebar:
  order: 6
---

The work stays on the Mend machine. Other devices attach to it.

A terminal attachment, browser tab, VS Code window, or phone is a client of the same session.
Closing one does not stop the agent, delete the worktree, or move the development service.

```mermaid
flowchart LR
  laptop[Laptop CLI]
  browser[Browser]
  vscode[VS Code]
  phone[Phone]
  slack[Slack]
  path[Loopback, private network, or TLS edge]
  mend[Mend machine]
  session[Session workspace]

  laptop --> path
  browser --> path
  vscode --> path
  phone --> path
  mend -. Socket Mode, outbound .-> slack
  path --> mend --> session
```

## Reach the server

Web and workspace SSH bind to localhost by default. Reaching the server from elsewhere is an
explicit choice when you set up the server: `mend server setup` asks how people reach it (just this
machine, your private network or Tailscale, or the public internet with HTTPS) and sets the
addresses from the answer. With flags:

```sh
mend server setup --bind 0.0.0.0 --url http://mend-host:3105 \
  --origin http://localhost:3105
```

Postgres publishes no port and no image registry is published. Binding `0.0.0.0` opens every IPv4
interface. Registration closes after the first account and everyone else joins by invitation, so
create that account before anyone else can reach the server. Read
[Install Mend](/getting-started/install/#network-boundary).

A private network is one way to run Mend, not a requirement. Mend authenticates and authorizes every
request itself, so a tailnet or a VPN in front of it is an extra gate you may add. Tell Mend how it
is reached with `MEND_EXPOSURE`: `loopback`, `private` (the default: a network you control admission
to) or `public`. A server cannot observe what is published in front of it, so this is your
statement, and `mend doctor` reports what Mend observes beside it. `mend server setup --exposure`
declares it on the Docker install; without the flag a setup install runs as `private`.

Plain HTTP on a LAN does not protect credentials from that network. Beyond the machine, put a TLS
edge in front of Mend. `mend server setup --edge <host>` runs the repository's Caddy overlay
(`deploy/docker/compose.edge.yaml`) and keeps it across upgrades, and the Kubernetes chart can
render an Ingress to the web tier. Test a terminal through the edge before relying on it.

`public` refuses to start while an item of the public exposure gate that Mend can observe is open.
`mend operator exposure` lists them. Two items, `core-private` and `edge-tls`, no build can observe,
nor `workspace-ssh` while workspace SSH is published on a non-loopback address apart from the web
port (`--ssh-bind`), nor `t3code-gateway` while the [t3code gateway](/integrations/t3code/) is
published beyond loopback or served by the edge. Of these, an open `workspace-ssh`, or an open
`t3code-gateway` published beyond loopback, refuses a `public` start. Once you have verified one
from outside, declare it (`mend server setup --declare <item>`, or `MEND_EXPOSURE_DECLARED`) and the
report shows it as declared. An independent security reassessment of the exact release is also yours
to record. Nothing in Mend says an instance is fit to expose to the Internet. Read
[Exposure](/operate/exposure/).

## Pair another device

On a signed-in machine, run:

```sh
mend pair
```

The command prints a QR code, a short code, and the address the second device should open. A pairing
code is valid for one device, one claim, and ten minutes.

The address comes from the origins configured on the server. `--url` selects one of those exact
URLs; it cannot introduce an address the server does not know:

```sh
mend pair --url http://mend-host.example:3105
```

A device that cannot scan or type a code in time can take a token minted by hand: in the web app,
Settings → Devices → **Mint a token by hand** names the device and shows its token once, beside the
configured origins. In the mobile app it goes under Settings → Advanced as the server URL and bearer
token. Mend keeps only the token's hash.

After a successful claim, the new device receives its own revocable token. Revoke devices from
**Settings**.

A device token acts as your account, inside your organization, with everything your account may do.
Read-only and control scopes are planned but not enforced yet. Pair only devices you trust with your
account.

## Reattach from another terminal

Install the Mend CLI on the second machine, point it at the server, and sign in:

```sh
mend login --url http://mend-host:3105
mend sessions
mend attach <session-id-prefix>
```

`mend attach` replays the terminal stream and then follows live output. Press `Ctrl+]` to detach
without stopping the process. Set `MEND_DETACH_KEY=none` when an outer terminal multiplexer owns the
detach key. Attaching takes back a session that was picked up on the phone. Read
[Terminal dashboard and attach](/clients/terminal/).

Only a session's owner steers it: sends turns, answers approvals, interrupts, and types in its
terminal. Others who can see the project follow it read-only unless the owner turns on shared
control, which lets them steer. In a workspace that shares one home their turns run on the owner's
provider logins and Git access; in a [per-person workspace](/operate/per-person-workspaces/) each
turn runs on its sender's login. Read
[Organizations](/organizations/overview/#who-steers-a-session).

## Browser

The web app lists the same projects and sessions. Use it to follow output, open a shell, inspect
project setup, review the current change and land it.

The [desktop app](/clients/desktop/) is not part of the 0.36 release: it has no published build, and
runs only from source.

## VS Code

The [VS Code extension](/clients/vscode/) lists projects and sessions, opens a session's terminal
over the web port, opens its review in the browser, and opens its workspace over Remote-SSH, which
needs the workspace SSH port too. It signs in with the browser, as `mend login` does.
[Mac mini and VS Code](/operate/mac-mini-vscode/) walks through a server on one machine and VS Code
on another.

A browser disconnect does not define session status. Reopening the session resumes from its durable
record.

## Phone

The responsive web app is the no-install phone path. The phone app under `apps/mobile` is not
published, and the Mend server does not serve its web build; from a checkout,
`pnpm --filter @mend/mobile web` runs it in a browser. In it, a session's conversation shows the
change's pull request ([Land a change](/guides/land-a-change/#where-the-pull-request-shows)) and a
Claude workflow's card while it runs. In the browser, **Stop session** and the other actions that
ask first do nothing; stop a session from the web app or with `mend stop`. Read
[Phone](/clients/phone/) for how to open it, pair it, and what it does.

Mobile is for steering, terminal access, session status, development-service links, and review. It
is not intended to replace a full editor.

## Slack

An organization can connect its own Slack app. A Slack thread then starts sessions and receives
their reports, and `@mend <prompt>` in the thread sends a follow-up. Read
[Slack](/integrations/slack/).

## Development services

A declared Service runs in a session workspace. `mend service connect <name>` binds its port on your
own machine's loopback over an authenticated WebSocket, on every deployment shape, with no extra
network exposure. `mend service run` opens that tunnel by itself when the CLI points at a
non-loopback server URL; against a server reached at `localhost` it prints the raw forward instead,
so run `mend service connect` explicitly there. That raw host forward is bound by the Mend server
process itself; in the Docker deployment that is the application container, not the Docker host.

Services the agent or the web started need no command of yours. While `mend attach`, `mend codex`,
`mend claude`, `mend rejoin`, or the dashboard is attached to a session on a remote server, each
live Service declared `--http` or `--https` is tunneled to your loopback, on its own port when that
port is free. `--no-tunnel` turns this off. Looking at a remote server, the web app shows
`mend service connect <name>` where an Open link to the server's loopback would not load.

Raw forwarded ports do not pass through Mend request authentication; when you expose one directly,
the private network is the access boundary. Declare HTTP or HTTPS before presenting a Service as a
browser link.
