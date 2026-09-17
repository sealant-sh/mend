---
title: Work from another device
description: Reach the same Mend sessions from a browser, desktop, phone, or another terminal.
sidebar:
  order: 6
---

The work stays on the Mend machine. Other devices attach to it.

A terminal attachment, browser tab, desktop window, or phone is a client of the same session.
Closing one does not stop the agent, delete the worktree, or move the development service.

```mermaid
flowchart LR
  laptop[Laptop CLI]
  browser[Browser]
  desktop[Desktop app]
  phone[Phone]
  private[Private network]
  mend[Mend machine]
  session[Session workspace]

  laptop --> private
  browser --> private
  desktop --> private
  phone --> private
  private --> mend --> session
```

## Use a private network

Web and workspace SSH bind to localhost by default. Exposing them on a private network is an
explicit choice when you set up the server:

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
is reached with `MEND_EXPOSURE`: `loopback` (the default), `private` (a network you control
admission to) or `public`. A server cannot observe what is published in front of it, so this is your
statement, and `mend doctor` reports what Mend observes beside it.

Plain HTTP on a LAN does not protect credentials from that network. Beyond the machine, put a TLS
edge in front of Mend: the bundle ships an opt-in Caddy overlay, and the chart can render an Ingress
to the web tier. Test a terminal through it before relying on it.

`public` refuses to start while an item of the public exposure gate that Mend can observe is open.
`mend operator exposure` lists them. The last items are yours to verify, an independent security
reassessment of the exact release among them. Nothing in Mend says an instance is fit to expose to
the Internet.

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

After a successful claim, the new device receives its own revocable token. Revoke devices from
**Settings**.

Current device tokens have normal authenticated API access. Read-only and control scopes are planned
but not enforced yet. Pair only devices and users you trust with the whole Mend instance.

## Reattach from another terminal

Install the Mend CLI on the second machine, point it at the server, and sign in:

```sh
mend login --url http://mend-host:3105
mend sessions
mend attach <session-id-prefix>
```

`mend attach` replays the terminal stream and then follows live output. Press `Ctrl+]` to detach
without stopping the process. Set `MEND_DETACH_KEY=none` when an outer terminal multiplexer owns the
detach key.

## Browser and desktop

The web and desktop apps list the same projects and sessions. Use them to follow output, open a
shell, inspect project setup, and review the current change.

A browser disconnect does not define session status. Reopening the session resumes from its durable
record.

## Phone

The responsive web app is the no-install phone path. The native client under `apps/mobile` is not
published yet.

Mobile is for steering, terminal access, session status, development-service links, and review. It
is not intended to replace a full editor.

## Development services

A declared Service runs in a session workspace. `mend service connect <name>` binds its port on your
own machine's loopback over an authenticated WebSocket, on every deployment shape, with no extra
network exposure. `mend service run` opens that tunnel by itself when the CLI points at a
non-loopback server URL; against a server reached at `localhost` it prints the raw forward instead,
so run `mend service connect` explicitly there. That raw host forward is bound by the Mend server
process itself; in the Docker deployment that is the application container, not the Docker host.

Raw forwarded ports do not pass through Mend request authentication; when you expose one directly,
the private network is the access boundary. Declare HTTP or HTTPS before presenting a Service as a
browser link.
