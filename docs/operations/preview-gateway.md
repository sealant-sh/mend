# The preview gateway

The preview gateway is the API process's own listener for live previews
([ADR 0017](../adr/0017-live-preview.md), "The preview gateway"). It admits a browser with a grant,
relays its requests to the preview's dev server over a forward, and starts a stopped preview when a
request reaches it. It is off until `MEND_PREVIEW_PORT` is set. It runs where the API's HTTP server
runs (`MEND_MODE=all` or `api`) and never in `MEND_MODE=worker`.

## Variables

The API reads them once, at start. A malformed value, or a combination that cannot run, stops the
API with a message that names the variable. An empty value counts as unset.

| Variable                        | Default     | What it sets                                                                                                                                       |
| ------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MEND_PREVIEW_PORT`             | unset (off) | The gateway's listen port. Required once any `MEND_PREVIEW_*` variable is set.                                                                     |
| `MEND_PREVIEW_BIND`             | `127.0.0.1` | The address it listens on, an IP address or `localhost`.                                                                                           |
| `MEND_PREVIEW_DOMAIN`           | unset       | The preview domain. Each preview is `https://<label>.<domain>`, behind an edge. Takes over from a tailnet hostname.                                |
| `MEND_PREVIEW_PUBLIC_PORT`      | `443`       | The port browsers use on the edge, with `MEND_PREVIEW_DOMAIN` only.                                                                                |
| `MEND_PREVIEW_TAILNET_HOSTNAME` | unset       | The gateway's name on a tailnet, such as `mend-preview.<tailnet>.ts.net`. Never Mend's own host.                                                   |
| `MEND_PREVIEW_TAILNET_PORTS`    | unset       | Each preview's port on that name, as `port=previewId`, comma-separated. One preview per port and one port per preview. Required with the hostname. |
| `MEND_PREVIEW_START_HOLD`       | `3 minutes` | How long a request waits for a stopped preview to start, such as `90 seconds`. At least 1 second.                                                  |
| `MEND_PREVIEW_BODY_BYTES`       | unset       | A cap on one request body, in bytes, counted as it streams. Unset means no cap.                                                                    |

How browsers reach a preview follows from what is set:

- **Loopback, with a port alone.** A preview is `http://<label>.localhost:<MEND_PREVIEW_PORT>`. The
  browser's port is the listen port, so `MEND_PREVIEW_PUBLIC_PORT` is refused here.
- **Behind an edge, with a domain.** A preview is
  `https://<label>.<MEND_PREVIEW_DOMAIN>:<MEND_PREVIEW_PUBLIC_PORT>`, and the edge terminates TLS
  for `*.<MEND_PREVIEW_DOMAIN>`. The API refuses a preview domain that equals one of Mend's own
  hosts (`APP_URL`, `MEND_ALLOWED_ORIGINS`), holds one of them, or sits under one of them, because
  previews need a domain apart from Mend's (ADR 0017, decision 1). It also refuses a preview domain
  on Mend's own site: one that shares the registrable domain of one of those hosts, by the Public
  Suffix List, such as `previews.example.com` beside `mend.example.com`. A page on such a preview
  can set cookies for `example.com`, and Mend's host receives them. Previews on Mend's own site need
  Mend's cookies to move to `__Host-` names, which ships in ADR 0017 step 8b with the tailnet
  default. Until then, use a preview domain on a registrable domain of its own, or loopback
  (`*.localhost`).
- **On a tailnet, with a hostname and its ports.** A preview is
  `https://<MEND_PREVIEW_TAILNET_HOSTNAME>:<its port>`. The port list is explicit, because Mend does
  not assign ports yet (delivery step 8). The API refuses a hostname equal to Mend's own host.

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

Behind an edge that speaks HTTP/2 to browsers, as Caddy does, a page asks for every module of its
first import wave at once, and the edge opens that many requests to the gateway. They wait for one
of the viewer's six forwards to the dev server, and a request that waits is not an open request in
any budget below. One that waits longer than 30 seconds is answered `503` with
`preview · web · every forward to it stayed busy · your request was not delivered`, so streams that
hold every forward cannot park the rest forever. The acceptance tests load a page of 300 modules
this way through Caddy over HTTP/2, with nothing refused.

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
