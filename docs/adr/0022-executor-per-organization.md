# Executor: one per organization, reached through Mend, with Mend as its sign-in

Accepted by Yiannis, 2026-11-05. Not yet scheduled for a release.

Agents in Mend sessions get tools for services such as Linear, Figma or Sentry through
[Executor](https://executor.sh), an MIT-licensed integration gateway. Executor keeps the logins to
those services and the rules for which calls may run. Mend does not reimplement any of that. An
organization either connects an Executor it already runs, or lets Mend run one for it: one Executor
per organization, never one per person. Agents never hold an Executor credential: Mend's server
calls Executor for them, as the person the call belongs to. When Mend runs the Executor, Mend is
also how people sign in to it, so nobody gets a second password.

This record is about Executor v2 (`ghcr.io/usefulsoftwareco/executor-selfhost`, release tags
`executor@2.0.0-beta.*`, source on the `v2-releases` branch of `UsefulSoftwareCo/executor`). The
repository's `main` branch is still v1, which has a different model; nothing here applies to it.

## What people get

- An owner opens Settings → Organization → Executor and chooses: **Mend runs Executor for this
  organization**, or **use an Executor this organization already has** (its URL). Members see the
  tab without credentials, so they know what their sessions get.
- Any member can **link** their own Executor account from Settings → You → Workspace (or
  `mend connect executor`, or the notice a session shows when a tool needs it). Linking is one
  consent page. With a Mend-run Executor it signs them in through Mend; there is no Executor
  password. Linking is opt-in: without it, a person's sessions still get the tools the organization
  shares with everyone.
- In a session, the agent sees Executor's tools beside Mend's own. Every call appears in the
  conversation and the record with the service, the tool, whose account it ran as and what came
  back. A call Executor holds for approval shows **Approve** and **Deny** in Mend, to the person the
  call runs as, in the session, in Slack and on the phone. The agent can't approve its own call.
- Adding services happens in Executor: an organization's shared accounts by its owners, personal
  accounts by each person. Mend adds no integrations for anyone.

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
- Executor's own nouns are used as Executor defines them: **app** (a set of tools), **personal
  account** (private to one member, even from Executor's administrators), **shared account** (shared
  with everyone or with groups).
- Status words follow the evidence rule: "Executor answered · observed 12:04", never "connected and
  healthy".

## Decisions

### 1. One Executor per organization, never per person

Executor v2 already separates what an organization shares from what each member keeps: a personal
account's "metadata and use are private to one organization member", and "personal accounts remain
private even from administrators"
(`apps/hosted/server/src/implementation/resource-policy.ts:347-371` at `executor@2.0.0-beta.36`). A
self-hosted Executor holds exactly one organization
(`apps/hosted/self-host/src/implementation/registration.ts:74-85`). So one Executor per Mend
organization gives each person a private space without a server of their own. A server per person
would cost about 1.1–1.5 GiB of memory each (see "What was observed") and add nothing a member can't
already keep private.

### 2. Mend relays every call; nothing about Executor reaches a workspace

Executor's tools are served through Mend's existing MCP server (`mend`), which the agent already
reaches over the session channel. Mend's server holds the Executor credentials, sealed with the
machine's `SecretCipher`, and calls Executor's MCP endpoint itself. No Executor URL, token or
network route is placed in a workspace.

Why: people sharing a workspace can read each other's homes (ADR 0016), so a token written there is
not private; workspaces cannot rely on reaching the Mend host or a private network, and Mend's
server can; and one path covers every harness. This requires giving opencode and pi the `mend` MCP
server, which only Claude and Codex get today (`packages/sessions/src/mend-mcp/launch.ts`). That
also brings them the screen and proof tools.

### 3. A call runs as the person the session channel names, or as Mend's member

The relay already knows who is calling: a person's session token names them (ADR 0016, decision 4).
A call runs with that person's Executor link. If that person has no link, or the token names nobody,
the call runs as Mend's member and sees only accounts shared with everyone. A call never runs with
another person's link, so under shared control a turn Bob sends uses Bob's link or Mend's member,
never the session owner's. This is ADR 0013's rule applied to tools.

### 4. A person's link is an MCP OAuth grant, in both modes

Mend is an MCP OAuth client of each organization's Executor: dynamic client registration, then the
person consents at the Executor's `/mcp/authorize`, then Mend keeps the access and refresh tokens
sealed (`apps/docs/content/mcp.md`). The grant is bound to that member and that organization and can
be revoked from either side. Mend fixes the grant's approval delivery to `model`, so a held call
comes back to Mend as a request it can answer (decision 6).

Rejected: Executor's personal API keys. They can only be created from a browser session on
Executor's own origin (`apps/hosted/server/src/implementation/api-keys.ts:31-60`); asking people to
paste one is a worse experience than one consent page and gains nothing.

For an organization's own Executor, Mend's member is whichever Executor member an owner links as
"Mend's member" once, by the same consent flow; the setup page says to use a member made for Mend,
not a person.

The first version sends people to the Executor's own pages to connect a service, where a Mend-run
Executor already has them signed in. Connecting from inside Mend works too (observed below), but
needs a second grant per person with Executor's `executor` scope, because the MCP grant can't call
Executor's HTTP API. That comes later, if people ask for it.

### 5. For a Mend-run Executor, Mend is the OpenID Connect provider

Mend serves an OpenID Connect provider from `packages/auth` using `@better-auth/oauth-provider` at
the catalog's Better Auth version (the plugin Better Auth recommends; its older bundled
`oidcProvider` is deprecated). Each Mend-run Executor is one confidential client, registered when
Mend provisions it, and is configured with Executor's `SSO_DISCOVERY_URL`, `SSO_CLIENT_ID`,
`SSO_CLIENT_SECRET` and `SSO_ALLOWED_DOMAINS`. A person who signs in that way joins the Executor as
a member with no password (`apps/hosted/self-host/src/implementation/registration.ts:99-170`).

