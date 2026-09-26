# Mend project environment variables — implementation plan

> Historical record (2026-09-26): shipped 2026-08-18 in Mend CLI 0.3.0. Current behaviour:
> https://docs.mend.run/guides/environment-variables/.

> Status: implemented across all three repos on 2026-08-17; every PR open, none merged. sealantd#55
> (secret env file) → sealant#174 (env) → sealant#175 (secretEnv, pins sealantd 0.10.0) → mend#64
> (domain/db/api) → mend#65 (UX) → mend#66 (secrets + launch wiring + `mend env load`). Mend pins
> @sealant/sdk + api-contracts 0.19.0. Remaining after releases: the Mend-side live matrix.

## Audit addendum (2026-08-17)

All core claims verified; line numbers cited below have drifted after the dotfiles commits (Core
#165/#166/#169/#172) but every mechanism exists. Corrections and decisions:

- **Reserved policy mirrors the Sealantd filter exactly (decided).** Sealantd's `passthrough_env`
  (`Sealantd/crates/sealantd/src/boot/config.rs:789-817`) silently drops any boot-env name
  containing `TOKEN`/`SECRET`/`PASSWORD`/`PASSWD`/`CREDENTIAL`/`APIKEY` as a **substring** (so
  `TOKENIZER_PATH` too), ending in `_KEY`, or **exactly `KEY`**, plus consumed `SEALANT_*` keys.
  Core's policy must be a strict superset so no accepted name can silently vanish: add the
  bare-`KEY` exact match and substring semantics to the reserved rules in this plan. We do not use
  the `SEALANT_HARNESS_ENV_KEYS` exemption knob.
- **Legacy `runtime.env` is more permissive than stated**: in docker argv it currently overrides
  `DOCKER_HOST`, `SEALANT_WORKSPACE_AUTH_KEY_BASE64`, clone HTTP tokens, and
  `SEALANT_DOTFILES_ARCHIVE_DIR`; only `credentialEnvArgs` (emitted last,
  `docker-runtime-adapter.ts:~1005-1009`) survives, and that ordering is comment-only with no test.
  New `userEnv` is emitted **first** (weakest caller layer); add the missing credential-precedence
  test.
- **SDK lowering hazard**: `buildCreateWorkspaceRequest` emits `runtime:` via a single conditional
  spread keyed on `dotfilesArchives`; `userEnv` must merge into that same object — a second
  `runtime:` spread would clobber archives.
- **API echo**: `userEnv` round-trips out via `WorkspaceDetails.spec` _and_
  `WorkspaceAttemptSummary.spec` (`workspaces.module.ts:~921, ~1072`); document both.
- **No Core proxy layer exists**; proxy protection lives in the daemon (`extra_env` applied last).
  `TERM` is force-set on the PTY path; `HOME`/`USER`/`LOGNAME` forced by `harness_child_env`. All
  already reserved.
- **k8s/k3s runtime adapters ignore env entirely** — capability is Docker-only in practice;
  document.
- **Plan-hash**: `runtime.env` deliberately excluded from the Containerfile hash; env-only changes
  reuse the prior image (correct; keep `userEnv` out of the hash too).
- **Mend**: next migration is `0025` (numbering is a known contention point); diff runs via
  `sealant.diffCommits`, not workspace exec (drop "diff commands" from the coverage list — no
  behavior change); PTY-vs-exec env asymmetry lives in `packages/sealant/src/client.ts`, not the
  engine; jsdom is an unwired dep (no vitest DOM config) — follow the pure-reducer test precedent;
  `$projectId_.` non-nested route is a repo first (supported); `session_runs` has a partial unique
  index enforcing one unsettled run per session.
- **Release state**: `@sealant/sdk`/`@sealant/api-contracts` 0.18.1 published, no pending
  changesets; `sealantd:0.9.0` pin is the latest daemon release (HEAD = v0.9.0).

## Scope expansion (2026-08-17, decided): the transient secret channel

The non-secret stack (PRs 1/2/4) is the substrate, but the product goal is a **project env store
teams use to start dev servers**, and a real `.env` is majority secret-shaped. Yiannis chose the
**transient secret channel** over "honest plaintext" and "non-secret only". Design, all three repos:

- **Sealantd** — new consumed key `SEALANT_SECRET_ENV_FILE`: a JSON object (`name → value`) the
  daemon reads once at boot. Names are grammar-checked and must not be `SEALANT_`-prefixed; the set
  merges into `child_env` **after** the passthrough env and **before** the forced identity vars
  (`HOME`/`USER`/`LOGNAME`/`PATH`), bypassing `is_secret_key` (these are explicitly injected). Every
  value seeds the redactor regardless of name. `config_hash` switches to hashing the sanitized
  summary so a fingerprint in logs never covers env values. Malformed/missing file = loud boot
  failure (parity with dotfiles archives). The daemon documents that the launcher removes the file
  after readiness; values then live only in daemon memory and child environments.
- **Core** — `CreateOptions.secretEnv`, validated by `parseWorkspaceSecretEnv` (same grammar/bounds
  as `env`; reserved = every platform class **except** secret-marker; account-lookup names such as
  `GITHUB_TOKEN` stay reserved — connected accounts own them). Never enters the blueprint, the
  attempt/user spec snapshot, `WorkspaceDetails`, or `WorkspaceAttemptSummary`. Transport to the
  worker: encrypted at rest with the existing credential cipher in a column on the build job,
  decrypted just before launch, written as a `0600` JSON file into the staging root (the dotfiles
  archive staging pattern), bind-mounted read-only at `/run/sealant/secrets`, passed as
  `SEALANT_SECRET_ENV_FILE`; the staging file is removed once the control socket is ready and the
  ciphertext column is cleared after the launch phase (success or failure). Platform-side restarts
  therefore run **without** secret env (Mend always launches fresh; documented). Requires a sealantd
  release + Core image-pin bump; e2e proves inheritance + redaction against the new image.
- **Mend** — a separate **Secrets** set per project: `project_secrets` (name, ciphertext, integer
  revision, unique `(project_id, name)`), encrypted at rest with a machine-local key file under
  `~/.config/mend/keys/` (0600, generated on first use, private half never leaves the host); the API
  is **write-only for values** (list = names + updated-at; create/replace never returns the value;
  rename keeps the ID; delete revokes); UI = Secrets panel beside Configuration with a write-only
  input and "value set · updated <when>"; launch passes both maps; `SessionRun` stamps names for
  both sets. **CLI**: `mend env load [file] [--project <name>] [--secret]` parses a dotenv file,
  routes each entry by name (ordinary → Configuration, secret-shaped → Secrets, or all → Secrets
  with `--secret`), upserts, and prints a per-name summary + rejections with reasons — never values.

Precedence with secrets: `env` (plaintext, container env, weakest) < daemon boot filter <
`secretEnv` (daemon merge) < forced identity vars < connected-account credentials/`extra_env`.

## Context

Mend projects should own ordinary environment configuration that future Sealant workspaces inherit.
The configuration must be available to the primary coding agent and every later process Mend starts
inside that workspace without bypassing Sealant's public SDK. It must not turn a plaintext project
settings table into a credential store or imply that nested Docker containers receive automatic
injection.

This plan follows Mend's product boundary: Mend is a public-SDK-only consumer (`Mend/AGENTS.md`;
`Mend/MEND-AGENT-WORKBENCH-PLAN.md:137-140`) and must not record secret values
(`Mend/MEND-AGENT-WORKBENCH-PLAN.md:1203-1213`). Boundary and persisted data are parsed into domain
types, failures are typed, and diagnostics never contain values.

