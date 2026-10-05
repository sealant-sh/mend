# pi and opencode as harnesses

- **Release:** 0.36
- **Status:** on main. Every PR below is merged.
- **PRs:** mend#456 (terminal sessions), mend#457 (the connected ChatGPT login), mend#460
  (`mend connect pi`), mend#503 (opencode: model, conversation identity, state dir, MCP logins),
  mend#505 (opencode's catalog rows, migration 0109), mend#504 (the phone reads "pi"); sealant#309
  (pi baked into every image); sealantd#127 and sealantd#136 (harness logins never captured, never
  restored). Open and related: mend#526 (one credential table, pi profile owner rule; on hold for
  the owner's per-person home decision).
- **Decision records:** none of its own. Bound by docs/adr/0002 (capture store), 0008 (one
  refresher; copies cannot refresh), 0010 (secret files; joins), 0013 (terminal sessions: only the
  owner types).
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`. Mend main pins sealantd `0.20.0-next.142` through Core `0.39.0-next.683`, which is
  sealantd `07ada50` (#136 included).

## Why it exists

Before 0.36 a Mend session ran Claude Code or Codex. opencode existed only as a bare command
(`opencode run`, one shot, the session ended with it) and pi not at all. People who use pi or
opencode on their own machine could not bring them into Mend without losing what Mend gives a
session: a recorded worktree, resume, review, steering from other devices.

Owner decisions: 2026-10-01, pi and opencode run on the ChatGPT subscription through the Codex login
already connected, not on a login of their own. ROADMAP 0.36 Must 6: a session on either, with its
agent home handled the same way as Claude's and Codex's.

What went wrong on the box after the first cut (preview 11, 2026-10-04, fixed by #503):

- Every opencode session started without `--model` failed its first prompt. opencode fell back to
  the first provider it saw, GitHub Copilot through the `GITHUB_TOKEN` Mend gives every workspace
  for git, and Copilot refused: `The requested model is not available for integrator "opencode"`.
- A stopped opencode session lost its conversation. In capture mode the harvest only looked for a
  transcript file, opencode keeps a SQLite database, and resume answered
  `Saved harness state is missing`.
- opencode's MCP logins rode the captured harness home to the next person in the worktree (review
  round 3, F4, P1 by the owner rule).

## What it does

- A person starts a pi or opencode session from the CLI (`mend pi ["prompt"]`,
  `mend opencode ["prompt"]`), the web composer, the desktop launcher or VS Code. Mend runs the
  tool's own TUI in a terminal session, in the session's worktree at `/workspace/repo`.
- pi opens with the prompt as its first message
  (`pi [--model <id>] [--thinking <level>] "<prompt>"`). opencode opens its TUI on `--prompt`
  (`opencode [--model <id>] --prompt "<prompt>"`).
- Neither asks permission per tool call by default. opencode gets
  `OPENCODE_PERMISSION={"*":"allow"}` in its environment, or `{"*":"ask"}` when the start asked for
  ask mode. pi has no per-tool prompts; Mend answers its project-trust question with `--approve`. pi
  ignores ask mode.
- Both run on the person's connected Codex (ChatGPT) login, written into each tool's own `auth.json`
  at every launch. No separate login is connected.
- `mend connect pi` sends the person's pi setup (extensions, themes, prompt templates,
  `settings.json`, `mcp.json`, keybindings) to the server. Every pi session that person starts
  receives it before pi starts. The CLI prints what goes and what stays, before it sends:

  ```
  pi profile · /home/alice/.pi/agent · 41 files · 1.2 MB
    extensions  3 · plan.ts, usage, review
    ...
    also        mcp.json (as it is, with any keys in it)
  pi       profile saved · revision 2 · new pi sessions receive it
  ```

  `--dry-run` sends nothing and prints `--dry-run: nothing sent`; `--remove` prints
  `pi: profile removed` or `pi: no profile saved`.

- A stopped session resumes on its own conversation: `pi --session <id>`, `opencode --session <id>`.
  When Mend cannot tell which opencode conversation is the session's, the resume is refused:
  `opencode left no conversation Mend can tell is session <id>'s; refusing to open another one.`
- When an opencode launch could not read what its database held before it started, the session line
  says so:
  `opencode · could not read its conversations before it started · this session's conversation may not be resumable`.
- Until the agent draws, the session line reads `pi is starting on the new machine` /
  `opencode is starting` (`agentStartingWords`).
- opencode's model: the catalog lists eight `openai/…` models with no default. With no model chosen,
  Mend sends no `--model` and records `model: null`; opencode then decides by its own order (its
  config, then the model it last used). The model-picker spec covers the pickers.
- The phone lists pi and opencode sessions with the harness named `pi` and `OpenCode`; it cannot
  start or steer them.

**Defaults and settings.**

