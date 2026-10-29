# The preview gateway

The preview gateway is the API process's own listener for live previews
([ADR 0017](../adr/0017-live-preview.md), "The preview gateway"). It admits a browser with a grant,
relays its requests to the preview's dev server over a forward, and starts a stopped preview when a
request reaches it. It is off until `MEND_PREVIEW_PORT` is set. It runs where the API's HTTP server
runs (`MEND_MODE=all` or `api`) and never in `MEND_MODE=worker`.

## Variables

The API reads them once, at start. A malformed value, or a combination that cannot run, stops the
API with a message that names the variable. An empty value counts as unset.

| Variable                        | Default       | What it sets                                                                                                                                               |
| ------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEND_PREVIEW_PORT`             | unset (off)   | The gateway's listen port. Required once any `MEND_PREVIEW_*` variable is set.                                                                             |
| `MEND_PREVIEW_BIND`             | `127.0.0.1`   | The address it listens on, an IP address or `localhost`.                                                                                                   |
| `MEND_PREVIEW_DOMAIN`           | unset         | The preview domain. Each preview is `https://<label>.<domain>`, behind an edge. Takes over from a tailnet hostname.                                        |
| `MEND_PREVIEW_PUBLIC_PORT`      | `443`         | The port browsers use on the edge, with `MEND_PREVIEW_DOMAIN` only.                                                                                        |
| `MEND_PREVIEW_TAILNET_HOSTNAME` | unset         | The gateway's name on a tailnet, such as `mend-preview.<tailnet>.ts.net`. Never Mend's own host.                                                           |
| `MEND_PREVIEW_TAILNET_PORTS`    | `20001-20016` | The ports Mend gives previews on that name, as ports and ranges, comma-separated in ascending order, such as `20001-20016` or `20001,20003`. At most 1000. |
| `MEND_PREVIEW_START_HOLD`       | `3 minutes`   | How long a request waits for a stopped preview to start, such as `90 seconds`. At least 1 second.                                                          |
| `MEND_PREVIEW_BODY_BYTES`       | unset         | A cap on one request body, in bytes, counted as it streams. Unset means no cap.                                                                            |
| `MEND_PREVIEW_PUBLISHED`        | unset         | Where the gateway's port is published, `<address>:<port>`, as setup states it. Read only by the public exposure gate's `preview-gateway` item.             |

How browsers reach a preview follows from what is set:

- **Loopback, with a port alone.** A preview is `http://<label>.localhost:<MEND_PREVIEW_PORT>`. The
  browser's port is the listen port, so `MEND_PREVIEW_PUBLIC_PORT` is refused here.
- **Behind an edge, with a domain.** A preview is
  `https://<label>.<MEND_PREVIEW_DOMAIN>:<MEND_PREVIEW_PUBLIC_PORT>`, and the edge terminates TLS
  for `*.<MEND_PREVIEW_DOMAIN>`. The API refuses a preview domain that equals one of Mend's own
  hosts (`APP_URL`, `MEND_ALLOWED_ORIGINS`), holds one of them, or sits under one of them, because
  previews need a domain apart from Mend's (ADR 0017, decision 1). A preview domain on Mend's own
  site, one that shares the registrable domain of one of those hosts by the Public Suffix List, such
  as `previews.example.com` beside `mend.example.com`, is allowed. A page on such a preview can set
  cookies for `example.com`, but Mend's own cookies are `__Host-` over https, so it can neither set
  nor replace them, and gate item 15 observes the prefix.
- **On a tailnet, with a hostname.** A preview is
  `https://<MEND_PREVIEW_TAILNET_HOSTNAME>:<its port>`. Mend gives a preview a port from
  `MEND_PREVIEW_TAILNET_PORTS` the first time someone opens it, never sooner, and the preview keeps
  it until it is removed with its worktree or project. A removed preview's port goes back to the
  set, and Mend reuses the ports never used first, then the one freed longest ago. The assignments
  live in the database, so a new preview needs no restart and every API process agrees. A preview
  whose port left the set gets a port of the current set the next time it is opened. When every port
  holds a preview, opening another answers `503` with a page that says how many ports the set has.
  The API refuses a hostname equal to Mend's own host, and the `port=previewId` form that earlier
  builds read, with a message that says what changed.

### Browsers on loopback

A loopback preview's grant is `mend-preview`: host-only on `<label>.localhost`, `HttpOnly`,
`SameSite=Lax`, and not `Secure`, because the origin is plain HTTP. Each label is a host of its own,
so a grant for one preview is never sent to another. `apps/api/test/preview-browsers.acceptance.ts`
opens a preview through a real ticket, with no resolver mapping and no certificate exception, and
observed on Linux:

