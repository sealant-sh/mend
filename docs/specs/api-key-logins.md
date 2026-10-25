# API-key logins (Claude and Codex)

- **Release:** 0.37
- **Status:** building. Yiannis decided D1 to D8 on 2026-10-24 and the calls that came out of the
  design on 2026-10-25, D1's organization key among them. The research below was written before the
  decisions, and the Decisions section overrides it where they differ.
- **PRs:** merged so far: mend#1137, mend#1145, mend#1146, sealant#403, sealant#414, sealant#415.
  The build is tracked as SLNT-265 onwards. Platform asks are in `PLATFORM-FEEDBACK.md`, under
  "Connected-account providers are a closed set".
- **Decision records:** [ADR 0018](../adr/0018-api-key-logins-and-organization-keys.md), amending
  0005, 0008, 0013 and 0016.
- **Written:** 2026-10-17 against:
  - mend main `637009289`, plus `feat/cross-harness-own-logins` (mend#684) at `725c71900`;
  - sealant `origin/main` `fa163c6f`;
  - sealantd `origin/main` `0f77e78`.

  Core and sealantd paths below were read at those commits. Harness behaviour comes from public
  docs, and from Codex source at `rust-v0.160.1`.

## Why it exists

Yiannis asked on 2026-10-17: "Would it be possible during sign-in to use an API key instead of a
sub, and if not, what would it take to add that?"

Today a person connects their provider logins, the Claude and Codex subscription logins. Their
sessions, Mend's inference passes and the T3 Code gateway all run on those logins. Some people don't
have a subscription. Others would rather pay per token, or work under an organization that issues
API keys. For Claude, an API key is also the sanctioned way for a third-party product to run the
model:

- opencode dropped Claude Pro/Max logins because Anthropic prohibits them in third-party tools.
- Mend's docs already steer pi and opencode to an API key
  (`apps/docs/src/content/docs/concepts/provider-logins.md:108`).
- ADR 0005 leaves the terms-of-service question open
  (`docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md:189-192`).

## What Mend does today

|                         | Anthropic key (Claude)                    | OpenAI key (Codex)                                                                                              |
| ----------------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Sessions                | Not a connected login.                    | Observed in code, not proven live: a Codex `auth.json` that holds only `OPENAI_API_KEY` is accepted and placed. |
| Mend's inference passes | No.                                       | Only where Mend uses the Codex arm.                                                                             |
| T3 Code gateway         | No. The gateway never holds a credential. | It follows the connected account.                                                                               |

### Sessions

**The login model has no API-key variant.**

- Providers are `claude | codex | github` (`packages/api-contracts/src/accounts.ts:11`; Core
  `packages/credentials/src/payloads.ts:9`).
- Core's Claude kinds are a setup token, checked by its `sk-ant-oat01-` prefix (Core
  `packages/credentials/src/payloads.ts:37-41`, `connected-accounts.module.ts:220-224`), and a
  `.credentials.json` narrowed to `claudeAiOauth` (`connected-accounts.module.ts:195-217`). A
  Console API key is refused at connect.
- ADR 0005 names an API key once, as a fallback
  (`docs/adr/0005-claude-credentials-and-a-grant-of-mends-own.md:182-183`).
- ADR 0008 rejected the setup token as the default because "it is an API-style credential"
  (`docs/adr/0008-one-refresher-for-provider-logins.md:153-155`).
- Core's design doc intends an API key "as a first-class alternative" (Core
  `docs/connected-accounts-design.md:72-73`). Nothing implements it.

**Codex accepts a key file today, through an undocumented path.**

1. Mend passes Codex secrets through unchanged
   (`packages/domain/src/workbench/connected-credential.ts:34-35`;
   `apps/api/src/routes/api-live.ts:213`). Two inputs do this:
   - the web paste field (`apps/web/src/routes/settings.tsx:816-821`);
   - `mend connect codex --from-stdin` (`apps/cli/src/main.ts:3444-3446`).
2. Core's parser requires `tokens.refresh_token` or `OPENAI_API_KEY` (Core
   `packages/credentials/src/payloads.ts:303-332`).
3. Core's copy treats a key file as its own copy (Core `packages/credentials/src/copies.ts:75-76`).
4. Core writes it into the person's home as `.codex/auth.json`, mode 0600, over stdin (Core
   `packages/workspaces/src/runtime/home-credentials.ts:1-10,28-44`;
   `apps/api/src/routes/workspaces/workspace-credentials.ts:255-311`).