- `MEND_SESSION_STORE=captured` (default): capture mode. `colocated` (deprecated) is the co-located
  store. Several behaviours below differ by mode; each section says which.
- No per-project or per-person switch turns either harness off.
- opencode's catalog has no default unless an operator flags a row `is_default` in `harness_models`;
  then that model is sent as `--model` when nobody chose one.

**In scope.**

- pi and opencode as PTY (terminal) sessions: launch, attach, stop, resume, follow-up to a stopped
  session, shell resume.
- The ChatGPT login copy for both.
- opencode's default model seed, its permission env, its state directory, its conversation identity
  (launch snapshot, harvest, resume by id), and keeping its MCP logins out of saved state.
- The pi profile: CLI scan and upload, storage, delivery, setup before pi starts.
- Harness names on the phone (#504).
- Both store modes: capture and co-located.

**Out of scope.**

- Protocol (conversation) mode for pi or opencode. `composeProtocolArgv` refuses them
  (`ProtocolHarnessUnsupportedError`); the phone, Slack and the t3 gateway cannot start or steer
  them; `SessionEngine.handoff` refuses them (`HandoffUnsupportedError`). An ACP adapter is a later
  release.
- A transcript or conversation view for opencode or pi in Mend. `extractTranscript` and
  `convertNativeSession` know only claude and codex.
- Resuming a pi or opencode conversation on another harness.
- Agent memory for pi and opencode (ADR 0009 is Claude and Codex).
- A shared effort scale for opencode (`HARNESS_EFFORTS.opencode = []`).
- A pi model catalog. pi has no `harness_models` rows; its model is its own (profile settings or
  `--model` typed on the CLI).
- Per-person harness homes inside a shared worktree (the owner's open "split home" decision).

## How it works

### Images and platform shape

1. Core bakes every harness into every workspace image
   (`Core packages/workspaces/src/harness/integrations.ts:89`, `bakedHarnessIds`). opencode is
   `npm install -g --allow-scripts=opencode-ai opencode-ai@latest`; pi is the latest GitHub release
   binary, checked against its `SHA256SUMS`, unpacked to `/opt/pi` (`PI_INSTALL_COMMAND`, line 23).
   Both float to the latest at image build.
2. Mend asks the platform for pi and opencode workspaces in the shell's shape: the `codex()` harness
   and the shell's credential ladder, `{claude, codex, github}` down to none
   (`packages/sessions/src/engine.ts:539` `platformShape`, cases at 577-579). The ladder degrades
   per provider, so a person with no Codex account still gets a workspace, without a ChatGPT login.

### Composing the launch

3. The API resolves model and effort against the catalog (`apps/api/src/session-start.ts:220`) and
   composes the argv (`packages/domain/src/workbench/harness-launch.ts:178` `composeLaunchArgv`,
   cases `opencode` 206, `pi` 214). pi's effort maps to `--thinking`; `ultra` clamps to `max`
   (`effortFor`, line 36). opencode's `ask` wraps the argv in `env OPENCODE_PERMISSION={"*":"ask"}`.
4. The engine adds permission defaults (`engine.ts:610` `withPermissionDefaults`): opencode gets
   `env OPENCODE_PERMISSION={"*":"allow"}` unless the argv is already an `env …`; pi gets
   `--approve` unless it names `--approve` or `--no-approve`.
5. The engine puts the argv behind the harness's seed (`packages/sessions/src/harness-seeds.ts:341`
   `withHarnessSetup`): `sh -c <seed> sh <argv…>`. Both launch sites pass
   `captured: capture !== null` (cold launch `engine.ts:11978-11982`, retained/join
   `engine.ts:12731-12735`).

### The seeds (`harness-seeds.ts`)

6. `CHATGPT_LOGIN_PROGRAM` (line 97) reads `~/.codex/auth.json` (the platform's injected copy, whose
   refresh token is `sealant-copy-cannot-refresh`, ADR 0008), decodes the access token's `exp`, and
   writes
   `{type:"oauth", access, refresh:"sealant-copy-cannot-refresh", expires: exp*1000, accountId}`
   under `openai` in opencode's `${XDG_DATA_HOME:-~/.local/share}/opencode/auth.json` or under
   `openai-codex` in pi's `${PI_CODING_AGENT_DIR:-~/.pi/agent}/auth.json`, mode 0600, by
   temp-and-rename. It writes only when the entry is absent or its refresh token is the placeholder
   (an earlier Mend copy). For pi it sets `defaultProvider: "openai-codex"` in `settings.json` only
   when none is set. No Codex login, an unparseable auth file, or a token without `exp`: it writes
   nothing and the tool still starts.
7. `OPENCODE_MODEL_PROGRAM` (line 124) writes
   `{recent:[{providerID:"openai", modelID:"gpt-6.1-sol"}]}` into
   `${XDG_STATE_HOME:-~/.local/state}/opencode/model.json` only when `auth.json` has an `openai`
   entry and `recent` is empty or missing. Other keys are kept; a file that is not a JSON object is
   left alone. `OPENCODE_DEFAULT_MODEL` is `harness-launch.ts:129`.
8. `OPENCODE_SEED` (line 177) is login, model, `OPENCODE_DISABLE_AUTOUPDATE=1`, `exec`.
   `OPENCODE_CAPTURED_SEED` (line 178) adds `OPENCODE_MCP_AUTH_SEED` (line 153) before the export:
   - a plain `mcp-auth.json` in opencode's data dir is removed unread (`rm -rf`);
   - `~/.mend/opencode` is made with umask 077 and resolved with `pwd -P`; if it is empty or under
     `/workspace`, the file is removed and the seed exits 1 with
     `mend: opencode's MCP logins cannot be kept out of saved state here; not starting opencode`;
   - otherwise `mcp-auth.json` becomes a link to `<resolved>/mcp-auth.json` (`ln -sfn`, then a
     `readlink` re-check so two launches racing both pass). opencode writes the file in place
     through the link, so the logins live in the executor's own home, outside every capture root.
9. `PI_SEED` (line 180) runs `PI_PROFILE_PROGRAM` first, then the login, then
   `PI_SKIP_VERSION_CHECK=1`, `exec`.

### Harness home (`packages/sessions/src/harness-state.ts`)

10. `HARNESS_STATE.opencode` (line 284): `homeDirs` and `paths` are `.local/share/opencode` and
    `.local/state/opencode`; no transcript file (`liveTranscript: null`);
    `stateFile: .local/share/opencode/opencode.db`. `HARNESS_STATE.pi` (line 292):
    `homeDirs: [".pi"]`, transcripts `.pi/agent/sessions/*/<time>_<uuid>.jsonl`, the uuid is the
    provider session id (`PI_SESSION`, line 232).
11. Before every launch, shells included, `relocateHarnessHomeScript` (line 423) moves each
    harness's `homeDirs` onto `/workspace/harness-home` and links `$HOME/<dir>` there
    (`engine.ts:9605` `relocateHarnessHome`). In capture mode it runs with
    `dropCapturedLogins: true`: a plain `harness-home/.local/share/opencode/mcp-auth.json` is
    removed unread, and a link there is removed unless it reads exactly
    `$HOME/.mend/opencode/mcp-auth.json` or its resolved form (`CAPTURED_LOGIN_FILES`, line 418;
    `dropLogins`, line 507). Before the relocation, `evictReservedSecretFiles` (`engine.ts:10153`)
    takes a secret file delivered under `.local/state/opencode` before that path was reserved out of
    the home: removed while it holds Mend's bytes on a plain path, else moved whole to
    `~/.mend/secret-files-set-aside/<stamp>/<path>`. A failure there fails the launch before the
    relocation (`secret_files_not_set_aside`).
12. Where the harness home lives:
    - **Capture mode.** The harness home is part of the worktree's capture (`harness/` in the
      workspace class). The next executor of the worktree, anyone's, materialises it. sealantd never
      captures and never restores the paths in its `HARNESS_CREDENTIALS`
      (`Sealantd crates/sealant-capture/src/index.rs:111`): for these two harnesses
      `.local/share/opencode/{auth.json,mcp-auth.json,repos,log}`,
      `.pi/agent/{auth.json,mcp-auth.json,oauth.json,mcp-oauth,mcp-oauth-encrypted,mcp.json,tmp,crashes.json}`,
      `.pi/agent/mend/profile/root/mcp.json` and `.mend/pi-profile-kept`, plus suffixed siblings of
      each file entry (`is_harness_excluded_path`, line 311).
    - **Co-located.** Each session has its own durable home on the host
      (`harnessHomePathOf(storePath, sessionId)`), mounted read-write into every workspace of that
      session. The harvest archive excludes Mend's own five-entry `HARNESS_HOME_CREDENTIALS` (line
      240), which includes both opencode files and pi's `auth.json`.