### Evidence summary

- The closest Mend precedent is workspace image selection: a nullable project override is resolved
  at each `SessionEngine.launchInternal`, passed to `createWorkspace`, and stamped as the launched
  value (`Mend/packages/sessions/src/engine.ts:1058-1146`). Resume creates a fresh workspace and a
  new ordered `SessionRun` (`engine.ts:1622-1716`; `packages/domain/src/workbench/session-run.ts`).
- Mend currently opens the primary harness, shell, Service, and Service restart through
  `workspace.sessions.open()`, while setup, helper, transcript, diff, and deterministic workbench
  commands use `workspace.exec()` (`Mend/packages/sessions/src/engine.ts`). Queue-era `RunStarter`
  creates separate issue workspaces with no Project ownership and is explicitly outside this feature
  (`packages/jobs/src/run-starter.ts:357-373`; `packages/db/src/schema/workbench.ts:80-89`). Mend's
  adapter does not expose per-session environment options
  (`packages/sealant/src/client.ts:90-94,243-246`).
- Sealant exposes only PTY-local `SessionOptions.env`; `CreateOptions`, `RunOptions`, and
  `WorkspaceExecOptions` have no environment field
  (`Core/packages/sdk/src/types.ts:209-271, 365-388`). PTY-only injection therefore cannot meet the
  process-coverage requirement.
- The platform already has launch-time blueprint environment, persists it in build jobs/attempt
  snapshots, restarts from that snapshot, and lowers it to workspace-container environment
  (`Core/packages/validators/src/workspaces/workspace-blueprint.ts:232-248`;
  `packages/workspaces/src/runtime/docker-runtime-adapter.ts:264-315,945-1009`). A small public SDK
  option can therefore cover every descendant process without a new daemon protocol.
- The existing `runtime.env` field is an unrestricted legacy/internal map. It is emitted after
  several `SEALANT_*` controls, can override boot behavior, is used by existing tests/specs, and is
  reparsed on worker execution/restart (`docker-runtime-adapter.ts:264-326,945-1009`). Add a
  separate strict additive `runtime.userEnv` for the new public capability rather than changing
  legacy parsing/precedence. The worker also temporarily merges resolved dotfiles tokens into
  `runtime.env` (`process-workspace-build-job.ts:515-543`); move those to protected transient launch
  input so secrets are not conflated with either caller field.
- Sealantd clears the inherited environment for managed exec/PTY children, then applies its
  configured child environment, request-local overrides, and protected proxy values. Exec validates
  only empty/`=`/NUL; PTY overlays do not call even that validator
  (`Sealantd/crates/sealant-process/src/runtime.rs:88-183`;
  `crates/sealant-pty/src/session.rs:284-321`).
- Workspace-level environment is durable and API-visible in Sealant workspace specs. Per-session
  overlays are not stored as session columns, but their values are not added to the redactor and can
  leak when echoed. Commands/arguments are recorded unredacted and redaction is chunk-local
  (`Sealantd/crates/sealantd/src/runtime.rs:31-46`;
  `crates/sealant-runtime-core/src/redact.rs:43-81`;
  `crates/sealant-process/src/runtime.rs:237-254`).
- Mend is pinned to `@sealant/sdk` 0.18.0 while Core is 0.18.1 (`Mend/pnpm-workspace.yaml`;
  `Core/packages/sdk/package.json`). The SDK and API-contract packages are a fixed Changesets
  release group (`Core/.changeset/config.json`).

## Approach

Ship **project-owned, non-secret environment variables** backed by a small general Sealant public
capability: optional `CreateOptions.env`. Mend reads one validated project snapshot at workspace
launch and passes it only at workspace creation. The workspace container environment then supplies
all direct Mend-started processes through normal inheritance.