5. `codex app-server` reads `auth.json` in API-key mode. Its environment-variable key path is off in
   that mode (codex `app-server/src/lib.rs:544,580`).
6. The Codex refresher returns "skipped" for it and never marks it invalid (Core
   `apps/worker/src/workers/refresh-codex-sessions.ts:200-204,342`).

Where it stops:

- `mend connect codex` refuses a key login on its default device-login path
  (`apps/cli/src/codex-grant.ts:98-103`).
- pi and opencode refuse it: Core returns `connected-account-unsupported`
  (`workspace-credentials.ts:280-293`). Mend says "the Codex account is not a ChatGPT login"
  (`packages/sessions/src/harness-layout-steps.ts:287`).
- No surface says the account is a key.

**Provider key names from other sources.**

- The plain project-variable lane refuses names ending in `_KEY`:
  - Mend: `packages/domain/src/workbench/project-environment.ts:69-77,105-107`;
  - Core: `packages/api-contracts/src/workspace-environment.ts:12-17`;
  - sealantd: `crates/sealantd/src/boot/config.rs:145-165`.
- The project secret lane does not reserve the provider key names:
  - Mend: `packages/domain/src/workbench/project-secret.ts:45-52`;
  - Core: `workspace-environment.ts:91-101`.
- sealantd strips them from a person's process (`crates/sealant-process/src/identity.rs:36-68`; ADR
  0016:144-150).
- **Gap:** in the shared layout (ADR 0016 §7a), the launcher's secret environment reaches the
  harness (`crates/sealantd/src/boot/mod.rs:438-492`). So a project secret with a provider key name
  changes which login a turn spends. Reserve the names (D6).
- A person's dotfiles `~/.claude/settings.json` can carry `env` or `apiKeyHelper` (ADR 0016:791-794;
  `packages/sessions/src/harness-seeds.ts:57,69`). So can a repository's `.claude/settings.json`,
  which ADR 0016:791 calls trusted. Claude Code prefers a key from either over the subscription.
  Mend overrides only its own keys in these files (`packages/sessions/src/claude-settings.ts:20-31`)
  and reports nothing about a key there.
- pi and opencode take a key typed into their own `/login`. It lives in their own data for one
  executor: pi's file is never uploaded (`apps/cli/src/pi-profile.ts:65`), and opencode's rows are
  scrubbed on exit (ADR 0016 §8a).

**mend#684 adds no kind.** It also gives a session the same person's other agent login, so a Codex
key account would land in that person's Claude sessions too. The `selectedOnly` setting opts out.

### Mend's inference passes

- Every pass calls `sealant.inferenceRespond` with account references only
  (`packages/inference/src/sealant-provider.ts:29-52`; `packages/sealant/src/client.ts:1133-1167`).
  The only layer the server provides is `sealantProviderLayer` (`apps/api/src/main.ts:711-712`,
  "Mend ships no model keys").
- **Whose account.** The asker's own:
  - `requestedBy` for review passes (`apps/api/src/review-pass-worker.ts:26-43`);
  - the session owner for naming (`apps/api/src/main.ts:477-485`);
  - the turn's author for intent (`apps/api/src/automatic-landing.ts:208-211`).
- **Claude.** Core's Claude engine authenticates with a setup token or a config directory only, and
  strips ambient `ANTHROPIC_API_KEY` (Core
  `apps/api/src/routes/inference/claude-engine.ts:65-83,230-248`).
- **Codex.** Core's Codex engine runs on the account's copy in a private `CODEX_HOME`, so a key file
  would work there (Core `codex-engine.ts:87-96`). Mend uses the Codex arm only as the fallback for
  naming and intent (`packages/inference/src/session-namer.ts:81-89`;
  `request-intent-reader.ts:105-110`). Review passes default to Claude
  (`packages/inference/src/provider.ts:50-54`).
- **The dev-only layer.** `devDirectProviderLayer` reads `ANTHROPIC_API_KEY` and is documented as
  dev only (`packages/inference/src/dev-provider.ts:14-31`). Nothing wires it.

### T3 Code gateway

- **It holds no provider credential**, only the paired person's device token. It refuses login setup
  and provider settings: `providerAuthStart/Complete/Respond`, `serverUpdateProvider` and
  `serverUpdateSettings` (`apps/t3-gateway/src/rpc.ts:177-183,640-660,692`).
- **Provider status** comes from `GET /api/me/sealant` and the `default` account per harness
  (`apps/t3-gateway/src/server-config.ts:217-334`). A Codex key account has no expiry, so it would
  read as authenticated.