### The pi profile

13. CLI: `apps/cli/src/main.ts:2877` `connectPi`. `scanPiProfile` (`apps/cli/src/pi-profile.ts:186`)
    reads `$PI_CODING_AGENT_DIR` or `~/.pi/agent`, follows links, copies local packages
    `settings.json` names into `packages/<name>/` and rewrites the entry, and writes a
    `package.json` for a Home Manager style `node_modules` with none. Logins, sessions, installed
    packages and skills stay behind.
14. Validation (`packages/domain/src/workbench/pi-profile.ts`): only `settings.json`,
    `package.json`, `package-lock.json`, `root/mcp.json`, `root/keybindings.json` and files under
    `extensions/ themes/ prompts/ packages/`; relative POSIX paths, no `.`/`..`/empty segments; at
    most 4000 files, 8 MB per file, 16 MB total.
15. Server: `GET/PUT/DELETE /api/me/pi-profile` (`apps/api/src/routes/pi-profile.ts`), always the
    caller's own row. Table `user_pi_profiles` (migration 0097,
    `packages/db/src/migrations.ts:2718`): `user_id` primary key, `files jsonb` (plaintext, not
    sealed), `digest`, `bytes`, `revision`, removed with the account. A save of identical files
    changes nothing, revision included. The PUT is an upload route with its own request budget
    (`apps/api/src/request-budgets.ts:21`).