Do not ship arbitrary secret values in this feature. A later secret-capable feature requires a
separate reference-based credential contract and runtime/redaction hardening; it must never be a
`secret: true` flag over the same plaintext value model.

### Canonical terminology and invariants

No glossary/ADR change is needed: `project`, `session`, `SessionRun`, `workspace`, and `run` already
have precise meanings. Add these implementation/domain terms only:

- **Project environment variable** — a project-owned, explicitly non-secret name/value pair.
- **Project environment snapshot** — the immutable set resolved for one workspace launch.
- **Workspace environment** — the non-secret map supplied at workspace creation and inherited by
  processes in that workspace.

Invariants:

1. One project has zero or more variables; names are unique within that project.
2. Entries have stable IDs so rename is an atomic update, not delete-and-create.
3. Values are ordinary configuration and are persisted/returned as plaintext by design; the UI and
   API state this before creation.
4. Secret-looking and platform-owned names are rejected rather than accepted with false assurances.
5. One snapshot is read once per fresh workspace launch. A live workspace is never mutated.
6. The safe launch manifest belongs to `SessionRun`, because one logical Mend session can resume
   into several workspaces with different project settings. `Session` is not the authority.
7. No component automatically copies a raw value into Mend events, logs, errors, metrics, process
   metadata, or Sealant run fields. Sealant's workspace attempt/build snapshot necessarily contains
   non-secret values, and a process that deliberately prints one will produce ordinary recorded
   output.

## Exact semantics

### Scope and precedence

- Variables are **project-only**. There is no machine/global default and no inheritance cascade in
  this first feature; “projects own environment variables” remains literal.
- At each fresh Mend workspace launch, resolve the complete current project map and pass it as
  `CreateOptions.env`.
- Effective precedence is:
  1. base-image `ENV` defaults;
  2. caller/project workspace environment;
  3. Sealant-owned boot/runtime values (`SEALANT_*`, workspace paths, Docker routing);
  4. connected-account credential injection;
  5. process-owned terminal details such as `TERM` and protected proxy values.
- Reserved-key rejection is the primary collision policy. Core orders platform values after the new
  public `runtime.userEnv` as defense in depth. Legacy/internal `runtime.env` retains its old
  behavior solely for stored-spec compatibility and is never emitted by Mend/the fluent SDK. Mend
  does not use `SessionOptions.env`, so no hidden PTY-specific override layer exists.
- Empty string is a valid value and means “set this variable to empty”; absence means unset. Mend
  does not add an explicit unset tombstone because there is no parent map to mask.
- Linux name matching is case-sensitive. `FOO` and `foo` are technically distinct, but the UI warns
  on case-only near-duplicates; exact duplicates are rejected.

### Lifecycle behavior

| Event                                                            | Result                                                                                                                                              |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create/edit/delete/rename project variable                       | Saved atomically; no running workspace changes.                                                                                                     |
| Start a new session                                              | Fresh workspace receives the latest complete project snapshot.                                                                                      |
| Attach/reopen UI for a live session                              | No process/workspace change; original snapshot remains.                                                                                             |
| Open a shell in a live workspace                                 | Inherits that workspace's original snapshot.                                                                                                        |
| Start or restart a Service in a live workspace                   | Inherits that workspace's original snapshot; restart does not reread project settings.                                                              |
| Restart Mend while workspace survives                            | Reattachment only; original snapshot remains.                                                                                                       |
| Resume a settled Mend session                                    | `launchInternal` creates a fresh workspace and new `SessionRun`; it receives current project settings.                                              |
| Resume as shell or another harness                               | Same fresh-workspace/current-settings rule.                                                                                                         |
| Sealant restarts an existing workspace from its stored blueprint | Reuses that workspace's stored snapshot, not current Mend settings.                                                                                 |
| Attach an externally created/legacy run                          | `SessionEngine.attachRun` did not own workspace creation; stamp an explicit legacy/unknown manifest (`revision` and names absent), never infer one. |
| Launch fails before a Sealant run exists                         | No synthetic `SessionRun`; failure reports operation/key metadata only, never values.                                                               |

The settings page always says: **“Changes apply to new workspace launches, including when you resume
a settled session. Running workspaces keep the configuration they started with.”** There is no
“Apply now” action.

### Process coverage

A creation-time workspace map reaches these processes through the container/daemon child base
environment:

- primary Codex, Claude, OpenCode, or custom harness PTY;
- shells opened later in the workspace;
- supervised Mend Services;
- restarted Services in the same workspace;
- custom-image setup commands;
- state restore/import, helper installation, transcript reads/harvest, and diff commands;
- deterministic `workspace.exec()` checks and other workbench exec paths;
- the shell/process that invokes `docker compose` or `docker run`.

It does **not** automatically inject variables into containers created by Docker Compose or
`docker run`. The Docker CLI/Compose process can use them for interpolation; child containers
receive only values explicitly declared in Compose (`environment`/`env_file`) or command flags
(`-e`/`--env-file`). Automatic nested-container injection is a separate future feature.

### Non-goals

- Secret/token/password/private-key storage or injection.
- Inferring that a value is safe from a password-shaped UI or heuristic scan.
- Editing a live workspace environment or restarting workspaces automatically.
- Session-specific overrides or global defaults.
- Automatic nested-container injection.
- Historical UI for environment values or exact reproduction after workspace/platform retention
  expires.
- Retrofitting legacy workspaces that were created without the map.
- Queue-era `RunStarter` issue workspaces and their one-shot verification/follow-up paths: legacy
  issues have a repository but no `ProjectId`, so there is no project environment to resolve. The
  workbench `SessionEngine` paths are the feature boundary; do not invent an Issue→Project migration
  for this feature.
