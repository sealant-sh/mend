# Live preview: a link to the change running, from Slack and the phone

Status: proposed 2026-10-24. Commits Mend to a preview gateway, an HTTP listener on an origin of its
own that opens a worktree's dev server inside its workspace. The link appears in the Slack thread,
on the phone and in the web app after a turn changes the app. Yiannis decided its six decisions on
2026-10-24: the domain, public links (who opens a link), a shared database, the setup cache, idle
defaults, and the gateway on a private instance. He also decided how Mend's cookies change on a
tailnet, how app cookies are kept apart, and what happens to a write that reaches a stopped preview.
On 2026-10-25 he decided three more: whose **Stop** keeps a preview stopped, what the gateway
strips, and that a bound dial never falls back to Docker. Each section quotes him. The other choices
in the decision log are proposals he may overturn.

**What this ADR does not claim.** A preview is not a deployment, and it does not say that a change
works. It shows what the dev server answered when someone asked
(`preview · web · answered HTTP 200 · observed 4 s ago`). It does not authorize public exposure
either. A `public` instance still needs ADR 0004's gate and a reassessment of the exact release.

## Context

### What was asked

Yiannis, 2026-09-26, in the session that wrote the earlier plan:

> Let's see what it would take to have mend return a live preview on various places. I'm talking
> about a kind of preview deployment kind of link. This would just be the dev server of a given
> project running inside the workspace after the agent is done so the user can preview the change.
> For instance in slack or on the phone both are very good targets for this. So the way i see it, we
> would somehow record the given steps needed to run a project and then combine that with our
> existing services ideea just spin it up and give a link. Also while we are at it i would like to
> also enable long running services that are used between worktrees. Think like a db running or
> something like that but i'm open to ideas/feedback. I have a target i want us to hit, like a
> complex wp site that requires stock wp, a theme, a bucnh of plugins etc but let's start with more
> basic shit

His words set the forces: a link like a preview deployment, the project's dev server in the
workspace, after the agent is done, Slack and the phone, the steps recorded with Services,
long-running services shared between worktrees, WordPress as the end target, and a simple app first.
On 2026-09-23 he set the order: "before doing anything slack related, we need to ensure services
work properly in alpha". On 2026-10-01 he put previews in 0.37. On 2026-10-24 he confirmed them as
the 0.37 headline ("See the work running"), and put shared long-running services (Linear P-SLNT-46)
and Firecracker workspaces in 0.37 too.

The earlier plan (Obsidian, "Mend live preview plan", 2026-09-27) is an agent's proposal. Yiannis
asked for it so he could study it, and he did not rule on it. Its domain and access questions were
put to him on 2026-09-23 and again on 2026-09-26, and neither got an answer then. He decided this
ADR's open questions on 2026-10-24, and each decision below quotes him. Every other mechanism below
is a proposal.

The marketing site already describes the feature as shipped: "A live link to every change"
(`apps/marketing/src/components/content.tsx:116-117`, `:170-176`).

### What exists

Mend represents a workspace's application ports as **Services** today. Workspace SSH is a separate
path for editors (`docs/WORKSPACE-SSH.md`). A Service is a declared port with an optional command,
and it belongs to one session: `services.sessionId` is non-null and cascades
(`packages/db/src/schema/workbench.ts:1546-1573`).

- `mend.toml` takes `[service.<name>]` tables with four keys: `port`, `command`, `protocol` and
  `browserScheme`. The parser reads only `parsed["service"]` and ignores every other key and table
  without a word (`packages/sessions/src/recipes.ts:95-153`).
- A recipe runs as `sh -c <command>` with no cwd and no env of its own
  (`packages/sessions/src/engine.ts:22076-22086`). Ready means that the port accepts a TCP
  connection, probed every 500 ms for up to 60 s (`engine.ts:1311`, `:21871`). Only the session's
  owner runs a recipe, because "the worktree's copy (which a turn may edit) wins"
  (`apps/api/src/routes/workbench.ts:2830-2832`). A steerer may restart a Service, and a restart
  reuses the recorded command (`engine.ts:22098-22131`).
- Bytes go through the SDK's `workspace.forward(port, { host, protocol })`, a raw duplex pipe with
  one WebSocket to Core and one daemon connection per call
  (`packages/sealant/src/client.ts:686-699`, `:987-1000`). Mend dials `127.0.0.1` and then `docker`
  (`packages/sessions/src/service-host.ts:340-355`). A forward names a port, never a process.
- Two consumers carry those bytes. `ServiceHost` binds a raw listener per Service on
  `MEND_SERVICE_HOSTS` (default `127.0.0.1`, ports 43100 to 43999) with no Mend authentication
  (`service-host.ts:190`, `:193-199`). `/api/service-tunnel` is an authenticated WebSocket that only
  the `mend` CLI speaks, and it requires the right to steer, not only visibility
  (`apps/api/src/routes/service-tunnel.ts:94-100`, `apps/api/src/session-steering.ts:184-193`).
- The web Services card shows **Open** with a raw URL when the browser is on the Mend host, or when
  the operator bound Services to a private interface. Otherwise it shows
  `mend service connect <name>` (`packages/domain/src/workbench/service.ts:177-192`,
  `apps/web/src/components/services-card.tsx:146-147`, `:202-258`). Slack and the phone show nothing
  about Services.
- A live Service keeps its workspace up indefinitely. The protocol idle stop answers
  `{ kind: "held", by: "services" }` while one runs
  (`packages/domain/src/workbench/protocol-idle.ts:81`), and the engine renews the workspace's 12 h
  lease every 10 minutes (`engine.ts:9848-9920`, scheduled at `:24106-24115`). Nothing measures
  traffic, and nothing wakes a stopped session on a request.

Mend serves one browser origin, `APP_URL`. The web front on :3105 routes by path, never reads
`Host`, and destroys any upgrade outside `/api` (`apps/web/src/entry/main.ts:146-150`, `:169-174`).
Over https, the session cookie is Better Auth's with `Secure`, `HttpOnly`, `SameSite=Lax` and no
`Domain`, named with the `__Secure-` prefix. Over plain http it drops `Secure` and the prefix. It
goes to Mend's host only, and nothing stops a sibling host from setting a cookie of that name for
the parent domain, which a `__Host-` prefix would (`packages/auth/src/auth.ts:119-149`). The
packaged edge is stock `caddy:2.10-alpine` with one named site, whose log filter redacts `ticket`,
`token` and `code` and drops `Referer`, and which imports `sites/*.caddy`
(`deploy/docker/Caddyfile:6-46`, `deploy/docker/compose.edge.yaml:29`). The t3code gateway is the
precedent for a second listener behind it: its own port, its own edge site with its own log filter,
and exposure gate item 14 (`apps/cli/src/server-edge.ts:287-360`,
`apps/api/src/exposure.ts:246-293`, ADR 0012).

### What stands

- **ADR 0004.** "Executor-served HTML is never served under the authenticated origin" (`:363-364`).
  Alternate origins are an exact list with no wildcard, and nothing is discovered from `Host`
  (`:86-87`). TLS ends at an operator-run edge. Exposure is declared and reported as observed.
  Upgrade tickets are single use, live 30 seconds, and are bound to the account, the target, its
  parameters and the credential (`:247-251`). Signed stateless tokens were rejected (decision 4,
  `:404-407`).
