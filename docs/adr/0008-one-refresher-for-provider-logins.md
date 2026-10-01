# Provider logins: one refresher, copies that cannot rotate

Status: accepted 2026-10-01. Builds on
[ADR 0005](0005-claude-credentials-and-a-grant-of-mends-own.md) (a grant of Mend's own) and replaces
its "Refresh stays where the credential lives" section. Commits the platform to being the **only**
place a Claude or Codex login is refreshed, to handing every other copy a credential that **cannot
rotate**, and to pushing a refreshed credential into running sessions without restarting them. Codex
gets a grant of Mend's own, as Claude did.

## Context

On alpha, 2026-09-30, both of one person's provider logins were dead at once.

- **Codex** was the laptop's own `~/.codex/auth.json`, sent by `mend connect codex`. The laptop's
  Codex refreshed on 2026-09-26; from then on every refresh on the platform was refused with
  `Your access token could not be refreshed because your refresh token was already used`. Tours,
  suggestions and Codex sessions all failed.
- **Claude** was a grant of Mend's own (ADR 0005), so no laptop shared it. It still died between
  19:27 and 21:09: a tour sent the stored access token, still hours from its `expiresAt`, and got
  `401 OAuth access token has been revoked`. From 21:15 every workspace's copy of the file came back
  with no access token at all.

ADR 0005 moved the race off the laptop, but not off the platform. The platform does not keep one
copy of a login. It writes one into every workspace that runs a harness and one into every inference
call, and each copy is handled by its own CLI process that may refresh it. The platform then reads
each copy back (after every exec a workspace runs, and at stop) and keeps the newest. Claude Code's
own guard (`[gateway-refresh] auth changed mid-refresh; discarding`) protects two processes reading
**one** store, not several stores holding one login.

### What the harnesses do (tested 2026-10-01)

Tested against Claude Code 2.1.286 and Codex 0.159.2, with throwaway logins for anything that
refreshed, then revoked. Each row was observed, not read from source alone.

|                                               | Claude Code                                                    | Codex                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Runs with no refresh token                    | yes, with the field removed                                    | yes, with a placeholder; the field is required, and without it the login does not load |
| Reads the credential file                     | before every request                                           | once; again after a 401, or within 5 minutes of expiry                                 |
| Takes a replaced file mid-session, no restart | yes, on the next request                                       | yes, after a 401 (reload from disk, then retry)                                        |
| A refresh revokes the previous access token   | **yes, at once**                                               | no, it stays valid until it expires                                                    |
| Refreshing with a spent refresh token         | refused; that copy's file is wiped; the current login survives | accepted within a grace period; refused days later                                     |
| A supported way to refresh on demand          | the CLI refreshes an expired token on use                      | `codex app-server` → `account/read { refreshToken: true }`, no model request           |

The last two rows explain alpha. A copy that refreshes revokes (Claude) or spends (Codex) the
credential every other copy holds. If its rotated file does not get back to the store (the machine
was drained, or the read-back failed on a 502, as it did that night), the store keeps a dead login
and hands it to every later workspace and tour.

## Decision

### One refresher

The platform's store holds the only refresh token of each login. Only the platform's keep-fresh
worker refreshes it, and only by running the **official** CLI in a private directory: Claude Code
(an expired token is refreshed on use) and `codex app-server`
(`account/read { refreshToken: true }`). Neither Mend nor the platform calls a provider's OAuth or
token endpoint, now or later.

- One refresh per login at a time, across every worker: a claim on the account row, not an
  in-process flag.
- Claude is refreshed about an hour before its access token expires (a session's token lives about
  eight hours). Codex is refreshed a day before its access token expires (about ten days).
- The refreshed file is written to the store **before** anything else is done with it.

### Copies that cannot rotate

Every other copy is a credential its holder cannot refresh:

- **Claude:** the file keeps `claudeAiOauth` without `refreshToken`.
- **Codex:** `auth.json` keeps `tokens.refresh_token` as a fixed placeholder that no provider will
  accept.

This covers workspace launches and inference calls alike. A copy can be used until its access token
expires and cannot spend or revoke anything. The platform stops reading copies back: there is
nothing newer a copy can hold.

### Push, do not wait

After each refresh the platform writes the new copy into every running workspace launched with that
account. The write goes over the executor's control connection (the same exec-with-stdin write the
launch uses), never through the run-exec queue, and every workspace is written in parallel.

