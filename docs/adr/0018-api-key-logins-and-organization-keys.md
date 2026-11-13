# API-key logins and organization keys

Status: accepted 2026-10-25, amended 2026-11-08; personal keys and custom endpoints built in #1547
to #1557. Organization keys are not built. Yiannis decided the eight questions (D1 to D8) of the
spec, `0dd4b4bf:docs/specs/api-key-logins.md`, on 2026-10-24 and the calls that came out of the
design on 2026-10-25 (SLNT-102 to SLNT-109). Amends
[ADR 0005](0005-claude-credentials-and-a-grant-of-mends-own.md) (keys as the fallback login),
[ADR 0008](0008-one-refresher-for-provider-logins.md) (what the refresher and the push touch),
[ADR 0013](0013-whoever-sends-a-turn-pays.md) (who pays for a turn) and
[ADR 0016](0016-per-person-harness-homes.md) decision 5 ("no person ever runs on anyone else's
login"). Read against Mend `7239f5cac` and sealant `9802ef32`. Amended 2026-11-08 with a custom
endpoint (decision 11).

## Amendment: a custom endpoint, 2026-11-08

Yiannis moved a custom base URL into scope on 2026-11-08: "Add a way for api cli proxy users to use
it in mend. We can combine that with the api keys work."

An API-key login for Claude or Codex may name a custom endpoint, the base URL of an
Anthropic-compatible or OpenAI-compatible API such as a company gateway. That login's requests go
there. Decision 11 below records how. Bedrock and Vertex stay out of scope. OpenRouter needs no
route of its own: its compatible endpoints are custom endpoints.

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
which Mend sets to read a file sealant placed in the person's home (0600, the person's own, outside
every capture root). Codex reads its official key file, `auth.json` with `auth_mode: apikey`. Mend
never puts a key it places into a command line, an environment variable, a log, a record or a
capture. Decision 7 names what that does not cover.

Bedrock and Vertex are out of scope. The `api-key` kind stays open to a later provider route. A
custom endpoint is decision 11.

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

How sealant holds the organization key and lets members' homes and inference passes reach it is
sealant's design (Delivery, C5), settled by an architect panel before any code. So is how a turn's
billing record names the organization, which ADR 0013's `billed_user_id` cannot.

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

"No person ever runs on anyone else's login" stands. An organization key is no person's login.
sealant places it in the member's home, owned by the member's user, like their own login.

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
own, and the retry onto another provider, never run on a key. sealant's `allowedLogin` on the
inference request (`subscription` or `any`) is the one place this is enforced.

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

- **A refused key turns invalid.** Mend and sealant mark a key invalid on the provider's structured
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

The names in sealant's `providerLoginEnvNames` (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY` and `CODEX_API_KEY`) are refused as new project secret
names, with words that point to Connected accounts. Rows stored under those names before are kept,
listed with the refusal words, and can be deleted or renamed. They are delivered at launch as
before. sealantd withholds these names from every person's process, so in a per-person executor
neither a session nor a Service sees them; only root's processes in the shared layout do. A key that
repository or dotfiles settings supply is reported as observed, and not stripped.

### 11. A custom endpoint on a key (2026-11-08)

- **What it is.** An API-key login may carry an endpoint: an absolute `http` or `https` URL with a
  host, and no user name, password, query or fragment. A trailing slash is dropped. `http` is
  allowed because endpoints on a private network often have no TLS. With an endpoint, the key may be
  any value without whitespace, a placeholder included, because some endpoints take no key.
- **Where it is kept.** sealant seals the endpoint with the key in the login's payload. Reconnecting
  replaces both, so a reconnect without an endpoint removes it. The account summary carries only the
  endpoint's host. The placement of a key in a home carries the full URL, and Mend reads it at
  launch.
- **One login, one destination.** A key with an endpoint is never sent anywhere else, by a session
  or by an inference pass. One limit is stated. A `codex` that a person starts by hand in a shell
  reads the key's `auth.json` without the endpoint, so its requests go to OpenAI's API. Mend does
  not detect, refuse or warn about any endpoint.