16. Delivery (`engine.ts:9824` `deliverPiProfile`), on the cold launch path only
    (`engine.ts:11892`), for `session.harness === "pi"` and the session owner's profile. The vacate
    program compares a tree digest of `.pi/agent/mend/profile` (skipping `node_modules`) with the
    profile's digest: equal, left alone; otherwise the directory is moved whole to
    `.mend/pi-profile-kept/<stamp>/` and the profile written. Co-located: host-side
    (`materializePiProfile`). Capture mode: through exec. Failure is logged; pi still starts.
17. `PI_PROFILE_PROGRAM` (`packages/sessions/src/pi-profile.ts`, after line 160) runs before pi
    whenever `.pi/agent/mend/profile` exists: installs extension dependencies with
    `--ignore-scripts` then `npm rebuild`, marks done installs in `node_modules/.mend-installed`;
    installs each `npm:` package `settings.json` declares into `.pi/agent/npm` and leaves out one
    that fails, saying
    `mend: pi package <spec> did not install, so this session runs without it: <reason>`; merges
    settings three-way against `mend/delivered-settings.json`; copies `root/mcp.json` and
    `root/keybindings.json` unless the session changed its copy. No step stops pi.

### opencode conversation identity (`packages/sessions/src/opencode-state.ts`)

18. **Reading.** `readOpencodeConversations` (line 37) writes the DB bytes and WAL into a temp dir,
    opens them with `node:sqlite`, requires `pragma quick_check = ok`, and lists `session` rows with
    `parent_id is null and directory = '/workspace/repo'`, newest `time_updated` first. Empty,
    corrupt, foreign or torn bytes read as null, never as an empty list.
    - Co-located: `readOpencodeHome` (line 95) reads plain files only; a WAL that is present but not
      a plain readable file makes the read null.
    - Capture mode: `capturedOpencode` (`engine.ts:440`) reads the head capture's
      `harness/.local/share/opencode/opencode.db` and `-wal`. A `torn` mark from sealantd on either
      is "torn"; a WAL that is not a file fails the read.
19. **Launch snapshot.** Before an opencode PTY process starts (not a shell, not protocol), the
    engine reads the conversation ids the database it is about to open already holds
    (`engine.ts:6877` `opencodeLaunchSnapshot`):
    - co-located: the session's durable home;
    - capture mode, fresh executor: the head capture it materialised;
    - capture mode, live executor (retained or a join): a `suspend` flush of that executor first,
      waited once for `CHECKPOINT_FLUSH_TIMEOUT` (20 s); the head is read only when the flush is
      caught up (`captureBehindReason` null, or health unreported by the SDK). Otherwise null. No
      database yet is `[]`; unreadable is null. The snapshot is written to
      `<processStateDir>/opencode-launch.json` after the process row exists (`engine.ts:12060`,
      `12804`). A null snapshot puts `OPENCODE_SNAPSHOT_MISSING` on the session line after
      `clearStaleStartSummary` (`engine.ts:12116`, `12853`).
20. **Attribution** (`opencodeConversationOf`, line 222), at harvest. The processes weighed
    (`engine.ts:6842` `opencodeConversationFor`): co-located, this session's own processes; capture
    mode, every opencode agent process of every session in the worktree. A process's candidates:
    - the conversation a resume named (`providerSessionId`), while the database still lists it;
    - every conversation not in its own launch snapshot, unless another process claims it, or any
      other process was running when this one launched, or a later process's snapshot lacks it (or
      that later process has no snapshot). Without a snapshot, only the named one. Of the
      candidates, the latest `time_updated`. Times are compared only among the database's own rows;
      no executor timestamp is compared with Mend's clock. Process start and end use Mend's clock
      (`createdAt`, `exitedAt`).
21. **Commit.** `commitConversationState` (`engine.ts:6926`) writes `manifest.json`
    `{harness:"opencode", providerSessionId, capturedAt}` in the process state dir and sets the id
    on the process and session rows. No transcript file is written.
