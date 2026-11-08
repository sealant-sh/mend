# Access keys: drive Mend from your own automation

Status: accepted 2026-11-08. Yiannis asked for it the same day: "We need a way to expose a mend api
behind an api key so external tools can access it. Imagine someone has setup a software factory and
they need their slack bot to spin up a mend session or their whatever system to do so." Read against
Mend `a9e9e9ea02`. Builds on [ADR 0003](0003-organizations-and-tenancy.md) (organizations),
[ADR 0004](0004-access-without-a-private-network.md) (budgets, upgrade tickets),
[ADR 0007](0007-landing.md) (who lands) and [ADR 0013](0013-whoever-sends-a-turn-pays.md) (who
pays).

## Context

A person who runs their own automation, such as a Slack bot, a CI job or an internal "software
factory", wants it to start Mend sessions and follow them. Today the only ways in are a browser
sign-in and a paired device. A paired device comes from `mend login`, which needs a browser to
approve it, or from minting a token by hand in Settings. That token acts as its person in whichever
organization they belong to, never expires, and can mint more tokens.

Mend already has a bearer credential with the properties this needs. A paired-device token (`mdt_…`)
is stored only as its SHA-256, is checked on every request, is revoked when its person is removed
from the organization, stops working when the account is deactivated, and ends every upgrade ticket
and preview grant it minted (`credentialStanding`). Every HTTP route an automation needs already
accepts it. The origin policy admits a bearer request that carries no Origin and no cookie, and the
request budget limits each presented credential separately.

"API key" already means a provider login in Mend
([ADR 0018](0018-api-key-logins-and-organization-keys.md)).

## Decision

### 1. The noun is "access key"

An `access key` is a named bearer credential a person creates to let their own automation call
Mend's HTTP API as them, in one organization. Never call it an API key, which is a provider login
(ADR 0018), or a token, which is what a paired device holds. Screens say "access key". The CLI
command is `mend access-keys`, because `mend keys` already manages the person's Mend SSH key.

### 2. One credential store, a third kind of credential

An access key is a row in the same store as paired-device tokens (`device_tokens`), with
`kind = 'access_key'`, the `organization_id` it acts in and an optional `expires_at`. A request it
proves carries the credential `key:<id>`, beside `session:<id>` for a sign-in and `device:<id>` for
a paired device. Upgrade tickets, preview grants and screen watches bind to it as they bind to a
device, and `credentialStanding` refuses them once the key is revoked or expired.

We considered three shapes:

| Shape                                     | What it reuses                                                 | Why not, or why                                                                                                                                                                                                                                    |
| ----------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth's API-key plugin              | Hashing, expiry, a per-key rate limit                          | A third token system beside sign-ins and device tokens. It keeps its own table outside Mend's migrations and resolves to a session Mend's credential standing, member removal and upgrade tickets never see. Its rate limit is not Mend's budgets. |
| A separate `access_keys` table            | The `key:` credential                                          | Every revocation path (member removal, deactivation, credential standing) would need a second copy that a later change can forget.                                                                                                                 |
| A kind of row in `device_tokens` (chosen) | Every revocation path, last-used stamping, credential standing | Device queries filter on `kind = 'device'`. That costs two `WHERE` clauses.                                                                                                                                                                        |

### 3. One person, one organization, fixed at creation

A key acts as the person who created it, in the organization they were acting in when they created
it, and never in another. A request with a key is refused unless its person is still a member of
that organization and their account is active. Removing the member revokes the key with their
devices.

Organization switching (one account in several organizations, being built beside this) pins the
organization a sign-in or device acts in. A `key:` credential is never pinned and never switches:
its organization is the key row's. A switch request made with a key is refused.

### 4. The key and how Mend checks it

A key reads `mak_<id>_<secret>`. The id is the row's, so it can be shown in lists and logs. The
secret is 32 random bytes in base64url. Mend stores only the SHA-256 of the secret, finds the row by
id, and compares hashes with `timingSafeEqual`. The secret is shown once, in the answer to the
request that created it.

Mend accepts a key only as `Authorization: Bearer`. It is never read from a query string, a cookie
or a form field. A request whose bearer starts with `mak_` is resolved as an access key and nothing
else: it never reaches Better Auth, so no library logs it.

### 5. Expiry and revocation

A key works for 1 to 365 days, or until revoked when created without an expiry. Settings offers 30
days, 90 days (the default), a year, or no expiry. Revoking a key, or its expiry passing, refuses
the next request that presents it, and every upgrade ticket and preview grant it minted. Expired
keys stay in the list until revoked, so their person sees why a job stopped.

### 6. A key cannot create or manage credentials

An access key cannot create, list or revoke access keys, pair or revoke devices, approve or deny a
CLI sign-in, or issue a password reset link. It also cannot give anyone a way in that outlives it:
it cannot create an organization invitation or an operator's owner invitation, register a workspace
SSH key, or confirm a Slack link. Each of those endpoints declares `PersonCredentialOnly` in the
contract and answers `403 AccessKeyRefused`. Without this, someone who stole a key could mint a
paired-device token, invite an account of their own or link their own Slack user, and keep access
after the key was revoked. Keys, devices, invitations and links are managed from a sign-in or a CLI
signed in with `mend login`.

### 7. Everything else follows the person

Every other route treats a key as its person. Visibility, steering and shared control (ADR 0003),
the change owner's right to land (ADR 0007), whose login a turn spends (ADR 0013: the sender's, so
the key's person's) and the account and organization budgets (ADR 0004) all apply unchanged. Each
key has its own request budget, because the budget keys on the presented credential.

### 8. Audit

The organization's audit log records `access_key.created` and `access_key.revoked`, with the key's
name. It records `access_key.used` the first time a key is used and then at most once an hour while
it stays in use. Every audited action taken with a key names the key beside the person
(`audit_events.access_key_id`), so the log reads "Ana landed a change · access key ci-bot".

### 9. What an automation can do

The existing routes in `@mend/api-contracts`, unchanged. An automation can list projects, create a
session and launch it in conversation mode with a prompt, harness, model and effort, send
follow-ups, read the session, its turns and history, read the diff and checkpoints, stop it, and
land its change. A terminal session needs a socket, so a key launches conversation sessions only. A
project whose git access runs through the CLI's SSH-agent bridge (`gitAuthMode: bridge`) cannot be
landed with curl, because no CLI is connected to sign the push.

## Consequences

- An automation needs no browser and no `mend login`: a person creates a key once and hands it to
  the job.
- The device queries (`list`, `revoke`) and push registration filter on `kind = 'device'`; the
  Devices panel never shows a key.
- A stolen key is worth what its person can do in one organization, until it expires or is revoked.
  Owners see every key's creation, use and revocation in the audit log, but cannot revoke another
  member's key except by removing the member.

## Out of scope

- A key for the operator, or a key that acts for the whole instance.
- Narrower permissions per key (read-only, one project).
- Owners listing or revoking members' keys.
- Telling an automation that a session finished without polling, such as a webhook per key or per
  session. Filed for later. `GET /api/events` (server-sent events) works with a key today.