- Broad remediation of existing Sealantd SFTP, command-recording, or streaming-redaction findings;
  those block a secret-capable design but are not required to inherit declared non-secret values.
- Removing the pre-existing low-level `runtime.env` blueprint escape hatch. Keep it compatible and
  document/deprecate it; the safe fluent SDK/Mend path uses strict `runtime.userEnv`. Its raw-client
  platform-override risk remains tracked security debt rather than being hidden by this feature.

## Design comparison and recommendation

### Candidate 1 — non-secret Mend-only fan-out (reject)

Mend could store ordinary values and widen its adapter to pass `SessionOptions.env` when opening the
primary PTY, shells, Services, and Service restarts. That is the only current public environment
option. It cannot reach `workspace.exec()` setup/helper/check paths or one-shot harness runs because
`WorkspaceExecOptions` and `RunOptions` have no env. Prefixing every command with `env KEY=value` or
shell exports would duplicate policy, miss future call sites, and put values in recorded argv. A
Mend-only implementation therefore cannot satisfy the stated semantics through the public SDK and
must not ship as a partial feature presented as workspace-wide.

### Candidate 2 — non-secret public workspace environment (recommended)

Mend persists explicitly ordinary project values in plaintext, while Core adds validated public
`CreateOptions.env` and lowers it to the existing blueprint. Mend stores only a safe launch manifest
on `SessionRun`: project environment revision and ordered variable names, not values or hashes.
Exact non-secret values are already durable in Sealant's workspace build/attempt spec for the life
of that platform record.

Advantages:

- Smallest capability that covers all process types through public SDK only.
- No daemon protocol change; existing Sealantd child inheritance is reused.
- Honest storage/UI contract and bounded review surface.
- Safe manifests avoid multiplying value exposure in Mend run/session APIs.

Costs:

- Values are plaintext in Mend's project configuration and Sealant workspace specs.
- Users must use existing connected-account credentials for supported secrets; arbitrary secrets are
  unavailable.
- Validation must reject secret-looking names and dangerous/platform-owned overrides.

### Candidate 3 — secret-capable project environment (defer)

A secure design cannot send raw values through `CreateOptions.env`: Core persists blueprint values,
returns specs through APIs, and currently places credential environment in Docker argv; Sealantd's
redactor does not learn per-session overlays, live exec attachment forwards raw bytes before
telemetry redaction, commands remain raw, configuration fingerprints hash secret-bearing child
environment, and chunk-split output can evade redaction.

A future secret-capable stack would require all of the following:

1. Mend stores only an opaque secret reference plus safe metadata; raw input is wrapped as
   `Redacted<SecretValue>` and its plaintext lifetime is minimized through final encryption/I/O. Do
   not promise reliable zeroization of JavaScript strings.
2. A public Sealant `CreateOptions.secretBindings`/generic credential-reference capability stores
   references, not resolved values, in workspace specs and jobs.
3. The worker resolves secrets just in time at the final runtime adapter; workspace details, errors,
   logs, hashes, and records never receive plaintext.
4. Runtime injection avoids plaintext process arguments where supported and seeds Sealantd's
   redactor with every resolved literal.
5. Sealantd uses streaming redaction across chunk boundaries, redacts/sanitizes live exec-return
   paths before clients receive bytes, persists sanitized command projections rather than raw
   secret-bearing argv, and excludes secret values from configuration fingerprints.
6. APIs list only name/reference/provider/update metadata; create/replace never returns the value;
   rename preserves the reference and delete revokes it.

This is materially larger, spans Mend/Core/Sealantd, and cannot truthfully fit behind a password
input over project JSONB. Recommend Candidate 2 now and a separate security design/ADR only when
generic secret bindings become a committed product requirement.

## Validation and reserved keys

Define the generic policy once in the public `@sealant/api-contracts` package as a pure parser plus
constants/structured failures; re-export it from `@sealant/sdk`. `CreateOptions.env` is parsed and
lowered into a new additive, strict `runtime.userEnv` blueprint field. Core's create, worker, and
restart reads all parse that field with the same policy; pre-feature specs have no field and decode
to an empty map. Keep legacy/internal `runtime.env` parsing and precedence unchanged so stored specs
and existing internal consumers remain compatible; do not expose it through the fluent SDK.

Move worker-resolved dotfiles auth out of legacy `runtime.env` into a protected transient runtime-
adapter launch field alongside existing credential/clone-auth inputs. The public `userEnv` map is
persisted; protected launch environment is assembled after parsing and merged after public values by
the adapter. Every stored row is still parsed at read time, including the new field.

### Bounds

- Name grammar: `[A-Za-z_][A-Za-z0-9_]*`.
- Name length: 1–128 UTF-8 bytes.
- Value: any UTF-8 string including empty/multiline, excluding NUL; maximum 4 KiB.
- Per project: at most 128 entries and 32 KiB total encoded name/value bytes.
- Exact duplicate names are rejected; records are serialized in name order for deterministic tests.
- For malformed names, errors identify entry index/rule and at most a bounded escaped rendering;
  only names that have passed grammar parsing may appear as diagnostic keys. Values/excerpts never
  appear.

### Reserved policy

Threat model: these values are ambient inputs to every bootstrap/helper/account-bearing process,
including processes that run before a user deliberately executes repository code. The policy does
not attempt to sandbox a malicious project owner; it prevents project settings from silently
reconfiguring Sealant control, connected-account lookup, loaders, shells, or global tool runtimes
and reduces accidental credential exposure. Legitimate uses of a blocked process-control variable
must be expressed in an explicit command/workspace-image configuration where the effect is visible.

