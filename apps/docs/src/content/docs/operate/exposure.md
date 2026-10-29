---
title: Exposure and the public gate
description:
  How you tell Mend who can reach it, what Mend observes beside that, the public exposure gate, the
  TLS edge, upgrade tickets, budgets and the browser header policy.
sidebar:
  order: 3
---

Mend authenticates and authorizes every request itself. A tailnet, a LAN or a VPN in front of it is
an extra gate you may add, and Mend never reads a network's headers as identity. So a private
network is one way to run Mend, and you tell Mend which way you chose with `MEND_EXPOSURE`.

Nothing on this page says an instance is fit to expose to the Internet. That needs an independent
security reassessment of the exact release you run, and Mend reports it as open until you record
one.

## Declare how the instance is reached

| Value      | Meaning                                                                                |
| ---------- | -------------------------------------------------------------------------------------- |
| `loopback` | Reached from this machine only.                                                        |
| `private`  | Reached over a network you control admission to: a tailnet, a LAN, a VPN. The default. |
| `public`   | Reachable from the Internet. Refuses to start while an item Mend can observe is open.  |

The value is your statement. A server cannot observe what is published in front of its container, so
Mend reports what it can observe beside what you declared. `loopback` and `private` differ only in
that report: neither refuses to start. Only `public` refuses.

Where you set it:

- On Kubernetes, `exposure.mode` in the chart's values (`loopback`, `private` or `public`; the chart
  refuses to render anything else). See [the Helm values](#kubernetes-ingress) below.
- On the Docker install made by `mend server setup`, from the answer to its first question (just
  this machine is `loopback`, a private network or Tailscale is `private`, the public internet with
  HTTPS is `public`), or with `--exposure`: `mend server setup --exposure private` writes it into
  the installation's generation and every rerun and upgrade keeps it. Without the flag the install
  runs the default, `private`. `public` needs [the edge](#the-caddy-edge) and an existing first
  account, and with it setup also sets the multi mode gate's variables and
  `MEND_URL_BEARERS=refuse`.

## What Mend reports

Each item Mend reports carries how it was established:

| Word       | Meaning                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `observed` | This server read it, in effect, on this instance.                                                    |
| `carried`  | This build contains it, and the server cannot see it in effect. The item says what would observe it. |
| `declared` | You stated it, and the server cannot check it.                                                       |
| `open`     | None of those.                                                                                       |

`mend doctor` prints one `exposure` line: what you declared, the origin's scheme, whether the
request arrived through a trusted proxy, and, when the origin is reachable beyond the machine, how
many gate items are open.

```text
✓ exposure    declared private · https origin · arrived via a trusted proxy · 5 gate items open → mend operator exposure
```

A browser origin still on plain `http` while the instance is reached from other machines turns the
line amber:

```text
○ exposure    declared private · http origin · 5 gate items open → serve it over https: on the server's machine, mend server setup --edge <domain>, or mend server setup --url https://<origin> behind HTTPS you run
```

A laptop install on `http://localhost` prints `declared private · http origin` and nothing more.
There is no tailnet check: a missing tailnet is not a finding.

`mend operator exposure` (operator only) prints the whole gate, one line per item. This is its
output for an instance behind the Caddy edge below, with the default budgets and the operator source
policy:

```text
exposure · declared private · reached over a network you control admission to
● https-origin                observed  every browser origin is https (1)
● secure-cookies              observed  session cookies are Secure, HttpOnly and SameSite=Lax
● trusted-proxies             observed  1 trusted proxy range(s)
◐ enrollment-closed           carried   this build closes registration after the first account; everyone else joins by invitation · what would observe it: a sign-up without an invitation, from outside, answering a refusal
· tenancy-gate                open      open multi mode gate item(s): source-policy, source-address-pinning, upload-length-binding · close them: mend operator gate
● budgets                     observed  every budget is set
· no-bearers-in-urls          open      a bearer in a URL is still accepted, for clients older than upgrade tickets · set MEND_URL_BEARERS=refuse once every client sends tickets
◐ browser-headers             carried   this build's web tier sets the browser header policy; the API cannot see the web tier that is actually in front of it · what would observe it: mend doctor against the public origin, which reads the headers a browser receives
● error-redaction             observed  error responses are scrubbed of upstream detail
○ executor-channel-transport  declared  the session channel is plain http, and the operator declared the executor network private (MEND_EXECUTOR_NETWORK=private)
● workspace-ssh               observed  workspace SSH is not published apart from the web port (MEND_SSH_PUBLISHED unset)
· core-private                open      this process cannot observe whether Sealant, its registry, the database and the package mirrors (npm-mirror:4873, docker-mirror:5000) are reachable from the Internet · what would verify it: a connection attempt to each from outside the deployment's network; then add core-private to MEND_EXPOSURE_DECLARED
· edge-tls                    open      this process cannot observe the edge's certificate, its renewal, or its port 80 redirect · what would verify it: mend doctor run against the origin from another network; then add edge-tls to MEND_EXPOSURE_DECLARED
· reassessment                open      no independent reassessment of 0.36.0 is recorded · after an independent security reassessment of this exact release, set MEND_EXPOSURE_REASSESSED=0.36.0
5 of 14 items open · 2 refuse a public start; MEND_EXPOSURE=public refuses to start · 3 do not
```

When nothing is open, the last line reads
`nothing open · every item was observed here, is carried by this build, or was declared by the operator`.
That is a statement about this list. It carries no check mark and no colour of success.

`/health` needs no sign-in, so it carries only the declaration and how many items are open, never
which ones.

## The public exposure gate

The gate has fourteen items, one more while the t3code gateway is enabled, and one more while the
[preview gateway](#previews) is on. The first eleven can be established by this build, or are stated
by you for what it cannot see; an open one among them refuses a `public` start. The rest cannot be
observed from inside the deployment, are reported as open until you state otherwise, and never block
a start.

| Item                         | Established by        | What closes it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https-origin`               | observed              | `APP_URL` and every `MEND_ALLOWED_ORIGINS` entry are `https`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `secure-cookies`             | observed              | Session cookies are `Secure`, `HttpOnly` and `SameSite=Lax`, which follows from an `https` `APP_URL`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `trusted-proxies`            | observed              | `MEND_TRUSTED_PROXIES` is set to the ranges of the edge and the web tier, and does not trust every address (`/0`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `enrollment-closed`          | carried               | Nothing to set. Registration closes after the first account; everyone else joins by invitation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `tenancy-gate`               | observed              | Every item of the multi mode gate is closed, in either tenancy mode (`mend operator gate`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `budgets`                    | observed              | Every [budget](#budgets) is set to a positive number; none is `0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `no-bearers-in-urls`         | observed              | `MEND_URL_BEARERS=refuse`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `browser-headers`            | carried               | Nothing to set. The web tier sets the header policy; the API cannot see which web tier is in front of it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `error-redaction`            | observed              | `MEND_ERROR_DETAIL` is unset.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `executor-channel-transport` | observed, or declared | The session channel is advertised over `https`, or `MEND_EXECUTOR_NETWORK=private` states that executors reach it over a network you control (reported as declared). A channel over a mounted socket reads observed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `workspace-ssh`              | observed, or declared | Workspace SSH is not published apart from the web port, or only on loopback (observed). Published elsewhere with `mend server setup --ssh-bind` (`MEND_SSH_PUBLISHED`), it is open until you checked from each network that should not reach it, and named it in `MEND_EXPOSURE_DECLARED` (`--declare workspace-ssh`). The gateway admits registered keys only, and a workspace only for its launcher; who reaches the port is not something the server can see. Before login it holds each source (an IPv4 address or an IPv6 /64) to sshd-like limits, which need it to see each client's own address.                                                                                                                                                                                                                                                                                    |
| `core-private`               | open until declared   | You checked from outside that Sealant, its registry, the database and any package mirrors answer nothing from the Internet, and named it in `MEND_EXPOSURE_DECLARED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `edge-tls`                   | open until declared   | You checked from another network that the certificate chains to a public root, renews, and that port 80 redirects, and named it in `MEND_EXPOSURE_DECLARED`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `t3code-gateway`             | observed, or declared | Listed while the [t3code gateway](/integrations/t3code/) is enabled, whether or not it is answering (`mend server status` says that). Its port published on loopback only (`MEND_T3_GATEWAY_PUBLISHED`) reads observed. Published on a private address, where Mend's web port is, it is open until you checked from each network that should not reach it and named it in `MEND_EXPOSURE_DECLARED`; an open one refuses a `public` start, as `workspace-ssh` does, and setup never publishes it beyond loopback on a public install. Served by the edge on its own origin (`--t3-gateway-origin`), it is open until you checked that origin's certificate from another network and named it. Every device pairs through Mend, wherever it is published.                                                                                                                                     |
| `preview-gateway`            | observed, or declared | Listed while the preview gateway is on (`MEND_PREVIEW_PORT`). The server observes that previews sit apart from Mend's origin, and on its registrable domain that Mend's cookies carry `__Host-`, their scheme, and where the gateway listens against where setup published its port (`MEND_PREVIEW_PUBLISHED`); the build carries the bounded forward. Previews on `http://<label>.localhost` read observed only under `MEND_EXPOSURE=loopback` with the gateway on loopback, and open otherwise. With a preview domain, it is open until you checked from another network the wildcard DNS, the certificate and who reaches the listener, and named it in `MEND_EXPOSURE_DECLARED`. On the tailnet default it observes that Mend's cookies carry `__Host-`, which they do whenever `APP_URL` is `https:`, and stays open while `APP_URL` is `http:`. An open one refuses a `public` start. |
| `reassessment`               | open until declared   | `MEND_EXPOSURE_REASSESSED` equals the running version. An upgrade reopens it. A build with no version of its own (`dev`) stays open.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

`MEND_EXPOSURE_DECLARED` takes a comma-separated list, and only `core-private`, `edge-tls`,
`workspace-ssh`, `t3code-gateway` and `preview-gateway`. `mend server setup` writes it: its
questions ask, on a public install, what you checked from outside, and `--declare <item>` adds one
statement to the saved ones (`--undeclare <item>` takes one back, `--declare none` clears them). Any
other name refuses to start, because every other item is read by the server or not at all:

```text
MEND_EXPOSURE_DECLARED names budgets: only core-private, edge-tls, workspace-ssh, t3code-gateway, preview-gateway can be declared; every other item is observed by this process or not at all.
```

A `public` start with an observable item open fails with the list of what is open and the fix for
each, and ends with
`Start with MEND_EXPOSURE=private behind a network you control admission to, or close them.` It
appears in `mend server logs` on Docker, or in the API Pod's log on Kubernetes.

The `tenancy-gate` item includes every item of the multi mode gate, whatever `MEND_TENANCY` is:

```text
✓ cross-organization-authorization  every route is classified and refuses across organizations with zero effects (project-access.test.ts)
✓ per-account-resources             signers, push devices, notifications and GitHub identity belong to one account
✓ folders-reach-workspaces          folders and references travel with the plan as content-addressed archives, laid down beside the worktree (needs sealantd 0.16.0 or newer)
· source-policy                     Mend's own git follows the operator source policy · set MEND_SOURCE_POLICY=tenant
· source-address-pinning            the operator source policy leaves git to resolve names itself · set MEND_SOURCE_POLICY=tenant
✓ transport-bound-to-origin         a workspace's git transport signs only against its project's remote
· upload-length-binding             capture uploads without a declared size are accepted · set MEND_CAPTURE_REQUIRE_SIZES=true with an S3-compatible MEND_BLOB_STORE
✓ daemon-declares-sizes             sealantd declares the length of every upload it asks a URL for (sealantd 0.16.0 or newer)
✓ raw-service-ports                 raw service listeners stay on loopback
✓ operator-present                  1 operator account(s)
3 of 10 items open; MEND_TENANCY=multi refuses to start
```

That is `mend operator gate` on the same instance. `operator-present` means an instance with no
operator account refuses `public`: until the first account exists, registration is open to whoever
arrives first.

### Before you declare public

- Create the first account over a private path, then declare `public`.
- Set `MEND_SOURCE_POLICY=tenant` and `MEND_CAPTURE_REQUIRE_SIZES=true` with an S3-compatible
  `MEND_BLOB_STORE`, and keep `MEND_SERVICE_HOSTS` on loopback, so the multi mode gate is closed.
- Set `MEND_URL_BEARERS=refuse` once the CLI, VS Code and phone builds you use send upgrade tickets.
- Keep every budget on.
- Keep Sealant, Postgres and the bucket off any public address. Sealant is a control plane behind
  Mend and is never offered to the Internet.

On the Docker install, `mend server setup --exposure public` does the second and third for you,
through a `compose.posture.yaml` the generation carries, and `--tenancy multi` does the second. The
bucket is Garage, which is S3-compatible. Every variable named here is described in
[Server environment](/reference/server-environment/).

## The edge

Mend does not terminate public TLS in its own process. An edge (a reverse proxy, an ingress
controller or a load balancer) holds the certificate and forwards to Mend's web tier, which serves
the app and proxies `/api`, the event stream and every WebSocket on that one origin. There is no
second API hostname and no separate terminal listener.

Mend is told the truth about the edge through three settings:

- `APP_URL` is the exact browser origin, `https://` when the instance is reached beyond the machine.
  Alternate origins are an exact list in `MEND_ALLOWED_ORIGINS`. No wildcard, and no discovery from
  `Host` or forwarded headers.
- `MEND_TRUSTED_PROXIES` names the hops whose `X-Forwarded-For` entries Mend believes. Mend takes
  the rightmost entry that is not a trusted hop, so a client cannot choose the address it is counted
  by.
- Session cookies are `Secure`, `HttpOnly` and `SameSite=Lax` whenever `APP_URL` is `https:`, and
  named `__Host-` (`__Host-better-auth.session_token`): host-only on Mend's host with `Path=/`, so
  no other host on Mend's site can set or replace them. Over `http:` the name has no prefix.
- A request that carries Mend's session cookie and that the browser marks as coming from another
  site or a sibling host (`Sec-Fetch-Site: same-site` or `cross-site`) is refused with `403` unless
  it names an allowed `Origin` or is a top-level navigation by `GET`. A preview on Mend's own site,
  as on a tailnet's `ts.net` default, then cannot act as the person signed in to Mend through an
  image, a script or a `fetch`, and a link to Mend from anywhere still opens. A browser that sends
  no Fetch Metadata, such as Safari before 16.4, gets only the `Origin` check, which covers writes
  and upgrades but not a `GET` such as an image.

### The Caddy edge

`deploy/docker/compose.edge.yaml` and `deploy/docker/Caddyfile` add a Caddy edge in front of the
Docker bundle. Caddy obtains and renews a certificate for one host, redirects port 80, and forwards
everything to Mend's web tier.

On the Docker install, `mend server setup` installs it:

```sh
mend server setup --edge mend.example.com
```

The CLI carries a copy of the two files and writes them into the installation's generation beside
`compose.yaml`, with `MEND_EDGE_HOST` in `server.env`. The browser origin becomes
`https://mend.example.com`, Mend's own port stays on loopback, and every `mend server start`,
`restart` and `upgrade` runs the overlay with `compose.yaml`, so an upgrade never drops it.
`mend server setup --no-edge` takes it away again, and removes the edge's container. Setup refuses
`--bind` on anything but loopback with an edge, a `--url` that is not exactly `https://<host>`,
`--port` or `--ssh-port` on 80 or 443, and `--edge` or a public `--bind` address on a fresh install:
until the first account exists, registration is open to whoever reaches the origin first, so the
account is created on localhost before the edge is added. On an existing install, a run that
publishes Mend's port or workspace SSH on a public address without the edge says so beside the
declared exposure.

For a certificate to be issued, the name's DNS must point at the machine and ports 80 and 443 must
reach it from the Internet. `mend server status` says whether the edge's container runs and whether
Caddy's data holds a certificate for the host, and `mend server logs` shows what Caddy tried.

For a Compose project you run by hand, from `compose.v2.yaml` and an `.env` holding the values that
file names (`deploy/docker/bundle.env.example` lists them), the same two files apply as an overlay:

```sh
# in the directory that holds compose.v2.yaml and your .env,
# after copying Caddyfile and compose.edge.yaml there from the release tag
cat >> .env <<'ENV'
MEND_EDGE_HOST=mend.example.com
APP_URL=https://mend.example.com
MEND_EXPOSURE=private
ENV
docker compose -f compose.v2.yaml -f compose.edge.yaml up -d
```

What the overlay does, and what it states on your behalf:

- The edge publishes 80 and 443 (`MEND_EDGE_BIND_HOST`, default `0.0.0.0`). Mend's own port stays on
  loopback (`MEND_BIND_HOST`), so the way in from outside is through TLS. A public certificate puts
  the hostname in certificate transparency logs.
- The edge carries HTTPS only. Workspace SSH (Remote-SSH from VS Code, `mend ssh`) stays on loopback
  with the web port unless you publish it on its own: `mend server setup --ssh-bind 0.0.0.0` (or a
  private address). The gateway admits only registered keys, and a workspace only to the person who
  launched it.
- The edge shares a network with Mend alone. It cannot reach Postgres, the bucket or a workspace.
- `MEND_TRUSTED_PROXIES` defaults to exactly the edge's network, `192.168.250.0/28`. Set
  `MEND_EDGE_SUBNET` when that range is already routed where the host lives, and the trusted range
  follows it.
- `MEND_EXECUTOR_NETWORK=private`: workspaces reach the session channel and Garage over plain HTTP
  on the Compose network, which never leaves the host. Mend reports this as declared.
- `MEND_EXPOSURE` (default `private`), `MEND_URL_BEARERS` (default `accept`),
  `MEND_EXPOSURE_REASSESSED` and `MEND_EXPOSURE_DECLARED` pass through from your `.env`. On the
  Docker install, `--exposure` writes the first two.
- The edge's log keeps a request's path on Mend's origin and nothing else of its URL, on any route.
  From the first `?` or `#` on, the URL reads `?REDACTED` or `#REDACTED`, so no line holds a
  socket's single-use ticket, a pairing code or any other query value. The userinfo of an
  absolute-form, opaque or `CONNECT` target reads `REDACTED`. A `Location` response header, such as
  the port-80 redirect's, is cut the same way. This holds for the access line and for Caddy's error
  line about a request, such as a failed dial. The cost is that an access line no longer shows an
  ordinary query.
- Every other line holds no URL and no `Location`. That covers the t3code gateway's origin
  (`--t3-gateway-origin`), where an image's URL path is its token and file name. It covers a request
  whose `Host` spells a site's name in another case or with a trailing dot, since Caddy names a
  line's log by the exact `Host`, and the port-80 redirect for one. It covers Caddy's line for a
  response cut short (`aborting with incomplete response`), which Caddy names for the proxy rather
  than the site; on Mend's origin the access line from the same `remote_port` holds the path.
- The edge drops the `Referer` header, and Caddy redacts `Authorization`, `Cookie` and `Set-Cookie`.
  The other request and response headers are logged as Caddy writes them, except the raw route's
  `X-Mend-File-*` headers, which the edge strips: only the t3code gateway reads them, from Mend over
  loopback.

What was checked: the merged files render, and the Caddyfile validates with Caddy. What was not: a
certificate issued and a browser session through it, end to end. Workspace SSH on port 2222 stays on
the loopback bind with the edge, since Caddy proxies HTTP alone, until `--ssh-bind` publishes it.

### Kubernetes Ingress

The chart renders an Ingress to the web Service only, on one host, with TLS. It does not install a
controller or an issuer.

```yaml
web:
  appUrl: https://mend.example.com
api:
  trustedProxyCidrs: ["10.244.0.0/16"] # the controller's Pods and the web tier, nothing wider
ingress:
  enabled: true
  className: nginx
  host: mend.example.com
  tls:
    secretName: mend-tls
  controller:
    namespace: ingress-nginx
    podLabels: { app.kubernetes.io/name: ingress-nginx }
exposure:
  mode: private
  executorNetwork: private # or sessionChannel.tls.enabled: true
  refuseUrlBearers: false
  reassessedVersion: ""
  declared: [] # core-private, edge-tls
```

The chart refuses to render when `web.appUrl` is not exactly `https://<ingress.host>`, when
`ingress.tls.secretName` is empty, or, with network policies on, when the controller's namespace and
Pod labels are missing. It also refuses a plain-http session channel unless
`exposure.executorNetwork` is `private`. The controller must not log query strings on `/api/tty`,
`/api/service-tunnel`, `/api/keys/bridge/ws` and `/tty-embed`; the chart cannot configure that for
you. See [Deploy on Kubernetes](/operate/deploy-kubernetes/) for the rest of the chart.

### Your own reverse proxy

A proxy you run in place of either must do five things:

1. Terminate TLS for exactly the `APP_URL` origin.
2. Forward to the web tier only, never to the API, Sealant, the session channel or the bucket.
3. Pass WebSocket upgrades, and never buffer or time out `/api/events`.
4. Append the client address to `X-Forwarded-For`, and be listed in `MEND_TRUSTED_PROXIES`.
5. Keep the query strings of `/api/tty`, `/api/service-tunnel`, `/api/keys/bridge/ws`, `/tty-embed`
   and `/pair` out of its logs.

### Previews

Live previews are served on hosts of their own, `https://<label>.<preview domain>`, apart from
Mend's host, so a page on a preview cannot act as Mend. On the Caddy edge, setup adds their site:

```sh
mend server setup --preview-domain previews.example.net \
  --preview-certificate /etc/mend/previews.crt --preview-key /etc/mend/previews.key
```

The domain must be neither Mend's host nor above or below it. `previews.example.com` beside
`mend.example.com` shares Mend's registrable domain and is allowed while Mend's URL is https: Mend's
cookies are `__Host-` there, so a page on a preview can neither set nor replace them, and Mend
refuses a request carrying its cookie from a sibling site unless it is a top-level navigation. Every
other host on `example.com` receives the cookies a preview's page sets, so give previews a
registrable domain of their own if any of those hosts keeps a session in a cookie without `__Host-`.
Without a domain, `mend server setup --preview-tailnet` serves previews on a tailnet's `ts.net`
name.

A wildcard certificate needs the DNS-01 challenge, which the packaged Caddy cannot do, so you supply
a certificate for `*.previews.example.net` and its key, issued elsewhere. Setup copies both into the
install on every run, after the edge's own container has loaded them; to serve a renewed
certificate, replace the files and run `mend server setup --yes`. The preview gateway's port is
published on `127.0.0.1` only, and the edge logs no path, query or `Referer` for preview hosts: the
sign-in exchange carries a single-use ticket in its query. Any edge you run in front of previews
must keep that query out of its logs too. On Kubernetes the chart's `preview.*` values render a
second Ingress for `*.<preview domain>` (see [Deploy on Kubernetes](/operate/deploy-kubernetes/)).

The gate's `preview-gateway` item stays open until you checked from another network that
`*.previews.example.net` resolves to the edge, that the certificate chains to a public root, and who
reaches the gateway, and stated it with `mend server setup --declare preview-gateway`. On a public
install Mend does not start while it is open, so setup refuses previews there until you state it.

## Upgrade tickets

A browser cannot set a header on a WebSocket, and a WebView cannot set one on a page load. Those are
the two places a credential has to ride a URL, so Mend puts an upgrade ticket there instead of a
long-lived bearer.

- A client mints one with `POST /api/upgrade-tickets`, authenticated by its cookie or its
  `Authorization` header. The ticket is single use and lives thirty seconds.
- It is bound to the account, to one target (`tty`, `service-tunnel`, `keys-bridge` or `tty-embed`),
  to that target's exact parameters (the process or session, the service, the bridge host), and to
  the sign-in or paired device that minted it. Only its hash is stored.
- The terminal socket (`/api/tty`), the service tunnel (`/api/service-tunnel`) and the key bridge
  (`/api/keys/bridge/ws`) accept it as `?ticket=`. Signing out, revoking a device or removing a
  member ends every ticket that credential minted.
- The terminal embed (`/tty-embed`, which the phone's WebView loads) trades its ticket for a socket
  ticket and a renewal ticket. The renewal ticket stays in the page's memory, travels only in a
  request body, and ends twelve hours after the app minted the URL, or with its credential.
- First-party clients mint a ticket per connection: the CLI (terminal, service tunnel, key bridge),
  the VS Code extension, and the phone. An `Authorization` header on the upgrade still works for a
  client that can set one.

When the mint answers 404 but `/health` says the server mints tickets, the CLI refuses to connect
rather than put its saved token in a URL:

```text
POST /api/upgrade-tickets answered 404, but this server mints upgrade tickets: something between this client and Mend is refusing it. The saved token was not put in a URL.
```

### Bearers in URLs

Older clients put their bearer in `?token=`. `MEND_URL_BEARERS` decides what happens to it:

- `accept` (the default, for one release): the bearer is read, and the server logs
  `a bearer arrived in a URL; this client predates upgrade tickets` with the value redacted. It is
  an open gate item.
- `refuse`: the socket answers 400 with
  `a bearer in the URL is refused; mint an upgrade ticket (POST /api/upgrade-tickets)`.

On Kubernetes, `exposure.refuseUrlBearers: true` sets it to `refuse`.

## Budgets

A budget bounds what one client address, one credential, one account or one organization may ask of
the instance. Reaching one refuses new work with `429` (or `413` for a body), the budget's name, and
for a request window, `Retry-After`. The refusal reads like
`budget reached · 4 launches starting at once for one account · nothing running was stopped`. A
budget never stops a running session, never closes a connection that is already open and never drops
a capture.

| Variable                                       | Default    | What it bounds                                                                                                               |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `MEND_BUDGET_BODY_BYTES`                       | `1048576`  | One request body. A declared length over it is refused unread; an undeclared one is cut at it.                               |
| `MEND_BUDGET_UPLOAD_BODY_BYTES`                | `25165824` | The same, for routes that take a file: pasted images, skills, folder uploads, dotfiles, the workspace image.                 |
| `MEND_BUDGET_FRAME_BYTES`                      | `1048576`  | One WebSocket frame from a client on a terminal, a service tunnel or the key bridge. Over it, the socket closes 1009.        |
| `MEND_BUDGET_ADDRESS_REQUESTS_PER_MINUTE`      | `1200`     | Requests from one client address, counted before authentication.                                                             |
| `MEND_BUDGET_CREDENTIAL_REQUESTS_PER_MINUTE`   | `1200`     | Requests presenting one credential (Mend's session cookie by its exact name, or a bearer), valid or not.                     |
| `MEND_BUDGET_SIGN_IN_ATTEMPTS_PER_MINUTE`      | `20`       | Sign-in, sign-up, password reset and invitation attempts from one address.                                                   |
| `MEND_BUDGET_ACCOUNT_LIVE_SESSIONS`            | `24`       | Unsettled sessions one account holds.                                                                                        |
| `MEND_BUDGET_ORGANIZATION_LIVE_SESSIONS`       | `120`      | Unsettled sessions one organization holds.                                                                                   |
| `MEND_BUDGET_ACCOUNT_LAUNCHES_IN_FLIGHT`       | `4`        | Launches one account has starting at once.                                                                                   |
| `MEND_BUDGET_BUNDLE_BYTES`                     | `67108864` | One git bundle: a `mend pull` answer, refused with its size, or a `mend handoff` body, refused unread.                       |
| `MEND_BUDGET_HANDOFF_FILE_BYTES`               | `8388608`  | One file `mend handoff` carries. The CLI names a larger file and leaves it in the checkout; the server refuses one it finds. |
| `MEND_BUDGET_ACCOUNT_HANDOFFS_IN_FLIGHT`       | `2`        | Handoffs one account has admitted at once. Each holds its bundle in memory while git verifies it.                            |
| `MEND_BUDGET_ACCOUNT_ORIGIN_CHECKS_PER_MINUTE` | `30`       | Fetches of origin's branch one account asks for ("Check origin").                                                            |
| `MEND_BUDGET_ACCOUNT_EVENT_STREAMS`            | `12`       | Open event streams for one account (one per browser tab or client).                                                          |
| `MEND_BUDGET_ACCOUNT_TERMINALS`                | `24`       | Open terminal sockets for one account.                                                                                       |
| `MEND_BUDGET_ACCOUNT_TUNNELS`                  | `24`       | Open service tunnels for one account.                                                                                        |
| `MEND_BUDGET_ACCOUNT_KEY_BRIDGES`              | `4`        | Open key bridges (ssh-agent shares) for one account.                                                                         |
| `MEND_BUDGET_ACCOUNT_RAW_READS`                | `128`      | Raw file reads one account has open at once (the t3code gateway's previews and media).                                       |
| `MEND_BUDGET_RAW_READS`                        | `512`      | Raw file reads open at once on the instance, whoever reads.                                                                  |

`0` turns one budget off. The API logs at start which are off, and the `budgets` gate item is open
while any is.

A few facts about how they count:

- The client address is the socket's address, or, when the socket is a trusted hop, the rightmost
  `X-Forwarded-For` entry that is not itself a trusted hop. IPv6 is counted by its /64. A loopback
  socket with no `X-Forwarded-For` (a process on the machine itself) is not counted by address, but
  its sign-in attempts are.
- Request windows are in memory, per API process. The API runs as one process today.
- Session ceilings are counted from the database, so two requests that arrive together can both
  pass: a ceiling can be overshot by the number in flight, never by more.
- Resuming a session or opening a shell takes no launch slot.
- A WebSocket frame is buffered by the server up to 100 MiB before Mend can refuse it. The frame
  budget and the connection budgets together bound the total; they do not bound that single frame.

## Error detail

Every error response leaves the API through one boundary. A declared error crosses with its message,
scrubbed of what arrived from below: server paths (the file name is kept), internal hosts, URL
credentials and queries, bearers, JWTs and long secret-shaped strings. A defect crosses as
`InternalError` with a reference, and its detail goes to the log under that reference.

`MEND_ERROR_DETAIL=verbose` turns the scrubbing off, for an operator debugging a private instance.
The server logs a warning at start when it is on, and the `error-redaction` gate item is open.

## Browser headers

The web tier sets one header policy on every response it relays, the app's and the API's alike. It
has no off switch.

- `Content-Security-Policy`: scripts, connections, workers, forms and the base URI from this origin
  only. `'unsafe-inline'` and `'wasm-unsafe-eval'` are allowed for scripts (the terminal is
  WebAssembly, and the page carries inline scripts until they get a nonce), `data:` is allowed in
  `connect-src` because the terminal library loads its WebAssembly from a `data:` URL,
  `object-src 'none'` and `frame-ancestors 'none'`.
- `X-Content-Type-Options: nosniff` and `X-Frame-Options: DENY`.
- `Referrer-Policy: strict-origin-when-cross-origin`, and `no-referrer` on `/tty-embed`, `/pair` and
  `/authorize`, whose URLs carry a credential.
- A `Permissions-Policy` that turns off the camera, microphone, geolocation, payment, USB, motion
  sensors and topics. The clipboard stays, because the terminal pastes.
- `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Resource-Policy: same-origin`.
- `Strict-Transport-Security: max-age=31536000` when `APP_URL` is `https`, for this host only, with
  no `includeSubDomains`.

The API sets `nosniff`, `DENY`, `no-referrer` and `default-src 'none'` on every answer of its own,
for anything that reaches it without the web tier in front.