- **Upstream key fields stay closed.** Upstream T3 Code can carry a provider instance `environment`
  and an `apiKey` field (`packages/t3-contracts/src/providerInstance.ts:97-129`). The gateway keeps
  both closed.

## What it would take

**Shape.** Add a kind `api-key` under the existing `claude` and `codex` providers, not new
providers. Core's `kind` column is free text, so this needs no migration (Core
`packages/db/src/schema/control-plane.ts:477-528`).

**Placement per home:**

- **Codex:** `auth.json` in API-key mode, as today.
- **Claude:** a 0600 key file outside every capture root, read by an `apiKeyHelper` that Mend passes
  through the `--settings` it already supplies. The key is never in an environment variable, a
  captured settings file or argv.

| Layer                          | Change                                                                                                                                                                                                                                                                                                                   | Size                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Core: storage and contracts    | `api-key` kind. Claude payload with the key; Codex also accepts a bare key and wraps it. Document the secret shapes. `SealantFeatures` flag.                                                                                                                                                                             | 6–8 files, ~150–250 lines                                      |
| Core: refresh                  | Nothing to refresh. The refresher, sync-back and push skip the kind explicitly. A 401 marks the account `invalid`.                                                                                                                                                                                                       | 3–4 files, ~50–100 lines                                       |
| Core: placement                | Claude key file plus helper in `home-credentials.ts`, written 0600. Never `docker run -e`: the `$HOME` launch passes env as argv today (`packages/workspaces/src/runtime/docker-runtime-adapter.ts:2403-2408`). pi and opencode key entries instead of a refusal.                                                        | 4–6 files, ~200–400 lines plus executor tests                  |
| Core: inference                | Claude engine runs on a key and scrubs it from errors. Codex works already.                                                                                                                                                                                                                                              | 2–3 files, ~80–150 lines                                       |
| Core: redaction                | Value patterns for provider keys in `credential-redaction.ts`, which matches by name today. Connected-account values fed to capture masking (`runtime-adapter.ts:104-108`).                                                                                                                                              | 2–3 files, ~60–120 lines                                       |
| **Core total**                 |                                                                                                                                                                                                                                                                                                                          | **~15–20 files, 500–900 lines, plus 600–1,000 lines of tests** |
| sealantd                       | Nothing required. Advised: feed per-request env values to the redactor (`crates/sealantd/src/runtime.rs:93-114`); list the key file in `HARNESS_CREDENTIALS` with its table row (`crates/sealant-capture/src/index.rs:106-278`); 0600 on credential writes, since person processes use umask 0002 (`identity.rs:33-34`). | ~50–150 lines                                                  |
| Mend: API and contracts        | Kind on `ConnectAccountInput`. Feature detection, with words when the platform lacks it. Provider key names reserved as project secret names.                                                                                                                                                                            | ~100–200 lines                                                 |
| Mend: sessions                 | Login words per kind (pi and opencode included). Session and turn lines name the kind.                                                                                                                                                                                                                                   | ~100–200 lines                                                 |
| Mend: CLI                      | `mend connect claude --api-key` and `mend connect codex --api-key`, reading stdin only. The kind and last four characters in `mend doctor`. A deliberate key path past the `codex-grant.ts` refusal.                                                                                                                     | ~150–250 lines                                                 |
| Mend: web                      | A key field per provider in Settings → Connected accounts, a kind badge, words for an invalid key.                                                                                                                                                                                                                       | ~150–250 lines                                                 |
| Mend: desktop, mobile, VS Code | Desktop is not shipping. Mobile has no accounts screen. VS Code signs in to Mend only.                                                                                                                                                                                                                                   | 0                                                              |
| Mend: inference                | Nothing; Mend passes references. The D3 words on each pass.                                                                                                                                                                                                                                                              | 0–30 lines                                                     |
| Mend: T3 gateway               | The kind in the provider message. Every refusal stays.                                                                                                                                                                                                                                                                   | ~20–50 lines                                                   |
| Mend: redaction                | `redactingConsole` handles URL credentials only (`apps/api/src/redacting-console.ts:6-24`). Add the value patterns `redactDetail` already has.                                                                                                                                                                           | ~20–40 lines                                                   |
| Docs and ADR                   | New ADR amending 0005, 0008, 0013 and 0016. Updates to `concepts/provider-logins`, `guides/provider-accounts`, `reference/cli`, `feature-status`. Changesets.                                                                                                                                                            | ~1 day                                                         |
| **Mend total**                 |                                                                                                                                                                                                                                                                                                                          | **~600–1,000 lines plus docs**                                 |

