# Executor: one per organization, reached only through Mend

Accepted by Yiannis, 2026-11-05. Amended the same day by Yiannis: "This isn't a trial. Build it. You
have to … provide for every case": people using Mend on a private network, over Tailscale, and on a
domain of their own. Being built for 0.38.

Agents in Mend sessions get tools for services such as Linear, Figma or Sentry through
[Executor](https://executor.sh), an MIT-licensed integration gateway. Executor keeps the logins to
those services and the rules for which calls may run. Mend does not reimplement any of that. An
organization either connects an Executor it already runs, or uses the one Mend runs for it: one
Executor per organization, never one per person. Agents never hold an Executor credential: Mend's
server calls Executor for them, as the person the call belongs to. A Mend-run Executor is never
reached by a browser. People do everything in Mend, at the one address they already use for Mend, so
it works the same however Mend is reached.

This record is about Executor v2 (`ghcr.io/usefulsoftwareco/executor-selfhost`, release tags
`executor@2.0.0-beta.*`, source on the `v2-releases` branch of `UsefulSoftwareCo/executor`). The
repository's `main` branch is still v1, which has a different model; nothing here applies to it.

## What people get

- An owner opens Settings → Organization → Executor and chooses **Mend runs Executor for this
  organization** (offered when Sealant can run it) or **use an Executor this organization already
  has** (its URL). Members see the tab without credentials, so they know what their sessions get.
- Any member can **link** their Executor account from Settings → You → Workspace, from
  `mend connect executor`, or from the notice a session shows when a tool needs it. With a Mend-run
  Executor, linking is one click in Mend and nothing else: no second sign-in, no password, no page
  on another address. With the organization's own Executor, it is one consent page there. Linking is
  opt-in: without it, a person's sessions still get the tools the organization shares with everyone.
- With a Mend-run Executor, people add services in Mend. An owner adds a service for the
  organization (by its MCP address) and shares it with everyone; each person connects their own
  account to it, through the service's own sign-in page, which returns to Mend. With the
  organization's own Executor, people add and connect services there, and Mend lists what they can
  use.
- In a session, the agent sees Executor's tools beside Mend's own. Every call appears in the
  conversation and the record with the service, the tool, whose account it ran as and what came
  back. A call Executor holds for approval shows **Approve** and **Deny** in Mend, to the person the
  call runs as. The agent can't approve its own call.
- Mend adds no services for anyone.

## Language

- **Executor** (capital E) is the product. Mend already says "executor" for the machine a session's
  workspace runs on (ADR 0016); never write a bare lowercase "executor" for the gateway, and never
  call the gateway Mend's executor.
- **An organization's Executor**: the one Executor an organization's sessions use. It is either
  **Mend-run** or the organization's **own**.
- **Executor link**: one person's consent that lets Mend call one Executor as them. Like a
  `Slack link`, it is made explicitly by the person, never inferred from an email.
- **Mend's member**: the Executor member Mend itself acts as when a call belongs to nobody who has
  linked. It sees only what the organization shares with everyone.
- **Service**: what people add and connect (Linear, Figma). Executor calls it an app; Mend's screens
  say service. **Personal account** and **shared account** keep Executor's meaning: a personal
  account is private to one member, even from Executor's administrators; a shared account is shared
  with everyone.
- Status words follow the evidence rule: "Executor answered · observed 12:04", never "connected and
  healthy".

## Decisions

### 1. One Executor per organization, never per person

Executor v2 already separates what an organization shares from what each member keeps: a personal
account's "metadata and use are private to one organization member", and "personal accounts remain
private even from administrators"
(`apps/hosted/server/src/implementation/resource-policy.ts:347-371` at `executor@2.0.0-beta.36`). A
self-hosted Executor holds exactly one organization
(`apps/hosted/self-host/src/implementation/registration.ts:74-85`). A server per person would cost
about 1.2–1.5 GiB of memory each (see "What was observed") and add nothing a member can't already
keep private.

Sealant runs each organization's Executor as a caller-owned retained service through its public SDK
(decision 9). The scope belongs to the organization in both single and multi tenancy. Its private
endpoint admits Mend's server only; workspaces cannot link to that scope.

### 2. Mend's address is the only one a browser needs

Mend already has exactly one browser origin, `APP_URL` (ADR 0004): `https:` whenever the instance is
reached from beyond its own machine, whether behind an edge on a domain, on a private network, or
through `tailscale serve`, and plain HTTP only on loopback. A Mend-run Executor adds no second one.
It is never published, never routed by the edge and never reachable from a workspace. Every step
that would otherwise need Executor's own pages happens in Mend or between servers:

| Step                            | Where it happens                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signing a person in to Executor | Server to server: Mend's server and the Executor, on their private network (decision 6)                                                                     |
| Linking (the person's consent)  | The click in Mend; Mend's server completes Executor's consent itself                                                                                        |
| Adding and sharing a service    | Mend's screens, calling Executor's HTTP API as Mend's member                                                                                                |
| Connecting an account           | The service's own sign-in page in the person's browser, which returns to `APP_URL`; Mend's server finishes it with Executor (`EXECUTOR_OAUTH_CALLBACK_URL`) |
| Approving a held call           | Mend's screens                                                                                                                                              |

So each exposure needs nothing beyond what Mend itself already needs:

| How Mend is reached                            | Mend-run Executor                                                                                 | Organization's own Executor                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Loopback, plain HTTP                           | Works; the service's sign-in returns to `http://localhost…`, which services accept for local apps | Works if the person's browser and Mend's server both reach it |
| Private network, HTTPS at the operator's edge  | Works                                                                                             | Same                                                          |
| Tailscale (`tailscale serve`, a `ts.net` name) | Works                                                                                             | Same                                                          |
| A domain of their own, HTTPS at the edge       | Works                                                                                             | Same                                                          |

Rejected: giving Executor its own hostname so people use its pages. Every exposure would need a
second name and certificate (a DNS record and certificate on a domain, a Tailscale Service on a
tailnet, an operator-issued certificate on a private network, nothing workable on loopback), and
people would sign in to a second product.

### 3. Mend relays every call; nothing about Executor reaches a workspace

Executor's tools are served through Mend's existing MCP server (`mend`), which the agent already
reaches over the session channel. Mend's server holds the Executor credentials, sealed with the
machine's `SecretCipher`, and calls Executor's MCP endpoint itself. No Executor URL, token or
network route is placed in a workspace.

Why: people sharing a workspace can read each other's homes (ADR 0016), so a token written there is
not private; workspaces cannot rely on reaching the Mend host or a private network, and Mend's
server can; and one path covers every harness. This requires giving opencode and pi the `mend` MCP
server, which only Claude and Codex get today (`packages/sessions/src/mend-mcp/launch.ts`). That
also brings them the screen and proof tools.

### 4. A call runs as the person the session channel names, or as Mend's member

The relay already knows who is calling: a person's session token names them (ADR 0016, decision 4).
A call runs with that person's Executor link. If that person has no link, or the token names nobody,
the call runs as Mend's member and sees only what is shared with everyone. A call never runs with
another person's link, so under shared control a turn Bob sends uses Bob's link or Mend's member,
never the session owner's. This is ADR 0013's rule applied to tools.

### 5. A link is two grants Executor issues to Mend

Mend is an OAuth client of each organization's Executor (dynamic client registration, PKCE). A link
holds two grants for the same member, both sealed:

- **The tool grant**, scopes `mcp offline_access`, for calling tools over MCP. Mend fixes its
  approval delivery to `model`, so a held call comes back to Mend as a request it can answer
  (decision 8).
- **The service grant**, scopes `executor offline_access`, for Executor's HTTP API: listing, adding
  and connecting services. The tool grant alone is refused there (observed).

Access tokens last an hour and refresh; a refresh token lasts 30 days. When a refresh fails, the
link shows "Executor refused this link · observed …" with **Link again**, and the person's calls
fall back to Mend's member.

With the organization's own Executor, the person consents in their browser at that Executor, which
returns to `APP_URL`. With a Mend-run Executor, the person's click in Mend is the consent, and
Mend's server performs Executor's sign-in and consent itself (decision 6). Unlinking revokes both
grants in Executor and deletes them in Mend.

Rejected: Executor's personal API keys. They can only be created from a browser session on
Executor's own origin (`apps/hosted/server/src/implementation/api-keys.ts:31-60`).

For an organization's own Executor, Mend's member is the Executor member an owner links as "Mend's
member" once, by the same consent; the page says to use a member made for Mend, not a person. For a
Mend-run Executor, Mend's member is the Executor's owner, which Mend creates on first start.

### 6. For a Mend-run Executor, Mend is its sign-in, on a private listener

Mend serves an OpenID Connect provider from `packages/auth`, using `@better-auth/oauth-provider` at
the catalog's Better Auth version (Better Auth's recommended plugin; its older bundled
`oidcProvider` is deprecated). The Executor is its one confidential client, configured through
`SSO_DISCOVERY_URL`, `SSO_CLIENT_ID`, `SSO_CLIENT_SECRET` and `SSO_ALLOWED_DOMAINS`. A person signed
in that way joins the Executor as a member with no password
(`apps/hosted/self-host/src/implementation/registration.ts:99-170`).

Executor requires HTTPS for discovery, the issuer and every endpoint, follows no redirect, and reads
discovery once at startup (`apps/hosted/self-host/src/implementation/auth-options.ts:8-20, 57-117`).
Browsers never use this provider, so it does not live on `APP_URL`:

- Mend serves it on a second listener, reachable only on the private network Mend shares with the
  Executor (decision 9). Its certificate comes from a private certificate authority Mend generates
  once and seals; the Executor trusts it through `NODE_EXTRA_CA_CERTS`. This is the second place
  Mend's process ends TLS, after the session channel (ADR 0004, decision 1), and for the same
  reason: a hop no edge sits on.
- Its authorize endpoint signs in only a person Mend's server names at that moment, with a
  single-use ticket minted when that person clicks Link. A browser has no route to it and no way to
  present a ticket.
- Mend's server drives the sign-in and both consents with its own cookie jar: Executor's SSO start,
  the provider's authorize with the ticket, Executor's callback, then Executor's `/mcp/authorize`
  consent for each grant. The Executor is registered with the provider as trusted, so the provider
  shows no consent of its own.

The claims: Executor accepts only `email_verified: true` and an email whose domain is in
`SSO_ALLOWED_DOMAINS`, matched exactly (`registration.ts:99-110`, `auth-options.ts:22-55`). Mend
does not verify mailboxes and an organization's members use many domains, so Mend issues each person
a stable address it owns, `<account id>@<organization id>.people.mend.invalid`, marked verified
because Mend is the only authority for that domain, with the person's name as the display name.
Executor keys the person by the token's `sub`, so a changed real email changes nothing.

Executor's own roles do not matter on a Mend-run Executor: people join as members, Mend's member is
the owner, and Mend applies Mend's own rules (only owners add and share services for the
organization) before it acts as Mend's member.

