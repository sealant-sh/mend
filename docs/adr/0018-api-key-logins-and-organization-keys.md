# API-key logins and organization keys

Status: accepted 2026-10-25. Yiannis decided the eight questions of the spec on 2026-10-24 and the
calls that came out of the design on 2026-10-25 (SLNT-102 to SLNT-109). Amends
[ADR 0005](0005-claude-credentials-and-a-grant-of-mends-own.md) (keys as the fallback login),
[ADR 0008](0008-one-refresher-for-provider-logins.md) (what the refresher and the push touch),
[ADR 0013](0013-whoever-sends-a-turn-pays.md) (who pays for a turn) and
[ADR 0016](0016-per-person-harness-homes.md) decision 5 ("no person ever runs on anyone else's
login"). Read against Mend `7239f5cac` and Sealant Core `9802ef32`. The product view, the risks and
the harness behaviour this rests on are in the spec, [API-key logins](../specs/api-key-logins.md).

## Context

Mend runs Claude Code and Codex on subscription logins only. A subscription is one person's: its
terms forbid lending it, and ADR 0013 and ADR 0016 make sure a turn never spends someone else's.
Some people and teams pay per token instead, with an Anthropic or OpenAI API key. Codex already runs
on a key when someone stores one in place of a ChatGPT login, unofficially; Claude refuses keys
everywhere.

A key is not a subscription. The provider bills the account that issued it, per token, and the
Claude and Codex subscription terms do not bind it. So a key can be used by several people, and the
rule that keeps a subscription personal does not apply to it (D1).

## Decision

### 1. A key is a login of its own kind

A person may connect an API key for Claude or Codex beside a subscription for the same provider. One
of their logins for each provider is their default, and Mend gives that one to the harness. For a
provider, Mend never falls back from one login to another on its own: not from a subscription that
reached its limit to a key, and not from an invalid key to a subscription. The one retry across
providers is in decision 6.

The harnesses read a key through their official paths. Claude Code reads it through `apiKeyHelper`,
which Mend sets to read a file Core placed in the person's home (0600, the person's own, outside
every capture root). Codex reads its official key file, `auth.json` with `auth_mode: apikey`. Mend
never puts a key it places into a command line, an environment variable, a log, a record or a
capture. Decision 7 names what that does not cover.

Bedrock, Vertex, a custom base URL and OpenRouter are out of scope. The `api-key` kind stays open to
a later provider route.

### 2. An organization key

An owner of an organization may add a key for a provider. A member who has no login of their own for
that provider runs on it. Within that:

- **It is a member's login only when they have none.** A member with their own login for that
  provider never runs on the organization key. An invalid login is refused at submit, and a turn on
  a login that is over its limit fails as it does today. Neither moves onto the organization key.
- **Only owners add, rotate or remove it.**
- **The organization pays.** A turn or an inference pass on the organization key is billed to the
  organization's provider account.
- **Members can read it (a stated limit).** The key file sits in each member's home, so every
  member, and any agent they run, can read it. The owner's add form says "every member's sessions
  can read this key". Yiannis accepted this on 2026-10-25.
- **A refused key is refused for everyone.** When the provider refuses the organization key, it
  turns invalid for every member at once.

How Core holds the organization key and lets members' homes and inference passes reach it is Core's
design (Delivery, C5), settled by an architect panel before any code. So is how a turn's billing
record names the organization, which ADR 0013's `billed_user_id` cannot.

### 3. Who pays for a turn (amends ADR 0013)

A turn runs on its sender's login, as ADR 0013 decided. A sender's login is their own default for
the harness's provider, or the organization key when they have no login of their own for that
provider. So:

- A steerer with no login of their own runs on the organization key when there is one. Without one,
  they are refused at submit as before: "Connect Claude to steer this session."
- Mend still never falls back to the owner's login for someone else's turn.
- The payer line keeps its shipped form and names the login in decision 5's words: "sent by Maria ·
  billed to Claude · API key of Acme ····a1b2 · observed".

