# Doppler: a project's secrets from Doppler, read at launch, delivered as secret environment

Status: proposed 2026-10-04 as ADR 0014 (first drafted as 0013, a number
[whoever sends a turn pays](0013-whoever-sends-a-turn-pays.md) took). Nothing is built. The owner
asked for Doppler support beside [secret files](0010-secret-files.md); the decisions below are
recommendations, and the ones the owner has to take are listed under "Decisions for the owner". Read
against Mend `6abd2ab9f`, `@sealant/sdk` 0.38.1 and the Doppler CLI v3.76.1.

## Context

### What Doppler is, as far as Mend cares

Doppler keeps secrets per **project** (`backend`), per **environment** (`dev`, `stg`, `prd`), and
per **config** inside an environment: a root config (`dev`) and branch configs that inherit from it
and override some values (`dev_yiannis`). Every config is a flat map of names to values.

- **Reading.** `GET https://api.doppler.com/v3/configs/config/secrets/download?format=json` with
  `Authorization: Bearer <token>` answers the computed values of one config (references resolved) as
  a flat JSON object, the same body `doppler secrets download --no-file --format json` prints.
  `project` and `config` are "not required if using a Service Token". Dynamic secrets appear only
  with `include_dynamic_secrets=true`.
  ([secrets-download](https://docs.doppler.com/reference/secrets-download))
- **Conditional reads.** Not in the API reference, but the CLI sends `If-None-Match` with the last
  `ETag` and reuses its cached copy on `304` (DopplerHQ/cli). A `304` records no access event
  ([access logs](https://docs.doppler.com/docs/access-logs)).
- **Tokens** ([token formats](https://docs.doppler.com/reference/auth-token-formats),
  [API](https://docs.doppler.com/reference/api)):

  | Token                    | Prefix                  | Reaches                                                                         |
  | ------------------------ | ----------------------- | ------------------------------------------------------------------------------- |
  | CLI (`doppler login`)    | `dp.ct.`                | read/write to everything the user can reach                                     |
  | Personal                 | `dp.pt.`                | the same                                                                        |
  | Service                  | `dp.st.`                | one config, `read` (the default) or `read/write`; optional expiry (`--max-age`) |
  | Service account          | `dp.sa.`                | a workplace role plus per-project roles; Team and Enterprise plans              |
  | Service account identity | `dp.said.`              | the same, short-lived, minted from an OIDC token                                |
  | SCIM, audit              | `dp.scim.`, `dp.audit.` | users and groups, no secrets                                                    |

  `GET /v3/me` returns the token's `type`, `token_preview`, `workplace` and `principal`; it does not
  document a service token's project, config or access level
  ([auth-me](https://docs.doppler.com/reference/auth-me)). A config holding a secret with Restricted
  visibility answers `403` to user tokens; only non-user tokens read it
  ([secret visibility](https://docs.doppler.com/docs/secret-visibility)).

- **Rate limits** are per token, counted per minute
  ([platform limits](https://docs.doppler.com/docs/platform-limits)): secret reads 120 on Developer,
  240 on Team, 480 on Enterprise. A limited request answers `429` with `retry-after`;
  `x-ratelimit-remaining` and `x-ratelimit-reset` come on every answer.
- **Sizes.** Up to 1,200 secrets per config, 50 KiB per value, 500 KiB per config.
- **Offline.** `doppler run` writes an encrypted **fallback file** after each successful fetch
  (`~/.doppler/fallback/`, AES-256-GCM under a passphrase derived from token, project and config)
  and reads it on a network error or a `5xx`. On `401`, `403` or `404` the CLI deletes it
  ([automatic fallbacks](https://docs.doppler.com/docs/automatic-fallbacks), DopplerHQ/cli). That is
  Doppler's own answer to "use the last known values", and its own answer to revocation.
- **Injection.** `doppler run -- <cmd>` starts `<cmd>` with the values in its environment, Doppler's
  values over existing ones unless `--preserve-env` names them. `--mount <file>` serves them from a
  0600 named pipe instead (`--mount-max-reads` bounds its reads). `--watch` (beta, Team and
  Enterprise) restarts the process on every change: SIGTERM, then SIGKILL after 10 s.
- **Change notification.** Webhooks per project, enabled per config, signed with
  `X-Doppler-Signature` (HMAC-SHA256), payload `config.secrets.update` with a names-only diff,
  delivered at least once with up to 5 retries, on every plan
  ([webhooks](https://docs.doppler.com/docs/webhooks)).
- **Values that change on their own.** Rotated secrets swap halfway through each interval (Team and
  Enterprise); dynamic secrets (Enterprise) are a new lease with a TTL, 30 minutes by default, on
  every fetch.
- **Configs.** Each environment (`dev`, `stg`, `prd`) has a root config; branch configs
  (`dev_<name>`) inherit and override it; `dev_personal` is each user's private branch. Doppler
  documents a service token as reaching "a specific config", so a token for `dev` should be assumed
  not to read `dev_yiannis`.
- **Repository setup.** `doppler setup` reads a `doppler.yaml` at the repository root and stores
  each entry against its directory in `~/.doppler/.doppler.yaml`:

  ```yaml
  setup:
    - project: backend
      config: dev_personal
      path: backend/
  ```

  A service token's own project and config always win over that file
  ([CLI](https://docs.doppler.com/docs/cli)).

- **Doppler's guidance for agents** ([agents](https://www.doppler.com/agents-claude-code)): an
  agent-only branch config holding only what the agent needs, a read-only service token with an
  expiry for it, and the agent kept on development configs.

Checked here, without creating anything: the owner's laptop has the CLI (v3.76.1) logged in with a
CLI token (`doppler me` reports `type: cli`), and its help shows
`doppler configs tokens create --project <p> --config <c> --access read --plain [--max-age <d>]` for
a service token on one config, `read` by default. A bad token answers
`401 {"messages":["Invalid Auth token"],"success":false}` on both `/v3/me` and the download
endpoint.

### What Mend has

- **Project configuration and project secrets** (migrations 0025/0026,
  `packages/domain/src/workbench/project-secret.ts`): per project, set by whoever may manage the
  project (`ProjectAccess.manageProject`), names visible and values write-only. Secrets are sealed
  with AES-256-GCM under the machine's `secrets.key` (`SecretCipher`), unsealed once per launch in
  `SessionEngine` and handed to the platform's `secretEnv`. The run records the revision and the
  **names** (`session_runs.secret_names`). A secret that does not unseal fails the launch.
- **Secret files** ([ADR 0010](0010-secret-files.md)): per person, every project, written into the
  executor's own `$HOME` over exec before the harness starts, never captured. Best-effort: a file
  that cannot be written is named on the session line and the agent still starts.
- **Provider logins** ([ADR 0008](0008-one-refresher-for-provider-logins.md)): Claude, Codex and
  GitHub are the platform's connected accounts, a closed set of providers the platform's worker
  resolves itself. A login belongs to one Mend account and is spent only on that account's sessions
  and the inference its own requests cause.
- **Whoever sends a turn pays** ([ADR 0013](0013-whoever-sends-a-turn-pays.md), proposed): under
  shared control a steerer's turn runs on the steerer's own login. Before dispatch Mend asks Core to
  write the sender's credential file into the owner's workspace and writes the owner's back when the
  turn ends. Claude Code rereads the file per request; Codex is restarted in the same workspace.
  Terminal sessions, shells and commands become the owner's only. The switch moves credential files
  only; the workspace's environment stays as it was created.
- **Per organization**, Mend keeps defaults (`organization_settings`: image, automatic passes,
  background sessions), not environment. There is no per-person environment today.

### What the platform's secret channel does

`CreateOptions.secretEnv` (SDK 0.38.1, `types.d.ts`):

- Delivered through the transient secret channel: never written to the blueprint, the attempt
  snapshot, `docker inspect` or any read API; **every value is masked in captured process output**.
- Inherited by every process the platform starts in the workspace (the harness, shells, `exec`,
  services), winning over `env` and container env.
- **Fixed at creation.** A live workspace is never mutated, and a platform-side restart runs without
  secret env. `SessionOptions.env` exists per session but is documented as "not for secrets"; there
  is no per-session or per-exec secret env.
- Bounded like `env` (`@sealant/api-contracts/workspace-environment`): names of at most 128
  characters, values of at most **4096 bytes**, at most **128 entries** and **32 KiB** in all.
  Platform-owned names (`SEALANT_*`, `PATH`, `HOME`, the loader, shell start-up, git ssh and
  connected-account names such as `GITHUB_TOKEN`) are refused.
- Docker runtime only.

Two places hold create-time inputs longer than one launch:

- **The hot pool** (`hot-pool.ts`) prepares workspaces ahead of a claim, per owner, keyed by a
  fingerprint of every create-time input, `secretRevision` included. A mismatch drains and rewarms.
- **A retained executor** (capture mode) runs a resumed session's next process in the same
  workspace. The resume path copies the previous run's secret names (`engine.ts`, resume): the new
  process inherits whatever `secretEnv` the workspace was created with.

## Decision

### 1. Whose token: the project's, and optionally the person's over it

Two layers. One source per launch, never a merge of two Doppler configs.

- **Project source.** Set by whoever may manage the project, exactly as project secrets are. Every
  session in the project receives it. This is the common case: a team's `dev` config for one
  repository, behind one read-only service token.
- **Person source, per person per project.** Optional. A person who keeps their own Doppler branch
  config (`dev_yiannis`) or their own token sets it for themselves; it replaces the project source
  for sessions they own. No one else's session reads it, and no route returns it to anyone else.
- **No organization source.** An organization-wide token would have to read every project's config,
  which is the broad credential the next section refuses. An organization that wants one place to
  manage Doppler sets the project source on each project; a later "default for new projects" is a
  convenience, not a layer.

Precedence at launch, for a session owned by O in project P: O's source for P, else P's source, else
none. Then, by name, highest first:

1. Mend's own names (`MEND_SESSION_TOKEN` and the rest of the session channel) and the platform's.
2. Project secrets and project configuration entered in Mend. An explicit value typed into Mend is
   the narrower decision; it overrides the synced one, as `doppler run --preserve-env=NAME` lets a
   local value win.
3. The Doppler source's values.

The launch records which source applied and, per name, where it came from.

**Whose Doppler values a session has.** The session owner's. A launch is the owner's; a Slack
`@mend` that starts a session starts it as the linked person.

**Shared control, after [ADR 0013](0013-whoever-sends-a-turn-pays.md).** ADR 0013 decides that a
steerer's turn runs on the steerer's login. Doppler values do not follow the turn's payer, and this
ADR recommends they stay with the session owner:

- **They cannot follow today.** The values are workspace environment, fixed at create and inherited
  by the harness process. ADR 0013's switch writes credential files; Claude Code keeps running
  through a switch, so its environment never changes, and the platform has no per-process secret env
  for the restarted Codex either (Platform feedback, below).
- **A Doppler read is not a spend.** ADR 0013 exists because a login is a subscription one person
  pays for and may not lend. A Doppler source costs its owner nothing per turn: one read per
  workspace, against a per-token rate limit. What a steerer's turn gets from the owner's source is
  access to data, not use of a paid account.
- **The project source has the same audience as the session.** A steerer can see the shared project,
  and every session in it receives the project source anyway. Nothing crosses.
- **The person source is the real question.** A session launched on the owner's person source
  (`dev_yiannis`) carries those values, and a steerer's turn runs with them in its environment. The
  shared control setting says so when the owner turns it on, naming the source ("people who steer
  run with your Doppler source `backend/dev_yiannis` and your secret files"). The steerer's own
  person source never applies to someone else's session.

In capture mode a session that joins a worktree runs in the holder's executor and so with the
holder's values; the join line says whose Doppler source the executor carries. ADR 0013 refuses its
login switch there for now, and secret files (ADR 0010) accepted the same exception.

### 2. Which tokens: read-only service tokens first

| Token                                         | Accepted                    | Why                                                                                                           |
| --------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Service token (`dp.st.`)                      | yes, the recommended kind   | One config. Doppler fixes the scope, so Mend stores no project or config of its own.                          |
| Service account token (`dp.sa.`)              | project source only, opt-in | For an organization that manages Doppler by service account. Mend asks for the project and config.            |
| Personal (`dp.pt.`) and CLI (`dp.ct.`) tokens | refused                     | Everything the person can reach, `prd` included, with write access. They also cannot read restricted secrets. |
| Service account identity, SCIM, audit         | refused                     | Short-lived and minted from an OIDC token Mend does not have; the others read no secrets.                     |

At save, Mend checks the prefix, calls `GET /v3/me` to confirm the `type` and the workplace, and
reads the config once so the person sees the names before anything launches. A kind it does not
accept is refused with the kind it saw. The token is sealed with `SecretCipher` like a project
secret and never returned; the API shows its `token_preview`.

Doppler does not document a way to read whether a service token is `read` or `read/write`, and Mend
will not probe with a write. Mend never writes to Doppler, so a write-capable token only matters if
it leaks. The save says so ("Doppler does not say whether this token can write; Mend only reads"),
and `mend connect doppler` always mints `read`.

`mend connect doppler` (section 6) turns a person's CLI login into a read-only service token on the
laptop, so nobody has to paste a broad token to get started. The CLI token stays on the laptop, the
way `mend connect claude` keeps the laptop's own login off the server. This is also the setup
Doppler recommends for agents.

### 3. When Mend reads, and what happens when Doppler does not answer

**At every launch that creates a workspace**: the cold launch, a capture-mode launch, and the claim
of a standby (below). Mend's server calls the download endpoint itself, once, with `If-None-Match`
when it holds a last-known copy. No Doppler call happens inside the workspace. The conditional read
is an optimization: it is undocumented, so a full answer is always handled. Mend does not ask for
dynamic secrets (`include_dynamic_secrets` stays false): a lease that expires in 30 minutes cannot
live in an environment fixed for a session's life.

One read per launch stays far inside the limits (120 secret reads a minute per token on the cheapest
plan). Mend coalesces concurrent reads of one source into one request, honours `retry-after` on a
`429`, and never retries a `4xx` other than `429`.

**Last-known copy.** After each successful read Mend keeps the values sealed under `secrets.key`,
with the time and the ETag, one copy per source (`doppler_source_snapshots`). It is the same posture
as project secrets, which already sit sealed in the same database, and it mirrors Doppler's own
encrypted fallback file. Removing a source deletes its copy.

**When Doppler does not answer** (connection refused, timeout, `5xx`, `429` past its `Retry-After`):
launch with the last-known copy and say so on the session line, with its age:

```
Doppler · backend/dev · not reached (timeout after 10 s) · launched with the values read 09:12, 3 h ago
```

With no copy, refuse the launch with Doppler's words and the way out:

```
Doppler · backend/dev · not reached (timeout after 10 s) · no earlier values · not launched
mend start --without-doppler launches without them
```

**When Doppler refuses** (`401`, `403`, `404`): refuse the launch, never use the copy, and delete
it. A revoked token or a removed config is someone's decision to cut access, and a cache must not
outlive it; the Doppler CLI deletes its fallback file on the same three answers. The source is
marked `refused` with Doppler's message until it is replaced, the same way ADR 0008 marks a login
`invalid`, and web, phone and `mend doctor` show it.

Launching quietly without the values is not an option: an agent whose tests fail on a missing
`DATABASE_URL` reports a broken repository, which is the wrong evidence. A launch that went without
Doppler on request says so on the line.

**A resume that reuses the session's workspace** (a retained executor in capture mode, a live
workspace otherwise) cannot change its environment, which was fixed at creation. Mend reads the
source again (a conditional request, usually a `304`) and, when the values moved, says so instead of
pretending:

```
Doppler · backend/dev · changed since this workspace started (09:12 → 14:02) · this run has the 09:12 values · stop the session to start with the new ones
```

**The hot pool.** A standby carries the values it was created with. Its fingerprint gains the
source's identity and a digest of the values it was created with (SHA-256 over the canonical, sorted
map; never stored beside the values). At claim Mend reads the source again: a different digest
drains the standby and the launch goes cold; a Doppler that does not answer lets the claim proceed
under the rule above, with the standby's values as the last-known copy and the line saying so.

**No refresh during a running process.** A process's environment cannot change after it starts, and
Doppler's own answer (`doppler run --watch`) restarts the process, which for an agent means killing
its turn. Mend does not poll on a timer. The session view reads the source when someone opens it
(coalesced: one read per source per minute across every viewer) and shows "changed since launch"
when it did. A Doppler webhook could replace that read later, since it is signed and carries only
names, but it needs Mend reachable from Doppler, which a loopback or private instance is not. A
platform per-session secret env (PLATFORM-FEEDBACK.md, below) would let the next process in a
retained executor start with fresh values; until then a new workspace is the way.

Rotated secrets are the case this hurts. Doppler's own advice is a rotation interval at least as
long as the longest a consumer runs without restarting. A session is such a consumer, bounded by the
12-hour TTL Mend gives every workspace.

### 4. How the values reach the session: secret environment, nothing else

Every value goes through `secretEnv`, the channel project secrets already use. Doppler does not say
which values are secret, so Mend treats every one as secret; none goes into `env`.

- **Names the platform refuses** (`PATH`, `LD_PRELOAD`, `BASH_ENV`, `GITHUB_TOKEN`, `SEALANT_*`,
  `MEND_*`) and values past the bounds (over 4096 bytes, past 128 entries or 32 KiB in all) are not
  delivered. The session line names each and why ("`GCP_SA_JSON` · 6.1 KB · over the platform's 4 KB
  per value"). Nothing is truncated. Doppler allows 50 KiB per value and 1,200 per config, so a
  large config will hit these bounds; the run records the names left out, and slice 1 measures how
  often on real configs before anything bigger is asked of the platform.
- **The loader and runtime-injection names** (`LD_PRELOAD`, `NODE_OPTIONS`, `PROMPT_COMMAND`) are
  the ones Doppler itself warns can run code. The platform's reserved list refuses them already
  (checked against `@sealant/api-contracts` 0.38.1: `NODE_OPTIONS`, `PYTHONPATH` and
  `JAVA_TOOL_OPTIONS` are `runtime-injection`, `PROMPT_COMMAND` is `shell-startup`, `HTTP_PROXY` is
  `runtime-network`; `DATABASE_URL` and `DOPPLER_CONFIG` pass). Mend reuses
  `validateProjectSecretName`, so the two lists cannot drift.
- **Not as files in the worktree.** A `.env` in `/workspace/repo` would be captured into every
  checkpoint and the change. Mend never writes one.
- **Not as secret files, in this ADR.** A value that is a file in disguise (a service-account JSON,
  a PEM) is the one case the bounds push out. Rendering chosen names into `$HOME` through ADR 0010's
  delivery is possible later, as an explicit per-name choice ("write `GCP_SA_JSON` to
  `~/.config/gcloud/key.json`"), never by default.
- **Not the Doppler CLI in the workspace.** Running `doppler run` inside the workspace needs the
  token inside it. The agent can read anything the workspace holds, so it would hold a credential
  that keeps working after the session ends, copied into a transcript or a shell history the capture
  keeps. Values delivered at launch stop being Mend's problem when the workspace ends; a token does
  not. It also needs the CLI in every image and spends one Doppler request per process. If people
  ask for `--watch` semantics later, it can come back as an opt-in with a short-lived token
  (`--max-age`) minted per launch.

What the agent sees is what any process in the workspace sees: `env` prints every value. That is
true of project secrets today and is the point of the feature; the guide says to connect a
development config, not production.

### 5. Which Doppler config: chosen in Mend, `doppler.yaml` only suggests

- **A service token names its own config.** Nothing to map. This is why it is the recommended kind.
- **A service account token** needs a project and config, chosen in Mend when the source is saved.
- **`doppler.yaml` is read, never obeyed.** When a source is being set up, Mend reads `doppler.yaml`
  at the project's default branch from the store and pre-fills the project and config (for
  `mend connect doppler`, the config to mint a token for). It never picks the config at launch. A
  branch that edits `doppler.yaml` to say `prd` would otherwise decide which secrets a person's
  broad token pulls into an agent's environment. The scope stays with the token and with what a
  person chose in Mend.
- **Monorepo entries** (several `setup` items with paths) cannot all apply: a workspace has one
  environment. Mend offers the entry for the repository root, else lists them and asks.
- **Branch configs per worktree** (worktree `feat-x` to config `dev_feat_x`) are not done. Doppler
  branch configs are mostly per person, which the person source covers. Revisit if someone asks.

### 6. Surfaces

Names only, never values, on every surface. A value is entered once, in Doppler.

- **CLI.**
  - `mend doppler` in a project: the source that applies to you, its kind, project/config, when it
    was last read, the names and which of them Mend values override or the platform refused.
  - `mend connect doppler [--project <p> --config <c>] [--for-project]`: with the Doppler CLI logged
    in on the laptop, mints a read-only service token for the config
    (`doppler configs tokens create --access read --plain --name mend-<host>-<project>`), sends it
    as your source for this project (or, with `--for-project`, as the project source, if you may
    manage the project), and prints the names Mend read. The project and config default to the
    repository's `doppler.yaml`. Without a logged-in CLI it reads a token from stdin.
  - `mend connect doppler --remove [--for-project]`.
  - `mend start --without-doppler` launches without the source, said on the line.
- **Web.** Project Setup → Environment gains a Doppler section beside Configuration and Secrets: the
  project source, its config, the names, the last read ("read 09:12 · 42 names · observed") and the
  state (`refused · Invalid Auth token`). Settings gets "Doppler" next to Secret files: your
  per-project sources.
- **Phone.** Lists both, with state and last read, and removes. No token entry on the phone.
- **Session.** The launch line names the source and the count ("Doppler · backend/dev · 42 names ·
  read 09:12"), or the fallback and refusal lines above. The run records source, project, config,
  names, read time and whether the copy was used.

### 7. What is never captured and never logged

Never written by Mend into anything a capture, checkpoint, record, log or API answer reads:

- **Values** exist in plaintext only in the launch path in `SessionEngine`, between the fetch (or
  the unseal of the copy) and the `createWorkspace` call, as project secrets do. They are stored
  only sealed. The run records names.
- **Tokens** exist in plaintext only in the Doppler client for the duration of a request. Sealed at
  rest, never returned, never sent to the workspace.
- **Logs** carry the source id, the Doppler project and config, the HTTP status and Doppler's
  `messages`, counts and names. Never a response body from the download endpoint: its body is the
  secrets. The client decodes the body with a schema that maps a decode failure to "Doppler's answer
  could not be read" with no excerpt, and does not log request headers.
- **Captured output.** The platform masks every `secretEnv` value in captured process output.

Enforced by:

- A **canary test** in `@mend/sessions`: a fake Doppler answers a config holding a canary value; the
  test drives the cold launch, the claim, the resume, the fallback and every refusal, and asserts
  the canary is absent from the captured log output, every database row other than the sealed
  columns, every API answer and every session line, and present in the `secretEnv` given to the fake
  platform.
- The same for the token canary.
- Reusing `SecretCipher` and the project-secret validation (`validateProjectSecretName`), so the
  reserved names match the platform's by construction.

Not enforced by this ADR, and true of project secrets today: an agent that prints a value puts it in
its conversation. The harness transcript lives in the captured harness home, Mend stores the agent's
items, and the review passes send transcripts to a provider. Mend does not mask values in agent
items today. Masking every known secret value (project secrets and Doppler) in agent items before
they are stored is worth its own change; it needs the values at fold time, which this design keeps
out of memory after launch.

## Considered

- **The Doppler CLI in the workspace with a service token** (`doppler run` as the harness wrapper).
  Live reload with `--watch`, offline with the fallback file, no Mend code to fetch. Refused for the
  token in reach of the agent, beyond the session's life (section 4).
- **Values as a file through secret files.** Keeps them out of process environment, but nearly every
  program reads its configuration from environment, so the agent would need
  `set -a; . ~/.doppler.env` in every shell and service. Kept for the oversized-value case only.
- **An organization token** that reads every project. Least privilege rules it out.
- **`doppler.yaml` as the source of truth.** A repository file would decide which secrets a token
  pulls (section 5).
- **Launching without the values when Doppler is down.** Quiet, and wrong evidence downstream.
- **Polling during a session.** No running process can take the new values, and it spends the rate
  limit for nothing.
- **Doppler as a platform connected account.** The platform's providers are a closed set it resolves
  itself (PLATFORM-FEEDBACK.md, 2026-07-25), and nothing about Doppler needs the platform: Mend's
  server can read it and use the channel that exists.

## Consequences

- A project that keeps its secrets in Doppler stops copying them into Mend; a change in Doppler
  reaches the next workspace without anyone touching Mend.
- Values that do not fit the platform's bounds do not arrive, and the session says which.
- Mend holds a sealed copy of each source's last values. Losing `secrets.key` loses the copies and
  the tokens with the project secrets; reconnect.
- A Doppler outage costs nothing for a project read before; for a project never read, it refuses
  launches until Doppler answers or someone launches `--without-doppler`.
- A revoked token stops launches at once; no cached copy outlives it.
- Long sessions run with the values they started with, and say so when Doppler has moved on.
- Doppler's access log shows the service token as the reader of each secret (Doppler keeps the first
  and the most recent read per reader). A `304` records nothing.

## Platform feedback

Nothing here needs the platform to ship first. Two entries go into PLATFORM-FEEDBACK.md with the
implementation:

- **Secret environment per session process.** `SessionOptions` takes `env` "not for secrets" and no
  `secretEnv`. A per-process secret env (same channel, same masking) would let a resumed session's
  next process start with values read at resume, a joiner's process run without the holder's person
  source, and, if the owner wants it, a Codex restarted by ADR 0013's switch run with the payer's
  Doppler source.
- **Larger secret environment.** 4 KiB per value, 128 entries and 32 KiB in all, against Doppler's
  50 KiB per value and 1,200 per config. Service-account JSON and certificates do not fit. A larger
  bound for `secretEnv`, or a secret file in the same channel (asked 2026-10-03), covers it. Filed
  with the counts slice 1 measures.

## Delivery

| Slice | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                   | Size     |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 1     | The project source with a read-only service token: migration (`doppler_sources`), Doppler client (Effect `HttpClient`, typed errors, rate-limit aware), token check at save, read at cold launch into `secretEnv`, precedence, names on the run and the line, refusals, canary test, web Setup section, `mend doppler`, `mend connect doppler --for-project` from stdin. A project with a Doppler source keeps no standby until slice 2 | 4–5 days |
| 2     | The last-known copy and the not-reached rule, `--without-doppler`, the hot pool fingerprint and claim read, resume "changed since" line, `refused` state in web, phone and `mend doctor`                                                                                                                                                                                                                                                | 3 days   |
| 3     | The person source: per person per project, precedence, settings page, phone list, `mend connect doppler` minting through the local CLI with `doppler.yaml` pre-fill, the shared control and join wording                                                                                                                                                                                                                                | 3–4 days |
| 4     | Service account tokens with a project/config picker, docs page (`integrations/doppler`), PLATFORM-FEEDBACK.md entries                                                                                                                                                                                                                                                                                                                   | 2 days   |

About 2.5 weeks for one person, slice 1 usable on its own.

## Decisions for the owner

1. Two layers (project, then person) and no organization layer?
2. Refuse personal and CLI tokens, accepting read-only service tokens (and service account tokens at
   project level)?
3. Doppler not reached: last-known values with their age, else refuse with `--without-doppler`? Or
   refuse always, or launch without?
4. Mend-entered project secrets win over Doppler values of the same name?
5. Keep a sealed last-known copy of Doppler values in Mend's database at all?
6. Values only as secret environment, with the Doppler CLI in the workspace ruled out?
7. `doppler.yaml` pre-fills only and never picks the config at launch?
8. `mend connect doppler` minting a read-only service token through the laptop's CLI, as the default
   way in? And should that token expire? Doppler's agent guide mints one for 24 hours, which would
   break a saved source every day; the recommendation is no expiry, a recognisable name
   (`mend-<host>-<project>`) so it can be revoked in Doppler, and `--max-age` for anyone who wants
   one.
9. Under shared control, now that ADR 0013 makes a steerer's turn run on the steerer's login, do
   Doppler values stay with the session owner (recommended, said on the shared control setting)? The
   alternatives: a session launched on a person source refuses shared control, or it relaunches on
   the project source when control is shared; or Doppler follows the turn's payer, which needs a
   per-process secret env from the platform and would still reach only Codex, since Claude Code is
   not restarted on a switch.

## Decision log

- 2026-10-04: proposed. Read and delivered by Mend's server through the platform's existing
  `secretEnv`, so no platform change is needed to start.
- 2026-10-04: renumbered 0013 → 0014; ADR 0013 (whoever sends a turn pays) took the number. Doppler
  values stay with the session owner under shared control, since a read is data access, not a spend,
  and environment cannot follow the turn's payer; the person-source case is left to the owner
  (question 9).