### 7. Services are added and connected in Mend

For a Mend-run Executor, Mend's screens cover what people would otherwise do in Executor:

- **Add a service** (owners): by its MCP address, through Executor's import
  (`POST /api/organizations/:org/apps/import`), as Mend's member, then shared with everyone.
  Executor accepts a server that allows anonymous use or advertises OAuth discovery. Services an
  owner adds are visible to everyone; a person may also add a service only they see.
- **Connect an account**: Mend starts the connection with the person's service grant and opens the
  service's sign-in page. It returns to `APP_URL` (the Executor's `EXECUTOR_OAUTH_CALLBACK_URL`
  points there) and Mend's server completes it through `oauth/complete`. A service that takes an API
  key gets a field in Mend instead. Owners connect shared accounts the same way, as Mend's member.
- **Disconnect** removes the account in Executor.

For an organization's own Executor, Mend shows what each person's link can use and links to that
Executor for changes.

### 8. Approvals happen in Mend, never by the agent

Executor decides which calls need a person, per tool, in the service's code. When a call is held,
Mend shows it to the person it runs as: the service, the tool, the arguments that matter, and
Approve or Deny, in the session and wherever that session's notices go. Mend answers with that
person's tool grant (`resume` with `accept` or `decline`,
`packages/mcp/src/contracts/execute.ts:326-345`). For a call run as Mend's member, the person who
sent the turn answers. The relay refuses an agent's own attempt to accept a held call; the agent can
only learn that it is waiting. Executor drops a held call after 15 minutes
(`packages/sdk/src/contracts/tools.ts:78`), and Mend says so instead of leaving a button that no
longer works.