- **The plan's decision log, 2026-08-01, amended 2026-08-20**
  (`MEND-AGENT-WORKBENCH-PLAN.md:1656-1663`). Per-port TCP forwards, not an HTTP path proxy, because
  "path prefixes … break absolute asset paths, HMR WebSockets, and cookies", and "raw forwards
  cannot enforce Mend authentication per request; the UI states that the private network is the
  access boundary".
- **Plan §2.7 and §4.10.** "The running application should be another authenticated view of the
  session" (`:96-101`), and it "must not become public by default" (`:189-193`).
- **The platform.** Mend uses Sealant only through the public SDK, and a gap is a
  `PLATFORM-FEEDBACK.md` entry, not a workaround (AGENTS.md). SDK 0.39.0 has no links between
  workspaces, no named shared volumes (host bind mounts only, and none in capture mode), no reverse
  forward, and no suspend or wake. A workspace's `env` is fixed when the workspace is created. A
  process's env is not, and the engine already passes one to `openSession`
  (`engine.ts:21945-21960`). The forward appends inbound frames to an array that has no bound, so a
  slow reader grows Mend's memory instead of slowing the dev server (SDK `facade/workspace.js:833`,
  `:859`). Core's 409, 502, 404 and 403 all reach Mend as the same WebSocket error.

## Decision

### A preview is a worktree's browser Service, at a host of its own

A **preview** is one named browser Service of one worktree, reached at its **preview host**. A
worktree has one change, and a link pasted into Slack is opened for days, across the sessions in the
worktree, Service restarts and executor replacement. So a preview is keyed by (worktree, Service
name). A Service row is not the key, because it dies with its session.

```ts
// packages/domain/src/workbench/preview.ts
export interface Preview {
  readonly id: PreviewId;
  readonly projectId: ProjectId;
  readonly worktreeId: WorktreeId;
  readonly serviceName: RecipeName;
  /** One DNS label, 128 random bits. Never reused; a removed preview leaves a tombstone. */
  readonly label: PreviewLabel;
  readonly state: "kept" | "removed";
}

/** What the host points at now. Only the lifecycle changes it, under a new epoch. */
export type PreviewBinding =
  | { readonly _tag: "Unbound"; readonly reason: UnboundReason }
  | {
      readonly _tag: "Bound";
      readonly epoch: BindingEpoch;
      readonly serviceId: ServiceId;
      readonly attemptId: SessionProcessId;
      readonly host: HostPolicy;
    };
```

- On a preview domain, the label picks the preview. On a tailnet's `ts.net` default (decision 6),
  the port does, and the label still names the preview in its cookies.
- The label names nothing: no organization, project, branch, person, session, port or id. Hostnames
  reach DNS resolvers, Certificate Transparency logs, Slack's unfurler and browser history. The
  label is a locator, not a credential, and knowing it opens nothing.
- A binding names a Service attempt. The session, the workspace, the port and the starter are read
  from that Service and attempt, so they have one owner each.
- The gateway routes to a binding only while its attempt is live, and closes every connection to it
  when the attempt exits or the binding changes. A late dial from an old epoch never reaches a new
  one. A forward names a port, not a process, so another process that takes the port after the
  attempt exits and before Mend sees the exit would receive traffic. Platform feedback asks for a
  forward bound to a process (below). Before a start, Mend refuses a port that already answers. That
  shows the port was free at that moment, and so narrows the gap. It cannot show which process
  answers afterwards, and only a forward bound to a process closes the gap.
- **A bound dial never falls back.** Decided by Yiannis, 2026-10-25. A dial bound to an attempt's
  process tries the workspace's loopback only. When loopback refuses it, the gateway answers that
  nothing listens and does not try the Docker route, because a container cannot prove the process. A
  docker-hosted Service is always port-scoped, and its status says `port-scoped`. Nothing claims a
  process proof for it. Step 9's recipe key declares which Services are docker-hosted.
- A second session in the worktree that runs the same name does not take the host over. A
  managed-port claim on (workspace, port) turns that into a named conflict.

### The preview gateway

The gateway is a new listener in the API process (`MEND_PREVIEW_BIND`, `MEND_PREVIEW_PORT`). It sits
behind the edge on the preview domain, in the shape ADR 0012 gave the t3code gateway. Web's :3105 is
unchanged and never serves preview bytes.

```
browser ──TLS──▶ edge: a site for *.<preview domain>          new site file, own log filter
                   ▼
          preview gateway (API process, own port)              new
            Host → exactly one label under the domain (on a tailnet, the port), else 404
            /__mend/* → the gateway's own paths, never forwarded
            Origin and Sec-Fetch-Site → admitted or refused
            grant cookie → viewer, else sign-in (below)
            viewer → who may open (decision 2)
            budgets → per account and per preview              ADR 0004 budgets, new kind
            label → preview → binding → request head rewrite
            http.Agent per binding, createConnection = forward  new
                   ▼
          WorkspaceCaller.byWorkspaceCreator.forward           reused
                   ▼
          Core /forward → sealantd → dev server :3000          reused
```

- **One hop that knows HTTP.** The gateway parses each request head and relays bodies as streams,
  and SSE without buffering. A WebSocket upgrade (hot reload) gets a forward of its own and becomes
  a raw pipe after the 101. Upstream connections stay open between requests in a bounded
  `http.Agent` per binding. A page of many modules then reuses a few forwards when the dev server
  keeps connections alive, and the agent is destroyed with its attempt. The gateway starts only on
  an SDK whose forward is bounded (platform feedback 1). It runs in the API process, so one slow
  phone on today's forward could exhaust the memory of Mend's control plane, on any exposure.
- **Only the preview's own pages can act with its grant.** Previews share a site with each other
  unless the preview domain is on the Public Suffix List (decision 1). On a shared site, a page on
  preview A can send a request to preview B, and the browser attaches B's grant. Under every option,
  the gateway admits a request that carries a grant only when its `Origin` is the preview's own
  origin. A request without `Origin` is admitted only when it is a safe method (`GET`, `HEAD`). A
  request whose `Sec-Fetch-Site` is `same-site` or `cross-site` is refused unless it is a top-level
  `GET` navigation. WebSocket upgrades follow the same rule. Mend's own API already refuses upgrades
  from a foreign origin (`apps/api/src/public-network-policy.ts:22-33`).
- **Host policy, per recipe.** `host = "rewrite"` (the default) sends `Host: localhost:<port>` with
  `X-Forwarded-Host` and `X-Forwarded-Proto`, which Vite's `server.allowedHosts` and Next's dev
  server expect. `host = "preserve"` sends the preview host. WordPress needs that, because it builds
  absolute URLs and redirects to its configured home.