| Browser                         | Opens `<label>.localhost` | Grant cookie as stated | Second label gets no grant | No grant goes to sign-in | `isSecureContext` | `Sec-Fetch-*` sent |
| ------------------------------- | ------------------------- | ---------------------- | -------------------------- | ------------------------ | ----------------- | ------------------ |
| Chromium 156 (Playwright build) | yes                       | yes                    | yes                        | yes                      | `true`            | yes                |
| Firefox 157 (Playwright build)  | yes                       | yes                    | yes                        | yes                      | `true`            | yes                |
| Safari                          | not verified live         |                        |                            |                          |                   |                    |

Both browsers resolve `*.localhost` to loopback themselves and reach a gateway on `127.0.0.1`, while
this machine's resolver answers `::1` first. Safari was not run: macOS 26 resolves `*.localhost`,
and WebKit does not treat `localhost` as a potentially trustworthy origin (WebKit bugs 171934 and
281149), so Safari is expected, not observed, to send no `Sec-Fetch-*` there. A navigation without a
grant that carries no `Sec-Fetch-*` field at all and asks for `text/html` is still sent to sign-in,
so a browser that withholds Fetch Metadata gets the redirect, not a 401. Playwright's Linux WebKit
is not Safari and was not used to stand in for it.

## The edge in front

The edge must pass the browser's `Host`, port included, because the gateway routes and checks
`Origin` by it. It must stream both ways, and it must not cut a request sooner than the start hold.
The settings below are the ones the gateway's acceptance tests run behind, with local certificates
(`apps/api/test/fixtures/preview/Caddyfile` and `nginx.conf`).

Caddy (the packaged `caddy:2.10-alpine`):

```caddyfile
*.previews.example.net {
	reverse_proxy 127.0.0.1:<MEND_PREVIEW_PORT> {
		flush_interval -1
		request_buffers 0
		header_up Host {hostport}
		transport http {
			response_header_timeout 10m
		}
	}
}
```

nginx:

```nginx
client_max_body_size 0;
client_body_timeout 600s;

location / {
    proxy_pass http://127.0.0.1:<MEND_PREVIEW_PORT>;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_request_buffering off;
    proxy_buffering off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
}
```

`proxy_request_buffering off` and `proxy_http_version 1.1` keep an upload streaming to the gateway
instead of spooling it to disk first, and `client_max_body_size 0` lets the gateway, not nginx,
decide what is too large. `$connection_upgrade` is the usual `map $http_upgrade` (`upgrade`, or
`close` when the header is empty). A timeout shorter than `MEND_PREVIEW_START_HOLD` answers a held
request with the edge's own error before the gateway's page.

`tailscale serve` in front of the gateway is not verified live. Delivery step 8 checks it on a
tailnet.

The gateway writes its own `X-Forwarded-Host` and `X-Forwarded-Proto`. It drops every inbound
`Forwarded`, `X-Real-IP`, `X-Forwarded-*` and `Tailscale-*` field before the app sees the request,
in every routing mode. `tailscale serve` adds the viewer's tailnet login, name and picture as
`Tailscale-User-*`, and a client that reaches the gateway directly can send any of these fields, so
none of them reaches code an agent wrote.

Behind an edge that speaks HTTP/2 to browsers, as Caddy does, a page asks for every module of its
first import wave at once, and the edge opens that many requests to the gateway. They wait for one
of the viewer's six forwards to the dev server, and a request that waits is not an open request in
any budget below. One that waits longer than 30 seconds is answered `503` with
`preview · web · every forward to it stayed busy · your request was not delivered`, so streams that
hold every forward cannot park the rest forever. The acceptance tests load a page of 300 modules
this way through Caddy over HTTP/2, with nothing refused.

## The packaged edge

On a Docker install with the edge (`mend server setup --edge <host>`), setup serves previews too:

```sh
mend server setup --preview-domain previews.example.net \
  --preview-certificate /etc/mend/previews.crt --preview-key /etc/mend/previews.key
```

- **The domain.** Each preview is `https://<label>.previews.example.net`. Setup refuses a domain
  that is Mend's host, holds it, or sits under it (`previews.mend.example.com` beside
  `mend.example.com`), for the reasons above. One on Mend's own site, such as `previews.example.com`
  beside `mend.example.com`, is allowed. Point `*.previews.example.net` at the same address as
  Mend's host. Setup says where `mend-preview-probe.<domain>` resolves from its machine.