### 9. Sealant runs one Executor per organization through the SDK

Mend's API asks Sealant's public SDK for an organization-owned scope and a caller-only retained
instance. Mend never starts containers directly or imports Sealant internals. Core's caller-owned
scope contract shipped in sealant-sh/sealant#451. The deployment configures the caller and its
private callback port, rather than declaring an Executor:

- **Packaged install**: Core's configured `mend` caller names the container running Mend and Core.
  Core creates each instance's private networks and retained volume. Only that caller reaches
  Executor, and Executor reaches only Mend's private callback port among private addresses, plus
  public internet integration endpoints. No Executor port is published.
- **Kubernetes**: the chart configures Mend's caller pods, private callback Service and ingress
  policy. Core's Kubernetes implementation is manifest-tested only (SLNT-544). Mend refuses "Mend
  runs Executor" there until live runtime support is accepted.
- **Local development**: Mend's server runs in a container named by Core's caller configuration. A
  bare-host Mend server is refused; containers on this machine cannot reach a host listener.

In every shape: an image digest pinned by each Mend release (Executor v2 is a nightly beta with no
data-compatibility promise, so the pin moves deliberately); one volume at `/app/data`, one replica;
a 1.5 GiB memory limit (Executor's pressure garbage collection only runs against a limit,
`apps/hosted/self-host/native/main.go:35-49`, and 1 GiB is too small); `BETTER_AUTH_SECRET`,
`EXECUTOR_ENCRYPTION_KEY` and the provider's client secret generated once and sealed, never rotated
(changing the encryption key makes every saved account unreadable); `DO_NOT_TRACK=1` and
`EXECUTOR_DISABLE_ANALYTICS=1`; `BETTER_AUTH_URL` set to a fixed loopback-style name,
`http://executor.localhost:4400`, which Mend's server maps to the Executor's real private address
for every request. The name is needed because Mend's provider (Better Auth) accepts a plain-HTTP
redirect address only for loopback hosts, and `*.localhost` counts as one by name; no certificate is
needed for the Executor. If the Executor ever rejects requests sent to its real address under that
name, a TLS front with a certificate from Mend's private authority replaces the name. Mend becomes
the Executor's owner through the one-time `POST /api/auth/self-host/setup` the first time it
answers; a second call is refused.