Two Executor rules shape the claims Mend issues:

- Executor accepts only `email_verified: true` and an email whose domain is in
  `SSO_ALLOWED_DOMAINS`, matched exactly (`registration.ts:99-110`, `auth-options.ts:22-55`). Mend
  does not verify people's mailboxes, and an organization's members use many domains. So Mend issues
  each person a stable address it owns, `<account id>@<organization id>.people.mend.invalid`, marked
  verified because Mend is the only authority for that domain, with the person's name as the display
  name. Executor's identity for them is the token's `sub`, so a changed real email changes nothing.
- Discovery, issuer and every endpoint must be HTTPS, discovery must not redirect, and Executor
  reads it once at startup (`auth-options.ts:8-20, 57-117`). So a Mend-run Executor needs Mend
  reachable over HTTPS in people's browsers: an instance behind an edge (ADR 0004). An instance that
  is only reachable on loopback over HTTP can use its organization's own Executor, and Mend asks
  Executor upstream to accept a loopback HTTP issuer the way it already accepts loopback HTTP
  elsewhere (`EXECUTOR_URL_ALLOW_LOOPBACK_HTTP`). Mend never installs a certificate authority on a
  person's machine to get around this.

Mend owners become Executor administrators and members stay members; Mend applies the role when the
person first links and when their Mend role changes.

### 6. Approvals happen in Mend, never by the agent

Executor decides which calls need a person, per tool, in the app's code. When a call is held, Mend
shows it to the person it runs as: the service, the tool, the arguments that matter, and Approve or
Deny. Mend answers with that person's grant (`resume` with `accept` or `decline`,
`packages/mcp/src/contracts/execute.ts:326-345`). For a call run as Mend's member, the person who
sent the turn answers. The relay refuses an agent's own attempt to accept a held call; the agent can
only learn that it is waiting. Executor drops a held call after 15 minutes
(`packages/sdk/src/contracts/tools.ts:78`), and Mend says so instead of leaving a button that no
longer works.

### 7. Running a Mend-run Executor

- One container per organization, from an image digest pinned by each Mend release, on the network
  Mend's server uses; never reachable from workspaces. Mend upgrades it only when Mend itself is
  upgraded, after stopping it and snapshotting its volume. Executor v2 is a nightly beta with no
  promise of data compatibility between releases, so Mend moves the pin deliberately.
- One volume at `/app/data`, one replica (Executor enforces this with a lock). Backups are taken
  while it is stopped.
- Memory limit 1.5 GiB. Executor's pressure garbage collection only runs against a cgroup limit
  (`apps/hosted/self-host/native/main.go:35-49`), and 1 GiB is too small (observed below).
- `BETTER_AUTH_SECRET` and `EXECUTOR_ENCRYPTION_KEY` are generated once, sealed by Mend, and never
  rotated: changing the encryption key makes every saved account unreadable.
- `DO_NOT_TRACK=1` and `EXECUTOR_DISABLE_ANALYTICS=1`.
- Its own hostname behind Mend's edge, because Executor rejects a path in `BETTER_AUTH_URL`:
  `executor.<base>` for a single-organization instance, `<organization slug>.executor.<base>`
  otherwise. Executor's app pages need a further wildcard origin; Mend leaves them off at first.
- Mend becomes the Executor's owner on first start through the unauthenticated, one-time
  `POST /api/auth/self-host/setup`, before the Executor is reachable from anywhere else. A second
  call is refused.

## What was observed

Local runs on 2026-11-05 of image digest
`sha256:055217310f759bf87ff529ecf8b7a69e6eb3bb8bae9dde8164eedfb2afb2b467` (`2.0.0-beta.36`, built
from upstream commit `1f1c5fa`, the commit the public tag exports):

- `/health` answered 200 within 11.3 s of start.
- `POST /api/auth/self-host/setup` from a script answered 200; the same call again answered 403
  "Setup is already complete".