Reject in the generic Core policy:

- prefix `SEALANT_`;
- identity/process roots: `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`, `SHLVL`,
  `TERM`, `COLORTERM`, `_`;
- runtime/network ownership: `DOCKER_HOST`, `DOCKER_TLS_CERTDIR`, `HTTP_PROXY`, `HTTPS_PROXY`,
  `ALL_PROXY`, and `NO_PROXY` (including lowercase/case variants);
- connected-account identity and lookup: `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`,
  `XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME`;
- dynamic-loader prefixes `LD_` and `DYLD_`, plus `GLIBC_TUNABLES`;
- shell startup/control keys `BASH_ENV`, `ENV`, `ZDOTDIR`, `PROMPT_COMMAND`, `PS4`, `SHELLOPTS`;
- runtime-wide code injection keys `NODE_OPTIONS`, `PYTHONPATH`, `PYTHONSTARTUP`, `RUBYOPT`,
  `PERL5OPT`, `JAVA_TOOL_OPTIONS`;
- Git/SSH identity and config controls: `SSH_AUTH_SOCK`, `GIT_SSH`, `GIT_SSH_COMMAND`,
  `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_COUNT`, and the
  `GIT_CONFIG_KEY_`/`GIT_CONFIG_VALUE_` prefixes;
- names matching Sealantd's secret markers: containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`,
  `CREDENTIAL`, or `APIKEY`, or equal to/ending in `_KEY`.

Reserved matching uses an ASCII-uppercase comparison so lowercase proxy/config variants cannot
bypass it. Mend composes one additional local reserved prefix, `MEND_`, without making a downstream
product namespace part of Sealant's generic contract. The public parser and contract fixtures are
versioned with `@sealant/api-contracts` and re-exported by `@sealant/sdk`; Mend imports only that
public surface. Do not scan values for “secret patterns”: that would create false assurance. The UI
instead states that all accepted values are stored and sent as plaintext.

A JavaScript/JSON record cannot represent or reliably diagnose duplicate object keys after parsing;
Core therefore validates the resulting map, not duplicates. Mend's resource model and database
unique constraint own duplicate-name detection.

## Create, edit, delete, and rename

Use stable `ProjectEnvironmentVariableId` resources and typed operations:

- **Create:** parse name/value, enforce project limit and unique name, insert, return the created
  variable and new project-environment revision.
- **Edit value:** address by stable ID and require the last-seen integer variable revision; return a
  typed stale-write failure instead of using timestamps or last-write-wins.
- **Rename:** one atomic update of the existing ID, with the same validation/uniqueness check; do
  not implement as delete plus create.
- **Delete:** require ID and last-seen revision, return the new aggregate revision; a missing
  resource is a typed not-found result. No value appears in audit/event payloads.
- A conflict leaves the browser draft intact. Case-only rename is allowed if no exact collision.
- Every mutation updates the aggregate revision and emits only a pointer event (`projectId`,
  revision) so subscribers refetch through the authorized API.

## Persistence, APIs, display, logging, and records

### Mend persistence

- Add a dedicated `project_environment_variables` table following `project_mounts`: stable ID,
  project FK with cascade delete, name, plaintext value, integer row revision, timestamps, and
  unique `(project_id, name)` constraint. Add `projects.environment_revision` as the aggregate
  integer revision (default `0`).
- Every mutation starts a transaction, locks the owning project row `FOR UPDATE`, reads/checks the
  complete aggregate under that lock (including count/byte limits), applies the row mutation, and
  increments `projects.environment_revision` before commit. This serializes distinct concurrent
  creates as well as edits to the same row.
- Launch reads aggregate revision plus name-sorted rows in one SQL statement (or an equivalent
  `FOR SHARE`/repeatable-read implementation), then parses the complete result. It must observe
  either the state before or after a concurrent mutation, never a revision/map mix.
- Add `environmentRevision` and `environmentVariableNames` to `session_runs`, not `agent_sessions`.
  They are inserted with the `SessionRun` after PTY/run creation. Pre-run failures do not fabricate
  history.
- Do not store environment values on `Session`, `SessionRun`, `SessionProcess`, Mend events, or
  summaries. Do not hash values.

### Mend APIs

Add a dedicated authenticated project-environment group rather than expanding every project-detail
response:

- `GET /projects/:id/environment` → `{ revision, variables[] }` (ordinary values included).
- `POST /projects/:id/environment/variables` → created variable + aggregate revision.
- `PUT /projects/:id/environment/variables/:variableId` → atomic name/value edit/rename with
  expected row revision.
- `DELETE /projects/:id/environment/variables/:variableId` → new aggregate revision.

Schemas parse path IDs, payloads, persisted values, and responses. Typed failures distinguish
invalid name/value, reserved key, duplicate, limit exceeded, stale write, variable/project not
found, and corrupt persisted record. The browser client must runtime-parse success/error responses
rather than assert `response.json()`.

Project list/detail and session detail do not return variable values. Session-run responses may
return only revision and names if/when run history is exposed.

### UI

Add a bounded, full-width **Project environment** page at `/projects/:projectId/environment`, using
the non-nested TanStack filename `projects.$projectId_.environment.tsx` (the existing project route
has no `<Outlet>`). Move/reuse only `WorkspaceImageSection` from the sidebar and add Configuration
beside it; replace the sidebar editor with an Environment summary/link. Leave References, Mounts,
Services, Dotfiles, Git access, Review automation, and Remove project where they are. This is the
smallest coherent environment-settings surface without turning the feature into an eight-section UI
migration. Reuse the global Settings page's full-width header/panel structure.

