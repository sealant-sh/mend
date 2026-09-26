# Access without a private network: Mend as its own authenticated front door

Status: proposed 2026-09-17. Commits Mend to the work that makes a private network layer a choice
and not a prerequisite. It closes the Mend findings the organizations stack left open in
[public exposure findings](../archive/reviews/public-exposure-findings.md) (MEND-05, MEND-08,
MEND-11, the event-stream lifecycle, and the edge), names the platform halves (CORE-01, -03, -04,
-05, -08 and the executor channel's transport), and defines the **public exposure gate**.

**This ADR does not authorize public exposure.** Public Mend is gate **G7** of the
[access plan](../operations/aws-access-plan.md), and G7 needs an independent reassessment of the
exact release. Nothing here, and no green test, stands in for that.

## Context

[Plan §7.5](../../MEND-AGENT-WORKBENCH-PLAN.md) was written with a tailnet assumed: bind to loopback
and private interfaces, show the machine's tailnet address, require no public inbound port. The
network was the perimeter, and the application was allowed to lean on it.

The organizations stack ([ADR 0003](0003-organizations-and-tenancy.md), #263 to #280, #282) removed
most of that leaning: registration is closed and by invitation, an operator role exists, every route
authorizes against the project before any effect, signers, devices, notifications and GitHub
identity belong to one account, folders replaced host mounts, Mend's own git follows a source policy
with pinned addresses, uploads are signed for their length, and raw service ports stay on loopback.
ADR 0003 deliberately deferred budgets: "an invited beta tenant is unlikely to exhaust resources on
purpose". An unauthenticated stranger on the Internet is not an invited tenant, so a public front
door is what makes them required.

What still leans on the network, as observed on `main` at `2c05944ce`:

- **No budgets (MEND-05).** No body-size limit exists anywhere in `apps/api`; `pasteImage`,
  `skills.sync`, `folders.upload` and the dotfiles push decode a whole base64 body into memory
  before any check. WebSocket frames have no `maxPayload`. Nothing bounds the launches, streams or
  sockets one account holds. Only pairing is rate limited.
- **Bearers in URLs (MEND-08).** `/api/tty`, `/api/service-tunnel` and `/api/keys/bridge/ws` fold
  `?token=` into `Authorization`. The CLI, desktop, the mobile socket and the mobile `/tty-embed`
  WebView all put a long-lived device or session bearer in that query string. No request log exists
  in Mend today, so Mend itself writes none of them down. Every proxy in front of it may.
- **Errors and headers (MEND-11).** No security header is set by web or API. Upstream detail crosses
  to clients: a Sealant dial error is a 502 body on the service tunnel, platform messages ride
  `AccountRejected` and `SealantUnavailable`, and there is no defect handler.
- **The edge.** Cookies carry no explicit attributes, so `Secure` follows the scheme of `APP_URL`
  silently. `MEND_TRUSTED_PROXIES` feeds only the pairing limiter. API and web listen on every
  interface of their container; the Docker publish address is the only bind control. The chart has
  no Ingress. `mend server setup` validates an `https://` URL and stops there.
- **How reachability is described.** `apps/api/src/routes/machine.ts` infers "tailnet" from an
  interface in `100.64.0.0/10`. The shell says `tailnet · reachable` or `tailnet · not detected`,
  and `mend doctor` has a `tailnet` check. For a LAN or public install the second is a false alarm,
  and the first was never a statement about who can reach the instance.
- **The event stream.** The per-stream `LISTEN` that let one closing browser silence the others is
  already gone: #267 moved every stream onto one application-owned fan-out (`events-bus.ts`) with
  cross-user filtering (`events.ts`). What remains is a lifecycle test through the real route, and a
  bound on how many streams one account may hold.

The platform halves, observed at Core `97c741c` and sealantd `aeb9b60`:

- Core serves every `/v1` route without a credential when `SEALANT_SERVICE_KEYS` is unset (CORE-01),
  reads "no owner named" as "unscoped" and updates runs and renames workspaces by id alone
  (CORE-03), has no budgets (CORE-04), sends an installation token to whatever URL a spec names and
  a session token to whatever endpoint it names (CORE-05), and interpolates registry names into URLs
  with no deadline or size bound (CORE-08).
- sealantd's `HttpRegistrar` and `PresignedHttp` dial any URL, `http://` included, follow ten
  redirects, verify against the bundled public roots only, and honour `HTTP_PROXY`. The recorded AWS
  deployment runs the executor channel over private-VPC HTTP.

## Decision

### The access model

**Mend web is the one front door.** A person reaches Mend at one HTTPS origin. Web serves the app
and proxies `/api/*`, the event stream and every WebSocket to the API on that origin. The CLI, the
desktop app, the phone and the editor extension use the same origin. There is no second API hostname
and no separate terminal listener.

**Mend authenticates and authorizes every request itself.** A network that admits a connection says
nothing about who is on it. A tailnet, a LAN, a VPN or an identity-aware proxy in front of Mend is
an extra gate an operator may add. Mend never reads its headers as identity and never trusts a
request more because of where it came from.

**TLS ends at an edge the operator runs; Mend is told the truth about it.** Mend does not terminate
public TLS in its own process. The edge is a reverse proxy, an ingress controller or a load balancer
that holds the certificate and forwards to web over a private hop. The chart can render an Ingress
and the packaged install can run a Caddy edge; both are opt-in deployment shapes of the same
contract:

- `APP_URL` is the exact browser origin and must be `https:` when the instance is exposed beyond the
  machine. Alternate origins stay an exact list (`MEND_ALLOWED_ORIGINS`). No wildcard, no discovery
  from `Host` or forwarded headers.
- `MEND_TRUSTED_PROXIES` names the hops whose `X-Forwarded-For` entries Mend believes. One resolver
  (`@mend/network`) derives the client address for everything that keys on it (pairing, budgets,
  audit). It takes the rightmost entry that is not a trusted hop, so a client cannot choose its own
  address. Web keeps deleting inbound `Forwarded`, `X-Forwarded-Host` and `X-Forwarded-Proto`.
- Cookies are `Secure`, `HttpOnly` and `SameSite=Lax` whenever `APP_URL` is `https:`, set explicitly
  and tested, not inferred.

**Everything behind Mend stays private.** Core, its registry, Postgres, the bucket's admin surface,
raw service ports and the Kubernetes API get no new exposure. Core stays a trusted control plane
called with a service key. It is never an authorization server for Mend's users, and a service key
never reaches a browser, a phone or a workspace.

**The executor channel does not assume a private network either.** A workspace reaches Mend's
session channel over HTTPS with a verified certificate, or the daemon refuses to boot. Plain HTTP is
dialled only when the launcher states that the network between executor and channel is private. Mend
states that from its own configuration and never by default for a public instance.

### Exposure is declared, and reported as observed

`MEND_EXPOSURE=loopback|private|public`, default `private`.

- `loopback`: reached from this machine only.
- `private` (the default): reached over a network the operator controls admission to (a tailnet, a
  LAN, a VPN).
- `public`: reachable from the Internet.

The declaration is the operator's statement of intent. Mend cannot observe who can reach it: a
container does not know what is published in front of it. So the product reports what it can observe
beside what was declared, and never a verdict:

```
exposure · declared public · https origin · 1 trusted proxy hop · gate 2 open
```

`machine.ts`, the shell and `mend doctor` stop saying "tailnet · reachable". They report the
declared exposure, the origin's scheme, whether the request that asked arrived through a trusted
hop, the interface families the host holds (a CGNAT address is reported as "an address in
100.64.0.0/10", which is what was observed, not "tailnet"), and the open gate items. A missing
tailnet is not a failed check. It is not a check.

### Public exposure gate

Starting with `MEND_EXPOSURE=public` is refused until the items this build can observe are closed,
in the style of the multi mode gate (`apps/api/src/exposure.ts`). Start-up names each open item with
its fix; `/health` reports the declaration and how many items are open, never which (it needs no
sign-in, and on a public instance the ids would be a list of what to try); `GET /operator/exposure`
(`mend operator exposure`) gives the operator the ids and the detail. Each item carries how it was
established: `observed` (this process read it, in effect, on this instance), `carried` (this build
contains it and this process cannot see it in effect; the item says what would observe it),
`declared` (the operator stated it and this process cannot check it), or `open`.

Required to start `public`, and `observed` unless marked:

1. **https-origin**: `APP_URL` and every alternate origin are `https:`.
2. **secure-cookies**: session cookies are `Secure`, `HttpOnly`, `SameSite=Lax`.
3. **trusted-proxies**: `MEND_TRUSTED_PROXIES` is set, and does not trust every address.
4. **enrollment-closed** (`carried`): registration is by invitation (in the build since #265). It is
   behaviour, not configuration, so the API reports that the build carries it and what would observe
   it: a sign-up without an invitation, from outside, answering a refusal.
5. **tenancy-gate**: every multi mode gate item this build observes is closed, in either tenancy
   mode. An Internet-facing single-organization install needs the same source policy, upload binding
   and loopback service ports as a multi-tenant one.
6. **budgets**: every budget below is set; none is `0`.
7. **no-bearers-in-urls**: `MEND_URL_BEARERS=refuse` (the default once every first-party client
   sends tickets; see "Upgrade tickets").
8. **browser-headers** (`carried`): the header policy has no off switch, and it is set by the web
   tier, which the API cannot see: a skewed web image, or a client reaching the API's port directly,
   would make an "observed" here untrue. What would observe it: `mend doctor` against the public
   origin, reading the headers a browser receives.
9. **error-redaction**: public error detail is off (`MEND_ERROR_DETAIL` unset).
10. **executor-channel-transport**: the session channel's advertised URL is `https:`, or the
    operator declared the executor network private (`MEND_EXECUTOR_NETWORK=private`), which is
    reported as `declared`.

Not observable by this build. Reported, never inferred, and they do not block start:

11. **core-private**: Core, its registry and the database are not reachable from the Internet. What
    would verify it: a connection attempt to each from outside the deployment's network.
12. **edge-tls**: the certificate chains to a public root, renews, and the edge redirects port 80.
    What would verify it: `mend doctor` run against the origin from another network.
13. **reassessment**: an independent security reassessment of this exact release. The operator
    records one with `MEND_EXPOSURE_REASSESSED=<version>`. The item reads `declared` only when that
    value equals the running version, and `open` otherwise, so an upgrade reopens it. A build with
    no version of its own (`dev`) has nothing a reassessment could name, and stays `open`.

Items 11 and 12 stay `open` until the operator, having verified them from outside, names them in
`MEND_EXPOSURE_DECLARED` (the chart's `exposure.declared`); they then read `declared`, with the
words "this process cannot check it". Nothing else can be declared: an item this process can read is
read, never taken on someone's word, and naming one there refuses to start.

"Nothing open" means every item was observed, is carried by the build, or was declared by the
operator. It is a report of what was observed and stated. It is not a statement that the instance is
safe, and the product never words it as one: no check mark, no colour of success.

Rejected: refusing `public` until item 13 is recorded (a build cannot tell a real reassessment from
a typed version string, so it would be theatre that also blocks the honest operator); and treating
`private` as ungated (it gets the same report, it just does not refuse to start).

### Budgets (MEND-05)

Hitting a budget refuses new work with a stated reason and a `Retry-After`. It never stops a running
session, never closes a socket that is already open, and never drops a capture. Every refusal
happens before the effect it guards.

- **Bodies, before decode.** A global middleware refuses a declared `Content-Length` over the
  route's limit with 413 before a byte is read, and sets `HttpIncomingMessage.MaxBodySize` so a
  chunked body is cut at the same point. Default 1 MiB; the upload routes (`pasteImage`,
  `skills.sync`, `folders.upload`, dotfiles, workspace image) get named larger limits.
- **Frames.** A terminal, a tunnel or the key bridge refuses to forward a client frame over the
  budget and closes the socket with 1009 (decision 12 says why this is not `maxPayload`).
- **Requests.** Per account and, before authentication, per client address: one sliding-window
  limiter generalized from the pairing limiter, keyed by the single client-address resolver. Sign-in
  and invitation acceptance get a tighter window than the rest. No request is exempt because its
  whole chain is trusted: it is counted under the socket's address (only a bare loopback socket with
  no `X-Forwarded-For` is this machine's own, and sign-in attempts are counted even then). A
  credential is the bearer or a session cookie's value, never the client-writable rest of `Cookie`.
- **Concurrent work.** Per account: live sessions, launches in flight, and open long-lived
  connections by kind (event streams, terminals, tunnels, key bridges). `ConnectionRegistry` already
  holds every long-lived connection per account, so it is where the connection budget is counted and
  refused. Per organization: live sessions.
- **One fan-out.** Already in place (#267). This ADR adds the per-account stream bound and a bound
  on the per-stream work a slow consumer can queue (the bus is a sliding buffer; the refresh work a
  stream does per event is bounded too).

Defaults are sized for a small team and are all configuration. Core enforces its own budgets
(CORE-04) behind Mend's; Mend maps a Core 429 to the same refusal shape and does not retry into it.

### Upgrade tickets (MEND-08)

A browser cannot set headers on a WebSocket, and a WebView cannot set them on a page load. Those are
the only two places a credential still has to ride a URL, so that credential becomes worthless
anywhere else:

- `POST /api/upgrade-tickets` (authenticated by cookie or `Authorization`) mints a **ticket**: 32
  random bytes, stored hashed, single use, 30 seconds to live, bound to the account, to one target
  (`tty`, `service-tunnel`, `keys-bridge`, `tty-embed`), to that target's exact parameters (the
  session or process id, the service id, the bridge host), and to the credential that minted it: the
  sign-in (`session:<id>`) or the paired device (`device:<id>`).
- The three WebSocket routes accept `?ticket=`. A ticket is spent by one statement that deletes it
  only when it is unexpired, for exactly this target and these parameters, and its credential still
  stands (the sign-in row exists and has not expired; the device is not revoked). Of many requests
  racing one ticket exactly one wins, a wrong guess spends nothing, and signing out, a password
  change that ends other sign-ins, revoking a device or removing a member ends every ticket that
  credential minted. A repeated addressing parameter is refused with 400, so the scope the ticket is
  checked against is always the parameter the route goes on to read. Authorization still runs as the
  ticket's account, exactly as for a header.
- `/tty-embed` takes a ticket and trades it, in the page, for the socket's ticket and a **renewal
  ticket**. The renewal ticket lives in the page's memory, travels only in a request body and is
  bound to the same terminal and the same credential, so a dropped socket reconnects without the app
  minting a new URL. It is the one ticket that is shown rather than spent: rotating it would strand
  the page whenever a reply was lost on the way back. It ends twelve hours after the app minted the
  URL, however often it was used, or with its credential, whichever is first. When the exchange
  refuses it, the page posts `mend:embed-expired` to the app that embedded it, which mints a fresh
  URL. No bearer reaches the WebView's URL, history or referrer.
- First-party clients all mint a ticket per connection, native ones included: the CLI (terminal,
  service tunnel, key bridge), the desktop main process on the renderer's behalf, the phone's socket
  and its WebView. One path is simpler to keep correct than a header on some clients and a ticket on
  others, and the saved bearer then travels only in a header on an HTTPS API call. An
  `Authorization` header on the upgrade still works for a client that can set one.
- A client newer than its server gets 404 from the mint. It falls back to `?token=`, which is what
  that server always received, only when `/health` does not say `upgradeTickets: true`. When it
  does, the 404 came from a hop in between, and the client refuses to connect with that reason
  instead of putting its bearer in URLs every hop logs.
- `?token=` is refused with 400 when `MEND_URL_BEARERS=refuse`, and accepted with a logged
  deprecation (the URL redacted) when `accept`. `accept` is the default for one release, so a newer
  server still serves an older CLI or phone build. It is an open gate item.
- **Redaction through the chain.** `redactUrl` (`@mend/network`) replaces the value of `token`,
  `ticket` and `code` in anything Mend writes down, and the embed answers
  `Referrer-Policy: no-referrer`. The chart's Ingress annotations and the Caddy edge's log format
  drop query strings. The docs say what an operator's own proxy must do. Mend's error bodies, audit
  rows and Sealant records never contain a request URL's query.

### Errors and browser headers (MEND-11)

- **Errors.** One boundary, on the router, maps what leaves the API. A declared contract error
  crosses with its tag and its message, and the message is scrubbed of what arrived from below:
  server paths (the leaf is kept), internal hosts, URL credentials and queries, bearers, JWTs,
  `Authorization` values, `name=value` pairs that name a credential, and anything long enough to be
  a secret, of which a short head is kept so a commit, a digest or a long branch name still says
  which one it is (`redactDetail`, `@mend/network`). Mend's own words pass through unchanged. The
  socket routes' plain-text 502s are scrubbed the same way. A defect, or a 5xx body nobody declared,
  crosses as `InternalError` and a reference; its detail goes to the log under that reference.
  `MEND_ERROR_DETAIL=verbose` turns the scrubbing off for an operator debugging a private instance,
  and is an open gate item.
- **Headers.** The web front sets the browser policy on every response it relays, the app's and the
  API's alike: `Content-Security-Policy` (this origin only for scripts, connections, workers, form
  targets and the base URI; `wasm-unsafe-eval` for the terminal, and `data:` in `connect-src`
  because the terminal library fetches its inlined WebAssembly from a `data:` URL, which reaches no
  server; `object-src 'none'`; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin` (`no-referrer` on
  `/tty-embed`, `/pair` and `/authorize`, whose URLs carry a credential), a `Permissions-Policy`
  that turns off what Mend does not use, `Cross-Origin-Opener-Policy` and
  `Cross-Origin-Resource-Policy: same-origin`, and `Strict-Transport-Security` for this host (no
  `includeSubDomains`: sibling hosts are not Mend's to pin) when the origin is `https:`. The API
  sets `nosniff`, `DENY`, `no-referrer` and `default-src 'none'` on every answer, for whatever
  reaches it without the front: its header middleware is outermost, so the budgets' and the origin
  policy's refusals, a defect's answer and a route that does not exist all carry them. The order of
  the API's global middleware is stated in one module and held by a test against what a client
  observes.
- **The terminal embed stays supported.** The one supported embedder of `/tty-embed` is the mobile
  app's WebView, which loads it as a top-level document, not a frame. `frame-ancestors 'none'` does
  not apply to it, and tests pin both halves: the policy allows the way the installed terminal
  library loads, and forbids framing the page. The WebAssembly load under the policy was observed in
  headless Chromium (refused without `data:`, loaded with it); no browser runs in CI, so that
  observation is not repeated on every change.

### Event stream lifecycle

A test through the real `/api/events` route: streams open, one is torn down with an event published
and unread, the others keep receiving and the one listen behind the bus is neither restarted nor
ended; a stream closed the way member removal closes it (the registry's `closeForUser`) releases its
registration; a refused stream over the account's budget leaves no subscription behind. The test
waits on what it can observe (a subscription taken, a registration released) and never on a fixed
sleep. Whether the server was part-way through writing a frame when the client left cannot be told
from outside the process, so the test does not claim it.

### The platform halves

- **sealantd**: one transport policy for the channel and for presigned object URLs. HTTPS with
  verified certificates or refuse; plain HTTP to loopback or under the launcher's explicit
  exception; a CA bundle for each path; no redirects; no ambient proxy.
- **Core**: fail closed without service keys (CORE-01); an owner named and checked on every
  operation, with the SSH gateway as its own narrower authority (CORE-03); per-credential and
  per-owner budgets (CORE-04); an installation token only to the repository it was issued for and a
  session token only to an approved channel (CORE-05); registry names held to the OCI grammar with
  bounded answers (CORE-08). Core stays private throughout.

Each bakes the one below, so the release order is sealantd, then Core, then Mend. No PR in one
repository depends on an unmerged PR in another. The top of this stack is that pin bump: Sealant
0.34.0 (which bakes sealantd 0.17.0), and `source.transport` on every capture launch, built from
`MEND_EXECUTOR_NETWORK` (the same value the exposure gate reports), `MEND_SESSION_ENDPOINT_CA_FILE`
and `MEND_BLOB_STORE_CA_FILE`, all read once in `DeploymentConfig`. Mend sends only what the
operator stated: no statement, no transport, and the daemon then requires verified HTTPS. The
packaged bundle states `private` itself, because the Compose network is a fact of the bundle; the
chart refuses to render a plain-http channel without the statement, so the failure is a sentence at
`helm upgrade` and not a workspace that never boots. The owner was already sent on every call: Mend
builds one Sealant client per user (#105), so Core's `SEALANT_REQUIRE_OWNER_SCOPE` can be on.

## Consequences

- The product language gains `exposure` (`loopback`, `private`, `public`), the
  `public exposure gate`, `upgrade ticket`, `budget` and `edge`. "Tailnet" leaves the product's own
  words and stays in the docs as one way to run `private`.
- Plan §7.5 is rewritten: Mend is its own front door; a private network is one deployment shape.
- A `public` instance that loses an observed item at restart (an `http:` origin after a bad config
  push) refuses to start, which is a worse failure for the operator than a warning and the only one
  that cannot be missed.
- Older first-party clients that still send `?token=` keep working for one release under
  `MEND_URL_BEARERS=accept`, then stop.
- Raw service forwards stay loopback-only on a `public` instance and are reached through the
  authenticated tunnel. Executor-served HTML is never served under the authenticated origin.

## Delivery

One ready-for-review PR per step, stacked:

1. This ADR.
2. Budgets: body limits before decode, frame limits, the request limiter and the single client
   address resolver, per-account and per-organization ceilings, the connection budget in
   `ConnectionRegistry`.
3. Upgrade tickets, header authentication on every native client, `MEND_URL_BEARERS`, query
   redaction.
4. The error boundary and the browser header policy, with the terminal-embed test.
5. The event stream lifecycle test and the per-account stream bound.
6. The edge: `MEND_EXPOSURE`, explicit cookie attributes, the public exposure gate,
   `GET /operator/exposure`, the chart's Ingress and the packaged install's Caddy edge.
7. Reporting and docs: `machine.ts`, the shell, `mend doctor`, plan §7.5, `AGENTS.md`, the
   self-hosting and remote-access guides.

Follows the Sealant release that carries the platform halves: the Sealant pin bump, `transport` on
the capture source from `MEND_EXECUTOR_NETWORK` and the channel's TLS settings, and gate item 10
reading the real value.

## Decision log

Choices a reviewer may overturn without touching the rest. Each names what was taken and why.

1. **TLS ends at an operator-run edge, not in Mend's process.** Taken: edge. Certificates, renewal,
   HTTP/2 and port 80 redirects are a solved problem in Caddy, ingress controllers and load
   balancers, and every serious deployment already has one. Rejected: an ACME client inside the web
   process (a second thing holding a private key, for no gain).
2. **Exposure is declared, not detected.** Taken: `MEND_EXPOSURE`. A process cannot observe what is
   published in front of its container, and a guess that reads "reachable" or "not reachable" is a
   verdict Mend cannot back. Rejected: inferring from interfaces, which is what `machine.ts` does
   today.
3. **`public` refuses to start on observed items only.** Taken. Items a build cannot observe are
   reported as `declared` or `open`. Rejected: blocking on the reassessment record, see above.
4. **Tickets, not signed URLs or a cookie-only rule.** Taken: opaque, hashed, single-use rows, the
   same storage pattern as pairing codes and session channel tokens. Rejected: a signed stateless
   token (cannot be single use without state anyway) and cookie-only browser sockets (the WebView
   and cross-origin dev setups have no cookie).
5. **Ticket lifetime 30 seconds.** Long enough for a phone on a bad network to open the socket it
   just asked for; short enough that a logged ticket is dead before anyone reads the log.
6. **`MEND_URL_BEARERS=accept` for one release.** Taken, so the server and the phone build do not
   have to ship on the same day. It is an open gate item for that release.
7. **Budgets refuse, they never kill.** Carried from ADR 0003. A budget that stops a running session
   destroys work to protect capacity, which is the wrong trade for this product.
8. **In-memory request windows.** Taken for v1: per API process, so N replicas admit N times the
   rate. The API runs as a singleton today. Concurrency ceilings are counted from Postgres and
   `ConnectionRegistry`. A shared limiter is later work if the API ever scales out.
9. **`frame-ancestors 'none'`, with the embed as a top-level document.** Taken, because the only
   supported embedder is a WebView. If a framed embed is ever supported it gets an exact-origin
   allowlist, never a wildcard.
10. **The chart renders an Ingress; it does not install a controller or an issuer.** Those are
    cluster decisions. The packaged install does run an edge (Caddy) when asked, because a single
    Docker host has no cluster to delegate to.
11. **Core budgets sit behind Mend's, not instead of them.** Mend refuses earlier and with better
    words; Core's are the backstop for a caller that is not Mend.

12. **WebSocket frames are bounded in Mend's handlers, not in the `ws` server.** Effect's Node HTTP
    server builds its WebSocket server without options and does not expose it, so `maxPayload`
    cannot be set. Taken: refuse to forward an oversized frame and close the socket with 1009, and
    bound connections per account, so the total is bounded. Rejected: patching the `ws` prototype
    (reaches into a transitive dependency's internals from application code) and copying
    `NodeHttpServer.make` to own the upgrade path (sixty lines of a moving library). The residual is
    one frame of up to `ws`'s own 100 MiB default buffered per connection before Mend can refuse it.

13. **`script-src` allows inline scripts for now.** The document carries two kinds: the no-flash
    theme bootstrap and the framework's hydration payload. A nonce on both is the fix and touches
    the SSR entry. Taken: `'self' 'unsafe-inline' 'wasm-unsafe-eval'`, which still refuses every
    other origin as a script source, plus `object-src 'none'`, `base-uri 'self'` and
    `form-action 'self'`. What it does not give: protection from an injected inline script. Mend
    renders no HTML from a repository or an agent as HTML, which is what would make that reachable.
14. **Upstream error text is scrubbed, not hidden.** Git's stderr is the user's own repository
    talking, and "remote branch not found" is what they need to read. Taken: keep the sentence,
    remove paths, internal hosts, credentials and secrets, at one boundary that sees every error
    response. Rejected: replacing every upstream message with a reference id (safe, and useless to
    the person who has to fix their base ref), and editing the eighty-odd call sites one by one (the
    next one written would be missed).

15. **The packaged install's edge is a Compose overlay, not a `mend server setup` flag, for now.**
    The bundle is a versioned release contract with its own packaged acceptance run, and a release
    was in flight while this was written. Taken: `deploy/docker/compose.edge.yaml` and a
    `Caddyfile`, opt-in, validated with the real Caddy binary and rendered in CI. The edge publishes
    80 and 443, Mend's own port stays on loopback, the edge shares a network with Mend alone, and
    Mend trusts exactly that network as a proxy hop. A `--edge` flag that writes the same overlay
    belongs with the next bundle contract revision. Until then a `mend server setup` install cannot
    take the overlay: setup refuses a loopback bind with a non-local `--url`, `server.env` is
    checked against the server config, and the lifecycle commands run `compose.yaml` alone. The
    overlay applies to a Compose project run by hand, and it has not been run end to end with an
    issued certificate. That is the largest gap between this stack and a packaged public install.
16. **A `public` instance needs an operator before it starts.** `operator-present` is part of the
    tenancy gate, and the exposure gate includes every tenancy item. Until the first account exists,
    registration is open to whoever arrives first; on the Internet that is not the owner. Create the
    first account over a private path, then declare `public`.

17. **`carried` is its own word.** An independent review found two items reporting `observed` from a
    hardcoded `true`. Taken: a fourth status for what the build contains and the process cannot see
    in effect, with what would observe it. Rejected: dropping the items (the operator should still
    see them) and leaving them `observed` (it is not what happened).
18. **The unobservable items can be closed only by the operator's statement.** Without one the gate
    could never read "nothing open", which made that branch dead code and the report less useful to
    an operator who had done the outside checks. Taken: `MEND_EXPOSURE_DECLARED`, limited to
    `core-private` and `edge-tls`. It never affects whether `public` starts.
19. **`/health` counts open items and does not name them.** It is unauthenticated. The ids are one
    sign-in away, for the operator.
20. **The default is `private`, not `loopback`.** Owner's call. An unset variable is far more often
    a tailnet, LAN or cluster install than one reached from its own machine (the packaged bundle
    cannot set the variable at all yet, and a tailnet install made with `--bind 0.0.0.0` would have
    reported `declared loopback`). The two modes differ only in the report: neither refuses to
    start. So the doctor's line keys its "serve it over https" and its gate count on the origin
    being reachable beyond the machine (a non-loopback host), not on the declaration alone, and a
    laptop install on `http://localhost` stays quiet.

## Open questions

Decisions that are the owner's. Work proceeds on the default stated with each.

1. **Does `private` also refuse to start on open items, or only report?** Default: only report, so
   existing tailnet and LAN installs upgrade without a new start-up failure.
2. **Budget defaults.** The numbers in PR 2 are sized from the author's own use. Default: ship them,
   all configurable.
3. **Who may record a reassessment?** Default: an environment variable, so it is an operator act
   that leaves a trace in deployment configuration. An audit-logged `mend operator` command is the
   alternative.
4. **The release that flips `MEND_URL_BEARERS` to `refuse` by default.** Default: the release after
   the mobile build that sends tickets is on the owner's phone.
5. **`/health` still names the open multi mode gate items** (`tenancyGate.failing`, from #263–#280,
   read by released clients). The same reasoning as decision 19 applies to it on a public instance.
   Default: left as released; changing it is a contract change for `mend doctor`.
6. **A private object store behind a private CA.** sealantd takes a second CA bundle for object
   URLs; whether Mend's chart should carry one is undecided. Default: not in this stack.
