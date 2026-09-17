# Per-user Sealant identity

Status: decided 2026-08-22. Implemented across Sealant Core (`feat/service-principals`) and Mend
(`yp/sealant-users`). Supersedes the `SEALANT_OWNER_USER_ID` hand-off in `DEVELOPMENT.md` and the
2026-08-18 entry in `docs/BUGS.md`.

## Problem

Every Mend user ran as one Sealant user. Mend's server held a single `SEALANT_OWNER_USER_ID` (the id
the operator signed up with in the Sealant web app) and stamped it on every workspace, run,
inference call and credential lookup. Consequences:

- One set of connected accounts (Claude / Codex / GitHub) for the whole Mend team — shared
  subscriptions, which breaks the providers' terms and makes per-user usage invisible.
- Every workspace and run in Sealant was owned by that one id; nothing on the platform could tell
  which Mend user did what.
- Connecting a credential required the Sealant web app — a second product with its own login that
  Mend users never otherwise see. We want to ship Mend without the Sealant web app running at all.

Sealant's API had no authentication: identity was a caller-asserted `ownerUserId` string, there was
no endpoint that creates a user, and the SDK read the owner from `process.env` once per process.

## Decision

**Mend owns the people; Sealant owns the resources.** Mend is the only login. Each Mend user is
mapped 1:1 to a Sealant user that Mend provisions on first use. Mend talks to Sealant as a _service
principal_ and acts _on behalf of_ the mapped Sealant user on every call. Users connect their own
Claude / Codex / GitHub accounts from Mend (web, desktop, CLI); Mend forwards the credential to
Sealant under the user's own Sealant id and never stores it.

"Infra provider" here means the connected-account providers Sealant models today (`claude`, `codex`,
`github`). Sealant has no compute-provider concept — the worker always drives the host Docker daemon
— and this change does not introduce one.

### Sealant Core

1. **Service principals.** `SEALANT_SERVICE_KEYS` (comma-separated secrets, `slt_svc_…`). When set,
   the API rejects every `/v1/*` request that does not present one of them as a bearer, except: the
   session surface, where a scoped user access token continues to authenticate on its own (Mend's
   pairing tokens for phones/desktop); and the gateway routes, which keep their shared secret. A
   service principal may assert any `ownerUserId` — the existing payload/query field is unchanged,
   so no contract churn. Unset keys keep today's open, loopback-only dev behaviour. `/`, `/healthz`,
   `/readyz`, `/docs`, `/openapi.json` stay public.
2. **Users endpoint.** `POST /v1/users` upserts by email (`{ email, name, userId? }` →
   `{ userId, email, name, created }`) and `GET /v1/users/:userId` reads one. This is the only
   user-creation path that does not go through Better Auth; it exists for service principals.
3. **Ownership on reads.** `GET /v1/workspaces/:id` and the
   `GET /v1/runs/:id[/timeline| /scrollback|/loss|/changes]` family take an optional `ownerUserId`
   query and answer 404 when it is present and does not match. The SDK always sends it.
4. **SDK.** `SealantConfig.ownerUserId` (overrides `SEALANT_OWNER_USER_ID`; the env var stays as a
   fallback for scripts). New namespaces: `sealant.users.ensure(…)`,
   `sealant.connectedAccounts. {list, connect, disconnect}`. The `/effect` ops are exported
   alongside.
5. `compose.selfhost.yaml` passes `SEALANT_SERVICE_KEYS` to the API. Nothing depends on the `web`
   service; a Mend deployment runs the stack without it (`docker compose up --scale web=0`, or drop
   the service). Sealant's own installer still starts it for standalone use.

### Mend

1. `SEALANT_SERVICE_KEY` replaces `SEALANT_API_KEY` (still read as a fallback);
   `SEALANT_OWNER_USER_ID` is removed from Mend's env, compose and docs.
2. `user_sealant_identities (user_id PK → user.id, sealant_user_id UNIQUE, created_at)`. On first
   use Mend calls `users.ensure` with the Mend user's email + name and records the mapping.
3. `@mend/sealant` splits into `SealantClients` (root factory: one SDK client per Sealant user,
   cached) and the existing `SealantClient` contract, which is now **per principal**. The principal
   is an Effect reference (`SealantPrincipal`) set per HTTP request from `CurrentUser`, and set by
   the engine from `session.ownerUserId` for every session-scoped fiber. Call sites are unchanged;
   an unset principal is a typed failure, never a silent fallback to a seed user.
4. Mend API: `GET /me/sealant` (the caller's Sealant user id + accounts),
   `POST /me/sealant/accounts`, `DELETE /me/sealant/accounts/:id`. Secrets pass through to Sealant
   and are never persisted or logged by Mend.
5. Surfaces: Settings → "Connected accounts" on web and desktop; `mend connect claude|codex|github`
   (reads the file the provider's CLI wrote at login, or `--from-stdin`) + `mend accounts`.
6. Hot-pool skeletons are provisioned as their owner and claimed only by that owner's sessions — a
   warmed workspace carries the owner's connected accounts. Since organizations
   (docs/adr/0003-organizations-and-tenancy.md) the pool warms for each account that ran a session
   in the project in the last seven days and may still run there, up to four, and drains an owner's
   skeletons once they lose access.
7. There is no stand-in account. A session without an owner (a row from an instance that had no
   account at upgrade) cannot launch or be steered; the retired queue's runs act as the operator.

## Consequences

- A Mend team of N people is N Sealant users with N credential sets; the harness-account fallback
  ladder (`withGitHubCredentialFallback`) now degrades per user, so one person's missing account
  never silently borrows another's.
- The Sealant web app is no longer part of a Mend deployment. Its remaining unique function (Better
  Auth sign-up) is not needed when Mend is the login.
- Teams/organizations on Mend's side (coming next) do not need a Sealant counterpart: ownership on
  the platform stays per user; sharing is a Mend concern.
- Until the Core change ships as an SDK release, Mend's worktree links the locally built
  `@sealant/sdk` / `@sealant/api-contracts` dist into `node_modules`; the catalog bump follows the
  release.
- Open: revoking a Sealant user when a Mend user is deleted (archive connected accounts, expire
  workspaces); surfacing "launched without a <provider> account" on the session status line —
  tracked, not in this change.