The **Configuration** panel shows readable/copyable ordinary name/value rows, an explicit plaintext
notice, and Add/Edit/Remove actions. Add/edit use labeled Name and Value controls; empty value is
explicitly allowed. Remove confirmation says live workspaces are unchanged. Rename edits the Name on
the same row. Loading, read failure, and empty states are distinct; save/copy/error messages use
live regions; scope controls use proper fieldset/radio semantics.

Do not render a Secrets panel or password input in this feature. Show one factual link/callout:
“Passwords, tokens, and private keys are not supported here. Use a connected account where
available.”

Accurate Docker copy:

> Docker Compose may use these values for interpolation. Containers started by Compose or
> `docker run` receive only values your Compose file or command explicitly passes.

### Logging and Sealant records

- Mend structured logs/errors may include operation, project/session/run IDs, revision, key count,
  and an already-validated key. Malformed input uses entry index/rule plus a bounded escaped display
  only; values never appear.
- Mend events carry pointers only. Process records retain argv as today but environment values must
  never be copied into argv or metadata by this feature.
- Core workspace build jobs and attempt snapshots contain accepted non-secret values because the
  blueprint is the durable restart source; workspace-details API can return that spec to authorized
  platform clients. SDK docs must state this explicitly.
- Sealant execution records do not add environment events. If a process prints a value, it is
  ordinary process output and may be recorded; the UI warning must not imply redaction for these
  declared non-secret values.

## Reuse

- Mend launch resolution and resume behavior: `packages/sessions/src/engine.ts::launchInternal` and
  `resumeSession`.
- Mend cohesive repositories/pointer events: `packages/db/src/repos/projects.ts` and the
  `project_mounts` schema pattern in `packages/db/src/schema/workbench.ts`.
- Mend transactional locking/update style: `packages/db/src/repos/settings.ts::modify`.
- Typed Effect HTTP contracts: `packages/api/src/contract.ts::projectsGroup`; workspace-image
  handler and typed failure translation in `packages/api/src/workbench.ts`.
- UI layout/design: `apps/web/src/routes/settings.tsx`, workspace-image form helpers in
  `apps/web/src/lib/workspace-environment.ts`, and clipboard fallback in
  `apps/web/src/lib/workbench-menus.ts::copyText`.
- Core public lowering: `packages/sdk/src/internal/blueprint.ts::buildCreateWorkspaceRequest`.
- Core compatible blueprint parsing plus the new strict additive field:
  `packages/validators/src/workspaces/workspace-blueprint.ts`.
- Core runtime inheritance: `packages/workspaces/src/runtime/docker-runtime-adapter.ts` and existing
  real-Sealantd proofs under `packages/workspaces/src/sealantd/*.e2e.ts`.

## Files to modify

Exact filenames may shift during implementation, but these are the critical owners discovered.
Generated output must be regenerated by its owner, never hand-edited.

### Sealant/Core

- New `packages/api-contracts/src/workspace-environment.ts` plus
  `packages/api-contracts/src/index.ts` — public policy constants, pure parser, and structured
  failures shared by server and consumers.
- `packages/sdk/src/types.ts` and `packages/sdk/src/index.ts` — public `CreateOptions.env` contract,
  parser re-export, and documentation.
- `packages/sdk/src/internal/blueprint.ts` and `.test.ts` — parse/lower into additive
  `runtime.userEnv` while composing with dotfiles.
- `packages/validators/src/workspaces/workspace-blueprint.ts` and tests — add strict
  `runtime.userEnv` while retaining legacy `runtime.env` compatibility.
- `apps/api/src/routes/workspaces/workspaces.module.ts` and tests — create/restart persistence and
  read-time parsing of the additive field plus pre-feature fixture compatibility.
- `packages/workspaces/src/runtime/runtime-adapter.ts`,
  `packages/workspaces/src/runtime/docker-runtime-adapter.ts`, and tests — a protected transient
  platform-environment launch field, explicit precedence, and platform-control defense in depth.
- `packages/workspaces/src/worker/process-workspace-build-job.ts` and tests — parsed job/restart
  propagation and separation of transient dotfiles auth from public `runtime.userEnv` and legacy
  `runtime.env`.
- `packages/workspaces/src/sealantd/target.e2e.ts` or `proof.e2e.ts` — real exec/PTY inheritance
  against the pinned daemon; `packages/sdk/src/smoke.live.test.ts` (or equivalent full-stack SDK
  suite) — public harness and reacquired-handle proof.
- `packages/sdk/README.md`, `packages/sdk/CHANGELOG.md` via Changesets, and a new `.changeset/*.md`.

No public HTTP endpoint, DB migration, daemon protocol, or generated client is required: create
already accepts a parsed blueprint, and clients derive from the Effect HTTP API.

### Mend

- `packages/domain/src/ids.ts`, `packages/domain/src/workbench/project.ts`, new
  `packages/domain/src/workbench/project-environment.ts`, and
  `packages/domain/src/workbench/index.ts` — constrained IDs, names, values, aggregate revision,
  launch manifest, typed mutation inputs, and exports.
- `packages/domain/src/workbench/session-run.ts` — safe revision/name manifest.
- `packages/db/src/schema/workbench.ts`, `packages/db/src/migrations.ts`, schema tests — variable
  rows, aggregate revision, SessionRun manifest columns.
- New `packages/db/src/repos/project-environment.ts`, `packages/db/src/index.ts`, and repository
  composition/tests — CRUD, coherent snapshot read, read-time parsing, typed corruption/conflict
  failures, and exports.