- **Claude:** its previous access token is revoked the moment the refresh lands. The push is
  prepared (targets resolved, connections open) before the refresh and written straight after. A
  request caught in between gets a 401, re-reads the file and retries.
- **Codex:** the previous token keeps working, so the push has no deadline beyond its expiry.

### When a login cannot be refreshed

A refused refresh marks the account `invalid` with the provider's words. Launches with it are
refused before a machine is started, inference answers `reconnect Claude` / `reconnect Codex`, and
Mend shows the account as needing a reconnect in the web app, the phone app and `mend doctor`.
Reconnecting clears it.

### A grant of Mend's own, for Codex too

`mend connect codex` runs `codex login --device-auth` in a throwaway `CODEX_HOME`, sends that login
and deletes the directory. It no longer sends the laptop's `~/.codex/auth.json`, whose refresh the
laptop would race. The laptop keeps no copy on purpose: the server refreshes the login from then on,
so a kept copy would soon hold a spent refresh token, and sending it again would replace a good
login with a dead one. Each `mend connect codex` is a fresh login. `--use-my-login` keeps the shared
login for anyone who accepts the race, as it does for Claude.

**Amended 2026-10-01: Claude keeps no copy either.** ADR 0005's grant lived in
`~/.config/mend/claude-grant`, and `mend connect claude` re-sent it while it had not expired. Once
the server refreshed the login, that copy held a spent refresh token: on alpha a reconnect re-sent
the 09-20 file and replaced the login with a dead one, which the keep-fresh worker refused at the
next sweep. `mend connect claude` now logs in against a throwaway directory as Codex does, sends the
grant, deletes the directory (and on macOS its Keychain item), and removes the old kept directory.

### Whose login pays

A connected login belongs to one Mend account and is spent only on that account's own sessions and
on the inference its own requests cause. No other account can read it, and no request from another
account selects it.

- **Review passes** (tour, read, suggest) run on the login of whoever asked. A pass review prep
  queues when a session settles runs on that session's owner's; the tour a landing asks for runs on
  the lander's. The job carries who asked, and a job that does not say runs on no one's. A request
  that joins a pass already queued or running for the change spends nothing.
- **Mend's other reads** (a session's name, a Slack thread's project, a request's intent) run on the
  session owner's, the person who mentioned `@mend`, and the turn's sender respectively. A turn with
  no recorded sender is read on no one's login.
- **Shared control** ([ADR 0003](0003-organizations-and-tenancy.md)) is the one path that spends a
  login on another person's action: the session's owner lets other members steer it, and the
  session's harness keeps running on the owner's subscription. The owner turns it on, and the
  setting says so where they do.

## Consequences

- The alpha failure cannot recur: nothing outside the store can rotate a login, so no rotation can
  be lost.
- A workspace no longer needs to reach the platform for a login to stay alive, and a stop no longer
  waits on a credential read.
- Workspaces launched before the change keep their refresh tokens until they end. They can still
  race until then.
- The keep-fresh worker must run for sessions to outlive one access token. If it stops, sessions run
  until the token expires, then fail with a 401 and a clear reason.
- A Claude request in flight at the moment of a refresh can fail once. The push keeps that window
  under a second.

## Delivery

1. Core: copies without a refresh token (injection and inference); the Codex keep-fresh worker; the
   per-account refresh claim; the push to running workspaces; no more read-back; `invalid` on a
   refused refresh. Its design document records the same decision.
2. Mend: `mend connect codex` with a grant of its own; the reconnect state shown everywhere; this
   ADR and the user documentation (`concepts/provider-logins`).

## Decision log

- **Setup tokens instead (rejected).** `claude setup-token` never refreshes, but it is an API-style
  credential: some models and features are unavailable on it, and interactive use differs from
  Claude Code's own login. Owner decision, 2026-10-01.
- **Codex external auth (kept as an option).** `codex app-server` can run on client-supplied tokens
  and ask the client for new ones on a 401 (`account/chatgptAuthTokens/refresh`); tested and
  working. It is behind Codex's experimental API flag, so the file-and-push path stays the default.
- **A placeholder, not an absent field, for Codex.** Without `refresh_token` Codex does not load the
  login at all.