- Memory, read from the container's cgroup: with a 3 GiB limit, start peaked at 1181 MiB and setup
  at 1402 MiB, settling near 1.0 GiB (about 850–940 MiB anonymous). With a 1.5 GiB or 1.25 GiB
  limit, start and setup succeeded and peaked near 1125 MiB. With a 1 GiB limit, one start succeeded
  and one was killed for memory during start.
- Containers on one Docker network reached each other and the internet; the Executor container could
  not reach a provider served from the host. Mend-run Executors therefore sit beside Mend's server
  on its network, and the sign-in provider is reached there.

The whole chain was then run with the sign-in provider in a container beside the Executor, using
`@better-auth/oauth-provider@1.6.23` and a 1.5 GiB limit:

- **Sign-in through Mend.** A test person clicked "Continue with SSO", signed in at the provider and
  came back to the Executor as an organization `member`. Their only Executor account was the `sso`
  one, with no password. Executor fetched discovery, authorization, token and signing keys, and
  never called UserInfo. The RS256 ID token carried `sub`, `name`, `email` and
  `email_verified: true`.
- **The link.** Dynamic client registration answered 201 for a public client using PKCE, with scopes
  `mcp offline_access`. The consent page names the client and the organization and says approvals
  come "through your agent"; the person clicked Connect. Access tokens last an hour; refreshing
  worked and replaced both tokens. Refresh tokens last 30 days by Executor's source
  (`packages/mcp-auth/src/implementation/oauth.ts:190`); that wasn't waited out.
- **Calls.** With the person's token: `tools/list` returned `skills`, `search`, `describe`, `call`,
  `execute`, `resume`; search, describe, call and execute worked, then 50 more calls.
- **Approval.** A tool marked `always()` returned `approval-required` with a request id; a `resume`
  with `accept`, sent from a different MCP session under the same person's grant, completed it. That
  is the interface Mend's Approve button uses.
- **Linear.** Importing `https://mcp.linear.app/mcp` as an app and sharing it with everyone worked.
  Starting the person's connection produced Linear's authorize URL with scopes `read write`. It was
  not opened: completing it needs a real Linear account.
- **Connecting without Executor's pages.** With `EXECUTOR_OAUTH_CALLBACK_URL` pointed at a relay,
  the relay finished a test service's OAuth through `oauth/complete` with the person's bearer token
  and no Executor browser session, and the person's agent could then call the service. That call
  needs a second grant with the `executor` scope; the MCP grant alone was refused.
- **Memory at 1.5 GiB.** Start peaked at 1218 MiB. In use: 689 MiB after start, 660 MiB after
  sign-in and link, 932 MiB after 50 calls, 614 MiB after six idle minutes. A 1.25 GiB run passed 20
  calls, peaking at 1123 MiB. A 1 GiB start was killed for memory.
- **Restore.** Stopping, copying the volume and starting a new container on the copy kept the
  person, a fresh sign-in and their existing link.
- **Upgrade.** A fresh beta.35 volume started under beta.36 kept the owner, their role and a link
  made before the upgrade.

## Alternatives not taken

- **Writing Executor's address and a key into each workspace.** Simpler, but the key is readable by
  co-tenants, workspaces may not reach the Executor, and each harness needs its own config.
- **A personal Executor server per person.** Costs a server's memory per person for privacy Executor
  already gives inside one organization.
- **Mend creating Executor accounts with generated passwords.** Executor allows it through its
  invitation endpoints, but Mend would hold passwords for people and drive endpoints Executor built
  for browsers. Single sign-on through Mend avoids both.
- **Hosted executor.sh as the only option.** It is moving organizations to v2 on its own schedule
  and is a third party holding every login; organizations that want that can still connect it as
  their own Executor.

## Consequences

- Mend becomes an OpenID Connect provider. That is new surface on the account system and gets the
  same review as sign-in itself.
- Mend's member and its grant on a Mend-run Executor are made by Mend at provisioning, through
  Executor's browser endpoints, because Executor v2 offers no service identity. Mend asks upstream
  for a supported bootstrap credential and replaces this when one exists.
- Each Mend-run Executor costs about 1.5 GiB of memory on the Mend host. The instance settings say
  so before an owner starts one.
- Executor's upgrade notes become part of Mend's release checklist while Executor is in beta.

## Build order

Each step is usable on its own and gets its own check on the box.

1. **The relay, links and approvals, for an organization's own Executor.** The `mend` MCP server for
   opencode and pi; the Executor tab and link flow; calls recorded in sessions; approvals in Mend.
   This needs no hosting and no sign-in provider.
2. **Mend as an OpenID Connect provider.**
3. **Mend-run Executors.** Provisioning, the edge hostname, pinned upgrades with a snapshot,
   backups, and the memory note in settings. Docker first; Kubernetes (a one-replica StatefulSet)
   after.

## Open items

- Whether to point a Mend-run Executor's `EXECUTOR_CATALOG_URL` at a public catalog, so Linear and
  Figma appear as choices in Executor's Add app list. Without it people add a service by its MCP
  URL. Either way nothing is added for them.
- Finishing a real Linear connection was not exercised; it needs a person's Linear account. Step 1's
  box check does it.