- **What the gateway strips and refuses.** Before forwarding, it removes its own grant cookie (every
  port's grant name on a tailnet's `ts.net` default), inbound `Forwarded` and `X-Forwarded-*`, and
  hop-by-hop headers. Decided by Yiannis, 2026-10-25: the app's own `Authorization` header and its
  own cookies pass untouched, both ways, `better-auth.*` names included. Mend's cookies are
  host-only on Mend's host, so a browser never sends them to a preview host, and Mend's bearers are
  never ambient, so a browser sends one only when the app's page asked it to. Stripping them would
  break an app that uses the same names and protect nothing. It refuses `CONNECT`, a request with
  two `Host` fields, and an unknown port. On the way back it removes the `Domain` attribute from
  every `Set-Cookie` and drops any cookie named like the grant, so an app cannot plant one. Unless
  the preview domain is on the Public Suffix List, a page's own JavaScript can still set a cookie
  for the whole preview domain, which reaches sibling previews. Header stripping cannot stop that,
  so decision 1 names it as a cost. The gateway sets `Cache-Control: private`, so an edge cache
  cannot serve one viewer's page to another, and `X-Robots-Tag: noindex`. It injects nothing into
  pages and sets no CSP on them, which would break apps.
- **Refused for now.** A service-worker script gets 403, because a service worker scoped to the root
  could answer the gateway's `/__mend/` routes from the browser's cache. An `https` Service gets a
  stated refusal, because the first slice speaks plain HTTP to the dev server inside the workspace.
  Each waits for a design of its own.
- **Logs.** The preview site's log filter redacts `ticket`, drops `Referer`, and leaves the app's
  own query strings out of the edge's access log. The site is a new file, so it gets its own filter,
  as `Caddyfile.t3` has one.

### Signing in: a ticket that becomes a grant

```
GET  https://k7f2….<preview domain>/pricing                 no grant cookie, a top-level GET
302  https://<APP_URL>/preview-auth?preview=<id>&path=/pricing
     Mend: session cookie → who may open → mint a `preview` ticket (30 s, single use)
302  https://k7f2….<preview domain>/__mend/auth?ticket=mut_…&path=/pricing
     gateway: spend the ticket → store a grant → Set-Cookie (below) → no-referrer
303  https://k7f2….<preview domain>/pricing                 grant cookie → proxied
```

- `preview` is a new upgrade-ticket target, scoped to the preview id and its exact origin. Its mint,
  its hashing, its single spend and its credential checks are ADR 0004's, unchanged.
- The grant is a separate stored credential, hashed and bound to one host:
  `__Host-mend-preview=<grant>; Secure; HttpOnly; SameSite=Lax; Path=/`. The `__Host-` prefix
  forbids a `Domain` attribute, so no sibling preview can set or replace it. On a tailnet's `ts.net`
  default the name carries the port (decision 6), and on loopback over plain HTTP it has neither the
  prefix nor `Secure` (decision 1). The grant lives as long as the sign-in that minted it, so a
  person who is signed in to Mend never meets an expired grant in the middle of their work. It ends
  with that credential: signing out, a revoked device, or removal from the organization ends it.
- Every request is checked against the grant and the binding, including a request on a reused
  connection. Open WebSockets and SSE streams are checked again whenever visibility changes, and in
  a sweep every 60 seconds that also covers missed events. A viewer who can no longer open the
  preview loses its open streams, including after a project becomes private.
- **A grant that is missing or revoked is refused.** A request that is not a top-level navigation
  and has no valid grant gets 401, never a sign-in page, because a module fetch cannot follow a
  redirect. A write without a valid grant is refused on purpose. It is not a loss.
- **A request to a stopped preview starts it.** Decided by Yiannis, 2026-10-24, first for writes
  ("let's have it get the preview up again and accept it"), then for every request, opening a link
  included. When any request from a person with a valid grant reaches a preview that is stopped or
  restarting, the gateway starts the preview, holds the request until the preview is ready, and then
  delivers it. That covers a `GET` as well as a write (`POST`, `PUT`, `PATCH`, `DELETE`), in the
  first slice. Mend stores nothing.
  - **The body stays in the browser.** While it holds, the gateway reads only the request head and
    does not read the body. TCP backpressure then leaves the body with the browser, past a few
    socket buffers, so an upload over any size is held without buffering it in Mend. Delivery then
    streams the body into the forward. That needs the send-ready half of the bounded forward:
    today's forward calls `ws.send` with no check on the socket's buffer (SDK
    `facade/workspace.js:885`), so Mend would read the whole upload into the forward's buffer
    (platform feedback 1).
  - **The body budget is the gateway's own.** ADR 0004's body budget refuses an API request whose
    declared `Content-Length` passes the route's limit (1 MiB by default) before reading, and cuts a
    chunked body at the same point (`apps/api/src/request-budgets.ts:122-123`). That budget guards
    bodies the API decodes. The gateway never decodes an app's body, so it is not under that budget.
    It gets a streaming cap per request, configurable and off by default, and the per-account
    connection budget counts a held request as an open connection.
  - **The hold is bounded.** A start timeout (`MEND_PREVIEW_START_HOLD`, proposed default 3 minutes,
    not measured) bounds the hold. It covers acquiring the workspace, setup, `depends`, the Service
    and the readiness check. The edge in front must not cut the request sooner: Caddy's defaults do
    not, an Ingress controller may, and an edge that buffers request bodies (nginx ingress's
    default) holds the upload itself and applies its own size limit. Delivery step 7 checks each
    shape.
  - **What is lost when the start fails.** If the preview fails to start, or does not answer within
    the timeout, the gateway answers 503 with a page that says what happened
    (`preview · web · did not start · setup failed · your request was not delivered`, or
    `did not start in 3 min · start timed out` when it outlasted the hold). The body was never read,
    so Mend has none of it. It is lost unless the browser kept it: Back may restore a form's fields,
    and an app's own `fetch` sees the 503 and decides for itself. This is the one remaining case in
    which a write is lost, and the page says so plainly.
  - **Who it runs as.** A start from a held request runs the approved recipe digest as its last
    starter, exactly as an owner's **Start** does, and one start runs however many requests arrive.
    Starts count against a wake budget per account. A preview a person stopped with **Stop** is not
    started by a request, and the request gets a page that says who stopped it (Decision log 6).
- **The phone.** The Mend app mints the ticket with its device token and opens the preview host in
  an in-app browser (`expo-web-browser`), so the person does not sign in again. The `/tty-embed`
  ticket flow is the precedent (`apps/mobile/src/components/ghostty-terminal.tsx:232-298`). A link
  tapped in Slack opens in Slack's own browser, which has no Mend session, so the first one asks the
  person to sign in to Mend on the web once in that browser.

### Dialing for a viewer

Who may open a preview is decision 2. Whoever it admits, the gateway never dials as the viewer. It
dials as the workspace's creator through `WorkspaceCaller`'s lending rule, which lends an act on the
creator's workspace only while the asker can see the project and the creator is still a member
(`packages/sessions/src/workspace-caller.ts:125-147`). A person the rule refuses gets 404, as for
the session. A guest without an account, under decision 2's share option, needs a lending rule of
its own, which that option defines.

The dev server runs as the person who started it (ADR 0016), and the gateway's requests reach it
from inside the workspace. So whoever may open a preview may also use what that dev server serves,
including a debug console it trusts from `localhost`, and its writes land in the worktree, where
Review shows them. Decision 2 weighed that.

### Recording how to run the project

`mend.toml` stays the record. It is versioned, it appears in Review, and an agent can change it as
part of a change. The additions, as a proposal:

```toml
[setup]                                     # shown with decision 4's recommendation
run = ["pnpm install --frozen-lockfile"]
inputs = ["pnpm-lock.yaml"]                 # hashed with `run` into the fingerprint

[service.web]
command = "pnpm dev --port 3000 --host 127.0.0.1"
port = 3000
browserScheme = "http"
cwd = "apps/web"                            # repository-relative, no `..`
env = { NODE_ENV = "development" }          # MEND_* names are Mend's and refused
ready = { http = "/", timeout = "120s" }    # any HTTP answer; the default stays a TCP accept
host = "rewrite"                            # or "preserve"
depends = ["db"]                            # started first, in order, never a cycle

[service.db]
command = "docker compose up db"
port = 5432

[preview]
service = "web"                             # must name a Service with a browserScheme
```

- Mend passes `cwd` and `env` to `openSession`, and adds `MEND_PREVIEW_URL` (the preview host's URL)
  and `PORT`. They are process env, so they reach a Service in a standby workspace, whose workspace
  env was fixed before its worktree was known. A Compose recipe passes the URL on. That is how
  WordPress's `WP_HOME` and `WP_SITEURL` get it.
- The new parser refuses a bad recipe on its own and names the key it refused. The other recipes in
  the file still run. An older Mend still ignores the new keys without a word, and no parser change
  in a newer Mend can fix that, so the release notes say which version reads them.
- `mend service init` learns the new keys. When a session ran `mend service run --http …` and the
  Service was observed answering, Mend proposes it as the project's `[preview]`: a suggestion that
  the person, or the agent in its next turn, applies to `mend.toml`. Mend never writes into the live
  worktree's `mend.toml` itself, because an agent or a person may be editing that file.

### After the agent is done

The trigger is a completed turn that changed the worktree, in a project with `[preview]`. That is
the proposal's reading of "after the agent is done". A question changes nothing and starts nothing.

- **A durable job, not a callback.** A preparation job claims each ended turn once. It finds ended
  turns the way automatic landing does, by scanning them
  (`apps/api/src/automatic-landing.ts:425-430`), with a sweep at start-up (`:513`) and every 60
  seconds. It does not hang off `onTurnCompleted` or the event bus. The bus is a sliding buffer that
  drops events while nothing reads (`apps/api/src/events-bus.ts:47`, `:61`), and `tryCheckpoint`
  returns null when a checkpoint fails (`engine.ts:8515-8526`). A turn whose change could not be
  read reports `preview not prepared · change not captured`, not "no change".
- **Protocol sessions first.** A terminal session's turns live in its process, not in the
  conversation tables, until a mode switch backfills them. Terminal sessions get the trigger in a
  later step, from their completion hook written to a durable row.
- **Not running:** setup if its fingerprint changed, then `depends`, then the Service, then the HTTP
  readiness check. **Running:** nothing, because hot reload already has the change.
- **Command authority stays ADR 0013's.** A recipe is a command, and the worktree's copy can be
  edited by any turn. So the owner approves a **recipe digest**: a hash over the Service's command,
  cwd, env, `depends`, and the `[setup]` steps and inputs that it runs. An automatic start or
  restart runs only an approved digest. When a turn changes the digest, the preview keeps running
  the approved version and says `preview · recipe changed · the owner's Start runs it`. The owner's
  Start approves the new digest. A steerer may restart the approved digest, the right a steerer has
  today. A steerer's turn never starts a changed command under the owner's name. Setup and the
  Service run as the person the Service runs as, which is the person who last started it (ADR 0016).

### Where the link shows up

One function builds the status line for every surface, so they all say the same words:
`preview · web · answered HTTP 200 · observed 4 s ago`, `preview · web · starting · setup`,
`preview · web · stopped after 30 min idle`. None is a verdict.

- **Slack.** An **Open preview** button on the status message beside **Open in Mend**
  (`packages/slack/src/format.ts:151-259`), and a line on the review reply (`format.ts:730`). The
  reporter's existing private-project check still hides a project that was made private
  (`packages/jobs/src/slack-reporter.ts:727-743`). Unfurls are off for preview links, and a crawler
  never gets a grant.
- **Phone.** A **Preview** button on the session screen, and the session's Services.
- **Web.** The Services card's **Open** goes to the preview on every instance where the gateway is
  on.

### Stopping when nobody uses it

The gateway is the only writer of a preview's activity clock, and it counts admitted application
requests. Sign-in pages, readiness probes, refused requests, Slack's unfurler, WebSocket pings and
an open hot-reload socket do not count, or an open tab would keep a VM up forever. A WebSocket-only
app therefore needs a longer duration or a "keep running" hold. The ADR states that limit instead of
guessing presence from bytes.

- **What a stop ends.** The preview's own Service only. Its `depends` keep running, and they keep
  holding the workspace as any Service does, unless the recipe marks one `disposable = true`. A
  per-session Compose database can hold what a reviewer typed into the preview, and stopping it, or
  letting the workspace go, would lose that. The cost is a workspace that stays up while a stateful
  dependency runs, which is today's behavior.
- **What holds a stop.** An open turn, a working agent, a shell, a pending approval, a capture
  flush, a "keep running" hold, or an in-flight request. An agent that tests the dev server from
  inside the workspace never goes through the gateway, so a turn in progress holds the preview.
- **How it stops.** The gateway stops admitting to the binding, drains in-flight requests, closes
  the streams, and stops the Service. Then the existing `stopWorkspaceIfUnleased` decides about the
  workspace. The protocol idle stop is unchanged. It holds while the preview runs, and once the
  preview stops, its next pass may stop the agent through `engine.stop`.
- **After a stop.** The preview keeps its host and answers a stopped page. Starting it again needs a
  new engine entry that acquires a workspace for Services with no agent process, whether the owner
  presses **Start** or a request arrives. Today's Service start needs a live workspace
  (`engine.ts:21149`). Decision 5 sets the duration and when a visit wakes a preview.

### Exposure

A new gate item, **15. preview-gateway**, is listed only while the gateway is on: with a preview
domain, or with the tailnet default (decision 6). It follows item 14:

- **observed:** APP_URL's host is neither the preview domain nor under it, and on the tailnet
  default it is not the gateway's `ts.net` name. The scheme is `https:` (or plain HTTP on loopback),
  the SDK in use has the bounded forward, and the listener's bind matches what setup published.
- **open until declared:** the wildcard DNS and certificate (on the tailnet default, the Tailscale
  steps of decision 6), and who can reach the published listener. Only a check from another network
  sees those. An open item refuses a `public` start, as item 14 does.
- **observed, on the tailnet default (decision 6) and under decision 1's subdomain option:** every
  Mend cookie carries `__Host-`.

`raw-service-ports` stays as it is. A preview never needs a raw port off loopback.

### Services shared between worktrees

A preview reaches a shared service only through a binding (decision 3). What a project service is,
how it lives and where it runs belongs to P-SLNT-46 and its own ADR. This ADR fixes one boundary.
Mend does not carry a service's bytes over the session channel, or over any other relay of its own,
to make up for the missing workspace links. AGENTS.md forbids that kind of workaround, so this ADR
withdraws the earlier plan's bridge. Platform feedback 4 and 5 record what the SDK lacks.

### What it does not do

- It never serves preview bytes on Mend's origin, and the web front never reads `Host`.
- It never discovers listeners. A preview exists only for a declared browser Service.
- It never publishes a raw port off loopback for a preview.
- It never makes the label a credential, and never puts a name in a hostname.
- It never keeps a workspace up because a tab is open, and never reads a held write into memory.

## Decisions

Each decision is Yiannis's. He decided all six on 2026-10-24, and each section quotes him. The
sections keep the options he weighed, so a later change can start from them.

### 1. The domain

**Decided by Yiannis, 2026-10-24: a separate registrable domain.** He asked, "I suppose the users
setup matters?" It does. The operator brings the preview domain and its DNS provider, and Mend
assumes neither. Each setup needs this:

- **Public, behind an edge.** A registrable domain of the operator's own, apart from Mend's, with a
  wildcard record `*.<preview domain>` that points at the edge. A wildcard certificate over DNS-01,
  from a Caddy build with the operator's DNS provider module, or a certificate the operator
  supplies. The DNS token stays in the edge's secrets. `MEND_PREVIEW_DOMAIN` names the domain, and
  gate item 15 is declared after a check from another network.
- **Private (a tailnet or a LAN).** Decision 6.
- **Loopback.** No domain. The preview domain is `localhost`, so a preview is
  `http://<label>.localhost:<port>`. Chrome and Firefox resolve every name under `localhost` to the
  loopback address. Whether Safari does, and whether each browser keeps the grant cookie there over
  plain HTTP, is unverified, and delivery step 8 checks it in all three. Over plain HTTP the grant
  cannot carry `Secure`, so its name drops the `__Host-` prefix. A loopback instance is one person's
  machine. Under the Public Suffix List's default rule, a name directly under an unlisted top-level
  label such as `localhost` is a site of its own, so each preview is its own site there (inferred
  from the list's algorithm, not observed in a browser).

The options weighed:

| Option                                                  | For a person                                                                                                     | For the operator                                                                                                       | In the code                                                                                                                                                                                     |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A separate registrable domain (`*.mendpreview.dev`)     | One redirect crosses sites. The app's cookies live outside Mend's site. Previews share one site with each other. | Buy and renew a second domain, and get a wildcard certificate over DNS-01.                                             | The preview domain is a one-label suffix. Nothing else moves.                                                                                                                                   |
| The same, listed on the Public Suffix List              | Every preview is a site of its own, so a page on one preview cannot set cookies for another.                     | The domain must be submitted to the list and accepted, which takes weeks, and browsers pick it up with their releases. | Nothing beyond the first option.                                                                                                                                                                |
| A subdomain of Mend's domain (`*.preview.mend.example`) | A familiar URL. Previews and Mend are cross-origin but **same-site**.                                            | No second domain. A wildcard certificate over DNS-01 is still needed.                                                  | Mend's own cookies move to `__Host-` names, the old names stop authenticating, every state-changing route is checked against requests from sibling sites, and gate item 15 observes the prefix. |
| Hosts the operator assigns, no wildcard                 | A fixed set of names.                                                                                            | DNS and a certificate per host, and a pool that runs out.                                                              | A table from host to preview replaces the suffix. A host is never reused, so a full pool answers "no host free".                                                                                |

**Why the separate domain.** ADR 0004 asks only for a separate origin (`:363-364`), so the subdomain
option is allowed. Its cost is what a sibling host can do. A page on a same-site host can set a
cookie for the parent domain from its own JavaScript, and a same-site request back to Mend carries
Mend's `SameSite=Lax` cookie. Mend's cookie is `__Secure-` today, not `__Host-`
(`packages/auth/src/auth.ts:119-149`). The separate domain keeps preview pages away from Mend, but
not from each other. The Public Suffix List entry closes that gap, and it is how `vercel.app` and
`github.io` give each customer a site of its own. Without the entry, a page on one preview can set
cookies that another preview's app reads, and the gateway's `Origin` rule above is what stops one
preview acting as a viewer of another.

**Evidence and costs shared by every wildcard option.** Let's Encrypt issues a wildcard only over
DNS-01, and the packaged edge is stock `caddy:2.10-alpine`, which has no DNS provider module
(`compose.edge.yaml:29`). So the edge needs a Caddy build with the operator's DNS provider, or a
certificate the operator supplies. The DNS token stays in the edge's secrets, never in Mend or a
workspace. The DNS provider is the operator's choice, and nothing assumes Cloudflare. A wildcard
certificate puts only `*.<domain>` in Certificate Transparency logs. Per-host certificates would
list every host and would meet Let's Encrypt's limit of 50 certificates per registered domain per
week.

### 2. Public links: who opens a link

**Decided by Yiannis, 2026-10-24: anyone who can see the session, signed in to Mend** ("Sure").
Share links that the owner makes are a later slice. The options weighed:

| Option                                                                          | For a person                                                                                                                                                | For the operator                                                                                      | In the code                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone who can see the session, signed in to Mend                               | A teammate opens the link from Slack after one sign-in. They can use whatever the dev server serves, as its starter, and their writes land in the worktree. | One identity model, already in place.                                                                 | Project visibility through `ProjectAccess` and the lending rule.                                                                                                                                                                                                                                                                                                                                                                              |
| Only people who can steer the session                                           | The owner and the people they let steer. A teammate who can only watch gets 404.                                                                            | As above.                                                                                             | The tunnel's rule, `SessionSteering.authorizeUser`.                                                                                                                                                                                                                                                                                                                                                                                           |
| The first option, plus share links the owner makes: stored, expiring, revocable | A client opens the link without an account. Anyone with a forwarded copy can too, until it ends.                                                            | A maximum lifetime, a list of open shares, a budget for guest traffic, and a switch for the instance. | A `preview_shares` table. A share is redeemed into a guest grant on the same host. The secret travels in the URL fragment, which a gateway page reads and posts, so request logs do not hold it. The gateway dials for a guest as the share's issuer, under a lending rule for previews only: the issuer must still see the project and the creator must still be a member. A share never wakes a preview and opens nothing but that preview. |
| Invited guests for previews only                                                | A client signs in and can be revoked alone. More friction than a link.                                                                                      | A guest directory or a restricted member class.                                                       | A tenancy amendment (ADR 0003) for a role that can open previews and read nothing else, and the guest lending rule above.                                                                                                                                                                                                                                                                                                                     |

**Why visibility.** Share links stay a later slice, for when clients review a site, as the WordPress
target suggests. He asked for Slack and the phone. A client without an account is the earlier plan's
idea, not his. Plan §2.7 calls the running app "another authenticated view of the session", which
matches visibility. The steering-only option is the cautious one. It takes the preview away from
teammates who only watch, because the dev server acts as its starter.

**Evidence.** Plan §4.10 says a preview "must not become public by default" (`:189-193`). ADR 0004
decision 4 rejected signed stateless tokens because they "cannot be single use without state anyway"
(`:404-407`). So a share must be a stored row with an expiry and a revocation. It needs an amendment
to decision 4, because a person uses it more than once. Slack shows links even in Slack Connect
channels (`format.ts:388-408`), so posting a share there is a disclosure the owner makes on purpose,
never a default.

### 3. A shared database

**Decided by Yiannis, 2026-10-24: the preview ADR does not own the database model.** His words:

> Don't we have the whole shared resources thing? ... It should be part of the shared resources
> thing. Ofc a session can spin up any infra, but in general if the user wants they should be able
> to get the shared ones instead.

A preview uses the project's shared long-running services (P-SLNT-46) when the person chooses them,
and a session can still run its own, such as a Compose database inside its workspace. The service
and database model belongs to P-SLNT-46's ADR: what a shared service is, whether its data is shared
by every worktree or split per worktree, and how it survives executor replacement. So does the way a
recipe names a shared service. This ADR keeps two things:

- **The binding.** A preview's `depends` names either a Service of its own session or a shared
  service of the project. Either one resolves to an address and credentials in the preview Service's
  env.
- **The boundary.** Mend never relays a service's bytes over the session channel (below).

The per-worktree database that an earlier draft of this ADR recommended is withdrawn.

### 4. The setup cache

**Decided by Yiannis, 2026-10-24: once per site and fingerprint, and measure before sharing anything
across workspaces.** The options weighed:

| Option                                     | For a person                                                                | For the operator                                      | In the code                                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Once per site and fingerprint              | A new workspace pays for the install. A restored capture reuses its output. | Nothing new to run.                                   | A stamp per site (the host's worktree directory, or one executor's copy) and fingerprint, under a claim, so two sessions never run `pnpm install` in one directory at once.                           |
| Dependency output shared across workspaces | Faster only when restoring beats installing.                                | Storage, quotas, retention, and entries per platform. | The existing project dependency cache gains complete immutable keys (inputs, command, image, OS, architecture, libc, layout) and a trusted writer. Setup's other effects still run in each workspace. |
| A package download mirror only             | Installs still run, with fewer downloads.                                   | The existing npm mirror.                              | No new cache. The image digest joins the fingerprint.                                                                                                                                                 |

**Why.** Share output across workspaces only after measuring the project's own restore against its
install. A lockfile hash alone is not a key, because scripts, the platform, the runtime, the image
and the person's layout change the result.

**Evidence.** Mend already has a project dependency cache in the capture store, with one writer (the
install job that Mend runs) and one reader (standby preparation). Its own comment records why a cold
launch skips it. On the box, restoring a 2.4 GB tree took about 20 seconds, against about 14 seconds
for `pnpm install` (`packages/sessions/src/dependency-cache.ts:20-40`). Image setup commands already
run only when an executor lays the worktree down fresh from capture 0, so a restored capture carries
their output (mend#419). On 2026-09-28 Yiannis kept tool installs in the image and said he would
streamline setup "later anyhow With the live preview services".

### 5. Idle defaults

**Decided by Yiannis, 2026-10-24.** A preview stops after 30 minutes without admitted requests, with
a visible "keep running" hold. Opening a preview link wakes a stopped preview. Any request from a
signed-in person with a valid grant starts it and is held until it is ready, `GET` requests
included, in the first slice (Signing in, above). This replaced his earlier "owner Start first, wake
later in 0.37". The owner can still press **Start**. The options weighed:

| Option                                                                    | For a person                                                                                               | For the operator                                                                    | In the code                                                                                                                                                        |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No preview stop                                                           | A forgotten preview runs until someone stops it, or until the platform's own limits do.                    | Today's cost: a Service holds its workspace indefinitely.                           | The clock exists and never fires.                                                                                                                                  |
| Stop after N minutes without admitted requests; the owner starts it again | A Slack link opened the next day shows a stopped page with **Start** for the owner.                        | Workspaces come back. A visit never launches one.                                   | The clock fires. A stopped page. The service-only workspace start, on the owner's press.                                                                           |
| Stop after N minutes; a signed-in navigation wakes it                     | A return visit waits for the workspace, setup and the dev server (tens of seconds to minutes), then opens. | A visitor can cause billable work, so wakes need caps, backoff and failure reports. | The service-only start, as a durable wake per preview that runs once however many visits arrive. A wake runs only the approved recipe digest, as its last starter. |

**What the wake brings into the first slice.** Thirty minutes is a proposed default, not a measured
one. Waking on every request means the first slice carries the lifecycle work that an earlier draft
staged for later: concurrent visits that share one start, a crash in the middle of a start, failure
reports, and a wake budget, because any viewer who opens an old Slack link now launches a workspace.
One runner of the design panel recommended this from the start, because a stopped Slack link is a
dead link.

**Evidence.** A live Service holds the protocol idle stop (`protocol-idle.ts:81`), and its lease is
renewed every 10 minutes (`engine.ts:9848-9920`), so nothing reclaims a forgotten dev server today.
On 2026-09-25 a teammate's MicroVM stayed up after Stop because three Services were running
(mend#368). The SDK has no suspend or wake, so a wake is a fresh workspace, then setup, then the dev
server.

### 6. The private-instance gateway

**Decided by Yiannis, 2026-10-24:** "Have that tailscale domains by default with the option to add a
domain." On a private instance on a tailnet, the gateway gets one dedicated `ts.net` name by
default, and each preview gets a port of its own on that name. The operator can add a preview domain
of their own, and it then takes over from the `ts.net` name. A public instance still needs a
registrable domain of its own (decision 1).

**The default on a tailnet.** One Tailscale Service, such as `svc:mend-preview`, is the gateway's
name: `https://mend-preview.<tailnet>.ts.net:<port>`. It is never Mend's own machine name. Mend runs
`tailscale serve --service=svc:mend-preview --https=<port> http://127.0.0.1:<gateway port>` for each
preview's port, so TLS ends at `tailscaled` on the Mend host, which is this setup's edge. The
gateway maps the port to the preview, where elsewhere it maps the label. Everything else in the
gateway is unchanged.

**What the tailnet default costs.**

- **Previews are the same site as Mend.** The Public Suffix List lists `ts.net` itself, so the
  registrable domain is `<tailnet>.ts.net` and every name in one tailnet is one site (the list's
  PRIVATE section, `ts.net` and `*.c.ts.net`). So Mend's own cookies move to `__Host-` names, the
  old names stop authenticating, and everyone signs in once more. Decided by Yiannis, 2026-10-24: "I
  don't mind the logout thing after update." Gate item 15 observes the prefix, and every
  state-changing Mend route is checked against requests from sibling sites, as in decision 1's
  subdomain row.
- **The grant cookie's name carries the port**, as `__Host-mend-preview-<port>`. Cookies ignore the
  port ("Cookies do not provide isolation by port", RFC 6265 §8.5), so one name would be overwritten
  by every preview. A grant still names its preview, so a grant for a port's earlier preview opens
  nothing on its next one.
- **App cookies are namespaced per preview.** Decided by Yiannis, 2026-10-24: "The cookie name thing
  is a very good way to deal with this." All previews share one host's cookie jar, so without this
  two apps that both set `next-auth.session-token` overwrite each other. On the way out, the gateway
  renames each `HttpOnly` cookie that the app sets with `Set-Cookie`, adding the preview's label
  after any `__Host-` or `__Secure-` prefix, which must stay first (`p-<label>.<name>`). On the way
  in, it passes the app only the cookies that carry that preview's prefix, with the prefix removed.
  A cookie from another preview, or from a removed preview whose port was reused, never reaches the
  app. The rename covers only `HttpOnly` cookies, because page JavaScript cannot read those, so no
  app code ever sees a renamed name.
- **The limit of the cookie rename.** The gateway sees only the `Set-Cookie` and `Cookie` headers.
  It never sees a cookie that page JavaScript writes with `document.cookie`, so those cookies are
  not namespaced. They collide between previews on the tailnet default, as they would on
  `localhost:3000` beside `localhost:3001`. The same holds for a server-set cookie without
  `HttpOnly`, such as a CSRF token that the app's JavaScript reads, which the gateway leaves alone
  so that the app can still read it. An app that keeps its sign-in in such a cookie signs its user
  out when another preview on the same tailnet sets the same name. The prefix also counts against
  the browser's limit of 4096 bytes per cookie. An operator's own preview domain gives each preview
  a host of its own, and the limit goes away.
- **Ports are finite, and they get reused.** A port is reused only after its preview is removed, and
  the least recently used free port goes first. A link to a removed preview's port can then open
  another preview, still behind that preview's own sign-in and visibility check.
- **How many previews fit.** The `tailscale serve` CLI accepts any `--https` port up to 65535, and
  only Funnel restricts ports (Tailscale `cmd/tailscale/cli/serve_v2.go` and `ipn/serve.go` at
  `a6cffd0a6d11`). A Tailscale Service advertises only the endpoints its definition in the admin
  console lists, such as `tcp:443` (https://tailscale.com/kb/1552/tailscale-services), and grants
  must allow those ports. So the real cap is the set of endpoints the operator defines. Whether a
  definition takes a range, such as `tcp:20000-20999`, is not documented. Delivery step 8 checks it
  before Mend relies on a range. Until then, setup asks for an explicit list.

**What the operator turns on in Tailscale.**

1. **MagicDNS**, so the Service's name resolves on every device.
2. **HTTPS certificates.** Turning them on means accepting that "your machine names and your tailnet
   DNS name will be published on a public ledger" (https://tailscale.com/kb/1153/enabling-https).
3. **The Service** `svc:mend-preview`, defined in the admin console with the endpoints (ports) for
   previews.
4. **A tag on the Mend host.** A host serves a Service only with a tag-based identity
   (https://tailscale.com/kb/1552/tailscale-services).
5. **Approval of the host** for the Service, by an Owner, an Admin or a Network admin, or an
   auto-approval policy that covers the tag.
6. **Grants** that let the people who use previews reach the Service on those ports.

Setup prints each of these, and gate item 15 reports them as declared, because Mend cannot observe
the tailnet's policy.

**With the operator's own domain.** The operator adds `MEND_PREVIEW_DOMAIN`, and it takes over from
the `ts.net` name. That needs DNS for the domain that resolves to the private edge on every device,
through public DNS or split DNS, and a wildcard certificate over DNS-01, which issues from a public
root without publishing the listener. Previews then get a label each and leave Mend's site, as
decision 1 describes.

The options weighed:

| Option                                                              | For a person                                                                                                                       | For the operator                                                                      | In the code                                                                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| One `ts.net` name for the gateway, a port per preview (the default) | **Open** works on the phone and in Slack inside the tailnet, with no domain. Previews are the same site as Mend and as each other. | The six Tailscale steps above.                                                        | Port routing, a port pool, `__Host-` Mend cookies, a grant name per port, and app cookies renamed per preview. |
| The operator's own preview domain (takes over when set)             | Previews leave Mend's site.                                                                                                        | A domain, DNS to the private edge on every device, and a DNS-01 wildcard certificate. | Label routing, as on a public instance.                                                                        |
| One Tailscale Service per preview                                   | A name per preview.                                                                                                                | "Up to 10 services" per tailnet (https://tailscale.com/blog/services-ga).             | Ten names cannot hold one preview each.                                                                        |
| One tsnet node per preview                                          | A name per preview, still the same site as Mend.                                                                                   | A device per preview, an auth key that Mend holds, and one shared certificate budget. | A Go sidecar, because tsnet is a Go library.                                                                   |
| Raw ports and the CLI tunnel only                                   | A browser on the private network opens a raw URL without Mend sign-in. Slack and the phone get no link.                            | Nothing new.                                                                          | No preview host.                                                                                               |

**Evidence.** Let's Encrypt counts certificates per registered domain, which it takes from the
Public Suffix List (https://letsencrypt.org/docs/rate-limits/), so every certificate in one tailnet
shares a budget of 50 a week. That rules out a certificate per preview. Wildcard names and wildcard
certificates under a machine name are not available: Tailscale's issue #7081 for subdomain or
wildcard certificates is open. ADR 0004 decision 21 published the t3code gateway where Mend's web
port is, because a gateway on loopback only made every T3 Code client keep an SSH tunnel open. The
bounded forward (platform feedback 1) gates the gateway on every exposure.

## Amendments

**The plan's decision log, 2026-08-01** (`MEND-AGENT-WORKBENCH-PLAN.md:1656-1663`), and §7.6
(`:754`). Append: "ADR 0017 adds an authenticated HTTP gateway for browser previews, on an origin of
its own, with one host per preview (on a tailnet's `ts.net` default, one port per preview) and
authorization on every request. Path prefixes stay rejected. Raw TCP and UDP Services and the CLI
tunnel keep their purposes and their network boundary." The earlier plan said that the gateway
"doesn't contradict" this entry. It does, because the entry rests on the private network being the
boundary.

**ADR 0004:**

- The access model (`:69-72`) says web "proxies `/api/*`, the event stream and every WebSocket to
  the API on that origin", and "There is no second API hostname and no separate terminal listener".
  Amend both to Mend's own traffic: "every Mend WebSocket", and "no second API hostname". Preview
  hosts are not Mend origins. They carry no Mend session, and the preview gateway serves only the
  preview sign-in exchange and preview traffic.
- Alternate origins (`:86-87`): "No wildcard, no discovery from `Host` or forwarded headers" governs
  Mend's own origins. The preview gateway routes by `Host` under one configured preview domain, or
  by port on its one `ts.net` name on a tailnet, parsed once at start-up. It never adds a preview
  host to `MEND_ALLOWED_ORIGINS`.
- Upgrade tickets (`:243-245`) are "the only two places a credential still has to ride a URL". Add
  the cross-origin preview sign-in. The target list (`:247-251`) gains `preview`, scoped to the
  preview id and its origin. Lifetime, hashing, single use and credential binding are unchanged.
- The consequences (`:363-364`) gain: "Declared browser previews are also reached through ADR 0017's
  gateway, on origins of their own, over the same SDK forwards." The sentence "Executor-served HTML
  is never served under the authenticated origin" stands.
- Decision 4, when decision 2's later slice of share links ships: "Preview shares are stored,
  expiring, revocable capabilities that open one preview. They are not upgrade tickets and do not
  change the single-use rule."
- Budgets (`:218-221`), "Bodies, before decode": the rule governs bodies the API decodes. The
  preview gateway never decodes an app's body. It streams it under a cap of its own, and it holds a
  write to a stopped preview without reading its body.
- The public exposure gate gains item 15.

**AGENTS.md**, when this ADR is accepted: the Product Language Contract gains `preview`,
`preview host`, `preview domain`, `preview gateway` and `preview grant`.

## Platform feedback

This PR adds five entries to `PLATFORM-FEEDBACK.md`:

1. **A bounded forward.** Receive backpressure and a send-ready signal, tested with a fast producer
   and a slow consumer. A Node `Duplex` around today's forward cannot bound a queue that it does not
   own. The gateway does not start without it, on any exposure, so it is part of the 0.37 Sealant
   release chain, ahead of the Mend release.
2. **Typed dial errors.** 409 (the workspace is not ready), 502 (nothing listens), 404 and 403 told
   apart, so that a stopped page says what was observed.
3. **A forward bound to a process**, so that traffic for an attempt never reaches another process
   that took its port.
4. **Workspace-to-service connectivity**, with identities, credentials and revocation (decision 3).
5. **Durable service storage** through executor replacement, in capture mode and on Firecracker
   (decision 3).

## Considered

- **A path prefix on Mend's origin** (`/preview/<id>/`). Rejected twice. It breaks absolute assets,
  HMR and cookies, and it serves executor HTML on the authenticated origin.
- **Raw ports published through the edge.** No Mend authentication per request, and one port per
  preview on the public edge.
- **One forward per browser connection**, as `ServiceHost` does. Each forward is a WebSocket to Core
  and a new daemon connection, which is a `docker exec socat` child on Docker without a host socket.
  A page of many modules would multiply that for every viewer.
- **A preview per session or per Service row.** The link would die when the session ends, which is
  the common case for a link pasted into Slack.
- **The earlier plan's bridge over the session channel** for shared services. It is a relay that
  stands in for a missing platform feature.
- **t3code's preview.** It is an embedded browser with device viewports and automation, not a link
  anyone can open. The t3code gateway still refuses it (ADR 0012).
- **A static build per turn.** Yiannis asked for the dev server, and hot reload is faster than a
  build after every turn.

## Consequences

- The product language gains `preview`, `preview host`, `preview domain`, `preview gateway` and
  `preview grant`. "Preview" also names a `next` docs build and t3code's embedded browser. Those
  keep their own words.
- An instance where the operator set up neither a preview domain nor the tailnet's Service behaves
  as it does today.
- On a tailnet, the `ts.net` default moves Mend's own cookies to `__Host-` names, so everyone signs
  in to Mend once more when it ships.
- The gateway waits for a Sealant release with the bounded forward, on every exposure.
- A stateful dependency keeps its workspace up after the preview stops, until P-SLNT-46 gives it
  durable storage.
- The marketing site's "A live link to every change" stays ahead of the product until the gateway
  ships on the instance a reader uses.
- Services prove themselves first. Yiannis made "services work properly in alpha" the gate for Slack
  work (2026-09-23). That proof was never recorded before alpha was torn down
  (`docs/current-scope.md`, "Services on alpha"), so it is recorded on the box.

## Delivery

One ready-for-review PR per step. Each ends in something a person can check.

1. This ADR, with the six answers written in, and the platform feedback.
2. Services proved on the box: a recipe Service opened through `mend service connect`, with its
   evidence recorded.
3. Sealant: the bounded forward, typed dial errors, and a forward bound to a process, released in
   the 0.37 chain (sealantd, then Core, then the Mend pin).
4. Preview identity and bindings, read-only. Two sessions in one worktree resolve one preview,
   another worktree resolves another, and a removed label is never reused.
5. The forward adapter, shared by `ServiceHost`, the tunnel and the gateway. The CLI tunnel still
   carries bytes and half-close, and the cost of a cold dial is recorded on Docker and Firecracker.
6. The `preview` ticket and the grant, against an HTTP fixture. One ticket opens once. A wrong host,
   a wrong target or a repeated parameter fails. Signing out, a revoked device and removal from the
   organization end access, and so does a project made private, for open streams too.
7. The gateway: HTTP, keep-alive, WebSockets, SSE, the `Origin` rule and held writes. A Vite app's
   page, its assets and hot reload work through it. A page on another preview cannot post to it or
   open its socket. A slow-reader test holds Mend's memory under a stated ceiling. A form post and
   an upload larger than 1 GiB to a stopped preview start it and arrive whole, with Mend's memory
   flat while it holds them, behind Caddy, behind an nginx ingress, and through `tailscale serve`. A
   start that times out answers the stated 503 page.
8. The edge site with its log filter, DNS-01 or a supplied certificate, the Helm equivalent, and
   gate item 15. A phone opens a preview over an issued certificate, and the edge log holds no
   ticket. On loopback, a `*.localhost` preview opens in Chrome, Firefox and Safari with its grant
   cookie, or the step records which browser refuses and why. On a tailnet, the `ts.net` default
   opens a preview on its port from a phone, and the step records whether a Service definition takes
   a port range.
9. Recipe fields: per-recipe parsing, `cwd`, `env`, `MEND_PREVIEW_URL`, `ready`, `depends`,
   `[setup]` and the recipe digest.
10. Start after a changed turn in a protocol session, the web **Open** and the phone button.
11. Slack: the button and the review line.
12. The service-only workspace start, the idle clock and the wake on any request (decision 5). A
    stopped preview opened from Slack starts once however many people open it, and a start that
    fails says so without looping.
13. Terminal sessions' trigger, and owner share links (decision 2's later slice).
14. WordPress: a seeded site with a theme and plugins, `host = "preserve"`, and its database from
    the project's shared services (P-SLNT-46).

## Decision log

These are choices the ADR proposes beyond the six. Each names what was taken and why, and Yiannis
may overturn any of them without touching the rest.

1. **A preview is keyed by worktree and Service name.** Taken, so that a link outlives its session.
   Rejected: per session, and per Service row.
2. **A grant distinct from the ticket.** Taken. The ticket stays single use and 30 seconds. The
   grant is a stored cookie bound to one host that lives as long as the sign-in that minted it.
   Rejected: a signed stateless cookie, for decision 4's reason.
3. **Only the preview's own origin acts with its grant.** Taken, because previews share a site under
   most domain options, and the rule costs nothing under the rest.
4. **Automatic runs only of a recipe digest the owner approved.** Taken, to keep ADR 0013's command
   rule while any turn can edit `mend.toml`. Rejected: running the edited recipe on a steerer's
   turn.
5. **A stop ends the preview's Service, never its stateful dependencies.** Taken, so that what a
   reviewer typed into the app survives.
6. **A preview a person stopped is not started by a request.** Decided by Yiannis, 2026-10-25, as
   extended from the owner's **Stop** this entry first proposed: any person's **Stop**, the owner's
   or a steerer's, keeps the preview stopped. The request's page says who stopped it
   (`preview · web · Maria stopped the preview · your request was not delivered`), naming them as
   Mend names people to others: their name, or `a member`. A person's **Start** or restart lets
   requests start it again. The agent's own `mend service stop` does not count, and only a Stop of
   the Service the preview serves does. Also decided by Yiannis, 2026-10-25: a person's Stop keeps
   requests from starting the Service; a run the agent starts is served while it lasts, and the Stop
   holds again when it ends. Only Mend's person-facing Stop, Start and restart decide it: the
   agent's own `mend service stop`, `run` or `restart` decides nothing, whichever token carries it,
   so a person executor's agent, which acts with its person's token, cannot stop or clear it either.
   A Start asked before a person's Stop never clears that Stop, however late it is carried out.
   Rejected: letting any visit undo it.
7. **No relay for shared services.** Taken, per AGENTS.md. Rejected: the earlier plan's bridge.
8. **A durable preparation job with a periodic sweep, not a turn callback.** Taken, because the
   event bus drops events and a checkpoint can fail.
9. **The gateway waits for a bounded forward on every exposure.** Taken, because the gateway runs in
   the API process, and an unbounded queue per connection can exhaust the memory of Mend's control
   plane.
