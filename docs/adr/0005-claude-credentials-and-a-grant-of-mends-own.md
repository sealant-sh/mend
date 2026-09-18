# Claude credentials: a grant of Mend's own

Status: proposed 2026-09-18. Commits Mend to connecting Claude through a **dedicated grant** — a
Claude login that belongs to Mend and not to the person's laptop — and to sending only the Claude
credential, never the third-party tokens that sit beside it. It closes the over-share this work
found, states who refreshes what, and names the two platform halves it cannot do alone.

**What this ADR does not claim.** It does not establish that using a Claude subscription credential
on a server, refreshed by a scheduled job, is permitted by Anthropic's terms. That is a separate
assessment against the current Consumer Terms and Usage Policy, and it is an open question below.

## Context

`mend connect claude` reads the credential the official CLI wrote at login and forwards it to the
platform. `apps/cli/src/main.ts` `localCredential` reads
`${CLAUDE_CONFIG_DIR:-~/.claude}/.credentials.json` and `connectCommand` posts it **verbatim** as
`secret` to `/me/sealant/accounts`; `apps/api/src/routes/api-live.ts` hands that string to the
platform unchanged. Mend keeps nothing of its own.

Three facts about that file, verified on a developer machine and in the shipped Claude Code bundle
(2.1.275):

1. **It holds more than Claude.** The document is `{ claudeAiOauth, mcpOAuth }`. `claudeAiOauth`
   carries an access token, a refresh token, `expiresAt`, `refreshTokenExpiresAt`,
   `subscriptionType` and `rateLimitTier`. `mcpOAuth` carries refresh tokens for whatever MCP
   servers the person has authorized — Figma, Atlassian and Linear on the machine inspected. All of
   it travels today, reaches the platform's database, and is written into every workspace that
   attaches the account.
2. **The refresh token rotates.** The bundle treats a refresh answer without a new refresh token as
   an error (`refresh response missing refresh_token or expiry`), reads `refresh_token_expires_in`,
   and carries the vocabulary of a rotating grant: `known_dead_refresh_token`, `no_refresh_token`,
   `invalid_grant|Token has been expired|reauth`, and a telemetry event for clearing a stale user
   OAuth refresh token. It also guards concurrency with
   `[gateway-refresh] auth changed mid-refresh; discarding` — which protects **two processes reading
   one store**, not two stores holding one grant.
3. **The grant is long-lived and the access token is not.** On the machine inspected: access token
   good for under six hours, refresh token good for 27 days.

The platform already owns refreshing, and does it the honest way. Core stores the credential as
`connected_accounts.encrypted_payload` (AES-256-GCM, scoped by owner), injects it into a workspace
as a **file** at `$HOME/.claude/.credentials.json` mode 0600 so the official CLI can rotate it in
place, reads the rotated file back newest-wins, and sweeps stale accounts every 15 minutes within a
30-minute horizon (`apps/worker/src/workers/refresh-claude-sessions.ts`). Its own comment states the
rule this ADR keeps: _"The CLI rotates the session itself; the worker never calls Anthropic's token
endpoint."_ The sweep spends one cheap inference turn per stale account to make the CLI refresh.

So the problem is not where the credential is stored, and on macOS it is not the Keychain either.
The problem is that **Mend and the person's laptop hold copies of one rotating grant**. Whichever
side refreshes first invalidates the other's refresh token. Mend refreshes on a schedule; a laptop
refreshes when it is used. The laptop is the side that gets logged out.

Two further findings, smaller but real:

- Mend relocates the injected credential into the session harness home, and the mode keeper's
  `chmod -R go+rX` leaves it **0644** on the Mend host (co-located store only).
- [ADR 0002](0002-session-capture-store.md) decision 6 and `DEVELOPMENT.md` say captures carry the
  credential file. They do not: sealantd excludes credentials from both the watcher and the capture
  roots, and a test asserts it. The documents are wrong, not the daemon.

## Decision

### One credential, narrowed at the source

Mend sends **only `claudeAiOauth`**. `mcpOAuth` never leaves the machine that authorized those MCP
servers. A pasted `--from-stdin` payload is narrowed the same way, and a `setup-token` payload (a
bare token, not a document) passes through unchanged.

The narrowing is a pure function in `@mend/domain`, used by the CLI **and** by Mend's API, so a
hand-rolled client cannot widen it. Core narrowing the same way is platform feedback below; Mend
does not depend on it.

### A grant of Mend's own

`mend connect claude` creates a Claude login for Mend, in a directory Mend owns
(`~/.config/mend/claude-grant`, 0700), by running
`CLAUDE_CONFIG_DIR=<dir> claude auth login --claudeai`. The person approves once in a browser.

Then Mend and the laptop hold two grants, each with its own refresh token, and neither rotation
invalidates the other. On macOS the login may store the grant in the Keychain rather than a file; a
dedicated directory gets its **own item**, because the bundle names the item
`Claude Code-credentials` plus `-` plus the first eight characters of `sha256(configDir)`. Mend
computes that name itself, so it reads its own item and never the person's.

