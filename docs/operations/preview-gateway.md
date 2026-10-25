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
  previews need a domain apart from Mend's (ADR 0017, decision 1).
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

## Refusals

- A request a budget refuses gets `429` and the budget's words: open preview requests for one
  account (`MEND_BUDGET_ACCOUNT_PREVIEW_CONNECTIONS`) and preview starts at once for one account
  (`MEND_BUDGET_ACCOUNT_PREVIEW_STARTS_IN_FLIGHT`). See [Budgets](budgets.md).
- The gateway's own ceilings on open requests and forwards answer `503`. They bound this process,
  not an account.
- A request held for a stopped preview that does not start in time gets `503` and one line, such as
  `preview · web · did not start in 3 min · start timed out · your request was not delivered`. The
  gateway never read the body, so Mend holds none of it.
- A preview its owner stopped answers `503` with
  `preview · web · the owner stopped the preview · your request was not delivered`, and a request
  never starts it.