## Invariants

1. Mend never places, spends or restores one person's key login for another person (ADR 0013, ADR
   0016). An organization key is no person's login: a member with no login of their own for the
   provider runs on it (D1, ADR 0018). ADR 0016's known limits still apply: a person with sudo in a
   workspace can read other people's files there.
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

## Risks a key adds over an OAuth login

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
   - **Contain:** no environment variables; files and the helper only. Set both scrubs as defence in
     depth. The agent can still read its own key file. Yiannis made that a stated limit on
     2026-10-25, as it is for `.credentials.json` today.
4. **A key from another source changes which login a turn spends.**
   - **Risk:** in `--print` mode Claude Code prefers `ANTHROPIC_API_KEY` or `apiKeyHelper` over the
     subscription, without asking. Mend's protocol sessions run `--print`
     (`packages/domain/src/workbench/harness-launch.ts:280-289`).
   - **Contain:** reserve the provider key names as project secret names. Report a key found in
     repository or dotfiles settings as observed.
5. **Redaction matches names, not values, in several places:**
   - Core's API logs;
   - Mend's `redactingConsole`;
   - sealantd's per-request env;
   - Core's capture masking of account values.

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
   - **Risk:** Core's `$HOME` launch passes env as `docker run -e`.
   - **Contain:** keys take only the per-home stdin path.
9. **The shared layout.**
   - **Risk:** one home holds one set of logins. A join or a shared-control turn there would spend
     the owner's key: cost with no plan cap, for someone who did not send the turn.
   - **Contain:** none in this feature. D4 decided that this feature does no shared-layout work and
     assumes the shared layout is gone. The feature therefore depends on the shared layout's
     removal, planned as its own 0.37 work, landing first. Until then Core refuses a Claude key in
     the launcher's `/root`, a temporary guard that the removal retires (ADR 0018 decision 4).
10. **mend#684 widens where a key lands.**
    - **Risk:** a Codex key also goes into the same person's Claude sessions.
    - **Contain:** it is the same person; `selectedOnly` opts out.

## Decisions

Yiannis decided all eight on 2026-10-24. The comments on SLNT-102 to SLNT-109 record each outcome in
his words.

- **D1. Per person or per organization. Decided: a key can be used by several people.**
  - API keys are not subscriptions, so the Claude and Codex subscription terms do not bind them.
    Sharing a key with others is allowed.
  - How several people share one key: **an organization key** (2026-10-25). An owner of an
    organization adds a key for a provider, and members who have no login of their own for that
    provider run on it. It is never used when a member's own login is invalid, expired or over its
    limit. Only owners add, rotate or remove it. Every member's sessions can read it, a stated limit
    the owner's add form says.
- **D2. A key and a subscription for the same provider. Decided: both, one default.**
  - A person may connect a key and a subscription for the same provider. One of them is the person's
    `default` for that provider, and Mend gives that one to the harness. A key that the person's
    repository or dotfiles settings supply can still take precedence in the harness. Mend reports it
    as observed (D6).
  - Mend never falls back from one to the other on its own, not even when a plan limit is reached.
- **D3. Words for which login a turn spent. Decided: "API key ····a1b2 · billed per token".**
  - The account line reads "Claude · API key ····a1b2 · billed per token" or "Claude ·
    subscription".
  - The session line, the shared-control line, inference passes and the T3 gateway's provider
    message use the same words.
  - The wording appears only for people who have connected a key. A person with only subscription
    logins sees the same lines as before.
  - An organization key's words name the organization: "Claude · API key of Acme ····a1b2 · billed
    per token", shown only where a key is involved (2026-10-25).
- **D4. Keys in the shared layout. Decided: no work.**
  - This feature assumes the shared workspace layout won't be a thing, and adds no shared-layout
    rule.
- **D5. The Codex key path that works today. Decided: make both key paths official in 0.37.**
  - The Codex key path becomes official, and the Claude key path is built and made official in the
    same release.
  - The recommendation he accepted also lists, for Codex: show the kind, add
    `mend connect codex --api-key` reading stdin, and make the pi and opencode words say the Codex
    account is an API key.
- **D6. Provider key names from project secrets, repository settings and dotfiles. Decided: refuse
  and report.**
  - Mend refuses the provider key names as project secret names, with words that point to Connected
    accounts.
  - Mend reports a key it finds in repository or dotfiles settings as observed, and does not strip
    it.