The owner's choice in Settings shows the approximately 1.5 GiB memory cost before starting.
Unsupported runtimes and missing caller configuration receive a clear refusal. Stop retains data.
Upgrade stops the instance and streams a complete volume backup to Mend's private store before
moving the release's image pin; an incomplete backup prevents replacement. Remove explicitly
confirms deletion of the organization's service logins, stops and purges the instance through the
SDK, then deletes Mend's sealed state and grants. Archive alone is never Remove: retained volumes
contain service logins. Remove requires Core's explicit purge contract.

## What was observed

Local runs on 2026-11-05 of image digest
`sha256:055217310f759bf87ff529ecf8b7a69e6eb3bb8bae9dde8164eedfb2afb2b467` (`2.0.0-beta.36`, built
from upstream commit `1f1c5fa`, the commit the public tag exports):

- `/health` answered 200 within 11.3 s of start.
- `POST /api/auth/self-host/setup` from a script answered 200; the same call again answered 403
  "Setup is already complete".
- Memory, read from the container's cgroup: with a 3 GiB limit, start peaked at 1181 MiB and setup
  at 1402 MiB, settling near 1.0 GiB. With a 1.5 GiB or 1.25 GiB limit, start and setup succeeded
  and peaked near 1125 MiB. With a 1 GiB limit, one start succeeded and one was killed for memory
  during start.
- Containers on one Docker network reached each other and the internet; the Executor container could
  not reach a provider served from the host. The provider listener therefore sits on the network
  Mend shares with the Executor.

The chain was then run with the provider in a container beside the Executor, using
`@better-auth/oauth-provider@1.6.23` and a 1.5 GiB limit. The sign-in and consents were clicked in a
headless browser that could reach both; decision 6 moves those same requests to Mend's server.

- **Sign-in.** The test person came back to the Executor as an organization `member`. Their only
  Executor account was the `sso` one, with no password. Executor fetched discovery, authorization,
  token and signing keys, and never called UserInfo. The RS256 ID token carried `sub`, `name`,
  `email` and `email_verified: true`.
- **The tool grant.** Dynamic client registration answered 201 for a public client using PKCE, with
  scopes `mcp offline_access`. Access tokens last an hour; refreshing worked and replaced both
  tokens. Refresh tokens last 30 days by Executor's source
  (`packages/mcp-auth/src/implementation/oauth.ts:190`); that wasn't waited out.
- **Calls.** `tools/list` returned `skills`, `search`, `describe`, `call`, `execute`, `resume`;
  search, describe, call and execute worked, then 50 more calls.
- **Approval.** A tool marked `always()` returned `approval-required` with a request id; a `resume`
  with `accept`, sent from a different MCP session under the same person's grant, completed it.
- **Linear.** Importing `https://mcp.linear.app/mcp` and sharing it with everyone worked. Starting
  the person's connection produced Linear's authorize URL with scopes `read write`. It was not
  opened.
- **Connecting through a relay.** With `EXECUTOR_OAUTH_CALLBACK_URL` pointed at a relay, the relay
  finished a test service's sign-in through `oauth/complete` with the person's service grant and no
  Executor browser session, and the person's agent then called the service. The tool grant alone was
  refused there.