### 4. A person's home (amends ADR 0016 decision 5)

"No person ever runs on anyone else's login" stands. An organization key is no person's login. Core
places it in the member's home, owned by the member's user, like their own login.

The shared layout (ADR 0016 decision 7a) is outside this feature (D4): its removal is a prerequisite
that lands first (spec risk 9). In that layout one home holds one set of logins, so a join or a
shared-control turn would spend the owner's key for someone else. Until the removal lands, a Codex
key is placed at `$HOME` there as it is today, and C3b refuses a Claude key in the launcher's
`/root`. That refusal is a temporary guard, and the shared layout's removal retires it. It follows
two rules already decided: no turn spends another person's login, and no workspace shares a home.

### 5. The words

Where a turn, a session, the shared-control line, an inference pass or the T3 gateway names the
login it spent:

- a person's own key: "Claude · API key ····a1b2 · billed per token";
- the organization key: "Claude · API key of Acme ····a1b2 · billed per token";
- a subscription: "Claude · subscription".

The key wording appears only where a key is involved. A person with only subscription logins, and no
organization key in use for them, sees the lines they see today.

### 6. Inference passes

One rule decides which passes may run on a key. A pass that a person's own action starts runs on
their login, a key included: the session name after they start a session, the request intent and
Slack thread reading after they send a request, and any pass they ask for. A pass Mend queues on its
own, and the retry onto another provider, never run on a key. Core's `allowedLogin` on the inference
request (`subscription` or `any`) is the one place this is enforced.

- **The person who asks pays.** On the organization key, the organization pays.
- **The Claude-to-Codex retry never lands on a key.** Session names, request intent and Slack thread
  reading retry on the person's Codex login when their Claude login is unusable, only when that
  Codex login is a subscription. Otherwise the read is skipped. An organization key counts as a key.
- **Automatic review prep is skipped on a key.** The review pass Mend queues after a settle does not
  run when the settled session's owner's Claude login is a key, an organization key included. A pass
  the person asks for still runs.
- **`MEND_INFERENCE_CLAUDE_ACCOUNT` and `MEND_INFERENCE_CODEX_ACCOUNT` must be unset or `default`.**
  Any other value is refused at startup with words, so no operator setting overrides a person's
  default.

### 7. A refused key, a read key

- **A refused key turns invalid.** Mend and Core mark a key invalid on the provider's structured
  401, never on message text, and only when the key Mend placed is the one the harness used.
- **An agent that reads its own key is a stated limit**, as it is for a subscription copy today. A
  key works until it is revoked, while a subscription copy expires within hours. Mend masks
  key-shaped text where it stores session records and pass results, and sealantd's masking is
  extended across output chunk boundaries in 0.37. Until then, a key split across two output reads
  can reach a record.
- **Others in the same executor can read a person's key (a stated limit).** ADR 0016's known limits
  apply: a person with sudo in a workspace can read other people's files there, and their agent can
  too. A subscription copy read that way lapses within hours; a key lasts until it is revoked.
- **A key from the person's repository or dotfiles settings is theirs.** Mend reports it as observed
  and does not strip it (decision 10).

### 8. The refresher and the push (amends ADR 0008)

A key is never refreshed. The refresher skips key accounts, and the refresh push never writes a
subscription copy over a placement that holds a key, Claude's or Codex's. ADR 0008's one-refresher
rule is unchanged for subscriptions.

### 9. Keys as more than a fallback (amends ADR 0005)

ADR 0005's open question names an API key as what Mend would use if its own Claude grant proved
impossible. A key is now a login a person chooses, beside the grant. The grant stays the way to
connect a subscription.

### 10. Provider key names are logins, not project secrets