- `packages/api/src/contract.ts`, `packages/api/src/workbench.ts`, `packages/api/src/server.ts`, and
  API tests — authenticated typed CRUD contracts, group registration, and error mapping.
- `packages/sealant/src/client.ts` — consume the released SDK type through existing
  `createWorkspace`; no internal imports.
- `packages/sessions/src/engine.ts` and `packages/sessions/test/engine.test.ts` — resolve once at
  launch, pass to workspace creation, stamp `SessionRun`, and verify every lifecycle path.
- `apps/web/src/entry/main.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/lib/queries.ts`, and tests
  — repository layer composition, runtime-parsed project-environment responses/errors, and query
  ownership.
- New `apps/web/src/routes/projects.$projectId_.environment.tsx` plus focused form/reducer tests;
  update `apps/web/src/routes/projects.$projectId.tsx` to move the image editor and link to Project
  environment.
- Generated TanStack `routeTree.gen.ts` may change through generation; do not edit it manually.

### Sealantd

No source change is required for the recommended non-secret design: Core already launches Sealantd
with workspace-container environment, and managed descendants inherit the daemon's parsed child
base. Sealantd is a required compatibility/e2e test target, not a PR stack. Core currently bakes
`ghcr.io/sealant-sh/sealantd:0.9.0`
(`packages/workspaces/src/buildkit/buildkit-builder.ts:319-323`); run the inheritance matrix against
that exact image. If the proof exposes a daemon mismatch, stop the Core release and add a separate
Sealantd fix/release plus Core image-pin gate rather than papering over it in Mend. The
secret-capable alternative would require changes in `crates/sealant-runtime-core/src/redact.rs`,
`crates/sealant-process/src/runtime.rs`, `crates/sealant-pty/src/session.rs`, spawn wrappers, and
protocol/record projections.

## Pull-request stacks and release gates

### PR 1 — Core: public validated workspace environment

**Repository:** Sealant/Core  
**Depends on:** none.

- Add non-secret `CreateOptions.env`, a public reusable parser/policy, and lowering into additive
  caller-owned `runtime.userEnv`.
- Parse the new field strictly at every create/stored read while retaining unchanged legacy
  `runtime.env` parsing/semantics for pre-feature specs.
- Separate transient protected platform environment (including resolved dotfiles auth) from the
  caller blueprint map before enforcing reserved names; do not persist resolved tokens.
- Make precedence explicit and protect platform/credential keys from the new public map, while
  preserving/documenting legacy-field behavior.
- Document durability, non-secret-only use, inheritance, live-workspace immutability, and Docker
  non-injection.
- Add a Changeset for the fixed `@sealant/sdk`/`@sealant/api-contracts` group.

#### Acceptance and tests

- SDK lowering preserves env, omission, and dotfiles composition; SDK and server consume the same
  public policy fixtures.
- Valid/invalid/reserved/boundary/count/aggregate cases are table-tested; failures never include
  values. Duplicate-map detection is not claimed after object parsing.
- New raw `runtime.userEnv` input rejects invalid maps, while fixture specs created before the
  feature—including legacy `runtime.env` platform overrides—still parse/restart with their previous
  semantics. Mend/the fluent SDK never emit the legacy field.
- Resolved dotfiles credentials remain in a protected transient launch field, pass reserved-name
  validation, and never enter the persisted blueprint/job/attempt payload.
- Build-job parse, runtime adapter, workspace restart, and reacquired handle preserve the caller
  map.
- A release-gating job requires the Sealantd image instead of using the existing skip-if-absent
  behavior. Real Core runtime tests cover exec/PTY; a full-stack public SDK smoke test separately
  covers a harness run and a handle reacquired through `workspaces.get()`.
- Precedence tests prove public project values override image defaults but cannot override platform,
  Docker-routing, proxy, or connected-account keys; separate compatibility fixtures pin the legacy
  field's previous behavior.
- No environment value is added to run telemetry/command metadata.

**Release gate:** merge and publish/deploy the Core release before Mend consumes it. Because the SDK
and API contracts are fixed, both publish together; expect the next minor from 0.18.x (exact version
is Changesets-owned). The deployed control plane/worker must match the validating release, not only
the npm SDK. The e2e proof must pass against pinned Sealantd 0.9.0; otherwise a Sealantd release and
Core image-pin update become prerequisites.

### PR 2 — Mend: project environment domain, persistence, and API

**Repository:** Mend  
**Depends on:** conceptual contract from PR 1; can develop before publication without upgrading the
SDK.

- Add parsed domain values/aggregate and typed errors.
- Add variable/revision schema and safe `SessionRun` manifest migration.
- Implement transactional CRUD/coherent snapshot repository and pointer events.
- Add authenticated API contracts and runtime parsing at the browser boundary.

#### Acceptance and tests

- Create, empty-value edit, atomic rename, delete, duplicate, stale-write, not-found, limits, and
  all reserved rules pass through the real API interface.
- The unique DB constraint closes same-name races; project-row locking closes distinct-create
  count/aggregate races. Tests cover two concurrent creates at the final slot/byte boundary and an
  update racing a launch snapshot; the result is wholly before or wholly after, never mixed.
- Project deletion cascades variables.
- Every DB read reparses rows; malformed persisted data produces a typed failure.
- Values appear only in the dedicated settings response/storage, not project detail, events, logs,
  errors, `Session`, `SessionRun`, or process records.
- Integer row and aggregate revisions drive stale-write behavior; timestamps are display-only.
- SessionRun migration is backward compatible (`revision`/names nullable or explicit legacy state).

### PR 3 — Mend: launch and lifecycle propagation

**Repository:** Mend  
**Depends on:** PR 1 published/deployed and PR 2 merged.