- **D7. Inference on a key. Decided: yes, the asker pays.**
  - Mend's inference passes may run on a key, under the same rule as subscription logins: the person
    who asked for the pass pays. On an organization key the organization pays (2026-10-25).
- **D8. Bedrock, Vertex, a custom base URL, OpenRouter. Decided: out of scope.**
  - None of them is built. The `api-key` kind stays open to a later provider route, such as "Claude
    via Bedrock".

### Decided 2026-10-25

These calls came up while designing the build. Yiannis decided them on 2026-10-25; SLNT-102 records
them, and ADR 0018 carries them.

- How several people share one key: an organization key (D1, above).
- Mend's background reads that switch from a Claude login to a Codex login (session names, request
  intent, Slack thread reading) never switch onto a key, an organization key included.
- A session agent that reads its own key file is a stated limit, as it is for subscription copies
  today. Masking where Mend stores records ships with the feature, and sealantd's masking across
  output chunk boundaries follows in 0.37.
- `MEND_INFERENCE_CLAUDE_ACCOUNT` and `MEND_INFERENCE_CODEX_ACCOUNT` must be unset or `default`; any
  other value is refused at startup with words.
- The automatic review prep after a settle is skipped when the login is a key, an organization key
  included. A pass the person asks for still runs.
- Project secrets that already use a provider key name are kept, listed with the refusal words, and
  delivered at launch as before.

## Harness behaviour this rests on

Pinned versions (Core `packages/workspaces/src/harness/integrations.ts:30-34`):

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
Codex 0.162.1:

- Claude Code used `"apiKeyHelper":"cat <file>"` passed through `--settings`, in `--print` mode and
  in an interactive terminal once onboarding and folder trust were set, with no approval prompt. It
  sent the key as `x-api-key` and retried after a 401.
- The stream-json `system/init` line reports `apiKeySource` as `apiKeyHelper` for the helper, as
  `ANTHROPIC_API_KEY` when an environment key is present (the environment key wins over the helper),
  and as `none` with neither.
- `codex login --with-api-key` writes `{"auth_mode":"apikey","OPENAI_API_KEY":"…"}` with mode 0600.

**pi and opencode** read `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` and keep keys in their own
`auth.json`. opencode supports Anthropic only by key.

## Open questions

- **The Codex path has not been run.** It is traced in code from paste to `app-server`, but no
  session has run on a key `auth.json` in a person's home. Prove it on a local stack before the
  feature is enabled, and on the box after merge.
- **The pinned harness versions are not yet checked.** The observations under "Harness behaviour
  this rests on" were made with Claude Code 2.1.308 and Codex 0.162.1. Check them on the pinned
  2.1.292 and 0.160.1.
- **Whether `apiKeyHelper` output reaches child processes is undocumented.** It is presumably not
  inherited, since it isn't an environment variable.

## Divergences found while writing

- **ADR 0016's wording on project secrets.** `docs/adr/0016-per-person-harness-homes.md:144-150`
  says the project's secrets "reach every person under any name". The same passage lists the
  provider key names as stripped "even when a project sets one", and sealantd strips them
  (`crates/sealant-process/src/identity.rs:36-68`). The sentence should exclude those names.
- **The CLI's Codex refusal assumes a key is never wanted.** `apps/cli/src/codex-grant.ts:98-103`
  refuses a key login, yet the web paste and `--from-stdin` paths accept one. D5 made the key path
  official, so the refusal is the divergence.
- **The Codex-is-not-ChatGPT words name the wrong cause for a key.**
  `packages/sessions/src/harness-layout-steps.ts:287` says "the Codex account is not a ChatGPT
  login" when the account is a key. The words are accurate, but they don't say what the account is.
- **Background reads already switch onto a Codex key.** When a person's Claude login is missing or
  invalid, session naming and request intent retry on their Codex login
  (`packages/inference/src/session-namer.ts:78-86`, `request-intent-reader.ts:66-67`), and the
  inference provider sends their default Codex account
  (`packages/inference/src/sealant-provider.ts:31-34`). A person whose Codex account is a key-only
  `auth.json` already gets these reads on the key. The retry rule (2026-10-25: never onto a key)
  ends that.
- **Operator settings already name one account for every person.** `MEND_INFERENCE_CLAUDE_ACCOUNT`
  and `MEND_INFERENCE_CODEX_ACCOUNT` (`packages/inference/src/sealant-provider.ts:29-30`,
  `apps/docs/src/content/docs/reference/server-environment.md:196-197`) send one account name for
  every asker. The 2026-10-25 decision (unset or `default` only) ends that.