- **Memory at 1.5 GiB.** Start peaked at 1218 MiB. In use: 689 MiB after start, 660 MiB after
  sign-in and link, 932 MiB after 50 calls, 614 MiB after six idle minutes.
- **Restore.** Stopping, copying the volume and starting a new container on the copy kept the
  person, a fresh sign-in and their existing link.
- **Upgrade.** A fresh beta.35 volume started under beta.36 kept the owner, their role and a link
  made before the upgrade.

**Server to server, no browser** (a further run the same day, Docker network `internal: true`, no
published ports, a Node client in a container standing in for Mend's server):

- `POST /api/auth/self-host/setup` gave the owner's cookie; with it, Mend's member got both grants.
- `POST /api/auth/sign-in/social` `{provider:"sso", callbackURL, disableRedirect:true}` returned the
  provider's authorize address. The provider's authorize, called with a single-use ticket header and
  no browser session, redirected to Executor's callback; a missing or reused ticket got 401. Better
  Auth 1.6.23 does this with a `hooks.before` hook that consumes the ticket and creates a real
  60-second session, with no patch to the library; the session must be stored, because the code
  exchange checks it. Executor's callback signed the person in as a `member` with one `sso` account.
- For each grant: registration 201, authorize 302, then `POST /api/auth/oauth2/consent`
  `{accept:true, oauth_query:<the signed query>}` with Executor's `Origin`, the session cookie and
  `X-Executor-Organization`, which returned the code in a JSON `url` (not a `Location` header).
  Token exchange returned both tokens. No value from rendered HTML was needed. A missing or wrong
  `Origin` got 403, no cookie 401, no organization 400, an altered query 400.
- Both tool grants listed the six tools; both service grants read the organization's apps; a tool
  grant on the HTTP API got 401.
- A plain-HTTP private name for the Executor's callback was refused by the provider (Better Auth
  allows plain HTTP only for loopback hosts); decision 9's `executor.localhost` name follows from
  that.

These requests belong to Executor's own web sign-in, which a beta can change. The image pin and an
end-to-end check of exactly these requests in CI guard them.

Not yet observed: a real Linear account connected end to end.

## Alternatives not taken

- **Writing Executor's address and a key into each workspace.** The key is readable by co-tenants,
  workspaces may not reach the Executor, and each harness needs its own config.
- **A personal Executor server per person.** Costs a server's memory per person for privacy Executor
  already gives inside one organization.
- **Executor on its own hostname, used through its own pages.** See decision 2.
- **Mend creating Executor accounts with generated passwords.** Mend would hold a password per
  person. The private sign-in provider gives the same server-side sign-in without one.
- **Mend's API starting the Executor container directly.** Sealant owns the lifecycle and network
  boundary through the public SDK; Mend's API receives no Docker or cluster access.
- **Hosted executor.sh as the only option.** It is a third party holding every login; organizations
  that want it can connect it as their own Executor.

## Consequences

- Mend becomes an OpenID Connect provider, on a listener only the Executor reaches. It gets the same
  review as sign-in itself.
- Mend drives Executor's sign-in and consent endpoints from its server, and creates Mend's member
  through the one-time setup call, because Executor v2 offers no service identity. Executor is in
  beta and may change those endpoints; the image pin and an end-to-end check in CI catch that, and
  Mend asks upstream for a supported service credential.
- A Mend-run Executor costs about 1.5 GiB of memory per organization. Settings says so before start.
- Executor's upgrade notes become part of Mend's release checklist while Executor is in beta.

## Build order

Each step is its own pull request in one stack and gets its own check on the box.

1. **The `mend` MCP server for opencode and pi.**
2. **Executor settings, links and the relay, for an organization's own Executor.** The tab, links
   (browser consent), calls run as the right person and recorded in sessions, approvals in Mend,
   `mend connect executor`.
3. **The Mend-run Executor through Sealant.** One organization-owned scope and caller-only instance,
   deployment caller configuration, the pinned image, stopped-volume backup on upgrade, Mend's
   member created on first start, and clear refusal on unsupported runtimes.
4. **Mend's private sign-in provider and one-click links** for a Mend-run Executor.
5. **Services in Mend**: add, share, connect and disconnect accounts, for a Mend-run Executor.

## Open items

- Whether to point a Mend-run Executor's `EXECUTOR_CATALOG_URL` at a public catalog, so Mend can
  offer Linear and Figma as choices instead of asking for an MCP address. Nothing is added for
  anyone either way.