- **Claude Code.** Mend adds `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
  `CLAUDE_CODE_MAX_RETRIES=3` and `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1` to the
  `env` of the inline `--settings` it already passes, beside the `apiKeyHelper` of decision 1.
  Nothing goes into a captured file, the process environment or argv.
- **Codex.** Mend selects a provider of its own with `-c` overrides on the launch, in the terminal
  and for `codex app-server`: `model_provider="mend-endpoint"`, its `base_url`,
  `wire_api="responses"`, `requires_openai_auth=true` and the name "Custom endpoint", plus
  `features.unbounded_connection_retries=false` and `analytics.enabled=false`. The key stays in
  `auth.json`. Mend never writes the endpoint into `config.toml`, which is captured with the
  worktree, and only ever uses it next to a key `auth.json`.
- **The words.** The person who added the login sees its host after decision 5's words: "Claude ·
  API key ····a1b2 · billed per token · endpoint gateway.example.com". Everyone else sees decision
  5's words alone.
- **An endpoint that does not answer.** When a turn on an endpoint login fails because the harness
  could not connect, Mend says what it observed and where from: "Could not reach gateway.example.com
  from this session's workspace (connection refused) · observed 21:40". It never says the endpoint
  is down or misconfigured.

#### What this rests on

Observed on 2026-11-08 against local fake endpoints, with fake keys, in a network namespace with
only loopback, on the pinned Claude Code 2.1.292 and Codex 0.160.1.

1. **Claude Code** takes `ANTHROPIC_BASE_URL` from the settings `env`, in `--print` stream-json and
   in a terminal, and keeps a path prefix. It sends the helper's key as both `x-api-key` and
   `Authorization: Bearer`, and a placeholder as it is. `system/init` reports
   `apiKeySource: "apiKeyHelper"`. Model names pass through verbatim, and an unknown one fails at
   once with Claude Code's own words. Without the traffic setting it also tries `api.anthropic.com`
   and sends a `HEAD /api/hello` to the endpoint. A terminal session still tries
   `downloads.claude.ai` and `github.com`. A closed port ends the turn after about 171 seconds of
   retries at the default of 10, and an unroutable address takes over 25 minutes.
   `CLAUDE_CODE_MAX_RETRIES` bounds both.
2. **Codex** sends the `auth.json` key as `Authorization: Bearer` to a custom provider's `base_url`
   only with `requires_openai_auth = true`, in `exec`, the terminal and `app-server`.
   `wire_api = "chat"` is refused, `OPENAI_BASE_URL` is ignored, the built-in `openai` provider
   cannot be redefined, and a repository's own `config.toml` cannot set a provider. By default a
   connection failure retries forever; with unbounded retries off, a closed port fails after about
   25 seconds with `httpConnectionFailed`. `model/list` never asks the endpoint for its models.
3. **Reachability** depends on the runtime. The Docker runtime refuses only cloud metadata
   (169.254.169.254 and fd00:ec2::254, sealant#358), at once. LAN, tailnet and public hosts follow
   the host's routing. `host.docker.internal` is the bridge gateway, so a service bound only to the
   host's `127.0.0.1` is not reachable from a session. The hosted microVM runtime drops every
   private, loopback, link-local and tailnet range and all IPv6, so only public hosts answer, after
   a timeout for the rest. The Kubernetes chart refuses RFC 1918 and metadata, not 100.64.0.0/10. No
   runtime reaches a person's own laptop without a tunnel.
4. **Models.** Mend's model and effort lists are its own catalog, not the endpoint's. Claude Code
   sends the chosen name as it is. For a Codex conversation with no model named, Mend picks the
   catalog's default, so an endpoint that serves other names refuses the turn. Only the CLI's
   `--model` takes a name outside the catalog.
5. **Inference** follows the asker's login, as decision 6 and ADR 0013 decided, and sealant's
   engines use the login's endpoint the same way the sessions do. The passes that name a fixed model
   (`claude-haiku-4-5`, `gpt-5.6-luna`) fail on an endpoint that does not serve it, and the read is
   skipped.

## Invariants

1. Mend never places, spends or restores one person's key login for another person (ADR 0013, ADR
   0016). An organization key is no person's login: a member with no login of their own for the
   provider runs on it (D1, decision 2). ADR 0016's known limits still apply: a person with sudo in
   a workspace can read other people's files there.
2. A key that Mend places never appears in a record Mend writes, a log line, argv, a file Mend
   captures, or the T3 gateway. A key that the person's repository or dotfiles settings supply is
   outside this invariant (D6). An agent that reads its own key file is a stated limit (2026-10-25):
   Mend masks key-shaped text where it stores records, and sealantd's masking is extended across
   output chunk boundaries.
3. A key has no refresher. Its account turns `invalid` on a provider 401, and no refresh is tried.
4. A key is written to a person's home with mode 0600, owned by that person, outside every capture
   root.
5. For a person who has connected a key, every surface that shows which login a turn spent says
   whether it was a key or a subscription.
6. A provider key from a project secret never decides which login a turn spends.

## Risks a key adds over an OAuth login, and their containment

1. **It never expires.**
   - **Risk:** ADR 0008 makes every OAuth copy non-refreshing, so a leaked copy lapses within hours.
     A leaked key works until it is revoked in the provider's console.
   - **Contain:** show the last four characters everywhere. Disconnect says the key stays valid
     until revoked.
2. **Spend has no plan cap.**
   - **Risk:** a key bills per token; a subscription stops at its usage limits.
   - **Contain:** recommend a spend limit on the Anthropic Console workspace or the OpenAI project.
     Words say "billed per token". A Mend `budget` per person can come later.
3. **The agent's own shell inherits a key held in the environment.**
   - **Risk:** Claude Code passes `ANTHROPIC_API_KEY` to Bash, hooks and MCP children unless
     `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. Codex's `ignore_default_excludes` defaults to true, so
     key-shaped names reach its shell tool.
   - **Contain:** no environment variables; files and the helper only. Claude Code's subprocess
     scrub is not set, because on 2.1.292 it needs bubblewrap and turns permission bypass off (open
     question 3). The agent can still read its own key file. Yiannis made that a stated limit on
     2026-10-25, as it is for `.credentials.json` today.