22. **Classification at settle** (`engine.ts:7545` `classifyTranscript`, `7577` `tryHarvest`).
    - Capture mode (`harvestFromCaptureAlone`, `engine.ts:6971`): no database, or a database with no
      conversation, is absent (`hasTranscript = false`, hidden as a dead end). A process that named
      nothing and whose snapshot holds every listed conversation is absent too. Torn, does not open,
      or cannot be attributed is a `HarnessStateIOError` read as unknown: `hasTranscript` stays null
      and the session stays listed.
    - Co-located (`engine.ts:6679`): a failed attribution is `identify-session`; the session is
      classified by `hasLiveConversation` (`harness-state.ts:609`), true when the durable home's
      database lists any conversation.
23. **Resume** (`engine.ts:13031` `resumeSession`). `harnessStateFor` (`engine.ts:7698`) finds the
    newest committed manifest, else harvests from the live home. For opencode a
    `HarnessStateNotFoundError` becomes the refusal text above; a manifest with a null id is refused
    (`Saved opencode state has no native session id; refusing to start session <id> from scratch.`).
    `nativeResumeArgv` (`harness-state.ts:624`) turns `opencode` into `opencode --session <id>` and
    `pi` into `pi --session <id>`, unless the argv already names a session, continue, fork or
    (opencode) `--prompt`. Never `--continue`.
24. **Shell resume** of an opencode session treats every harness-state read error as no state
    (`engine.ts:13127-13136`) and opens the shell.

### Clients

25. CLI: `mend codex|claude|opencode|pi` (`apps/cli/src/help.ts:163`), completions,
    `mend connect pi`. Web: `HARNESSES` in `apps/web/src/lib/session-launch.ts:15`, resume buttons
    `RESUME_HARNESSES` in `apps/web/src/routes/sessions.$sessionId.tsx:53`. Desktop:
    `apps/desktop/src/renderer/src/lib/app-settings.ts:4`. VS Code: harness pick at
    `apps/vscode/src/extension.ts:688-689`. Phone: `PROTOCOL_HARNESSES = ["claude","codex"]`
    (`apps/mobile/src/data/live.ts:163`) for starting; rows name the harness through `harnessName`
    (`apps/mobile/src/data/harness-name.ts`): `claude` → `Claude Code`, `codex` → `Codex`,
    `opencode` → `OpenCode`, anything else as its id. t3 gateway: `HARNESS_DRIVERS` is codex and
    claude only (`apps/t3-gateway/src/server-config.ts:36`).

### Concurrency, ordering, restart

- One harvest per agent at a time (`harvestLocks`, `engine.ts:6964`).
- The launch snapshot is read before the PTY opens and kept after the process row is created. A
  server restart between the two leaves the process with no snapshot: only a named conversation can
  be attributed to it.
- In capture mode, two opencode processes of one worktree that overlap (one running when the other
  launched) cannot attribute new conversations; both refuse rather than guess.
- The pi profile and the ChatGPT login are written at every launch; a running session keeps what it
  started with.

## Happy path

Capture mode, the box. Alice has connected Codex (`mend connect codex`).

1. On her laptop Alice runs `mend connect pi --dry-run`. The CLI prints her profile summary,
   including `also mcp.json (as it is, with any keys in it)`, and `--dry-run: nothing sent`. She
   runs `mend connect pi`; it prints `pi profile saved · revision 1 · new pi sessions receive it`.
2. In `~/src/api` she runs `mend pi "add a /health endpoint"`. The session line reads
   `pi is starting on the new machine`, then pi draws. In the terminal she sees
   `mend: installing what your pi extensions import`. pi runs on `openai-codex` (`pi auth check`
   would read `ready`), with her extensions loaded, and works on the prompt. Her pi `settings.json`
   already named a `defaultProvider`, so it is kept.
3. She detaches, and later presses Stop on the web. The session settles `stopped`. Its row has
   `providerSessionId` = the uuid of `.pi/agent/sessions/<dir>/<time>_<uuid>.jsonl`.
4. Next day she presses Resume → pi on the web. A new executor materialises the worktree's head;
   Mend runs `pi --session <uuid>`, and pi opens yesterday's conversation.
5. In the same project she starts opencode from the web composer with the model pill on "opencode's
   own choice" and the prompt "write tests for /health". Mend runs
   `sh -c <OPENCODE_CAPTURED_SEED> sh env OPENCODE_PERMISSION={"*":"allow"} opencode --prompt "write tests for /health"`.
   The session row's model is null. opencode opens on `openai/gpt-6.1-sol` (the seeded last-used
   model), signed in as OpenAI oauth.
6. Inside opencode she signs in to her Linear MCP server. The tokens go to
   `~/.mend/opencode/mcp-auth.json` in the executor's home, through the link.
7. She stops the session. The harvest reads `opencode.db` + WAL from the head capture, sees one new
   conversation `ses_9f…` not in the launch snapshot `[]`, and records it.
8. Bob, in the same organization, later starts a Claude session in that worktree. His executor
   materialises the head: no `mcp-auth.json`, no `auth.json` for opencode, no `.pi/agent/mcp.json`.