- Pin the released `@sealant/sdk` version.
- Resolve one environment snapshot in `launchInternal`, pass it to `createWorkspace`, and stamp only
  revision/names on the new `SessionRun`.
- Keep all later process calls free of duplicated per-process maps; rely on workspace inheritance.

#### Acceptance and tests

- Mend's existing fake-engine tests assert the exact map is passed once to `createWorkspace`, later
  PTY/exec calls do not carry divergent copies, and `attachRun` records the explicit legacy/unknown
  manifest. They do not claim to prove daemon inheritance.
- Edit settings while live: new shell/Service restart still sees old workspace values.
- New session and settled-session resume see latest values and create distinct run manifests.
- Mend process restart/reattach does not change the workspace snapshot.
- Launch failure before PTY creates no fake run and leaks no value in summary/error/logs.
- A released-stack e2e (real Core plus pinned Sealantd) proves primary harness, shell, Service
  start/restart, setup, and deterministic exec/check inheritance across live edits/resume.
- With `services.docker` explicitly enabled, Docker Compose interpolation sees the workspace value;
  a nested test container does not receive it unless Compose/`docker run -e` explicitly passes it.

**Version gate:** update only Mend's catalog package pin after the Core package is published; follow
`Mend/AGENTS.md` and do not modify `pnpm-lock.yaml`. CI must run against a control plane/worker with
the matching validation semantics (`--lockfile=false` is the repository's deliberate install mode).

### PR 4 — Mend: project Environment UX

**Repository:** Mend  
**Depends on:** PR 2 API; may merge after PR 3 if feature flags are not used.

- Add the non-nested Project environment route, move only Workspace image there, add the
  Configuration panel, and leave a concise environment summary/link on project detail.
- Implement accessible CRUD/rename, plaintext/non-secret notice, lifecycle copy, and Docker boundary
  copy.
- Reuse existing section behavior without redesigning it, and keep ordinary configuration separate
  from future Secrets.

#### Acceptance and tests

- Loading, empty, read failure, validation, duplicate, stale conflict, pending, success, and delete
  confirmation states render distinctly.
- Draft survives server rejection; successful create/rename returns focus and announces status.
- Keyboard/touch interaction, labels, `aria-invalid`/descriptions, live regions, and non-hover-only
  actions are covered by pure form/reducer tests plus focused jsdom render/interaction tests using
  the existing Vitest/jsdom dependencies; do not assume a pre-existing component-test harness.
- No password field, reveal control, or copy suggesting secret support exists.
- Manual e2e: save a variable, start a session, read it in agent/shell/Service/check, edit it, prove
  the live workspace is unchanged, resume into a fresh workspace, and observe the new value.

Four PRs are natural. Do not create a Sealantd PR solely to reach five; its broader hardening
belongs to the deferred secret-capable work.

## Steps

- [ ] Land Core public capability, shared new-input validation, stored-spec compatibility, docs,
      tests, and Changeset.
- [ ] Publish/deploy the compatible Core package/control-plane/worker release.
- [ ] Land Mend domain/persistence/API resources and safe SessionRun manifest.
- [ ] Upgrade Mend's public SDK pin and wire launch-time workspace inheritance.
- [ ] Land the Project environment UX and end-to-end lifecycle copy/tests.

## Verification

For every implementation PR, run that repository's required format, typecheck, lint, and focused
test commands from its `AGENTS.md`. Before feature completion, run one cross-repository environment
matrix against the released Core stack and its pinned Sealantd image:

1. accepted, rejected, empty, multiline, max-size, and concurrent mutation cases;
2. initial launch, live attach, new shell, Service start/restart, setup, check, Mend restart,
   settled resume, and new session;
3. connected-account collision and every reserved-key class;
4. newly invalid create input plus restart/re-fetch of pre-release permissive stored specs;
5. Sealant workspace stop/restart/re-fetch behavior, with the pinned image required rather than
   skipped;
6. Docker Compose interpolation versus explicit nested-container pass-through with Docker service
   enabled;
7. storage/API/log/error/event/run-record inspection using a unique canary value to prove the
   platform does not automatically copy it into Mend manifests, logs, errors, process metadata, or
   execution-record fields. A test that deliberately places/prints the value in command argv/output
   must treat that resulting record as expected process evidence, not as an environment leak.

## Evidence index

- Mend domain/persistence: `packages/domain/src/workbench/{project,session-run}.ts`,
  `packages/db/src/{schema/workbench,migrations}.ts`,
  `packages/db/src/repos/{projects,settings, session-runs}.ts`.
- Mend launch/processes: `packages/sessions/src/engine.ts`, `packages/sealant/src/client.ts`,
  `packages/jobs/src/run-starter.ts`, `apps/cli/src/main.ts`.
- Core public/lowering: `packages/api-contracts/src`, `packages/sdk/src/{index,types}.ts`,
  `packages/sdk/src/internal/blueprint.ts`,
  `packages/validators/src/workspaces/workspace-blueprint.ts`,
  `packages/workspaces/src/{worker/process-workspace-build-job,runtime/docker-runtime-adapter}.ts`.
- Sealantd inheritance/security: `crates/sealantd/src/boot/{config,mod}.rs`,
  `crates/sealantd/src/runtime.rs`, `crates/sealant-process/src/runtime.rs`,
  `crates/sealant-pty/src/session.rs`, `crates/sealant-runtime-core/src/redact.rs`.
- Product/UX: `MEND-AGENT-WORKBENCH-PLAN.md:1203-1217`, `DESIGN.md`,
  `apps/web/src/routes/{settings,projects.$projectId}.tsx`.