Before it connects, Mend compares the new refresh token against the one in the default location. If
they are the same grant, it refuses and says why: connecting that credential would re-create the
race.

### `mend connect claude` reads the situation

One command, no `--relogin`, four states:

| State                      | What Mend does                          |
| -------------------------- | --------------------------------------- |
| no grant                   | logs in                                 |
| grant works                | prints the facts and stops — no browser |
| grant expired or missing   | logs in again, without asking           |
| grant refused by Anthropic | logs in again                           |

"Works" is **observed, not assumed**: Mend runs `claude auth status` against its own config
directory rather than trusting a stored timestamp, which can read healthy while the grant is dead.

### Failure is reported before a launch, not during one

A session must not start into a harness that cannot authenticate. When a session fails because
Claude refused the credential, Mend marks that connected account as needing attention. `mend doctor`
and the web app then say `claude · grant expired · run mend connect claude`, and a launch refuses
with that reason instead of starting.

### Modes stay as the writer set them

The credential file Mend places or relocates is 0600, and the harness-home mode keeper leaves it
alone. Nothing Mend does widens a credential.

### Refresh stays where the credential lives

Mend never calls Anthropic's token endpoint. The official CLI rotates the grant, inside the
workspace or under the platform's sweep, and the platform persists the rotation. Mend reports what
it observes about expiry; it does not mint.

## Consequences

- Mend holds a refresh token for its own grant. It can obtain access for as long as that grant lives
  — 28 days idle on the evidence here — and it is encrypted per account in the platform.
- A running workspace holds a 0600 copy while the session runs. Captures do not.
- Keeping the grant alive costs one small inference turn per stale account per sweep, charged to the
  grant's subscription. That is the platform's existing trade-off, now written down.
- The person's own Claude login is untouched, and this ADR is what makes that true rather than
  hopeful.
- A person who never runs a session for 28 days must connect again. Mend says so before it matters.

## Delivery

| PR  | What it delivers                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------------------------- |
| 1   | This ADR, and the platform feedback for the two Core halves.                                                      |
| 2   | `claudeAiOauth` only, in `@mend/domain`, used by the CLI and the API.                                             |
| 3   | The harness-home credential stays 0600.                                                                           |
| 4   | ADR 0002 and `DEVELOPMENT.md` corrected to what sealantd does.                                                    |
| 5   | The dedicated grant in `mend connect claude`, with the same-grant refusal.                                        |
| 6   | The four states, the `claude auth status` probe, and expiry reported by doctor, the web app and a refused launch. |

PRs 2 to 4 stand on their own and depend on nothing below. PR 5 depends on the first open question.

## Decision log

1. **Narrow, rather than ask the platform to narrow.** The over-share is Mend's to stop; it is Mend
   that reads the file. Core narrowing is defence in depth, not the fix.
2. **A dedicated grant, rather than mint-on-demand.** Minting means calling Anthropic's token
   endpoint, which Core refuses to do by design, and a Keychain read cannot be automated headless.
   The platform's sweeper already is mint-on-demand, with the refresher where the credential lives.
3. **A dedicated grant, rather than accepting the race.** The race is not rare: the platform
   refreshes on a schedule, so the laptop loses within a day of normal use.
4. **No `--relogin` flag.** A flag asks the person to know which state they are in. The command can
   look.
5. **Observe the grant, do not trust the timestamp.** A revoked grant has a healthy `expiresAt`.
6. **The Keychain is not the problem, so it is not the first PR.** If a Mac writes
   `.credentials.json` like Linux, no Mac-specific reading is needed at all; the probe settles it
   and the dedicated directory handles either answer.
7. **Say what the keep-alive costs.** A scheduled inference turn on someone's subscription is a fact
   a person should be told, not a detail to bury.

## Platform halves (feedback, not blockers)

1. **Narrow at connect and at sync-back.** The platform should store only the Claude credential,
   whatever a client sends, and never persist an `mcpOAuth` section a rotated file brings back.
2. **Report expiry and sync state as typed fields.** Mend infers freshness today. A connected
   account should carry its access expiry, its refresh expiry and the outcome of the last refresh,
   so Mend can report `grant expired` as an observation rather than a guess.

## Open questions

1. **Can one Claude account hold two live grants?** If a new login invalidates the previous session,
   the dedicated grant is impossible and Mend must use `claude setup-token` or an API key instead.
   This decides PR 5. Settle it with a login into a scratch config directory, then
   `claude auth status` against both.
2. **Does Anthropic's server allow a reuse window for a rotated refresh token?** The client clearly
   rotates; whether the old token dies immediately is not visible from the client. It decides how
   sharp the race is for anyone who declines a dedicated grant.
3. **Is any of this permitted by Anthropic's terms?** Specifically: a subscription credential on a
   server, a scheduled keep-alive turn, and `shared control` spending the owner's grant. Needs an
   assessment against the current terms, and it is the one question that can invalidate the feature
   rather than the design.
4. **Does a Mac still use the Keychain for this?** One probe answers it and shrinks or removes PR
   5's platform-specific half.
5. **Should a session that outlives its grant pause instead of failing?** Today it fails. Pausing
   would need a way to hand a rotated credential to a live workspace.