9. Alice resumes her opencode session: `opencode --session ses_9f…`. Her MCP server asks her to sign
   in again (the executor is new).

## Invariants

1. One person's provider login is never written into, restored into, or read from another person's
   fresh executor through a capture: no capture holds a path in sealantd's `HARNESS_CREDENTIALS`,
   and no restore writes one (sealantd #136, pinned in Mend main).
2. In capture mode, after the relocation of any launch (any harness, shells included) and before the
   harness starts, `harness-home/.local/share/opencode/mcp-auth.json` is either absent or a link to
   `$HOME/.mend/opencode/mcp-auth.json` (or its resolved form).
3. In capture mode an opencode launch never starts unless its MCP logins file is a link into the
   executor's own home, outside `/workspace`.
4. Mend's ChatGPT copy never replaces a login entry whose refresh token is not
   `sealant-copy-cannot-refresh`.
5. Mend's ChatGPT copy always carries the placeholder refresh token: no copy can rotate the login
   the platform refreshes (ADR 0008).
6. pi's `defaultProvider` is set only when absent.
7. `model.json`'s `recent` is written only when it is empty or missing and opencode holds an
   `openai` login.
8. A resume of an opencode session opens a conversation by id or not at all. It is never
   `--continue`, never "the newest".
9. An opencode conversation is never attributed to a session when another process of the same
   database could have started it (running at launch, claimed, or missing from a later process's
   snapshot).
10. In capture mode, an opencode session is hidden as a dead end (`hasTranscript = false`) only when
    the database is missing, lists no conversation, or the session's own snapshot proves it started
    none.
11. A shell resume of an opencode session is never refused for harness-state reasons.
12. A pi profile is read, written and removed only by its owner. No route returns another account's
    profile.
13. A pi profile directory that is not exactly the one being delivered is moved aside whole, never
    deleted.
14. No step of `PI_PROFILE_PROGRAM` stops pi from starting.
15. Neither seed writes the person's opencode or pi config files other than `auth.json`,
    `model.json`, pi's `settings.json` (merge) and the profile-delivered `mcp.json` and
    `keybindings.json`; opencode's permission is set in the environment only.
16. The phone never shows a harness that is not `opencode` as "OpenCode".
17. No step deletes work product: a secret file set aside, a profile moved aside and a session's
    worktree are moved or left, never removed (the only removals are Mend's own bytes on a plain
    path and captured credential files).

## Edge cases and failure behaviour

**Logins**

- No Codex account connected: the ladder gives the workspace no Codex login, the login program
  writes nothing, and pi or opencode starts without a ChatGPT login. opencode's model seed also
  writes nothing (no `openai` entry), so opencode falls back to its first provider: Copilot via
  `GITHUB_TOKEN`, which refuses. Nothing in Mend says so before the first prompt.
- A `/login` made inside the session is kept for that executor. In capture mode `auth.json` is never
  captured, so the next executor starts on Mend's copy again.
- The access token expires (about 10 days) in a long-running session: the copy is not refreshed
  until the next launch or resume.
- Claude subscription logins cannot be used in pi or opencode (Anthropic forbids it); an Anthropic
  API key can (docs `concepts/provider-logins.md`).

**Joins and shared executors (capture mode)**

- Bob's session joins Alice's live executor (the worktree is leased to her session): his pi or
  opencode runs in her home, on the ChatGPT login her executor holds, beside her MCP logins in
  `~/.mend/opencode/mcp-auth.json`. Accepted posture (ADR 0010, ADR 0013 open question 2; known
  issues: "People joined on one workspace share that file").
- A `/login` Bob makes in opencode inside Alice's executor is a non-placeholder entry, so Alice's
  later opencode launches in that executor keep using it (invariant 4 protects it).
- Two opencode launches into one executor at once: both end with the same link and both start.

**opencode identity**

- Two opencode sessions overlap in one worktree (capture mode): new conversations of the later one
  are refused attribution; resume says Mend cannot tell. Both sessions stay listed.
- Co-located: only the session's own processes are weighed; two sessions never block each other.
- The launch snapshot read fails or the flush does not catch up in 20 s: the launch goes ahead, the
  session line says `may not be resumable`, and a later resume is refused unless a resume had named
  the conversation.
- The snapshot was read but writing `opencode-launch.json` failed: logged only
  (`opencode launch snapshot not kept`); see Divergences.
- A never-prompted opencode session: opencode creates a `session` row only on the first prompt. If
  the snapshot covers every listed conversation, the session is absent (hidden); if there was no
  snapshot, it is unknown (listed, resume refused).
- A resumed session that opened a new conversation inside opencode and worked in it last is recorded
  on the new one at its next Stop.
- A resume that names a conversation the database no longer lists: the named id is not a candidate;
  another may be chosen by the snapshot rules.
- Torn database or WAL in the capture: unknown, listed, resume refused.
- The WAL is a link or unreadable: the read fails rather than read the database without it.
- A follow-up to a stopped opencode or pi session runs the harness on a prompt (`promptArgv`,
  `engine.ts:488`), which opens a new conversation, not `--session`. The previous conversation stays
  in the database.

**pi**

- No profile saved: nothing is delivered; whatever `.pi/agent/mend/profile` the harness home already
  holds is still set up by `PI_PROFILE_PROGRAM`.
- A package that needs native build tools (`@plannotator/pi-extension`: `not found: make`) is left
  out of that session and retried at every launch.
- `settings.json` unreadable: profile settings are not applied; the terminal says so.
- The person changed `mcp.json` in the session: the profile does not replace it; the terminal says
  so.
- A pi session without a transcript file at Stop. Capture mode: the harvest finds none, the session
  reads absent (hidden), and a resume fails `Saved harness state is missing for session <id>.`
  Co-located: the archive is committed with `providerSessionId: null`, and a resume starts pi fresh,
  without `--session`: pi is not in the "refusing to start session … from scratch" check
  (`engine.ts:13169-13180`).

**Restarts**

- Mend server restart mid-launch: the snapshot is read again on the next launch; a process row
  created without its snapshot file attributes only a named conversation.
- Executor lost before Stop: the capture-mode harvest reads the last head; co-located reads the
  durable home.

**Older data**

- A capture made before sealantd#136 holding `mcp-auth.json`, opencode's or pi's `auth.json`:
  sealantd no longer restores those paths; Mend's relocation removes a plain `mcp-auth.json` or a
  foreign link before anything starts.
- A secret file delivered under `.local/state/opencode` before 0.36: evicted before the relocation
  (see step 11).
- Hot standbys from before #456 (layout v1) are not reused.

**Permissions**

- Owner: everything.
- Member steering with shared control: watches the terminal read-only; cannot start the agent in the
  terminal (`terminal_owner_only`), cannot hand off to a conversation (pi and opencode have none).
- Operator: no access to organization content.

**Clients**

- CLI, web, desktop, VS Code: start, attach, resume.
- Phone, Slack, t3 gateway: cannot start or steer either. The phone lists them by name.

## Known limits

- Terminal only; no conversation mode, no transcript view, no cross-harness resume
  (`reference/known-issues.md`, "opencode runs in the terminal only", "pi runs in the terminal
  only").
- opencode's database holds the opencode console and integration logins a person makes inside it
  (`account`, `control_account`, `credential` tables). In capture mode it is saved with the session
  and the next session in the worktree opens it. Mend's own logins never go there. Known issues:
  "Sign in to the console or integrations only in a worktree nobody else uses."
  PLATFORM-FEEDBACK.md. Owner decision open.
- An MCP sign-in in opencode lasts one executor in capture mode.
- An opencode started by hand in a shell, a service or a `mend run` is not seeded: its MCP logins
  are written as a plain file; sealantd#136 keeps it out of captures.
- pi native packages need build tools; retried at every launch.
- Each new pi executor installs its packages again (about a minute the first time).
- The pi profile is one per person, the same in every project.
- Both tools float to their latest release at image build; Mend's readers are verified against
  opencode 1.18.34 (database schema, `model.json`, `writeJson` writing in place) and pi 1.0.x.
- opencode has no effort scale.

## How to verify

**Tests.**

- `packages/sessions/src/harness-seeds.test.ts`: ChatGPT login for pi and opencode (lines 286-372),
  opencode's model (374-432), MCP seed (480-556).
- `packages/sessions/src/opencode-state.test.ts`: reading with and without WAL, empty/corrupt/
  foreign databases, links, attribution cases, launch snapshot, unreadable WAL.
- `packages/sessions/src/harness-state.test.ts`: `--session` resume, `hasLiveConversation`,
  co-located archive keeps no login, a login an older capture brought.
- `packages/sessions/src/pi-profile.test.ts`: delivery and setup.
- `packages/sessions/src/secret-files.test.ts`: eviction of reserved paths.
- `packages/sessions/test/engine.test.ts`: pi profile delivered only to pi (3183); co-located
  opencode launch (4168); capture-mode opencode cases (8071-8320: commit and pickup by id, refusal,
  unattributed stays unclassified, provable absence); refusal on an unreadable secret record
  (21280).
- `apps/api/src/session-start.test.ts:320`: opencode gets no model nobody chose.
- `apps/mobile/src/data/harness-name.test.ts`.
- sealantd `crates/sealant-capture/tests/round_trip.rs`: credentials never captured, a legacy
  capture's credential never restored.
- Not covered: two real sessions stopped and resumed through a deployed server; the retained-
  executor flush before a snapshot; a join running pi or opencode; pi profile in a join.

**By hand on the box.**

```sh
mend connect pi --dry-run
mend pi "say hello" -d && mend sessions
mend opencode "list the files" -d
mend stop <id>; mend resume <id>          # opencode --session <id>
mend shell <id>                       # while it runs: a shell in its executor
ls -l ~/.local/share/opencode/mcp-auth.json   # -> /root/.mend/opencode/mcp-auth.json
node -p 'Object.keys(require(process.env.HOME + "/.local/share/opencode/auth.json"))'   # [ 'openai' ]
```

**Signals.**

- Session line: `opencode · could not read its conversations before it started · …`.
- Logs: `session engine: opencode launch snapshot not read`, `… not kept`,
  `session engine: the pi profile was not delivered`,
  `session engine: harness-state harvest failed`,
  `session engine: harness state observed at capture`.
- Terminal:
  `mend: opencode's MCP logins cannot be kept out of saved state here; not starting opencode`,
  `mend: pi package … did not install …`.

## Divergences found while writing

- `packages/sessions/src/engine.ts:12590` (`launchInRetainedWorkspace`): no `deliverPiProfile` call.
  A pi session resumed or followed up in a retained executor, or joining another person's executor,
  runs `PI_PROFILE_PROGRAM` over whatever profile the home already holds; in a join that is the
  holder's (extensions, settings, and `root/mcp.json` with any keys in it, live in that executor).
  Owner rule: one person's credentials are not spent by another. mend#526 (open, on hold) refuses
  `PI_PROFILE_IN_USE` and undoes foreign deliveries.
- `packages/sessions/src/engine.ts:9829`: a pi session whose owner has no profile returns early, so
  a profile another person delivered that the head capture restored (everything but `root/mcp.json`)
  stays at `.pi/agent/mend/profile` and is set up for this person's pi.
- `packages/sessions/src/engine.ts:9844` with sealantd `index.rs` excluding
  `.pi/agent/mend/profile/root/mcp.json`: a profile restored without `root/mcp.json` no longer
  matches its digest, so every fresh executor moves the owner's own profile aside (with its
  `node_modules`) and reinstalls. Cost, not loss. mend#526 makes the comparison skip that file.
- `packages/sessions/src/engine.ts:11265-11300` (join branch of `launchInternalBody`) with
  `engine.ts:13236`: a resume that does not retain the session's own executor and joins a lease
  holder passes the bare `["opencode"]` / `["pi"]` / `["claude"]` argv; `nativeResumeArgv` is
  applied only at `13236` (retained) and `11757` (cold, after the join branch has returned). The
  process row names the conversation but the harness opens a new one; for opencode the harvest then
  picks the newest candidate, for claude/codex/pi the named transcript.
- `packages/sessions/src/engine.ts:12060-12069` and `12804-12813`: a snapshot that was read but not
  written to `opencode-launch.json` is only logged. The session line does not say "may not be
  resumable", though attribution will treat the process as having no snapshot.
- `packages/sessions/src/harness-seeds.ts:153-161`: the MCP seed uses `${XDG_DATA_HOME:-…}` while
  the relocation's `CAPTURED_LOGIN_FILES` (`harness-state.ts:421`), `HARNESS_STATE.opencode` and
  sealantd's exclusion use the fixed `.local/share/opencode`. If the workspace's environment sets
  `XDG_DATA_HOME` (or `XDG_STATE_HOME`), opencode's data and `opencode.db` leave the relocated,
  captured directory; attribution and resume then see no database. Not handled or documented;
  unclear whether it should be.
- `apps/docs/src/content/docs/reference/known-issues.md:148`: "A session's harness home is its own"
  is true only co-located; in capture mode the harness home is the worktree's.
- `apps/docs/src/content/docs/reference/known-issues.md:123-128`: still says an opencode started by
  hand writes the file "into saved state until the platform leaves it out too (sealantd#136)"; Mend
  main now pins a sealantd with #136.
- `apps/web/src/lib/api.ts:684` `continueArgv`: unused, says opencode continues with `opencode run`,
  and says it is "the same table the CLI's mend continue uses"; the CLI's `CONTINUE_COMMANDS`
  (`apps/cli/src/shared.ts:22`) uses `opencode --prompt` and has pi.
- `packages/sessions/src/harness-state.ts:240` `HARNESS_HOME_CREDENTIALS` (5 paths) and sealantd's
  `HARNESS_CREDENTIALS` (27 paths) differ. In capture mode only sealantd's list keeps credentials
  out of saved state; Mend's list drives the co-located archive and the mode keeper. mend#526 joins
  them.
- `packages/db/src/migrations.ts:2718`: `user_pi_profiles.files` holds `root/mcp.json` in plaintext
  jsonb, unlike secret files, which are sealed. The CLI warns ("with any keys in it"); whether it
  should be sealed is not decided anywhere.