4. **A key from another source changes which login a turn spends.**
   - **Risk:** in `--print` mode Claude Code prefers `ANTHROPIC_API_KEY` or `apiKeyHelper` over the
     subscription, without asking. Mend's protocol sessions run `--print`
     (`packages/domain/src/workbench/harness-launch.ts:280-289`).
   - **Contain:** reserve the provider key names as project secret names. Report a key found in
     repository or dotfiles settings as observed.
5. **Redaction matches names, not values, in several places:**
   - sealant's API logs;
   - Mend's `redactingConsole`;
   - sealantd's per-request env;
   - sealant's capture masking of account values.

   sealantd's `sk-` pattern covers both providers' keys in its redacted taps. Attach channels are
   raw by design (`crates/sealant-protocol/src/stream.rs:34`).
   - **Contain:** value patterns and literal seeding wherever a key is placed.

6. **File mode.**
   - **Risk:** person processes use umask 0002, so a file written without an explicit mode is
     readable by group `mend`.
   - **Contain:** every key file is written 0600, with a test.
7. **Capture.**
   - **Risk:** `.claude/settings.json` `env`, `.codex/config.toml` and pi's settings are captured
     with the worktree.
   - **Contain:** a key never goes into a captured file.
8. **Argv.**
   - **Risk:** sealant's `$HOME` launch passes env as `docker run -e`.
   - **Contain:** keys take only the per-home stdin path.
9. **The shared layout.**
   - **Risk:** one home holds one set of logins. A join or a shared-control turn there would spend
     the owner's key: cost with no plan cap, for someone who did not send the turn.
   - **Contain:** none in this feature. D4 decided that this feature does no shared-layout work and
     assumes the shared layout is gone. The feature therefore depends on the shared layout's
     removal, planned as its own 0.37 work, landing first. Until then sealant refuses a Claude key
     in the launcher's `/root`, a temporary guard that the removal retires (decision 4).
10. **mend#684 widens where a key lands.**
    - **Risk:** a Codex key also goes into the same person's Claude sessions.
    - **Contain:** it is the same person; `selectedOnly` opts out.

## Harness behaviour this rests on

Pinned versions (sealant `packages/workspaces/src/harness/integrations.ts:30-34`):

| Harness     | Version |
| ----------- | ------- |
| claude-code | 2.1.292 |
| codex       | 0.160.1 |
| opencode    | 1.18.34 |
| pi          | 1.0.4   |

**Claude Code** (code.claude.com docs: authentication, env-vars, settings-reference, remote-control,
costs).

- **Precedence:** cloud provider, then `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`,
  `CLAUDE_CODE_OAUTH_TOKEN`, and last `/login` OAuth.
- **With `--print`**, a key in the environment is used without asking.
- **`apiKeyHelper`** is a shell command whose output is cached for five minutes and rerun after
  a 401.
- **Billing:** a key bills per token. Remote Control, claude.ai connectors, scheduled routines and
  cloud sessions need a subscription. The docs name no model limited to one kind.

**Codex 0.160.1.**

- `auth.json` fields: `auth_mode`, `OPENAI_API_KEY`, `tokens`, `last_refresh`.
- `codex login --with-api-key` reads stdin. The app-server takes an API-key login request.
- In `app-server`, a key in the environment is not used.
- **Billing:** a key bills at API rates. Cloud tasks, GitHub review and Slack need a ChatGPT
  sign-in. Models follow the key's API access.