- **The certificate.** The packaged edge, the stock `caddy:2.10-alpine`, has no DNS provider module,
  and a wildcard certificate needs the ACME DNS-01 challenge. So you supply one: a PEM certificate
  whose names include `*.<domain>`, and its key, at absolute paths on the machine Mend runs on. Each
  setup run reads both files, checks that the certificate names the wildcard itself and that the key
  is its own, and refuses the run when either fails, whatever else the run changes. It does not
  check the chain to a public root. A certificate that expires within 30 days, or has expired, is
  said and not refused; one you supply that has already expired is refused. Setup then copies both
  into the install's generation, `preview-certificate.pem` and `preview-key.pem`, and the edge reads
  those copies. The key copy is readable by you and your group only, and the edge joins that group:
  it runs as root with every capability dropped, so it cannot read a key only you can read. Before
  the new generation goes live, setup has Caddy load it in a container run as the edge is, and
  refuses the run if Caddy cannot.
- **Renewal.** Replace the files at the same paths, then run `mend server setup --yes`. It copies
  them again into a new generation, which recreates the edge, and the edge serves the renewed
  certificate. `mend server restart` does not: it restarts Mend alone, and the edge keeps the
  certificate it loaded. Without `--yes` on a terminal, setup opens its guide first.
- **The gateway.** It runs in the Mend container on port 3130 (`MEND_PREVIEW_BIND=0.0.0.0` there, so
  the edge's container reaches it) and is published on `127.0.0.1:3130` only
  (`MEND_PREVIEW_PUBLISHED`). Setup says whether it answered there. The port is fixed: two installs
  on one machine, such as Docker Desktop's and OrbStack's on one Mac, cannot both serve previews,
  and setup refuses the second because the port is taken.
- **A public install.** With `--exposure public`, Mend does not start while the gate's
  `preview-gateway` item is open, so setup refuses previews until you add
  `--declare preview-gateway`. That statement says you checked from another network that
  `*.<domain>` resolves to the edge, that `https://<label>.<domain>` answers over a certificate that
  chains to a public root, and that `127.0.0.1:3130` answers nothing from another machine. To check
  before you state it, turn previews on under `--exposure private` first, then switch.
- **The files.** Setup writes `Caddyfile.preview`, mounted at `/etc/caddy/sites/preview.caddy`,
  `compose.preview.yaml` and the two copies into the install's generation. They are kept across
  reruns and upgrades. `mend server setup --no-preview-domain` removes them and leaves your
  certificate files where they are.

The site the edge serves, as setup writes it:

```caddyfile
*.{$MEND_PREVIEW_DOMAIN} {
	tls /etc/caddy/preview/certificate.pem /etc/caddy/preview/key.pem

	reverse_proxy mend:3130 {
		flush_interval -1
		transport http {
			response_header_timeout 10m
		}
	}

	log preview {
		output stdout
		import uri-free
	}
}
```

### A certificate over DNS-01

Two ways, and Mend wires neither in:

- **Issue it elsewhere and supply it.** Any ACME client that speaks DNS-01 to your DNS provider
  (certbot with a DNS plugin, lego, acme.sh) issues `*.<domain>` from a public root without
  publishing the listener. Point `--preview-certificate` and `--preview-key` at what it writes, and
  run `mend server setup --yes` after each renewal, from the client's deploy hook if it has one.
- **Run your own Caddy.** Build an image with your provider's module
  (`xcaddy build --with github.com/caddy-dns/<provider>`) and run it as the edge in front of the
  gateway yourself, with the site above and its `tls` line replaced by your provider's block, such
  as `tls { dns cloudflare {env.CLOUDFLARE_API_TOKEN} }`. The packaged edge's image is pinned by
  setup, so this is an edge you run, as in [The edge in front](#the-edge-in-front).

## Kubernetes

The chart's `preview.*` values render the gateway's port on the API Pod, a ClusterIP Service, a
second Ingress for `*.<domain>` with TLS, and a NetworkPolicy rule admitting the ingress controller
to that port only. It installs no issuer, and leaves the controller's annotations to you. See
[Live previews](../KUBERNETES.md#live-previews).

## Logs

The sign-in exchange puts a single-use ticket in the preview host's query:
`/__mend/auth?ticket=…&path=…`. The ticket lives 30 seconds and opens once, and until the exchange
spends it, it is a credential. The app's own paths and queries are the app's. So the edge in front
of the gateway logs no URI for preview hosts:

- **The packaged edge** imports the Caddyfile's `uri-free` snippet into the preview site's log, as
  the T3 Code gateway's site does: the URI reads `REDACTED`, and `Location` and `Referer` are
  dropped. Caddy redacts `Cookie`, `Set-Cookie` and `Authorization` itself. Caddy's error lines
  about these requests, a failed dial among them, go to its `default` log, which also holds no URI.
  This was chosen over a filter that keeps the path because it reuses a snippet that already exists
  and needs no regular expression to keep correct. `scripts/edge-overlay.test.mjs` runs the real
  image and holds every line to it.
- **nginx** writes the request line into its access log with the default `combined` format, query
  and `Referer` included. Give the preview server a format with the path and no query, and no
  `Referer`:

  ```nginx
  log_format preview '$remote_addr [$time_local] "$request_method $uri $server_protocol" $status $body_bytes_sent';

  server {
      server_name *.previews.example.net;
      access_log /var/log/nginx/preview.access.log preview;
      error_log /var/log/nginx/preview.error.log crit;
      # ...
  }
  ```

  `$uri` is the path without the query; never use `$request`, `$request_uri` or `$args` there, or
  `$http_referer`. `access_log off;` for the preview server is the other choice.

- **nginx's error log cannot be formatted.** When the dial to the gateway fails during the exchange,
  nginx writes, at its default level `error`, a line that holds the request line with the ticket,
  the upstream URL with the ticket again, and the `Referer`:

  ```text
  [error] connect() failed (111: Connection refused) while connecting to upstream, client: 127.0.0.1, server: *.preview.localhost, request: "GET /__mend/auth?ticket=<the ticket>&path=%2F HTTP/1.1", upstream: "http://127.0.0.1:37065/__mend/auth?ticket=<the ticket>&path=%2F", host: "<label>.preview.localhost:34697", referrer: "…"
  ```

  The ticket is then unspent and opens the preview once, for the rest of its 30 seconds. No
  `log_format` reaches this line. Keep it out of a shared log: set the preview server's `error_log`
  to `crit`, as above, so failed dials are not logged there (the access log still records the 502),
  or give the preview server an error log of its own that nothing ships and that is kept for less
  time than anything else. `apps/api/test/preview-edge-logs.acceptance.ts` records this against
  nginx 1.29 with a real ticket, and holds the `crit` setting to an error log with no ticket in it.

## Refusals

- Every `429` carries a `Retry-After`, and nothing is started. Before anything is read, the gateway
  counts requests per minute from one client address
  (`MEND_BUDGET_ADDRESS_PREVIEW_REQUESTS_PER_MINUTE`, apart from the router's window, because one
  page asks for hundreds of modules) and bounds the requests being admitted at once (256). The
  address is the one Mend's router resolves, through the same trusted proxies; a loopback socket
  with no `X-Forwarded-For` is never counted. After the grant stands, the account budgets are open
  preview requests (`MEND_BUDGET_ACCOUNT_PREVIEW_CONNECTIONS`), preview starts at once
  (`MEND_BUDGET_ACCOUNT_PREVIEW_STARTS_IN_FLIGHT`) and preview starts per minute
  (`MEND_BUDGET_ACCOUNT_PREVIEW_STARTS_PER_MINUTE`). See [Budgets](budgets.md). An open request is a
  long-lived one: a request held while its preview starts, one holding a forward, or an upgrade. The
  gateway's own ceilings bound this process rather than an account: open requests for one preview
  (64), open requests across previews (256), requests waiting for a forward (2048) and open forwards
  (128). A start pays the start budgets only when it launches a process, and the account whose
  request launched it pays; a request that waits for a start under way, or meets a start that
  already failed, pays nothing. A `503` from the gateway always means the preview is not available.
- A request held for a stopped preview that does not start in time gets `503` and one line, such as
  `preview · web · did not start in 3 min · start timed out · your request was not delivered`. A
  start refused sooner says only why, as in
  `preview · web · did not start · command failed · your request was not delivered`. The gateway
  never read the body, so Mend holds none of it.
- A preview a person stopped with **Stop**, its owner or a steerer, answers `503` with
  `preview · web · Maria stopped the preview · your request was not delivered`, and a request never
  starts it. The page names the person as Mend names people to others: their name, or `a member`. If
  the agent runs the Service again (`mend service run web`), the preview serves that run while it
  lasts, and the Stop holds again once it ends. A person's **Start** or restart, from Mend's Stop,
  Start and restart buttons or the `mend` CLI on their own machine, lets requests start it again.
  The agent's own `mend service stop`, `run` or `restart` decides nothing, whichever token carries
  it.