The names in Core's `providerLoginEnvNames` (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY`) are refused as new project secret
names, with words that point to Connected accounts. Rows stored under those names before are kept,
listed with the refusal words, and can be deleted or renamed. They are delivered at launch as
before. sealantd withholds these names from every person's process, so in a per-person executor
neither a session nor a Service sees them; only root's processes in the shared layout do. A key that
repository or dotfiles settings supply is reported as observed, and not stripped.

## Consequences

- People and teams who pay per token can use Mend, with Claude and Codex both on their official key
  paths.
- An organization can run members who have no subscription on one key it pays for. Every member can
  read that key.
- A turn's payer is no longer always a person. The payer line names the organization when it paid.
- The rule that keeps a subscription personal is unchanged. A person's own key stays theirs, within
  ADR 0016's known limits.
- An operator who set `MEND_INFERENCE_CLAUDE_ACCOUNT` or `MEND_INFERENCE_CODEX_ACCOUNT` to anything
  but `default` gets a server that refuses to start, with words naming the setting, until they unset
  it.

## Delivery

Core (`sealant-sh/sealant`):

1. C1, a chosen default login per provider (sealant#403, merged).
2. C2, every credential placement is recorded (sealant#414, merged). Placements replace
   `workspace_credential_homes.accounts`, and that column is dropped (Yiannis, 2026-10-25).
3. C3a, the API-key kind, connecting by class, the legacy Codex re-seal and key redaction
   (sealant#415, merged).
4. C3b, a Claude key in a home, and the login kind on every placement, so the refresh push never
   writes a subscription over a key, Codex included (sealant#417).
5. C4, inference on a key, `allowedLogin`, and a refused key turns invalid.
6. C5, organization keys.

Mend (`sealant-sh/mend`): this ADR and the spec's decisions, then the layers M3 to M13 (live
placements, the Claude helper and settings, the words, a refused key, the inference login, the CLI,
the web, the guides, the retry rule, organization keys and their screens). M1 and M2 are merged
(mend#1145, mend#1146).

sealantd (`sealant-sh/sealantd`): masking across output chunk boundaries.

The shared layout's removal is its own 0.37 work and lands before this feature is turned on.

## Decision log

- **How several people share a key (D1).** Three readings went to Yiannis on 2026-10-24: each person
  connects the same key as their own (A), one person's key account is used by others (B), or the
  organization holds a key (C). He chose C on 2026-10-25. B would have made one person a payer for
  others, which ADR 0013 rejects for subscriptions and which C avoids by making the organization the
  payer.
- **A proxy that keeps keys out of homes (not now).** A proxy holding the key would stop members
  reading it. It is new Core work, outside 0.37. Yiannis accepted members reading the organization
  key instead. ADR 0013's rejection of a proxy that pools subscription logins is unrelated and
  stands.
- **The organization key as a fallback past an invalid own login (rejected).** It would spend the
  organization's money without anyone choosing it, against decision 1.
- **The Claude-to-Codex retry onto a key (rejected).** Same reason: per-token money spent without a
  choice.
- **Removing the `MEND_INFERENCE_*_ACCOUNT` settings (not chosen).** Accepting unset or `default`
  keeps the configurations that already follow each person's default, and refuses the rest.
- **Stopping delivery of existing provider-named project secrets (not chosen).** They keep today's
  delivery; sealantd already keeps them from every person's process.

## Open questions

1. **Claude Code's helper on the pinned version.** `apiKeyHelper` taking precedence over
   `.credentials.json` was observed on 2.1.308 (2026-10-24). C3b's and M4's checks re-observe it on
   the pinned 2.1.292.
2. **Codex on its official key file.** The `auth_mode: apikey` path has not been run against the
   provider; only a local fake.
3. **Helper output in child processes.** Whether Claude Code passes the helper's output to its Bash,
   hook and MCP children is undocumented. Mend sets `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` either way.
4. **C5's shape.** Linked copies of the organization key per member, or one account granted to
   members. The architect panel decides, and this ADR's Delivery is updated with the outcome.