**Observed on 2026-10-24**, with fake keys against a local fake server, on Claude Code 2.1.308 and
Codex 0.162.1 (decision 11 checked the pinned versions on 2026-11-08):

- Claude Code used `"apiKeyHelper":"cat <file>"` passed through `--settings`, in `--print` mode and
  in an interactive terminal once onboarding and folder trust were set, with no approval prompt. It
  sent the key as `x-api-key` and retried after a 401.
- The stream-json `system/init` line reports `apiKeySource` as `apiKeyHelper` for the helper, as
  `ANTHROPIC_API_KEY` when an environment key is present (the environment key wins over the helper),
  and as `none` with neither.
- `codex login --with-api-key` writes `{"auth_mode":"apikey","OPENAI_API_KEY":"…"}` with mode 0600.

**pi and opencode** read `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and keep keys in their own
`auth.json`. opencode supports Anthropic only by key.

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

sealant (`sealant-sh/sealant`):

1. C1, a chosen default login per provider (sealant#403, merged).
2. C2, every credential placement is recorded (sealant#414, merged). Placements replace
   `workspace_credential_homes.accounts`, and that column is dropped (Yiannis, 2026-10-25).
3. C3a, the API-key kind, connecting by class, the legacy Codex re-seal and key redaction
   (sealant#415, merged).
4. C3b, a Claude key in a home, and the login kind on every placement, so the refresh push never
   writes a subscription over a key, Codex included (sealant#417).
5. C4, inference on a key, `allowedLogin`, and a refused key turns invalid.
6. C5, organization keys.
7. C6, a custom endpoint on a key: sealed with the key, carried on its placement, and used by
   inference (decision 11).

Mend (`sealant-sh/mend`): this ADR and the spec's decisions, then the layers M3 to M13 (live
placements, the Claude helper and settings, the words, a refused key, the inference login, the CLI,
the web, the guides, the retry rule, organization keys and their screens), and the custom endpoint
at launch, in the forms and in the words (decision 11). M1 and M2 are merged (mend#1145, mend#1146).

sealantd (`sealant-sh/sealantd`): masking across output chunk boundaries.

The shared layout's removal is its own 0.37 work and lands before this feature is turned on.

## Decision log

- **How several people share a key (D1).** Three readings went to Yiannis on 2026-10-24: each person
  connects the same key as their own (A), one person's key account is used by others (B), or the
  organization holds a key (C). He chose C on 2026-10-25. B would have made one person a payer for
  others, which ADR 0013 rejects for subscriptions and which C avoids by making the organization the
  payer.
- **A proxy that keeps keys out of homes (not now).** A proxy holding the key would stop members
  reading it. It is new sealant work, outside 0.37. Yiannis accepted members reading the
  organization key instead. ADR 0013's rejection of a proxy that pools subscription logins is
  unrelated and stands.
- **The organization key as a fallback past an invalid own login (rejected).** It would spend the
  organization's money without anyone choosing it, against decision 1.
- **The Claude-to-Codex retry onto a key (rejected).** Same reason: per-token money spent without a
  choice.
- **Removing the `MEND_INFERENCE_*_ACCOUNT` settings (not chosen).** Accepting unset or `default`
  keeps the configurations that already follow each person's default, and refuses the rest.
- **Stopping delivery of existing provider-named project secrets (not chosen).** They keep today's
  delivery; sealantd already keeps them from every person's process.

## Open questions

1. **Claude Code's helper on the pinned version.** Observed on the pinned 2.1.292 on 2026-11-08, in
   `--print` stream-json and in a terminal, with no prompt about the key (decision 11).
2. **Codex on its official key file.** The `auth_mode: apikey` path has not been run against the
   provider; only a local fake.
3. **Helper output in child processes.** On the pinned 2.1.292, a Bash child's environment held
   neither the helper's key nor `ANTHROPIC_API_KEY` (observed 2026-11-08). Hooks and MCP children
   were not checked. Mend does not set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. On 2.1.292 it refuses
   to start without bubblewrap and, with it, forces the permission mode to default.
4. **C5's shape.** Linked copies of the organization key per member, or one account granted to
   members. The architect panel decides, and this ADR's Delivery is updated with the outcome.
5. **An endpoint's own model names.** Mend's pickers list its catalog, and a Codex conversation with
   no model named takes the catalog's default. A person whose endpoint serves other names can name
   one only through the CLI's `--model` today.
6. **An unroutable endpoint is slow to fail.** A refused connection or an unknown host fails within
   seconds with the bounded retries, but an address that drops packets holds a turn for minutes.
   Checking the endpoint from the workspace before the harness starts would answer sooner.
