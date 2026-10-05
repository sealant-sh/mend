# Per-person harness homes: every process runs entirely as one person

Status: accepted 2026-10-05, for 0.36; revised the same day after an adversarial design review (7
P1, 9 P2, 12 P3), which found the storage half sound and the identity half not. Amends
[ADR 0003](0003-organizations-and-tenancy.md) (a session runs as its owner),
[ADR 0009](0009-agent-memory-per-person-per-project.md) (memory in capture mode, and whose memory a
steered turn writes), [ADR 0010](0010-secret-files.md) (where secret files go) and
[ADR 0013](0013-whoever-sends-a-turn-pays.md) (the steering switch becomes a process per payer and
ships in 0.36). Read against Mend `c9b645b0b` with mend#526 (`ac3bdce06`) open, Sealant Core
`bc9ec42` (SDK 0.38.1) with sealant#315 and sealant#316 open, and sealantd `07ada50`.

## Context

In capture mode (ADR 0002) a worktree has one live executor, a container whose processes run as root
with `HOME=/root`, and every session in the worktree runs in it: a join, a sibling shell and a
resume are processes in the lease holder's executor. sealantd saves `/workspace/harness-home` as the
capture's `harness/` section, less the paths in `HARNESS_CREDENTIALS` and `HARNESS_MACHINE_STATE`
(sealantd#136). It does not save `/root`. Mend's relocation (`relocateHarnessHomeScript`) links
`~/.claude`, `~/.codex`, `~/.pi`, `~/.local/share/opencode` and `~/.local/state/opencode` into that
home, so they are saved, and restored for whoever comes next.

Everything else that says who a process is belongs to the person whose launch made the executor:

- Core injects that person's Claude and Codex logins at `$HOME` and their GitHub token as
  `GITHUB_TOKEN`/`GH_TOKEN` for the whole container, at create;
- sealantd applies that person's dotfiles to `/root`, `.gitconfig`, `.ssh` and `.netrc` included;
- `applyGitAuthor` sets `git config --system user.name/email` to them;
- the SSH transport shim (`/run/mend/bin/mend-git-ssh`, `core.sshCommand` system-wide) and the
  `mend` helper authenticate with `MEND_SESSION_ID`/`MEND_SESSION_TOKEN` in the container's
  environment, issued for that launch's session; the server signs git over SSH as its owner, with
  their Mend key or their laptop's agent through the bridge;
- their secret files are written into `/root`.

Over the week of 2026-09-28 the shared harness home caused one class of bugs: credential files
restored for the next person (sealantd#136, mend#526); one person's pi profile in the next person's
pi (mend#526 refused the second pi, which the owner rejected, because two people must be able to
work in one worktree at once); memory credited to the wrong person (mend#528, six review rounds);
Codex building one person's memory from other people's conversations; opencode's database holding
in-app logins beside the conversations it resumes. And every joiner, and every steerer's turn, ran
on the launcher's or the owner's identity.

### What each harness reads

Checked 2026-10-05 in an unprivileged container with no network and a fake model, at the versions
the images install (Claude Code 2.1.289, Codex 0.160.0, opencode 1.18.34, pi 1.0.2). With `HOME` set
per person, every harness keeps all of its state under it, and every tool call inherits it. Claude
still writes task output and sockets to `/tmp/claude-<uid>` unless `CLAUDE_CODE_TMPDIR` is set;
Codex's daemon socket is per `CODEX_HOME`, and Mend runs Codex without the daemon (#527). What a
per-person `HOME` breaks, and the fix:

- pnpm's store (`ERR_PNPM_UNEXPECTED_STORE` in a `node_modules` another person installed): pinned;
- tools installed under `/root` that resolve `$HOME` at run time (rustup, cargo, bun, nvm, pyenv):
  pinned to their `/root` locations; literal `PATH` entries keep working;
- OpenSSH reads `~/.ssh` from the passwd entry, not `$HOME`: a wrapper (decision 4);
- dotfiles and Mend's shell profile, written to `/root` today: written into each person's home.

## Decision

**Every process runs entirely as one person.** A conversation is shared data that different people's
processes may continue. "Entirely" means that person's home, logins, MCP servers and their tokens,
settings, memory, secret files, dotfiles, git identity (author, committer, signing key, global
config, credentials), SSH keys, and the Mend identity the SSH shim and the `mend` helper present.
Nothing a process can find without being pointed at it on purpose is another person's.

The owner decided 2026-10-05 that separate POSIX users per person are not part of 0.36. Everyone
still runs as root in one container, so a process can read any other person's files on purpose
(decision 13). The principle is about what a process uses, by default and by every path Mend
controls, not about what root can read.

### 1. Who each process runs as

| Process                                                                                | Runs as                                                                          |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| An agent Mend starts (cold, claimed standby, join, resume, follow-up, retained run)    | the person whose turn it runs: the session owner, or a steerer (decision 6)      |
| A shell, a terminal attach                                                             | the person who opened it                                                         |
| A Service                                                                              | the person who started it; a `mend.toml` service started at launch, the launcher |
| Dependency install and setup commands                                                  | the launcher (they are the launch's work)                                        |
| A VS Code Remote-SSH connection opened through Mend                                    | the person who opened it (decision 10)                                           |
| Anything else: `docker exec`, an image's own setup, a connection without Mend's config | the launcher, the executor's defined default (decision 10)                       |

The person a process runs as is recorded on the process when it starts, never inferred later.

### 2. Three places per person

- **The person's home**, `/root/.mend/homes/<account id>` (written `R` below), the process's `HOME`.
  Outside every capture root, gone when the executor ends. Logins, settings, caches, dotfiles,
  secret files, Codex's databases, pi's installed packages.
- **The person's saved directory**, `/workspace/harness-home/people/<account id>` (`P`). Inside the
  harness home, so saved with every capture and restored into every executor of the worktree.
  Conversations and memory only: Claude `projects/`, Codex `sessions/` and `memories/`, pi
  `sessions/`, opencode's data directory, Mend's per-person records (`.mend/`). Each is a real
  directory in `P`, reached from `R` through a directory link: sealantd stores a link as a link and
  never follows it, so the bytes sit on the saved side.
- **The executor's shared parts**, `/root`: the image's own files and executor-wide caches. In the
  person layout Mend and Core write nothing personal into `/root` except the launcher links of
  decision 10.

`R` is seeded by one `sh` per person per executor, folded into the launch's existing file exec
(#513): its links into `P`; a link to each entry the image put in `/root` (top level, and one level
under `.config` and `.local/share`), except personal names (harness directories, `.ssh`, `.gnupg`,
`.gitconfig`, `.git-credentials`, `.netrc`, `.aws`, `.kube`, `.docker`, `.npmrc`, `.config/gh`,
`.config/git`, `.mend`) and except anything leading into `/root/.mend`; then the person's dotfiles,
shell profile and secret files, which win over a link. A link into `P` that cannot be made fails the
launch, so no conversation is ever written only to `R`.

### 3. The environment

Every process Mend starts gets, through `SessionOptions.env` (paths, never secrets):

- `HOME=R`, `CLAUDE_CODE_TMPDIR=R/.t` (short for `AF_UNIX`);
- the pins, resolved once in `prepareExecutor` from the image and set only when the path exists:
  `npm_config_store_dir`, `npm_config_cache`, `COREPACK_HOME`, `RUSTUP_HOME`, `CARGO_HOME`,
  `BUN_INSTALL`, `NVM_DIR`, `PYENV_ROOT`, `GOMODCACHE`, `UV_CACHE_DIR`, `PIP_CACHE_DIR`. They hold
  packages and caches, never credentials, and stay shared so a second person's install is a cache
  hit;
- `MEND_SESSION_ID` and `MEND_SESSION_TOKEN_FILE` (decision 4);
- `PATH` with `/run/mend/bin` first (the `ssh` wrapper).

Dependency install and setup run through the platform's exec as `env HOME=R_launcher … sh -c …`. The
container's own environment holds no person's identity: no `GITHUB_TOKEN`, `GH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, or `MEND_SESSION_TOKEN` usable for git or the helper.

### 4. Git, SSH and the Mend identity per process

- **The Mend identity.** Each (launch, person) gets its own session-channel token, written 0600 to
  `R/.mend/session-token` and named by `MEND_SESSION_TOKEN_FILE`; `MEND_SESSION_ID` names the
  session the process belongs to. The shim and the helper read them from there, and default to
  `$HOME/.mend/session-token` when the variable is unset (decision 10). The container-wide token
  stays for sealantd's capture channel only, and the server refuses it on `/git/transport` and on
  every helper route.
- **Git over SSH** to origin goes through the shim as today, and the server signs as the token's
  person, with their Mend key or their bridge. A steerer's process pushes as the steerer.
- **The helper** (`mend land`, `repo add`, `runService`, `runServiceRecipe`) authorises the token's
  person under the same rules as that person's API calls: only the change's owner lands (ADR 0007),
  only the owner runs a command in a terminal session (ADR 0013).
- **Git over HTTPS to GitHub** uses Mend's own credential helper,
  `/run/mend/bin/mend-git-credential` (system config for `https://github.com`), which reads
  `$HOME/.config/gh/hosts.yml`, the file Core writes (decision 5). No `gh` needed in the image, so
  custom images work too.
- **Git author and config.** `git config --system user.*` is no longer written. Mend writes the
  person's git author to `R/.config/git/config`; the person's dotfiles' `.gitconfig`, if any, is
  `R/.gitconfig` and wins, as global config wins over Mend's today. Signing keys, credential helpers
  and `includeIf` in it are the person's. `GNUPGHOME` defaults to `R/.gnupg`.
- **SSH to other hosts.** `/run/mend/bin/ssh` runs `/usr/bin/ssh -F "$HOME/.ssh/config"` with
  `UserKnownHostsFile`, `IdentityFile` for each key in `$HOME/.ssh` and `IdentitiesOnly=yes`. `scp`,
  `sftp` and `rsync` reach it through `PATH` (`rsync -e ssh`, `scp -S ssh`). `/root/.ssh` holds
  nothing personal, so a tool that calls `/usr/bin/ssh` by its path finds no key: never someone
  else's (Known limits).
- **`.netrc`, `.git-credentials`, `.aws`, `.kube`, `.npmrc`, `.docker`, gcloud** are read through
  `$HOME` and are the person's. The five-path variable table of the first draft is gone.

### 5. Logins: one Core primitive, a home for each person

**No person ever runs on anyone else's login.** One Core call puts a given person's logins into a
given home of a running workspace and keeps them refreshed; a home holds one person for its whole
life.

```
POST   /v1/workspaces/:id/credentials   { onBehalfOf, home, claude?, codex?, github? }
DELETE /v1/workspaces/:id/credentials   { home }
GET    /v1/workspaces/:id/credentials   → the homes, each with its person and accounts
workspaces.create({ …, credentialsHome })
```

- **Built on sealant#315 and sealant#316.** #315 has the parts: resolution as at create, a copy
  without a refresh token, the write over the control connection, a record the refresh push follows,
  the spec left alone, service-key authorisation. Its switch semantics go: a home is never switched
  to another person, so `restorePrevious`, the compare-and-set per switch and the unknown state
  after a failed write are not needed. It gains:
  - `home` (absolute, outside `/workspace`, no `..`, no link on the way, checked by the write);
  - the record per instance and home: one person, one account per provider, for the home's life. A
    POST naming another person for a held home is refused (409 `home-held`); a POST for the same
    person and accounts is idempotent; changing an account means DELETE and POST with the home's
    processes stopped;
  - GitHub as a provider, written as `<home>/.config/gh/hosts.yml`;
  - a provider not named is not written; nothing else is ever in a home;
  - pushes, POST and DELETE for one (instance, home) under one row lock, re-read before each write.

  #316 is needed as it is: a setup token in `CLAUDE_CODE_OAUTH_TOKEN` is one value for every process
  in the container.

- **New in Core:** `credentialsHome` on create writes the launch's logins there and sets no login in
  the environment; `DELETE`; `GET` for reconciliation.
- **Authorisation.** Under #315 a service key acting for the workspace's owner may write any
  `onBehalfOf` person's login into it. Mend is therefore what enforces "a login only for that
  person's own processes": Mend posts a person's login only into that person's `R`, only when a
  process of theirs is about to start there.
- **How Mend uses it:**
  - A cold launch or claimed standby (pools are per owner, ADR 0003) names `R_launcher` in
    `credentialsHome`. No extra call on the cold path.
  - Any other person gets one POST when their first process in the executor is about to start, in
    parallel with their layout and deliveries; the process start waits for both.
  - A session that needs a provider the person has not connected, or whose login is `invalid`, is
    refused before anything of theirs is written: "Connect Claude to start a session here." A shell
    starts without.
  - When a person's last process in an executor ends, Mend releases their home (DELETE) and removes
    the copies Mend's ChatGPT-login program made for pi and opencode. At startup and every ten
    minutes Mend compares `GET` with its live processes and releases homes nobody holds.
  - An authentication failure in a person's process makes Mend POST that person's login once more,
    which writes Core's current copy.

### 6. Steering: a process per payer

Shared control lets B send turns to A's conversation. B's turn runs in a process started as B, with
B's full home, continuing A's conversation. There is no login swap inside a running process and no
switch back.

- **What B's turn uses:** B's login, B's settings, B's MCP servers and their tokens, B's memory,
  skills, secret files, git identity and Mend identity, with A's conversation history as its
  context. It writes into A's conversation and into B's memory. The model is the conversation's.
- **The conversation stays where it is.** It lives in its owner's `P`. B's process reaches it
  through links Mend makes in `P_B` at that process's start, to the exact files of that conversation
  by provider session id (Claude `projects/-workspace-repo/<id>.jsonl` and `<id>/`; the Codex
  rollout at its dated path), and removes when the process ends. Claude resumes with
  `--resume <id>`, which continues the same file; Codex with `thread/resume` naming the rollout's
  `path`. Verified per harness before the steering PR merges; a harness that writes elsewhere has
  that file moved into the owner's `P` when the process ends.
- **A payer change restarts the agent, at a quiescent point.** When the next queued turn's sender is
  not the person the conversation's process runs as, dispatch waits until that process has no open
  turn and no running background task (background agents, commands and workflows, which Mend already
  tracks). Then it stops the process, starts one as the sender, resumes, and sends the turn.
  - While it waits, the turn shows "Waits for Alice's 2 background tasks to finish before Bob's turn
    starts." Mend never stops background work to make way: the person the process runs as, or the
    session owner, may stop the tasks; the sender may withdraw the turn. No timeout kills them.
  - So A's background work only ever runs in A's process on A's login, and B's in B's. A background
    task that opens a turn of its own opens it in the process that runs it, paid by that process's
    person.
  - A resume that fails (the file is missing, Codex answers "not found") fails the turn and leaves
    no process on a new conversation. This path never falls back to `thread/start` or a new Claude
    session.
  - "Accept for session" approvals end with the process; the next process asks again.
- **The payer of every turn is the person its process runs as,** recorded from the process record:
  turns from a sender, turns a harness opens itself, and turns Mend starts (a keep-alive, a landing
  follow-up), which run in the owner's process.
- **Codex for a steerer starts with memory generation off** (`-c memories.generate_memories=false`,
  memory overrides in the argv dropped, mend#528's plumbing kept): it reads B's memory and
  summarises nothing, so Codex's startup job never spends B's login on A's conversations.
- **Terminal sessions** stay as ADR 0013 and mend#518 made them: only the owner types.
- **Refusals:** a steerer with no login for the provider is refused at submit, as ADR 0013 says. A
  login found invalid at dispatch fails the turn with the same words.
- **When shared control is turned off,** or the steerer is removed from the organization, their
  queued turns are cancelled with the reason, and a running turn of theirs finishes in their own
  process. Today neither path touches queued turns.
- **Automatic landing** (ADR 0007) follows the owner's own turns only. A steered turn's change lands
  when the owner lands it.
- **Slack** checks the sender's login, not the owner's (`credentialProblem` in the resume path).

### 7. Joins

A person who starts a session in a worktree where another person's session runs gets their own
processes in the same executor, every one of them theirs: home, logins, dotfiles, git and Mend
identity, pi profile, skills, memory, secret files, saved directory. Two people work live in one
worktree, on one change, each entirely as themselves. ADR 0010's "a joiner receives no secret files
of its own" and ADR 0009's "what a joined agent writes goes to the executor's owner" no longer hold.

### 8. What is saved per person, and what is never saved

| Saved in `P`, per person                                                                          | Never saved (in `R`)                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude `projects/` (transcripts, auto memory)                                                     | every login: Claude, Codex, GitHub, MCP tokens, pi and opencode `auth.json`, the Mend session token                             |
| Codex `sessions/` (rollouts), `memories/`                                                         | settings: Claude `settings.json` and `.claude.json`, Codex `config.toml`, pi `settings.json` and `models.json`, opencode config |
| pi `sessions/`                                                                                    | dotfiles, secret files, git config, SSH keys                                                                                    |
| opencode's data directory; its `auth.json` and `mcp-auth.json` are links into `R/.mend/opencode/` | Codex's databases and daemon state; pi's packages and `git/` clones; caches; temp                                               |
| Mend's per-person records (`.mend/`)                                                              | Claude `backups/`, `file-history/`, `shell-snapshots/`, `session-env/`, `ide/`                                                  |

- Settings are written in at launch (seeds, pi profile). One edited by hand inside an executor lasts
  until it ends. mend#526's "kept, with a reason" list is no longer saved.
- Codex's memory database is read back from the live executor at each Codex process's end, through
  `node:sqlite` `VACUUM INTO`. When the executor is gone first, the stored copy stands (ADR 0009
  Codex consequences).
- **The credential tables stay as a second layer.** sealantd applies `HARNESS_CREDENTIALS` and
  `HARNESS_MACHINE_STATE` under each `people/<id>/` as well as at the root. Mend's copy and the test
  that holds it to sealantd's stay.
- **One login is still saved: an in-app opencode login.** opencode keeps a console or integration
  login in the same database as the conversations resume needs. It is saved in that person's `P`,
  used by no one else's opencode, readable by anyone working in the worktree. **For the owner:**
  this breaks "logins are never saved" for that case. Recommended: accept it for 0.36 with a Known
  issue, and ask sealantd to scrub opencode's `account`, `control_account` and `credential` tables
  from captures (PLATFORM-FEEDBACK 2026-10-04). The alternative, refusing opencode in-app logins,
  has no mechanism today.

### 9. Memory per person (replaces mend#528's hand-over)

- **Delivery** (ADR 0009 decision 2) writes a person's memory into their own `R`, which links into
  `P`, at every process start of theirs.
- **Read-back** (decision 3) runs when a process ends, for the person it ran as, from
  `harness/people/<person>/` in the flushed head. A steerer's process credits the steerer: decision
  1's "a turn someone else steers writes the owner's memory" is amended.
- **Codex** builds memory only from rollouts in the person's own `sessions/`, so nothing is
  withheld: `withholdCodexThreadsExec` goes. A conversation linked in for a steered turn is gone
  from `P_B` when that process ends, and that process generated nothing (decision 6).
- **Carried conversations** (decision 8) go into the person's own `sessions/`, never one already
  there.
- **Goes:** the hand-over at launch, its forced capture, `.mend/agent-memory-owner`, new
  `agent_memory_homes` writes. The table stays for the migration until 0.37.

### 10. Processes Mend does not start

- **The defined default is the launcher.** In the person layout `/root`'s personal names are links
  into `R_launcher`: `.claude`, `.codex`, `.pi`, `.local/share/opencode`, `.local/state/opencode`,
  `.config/gh`, `.config/git`, `.gitconfig`, `.mend/session-token`. A `docker exec`, an image's own
  setup or anything else with `HOME=/root` therefore runs on the launcher's logins and identity, and
  its conversations are saved in the launcher's `P`. Not linked: `.ssh` and `.gnupg`, which tools
  find through the passwd entry whatever `HOME` says, so a person's own process could reach them by
  default.
- **VS Code Remote-SSH opened through Mend** (`mend` writes the SSH config,
  `packages/workspace-ssh`) sends the connecting person's `HOME`, `MEND_SESSION_ID`,
  `MEND_SESSION_TOKEN_FILE` and `PATH` with `SetEnv`, which Core's gateway passes to the session.
  Before connecting, Mend prepares that person's `R` (layout, login, deliveries) as for a shell. The
  extension host, its terminals and the Claude Code extension then run as that person, and their
  conversations are saved in their `P`. A connection without Mend's config is the launcher's.

### 11. Secret files and dotfiles per person (amends ADR 0010 decision 3)

- Each person's secret files go into their own `R`, at their path under `HOME`, joins included. The
  record of what was written (`~/.mend/secret-files`) is therefore per person. `.config/gh/`,
  `.config/git/` and `.mend/` are reserved, beside today's reserved paths.
- Each person's dotfiles (repository and snapshot, as resolved today) are unpacked into their `R` by
  exec, after the layout and before secret files. The person layout passes no dotfiles to create, so
  nothing personal lands in `/root`. Mend's default shell profile is written into `R` too.

### 12. Readers

Every reader goes by a prefix: `HARNESS_STATE`'s transcript patterns become `^people/<id>/…`;
`harvestFromCaptureAlone`, `hasLiveHarnessState`, `locateLiveTranscript`, `readHarnessFileScript`,
`CARRIED_TRANSCRIPTS` and the opencode reader take the session owner's directory for a conversation,
and the process's person for memory. Two sessions of one person in one worktree still share a
directory; pinning provider session ids at launch is a follow-up.

### 13. What the product says

While people share a workspace, each person, and their agents, can read the others' homes, logins
included, and a person's saved conversations and memory are restored into every executor of the
worktree. Nothing of anyone else's is used by default, and nobody's login is saved, but root is not
a boundary between people.

- **Where two people meet in a worktree,** in the product's words for it ("join a worktree" in the
  CLI, the composer's Worktree picker, the worktree's New session menu): "Anna's session is running
  in this worktree. You share its workspace: everything you run uses your own logins and settings,
  but either of you can read the other's files, logins included."
- **On a session while another person's process is live in its executor:** "Shared workspace with
  Anna · each of you runs as yourself · either of you can read the other's files."
- **Beside the Shared control switch,** replacing "using your provider logins and Git access": "Each
  turn runs as its sender, with their logins, settings and memory, continuing this conversation.
  When the sender changes, the agent restarts once its background tasks finish."
- The API's session view lists the people live in its executor, so every client draws the same line.
- Known issues: "People in one worktree can read each other's files".

### 14. Executors started before this release, and the migration

- **The layout is recorded per launch** (`harness_layout`: `person`, or null for launches before
  this release). Every delivery and reader goes by the executor's.
- **A pre-release executor retires at its first idle point.** At upgrade every `shared` executor is
  marked to retire. Its first moment with no open turn, no running background task, and no terminal
  or shell with an attached client or output in the last 15 minutes (the protocol idle stop's
  bound), Mend sends its final flush, relaunches the worktree in the person layout and resumes its
  conversations; terminal sessions end resumable. Until then, a join and a turn from anyone but its
  launcher are refused: "This worktree's workspace started before Mend 0.36 and shares one home; it
  takes another person once it is replaced, when nothing is running there." People who joined before
  the upgrade keep running there on the launcher's identity until it retires; the release notes say
  so, and how long it can last (until its terminals go quiet).
- **The migration of an old shared home is a server-side job per worktree,** off every launch path.
  It reads the head capture, as read-back does, and records completion in the database; it moves
  nothing and execs nothing. The old root paths are inert after the flip and stay in the capture
  until the worktree is removed.
  - **Memory** is read back into one person: the person a saved `agent_memory_homes` record names;
    else, when every session the worktree ever had was one person's, that person; else nobody, and
    the files stay in the old home, listed on the worktree as "memory from before 0.36, not
    credited" (claiming them is a later feature). A job that fails retries; no launch waits for it.
  - **Transcripts** of pre-release Claude, Codex and pi sessions are found at the old path by their
    exact provider session id, and copied into the session owner's `P` when the session resumes.
  - **opencode's old shared database** is never given whole to anyone. A pre-release opencode
    session resumes only for its owner, on a scrubbed copy: Mend copies the database into a scratch
    data directory in the owner's `R`, deletes every other session's rows and every row of
    `account`, `control_account` and `credential` with `node:sqlite`, checks that only that session
    remains and the three tables are empty, and only then opens it. A copy that fails the check is
    deleted and the resume is refused with the reason. The old database stays in the capture.

## Start-time impact

- **Cold launch:** no added Core call (`credentialsHome`). The layout, dotfiles and shell profile
  join the launch's file exec. Removed: mend#528's hand-over (a capture read, an `sh` exec and a
  forced capture), the Codex withholding exec, and the migration (now server-side).
- **Join:** one Core call, run in parallel with the joiner's layout and deliveries, which a join
  skips today. pi's package install is a cache hit after the first person in an executor (shared
  `npm_config_cache`).
- **Payer change:** one agent process stop and start, plus waiting for background tasks. No Core
  call when the sender already has a home there. Measured on the box for Claude and Codex before the
  flip, against the interactive bar.
- **Per person per executor:** Codex unpacks its `.system` skills; caches not in the pin list start
  cold; Codex's thread index (not saved) re-indexes the person's rollouts on its first open, to be
  measured.

## Known limits

- **Root reads everything.** People sharing a workspace can read each other's files, logins
  included, and everyone's saved conversations and memory for that worktree (decision 13).
- **SSH by absolute path.** A tool that runs `/usr/bin/ssh` itself (not through `PATH`) finds no
  key. Never someone else's.
- **No `GITHUB_TOKEN` in the environment.** A repository `.npmrc` with `${GITHUB_TOKEN}` (GitHub
  Packages) fails until the person exports `GITHUB_TOKEN=$(mend-git-credential token)` in their
  dotfiles. The settings copy "Gives `gh` inside every session a GH_TOKEN" changes with it.
- **Processes Mend does not start are the launcher's** (decision 10).
- **Pre-release executors** keep the shared home until they retire (decision 14).
- **opencode in-app logins are saved** (decision 8), pending the owner.
- **A payer change waits** for background tasks, and ends "accept for session" approvals.
- **Tools that resolve `$HOME` and are not pinned** find their `/root` install only through the
  image links of decision 2; a tool that writes state under `$HOME` keeps it per person.
- **A setting edited by hand** lasts until the executor ends.
- **pi's and opencode's copies of the ChatGPT login** are refreshed at each process start, not
  mid-process.
- **Two sessions of one person in one worktree** share a directory until provider session ids are
  pinned.

## Consequences

- Two people work live in one worktree, each entirely as themselves; a steerer's turn runs as the
  steerer, continuing the owner's conversation.
- Commits, pushes, pull requests, MCP calls, cloud CLIs and package publishes from a process are
  that process's person's.
- A steered turn costs a process restart when the payer changes, and may wait for background work.
- The capture holds one directory per person who worked in the worktree.

## Follow-ups

- **Separate POSIX users per person,** or an executor per person (ADR 0002's accepted relaxation):
  the step that makes people in one worktree unable to read each other.
- **Provider session ids pinned at launch** (Claude and pi `--session-id`).
- **Claiming uncredited memory** from before 0.36.
- **sealantd scrubbing opencode's login tables** from captures.
- **Restoring only the people live in an executor.**

## Delivery

Ordered; each is one pull request; sizes are lines changed, tests included. From 7 on, everything is
behind `MEND_HARNESS_LAYOUT=person` (default `shared`), which the box turns on as soon as 7 merges,
so 8–16 run there before 17 flips the default. Main keeps working at every step.

1. **Mend · this ADR.** Amendment notes in 0003, 0009, 0010, 0013; PLATFORM-FEEDBACK. ~700.
2. **sealantd · the tables under `people/*/`.** `is_harness_excluded_path` also matches with a
   leading `people/<one component>/` stripped; listing, never-restore and the watcher use it.
   Round-trip test: a person directory holding every listed path saves and restores none; a link in
   `P` is saved as a link. Then a `next` release, Core's pin and the image builds, so executors have
   it. S, ~150.
3. **Core · sealant#316 as it is.** S, open.
4. **Core · sealant#315 reshaped into per-home injection.** `home`; the record per instance and home
   with one person for its life (`home-held`); GitHub as `hosts.yml`; POST, DELETE and push under a
   row lock; the switch semantics removed. Tests: two homes in one instance refreshed with their own
   accounts; a push never reaches another home; `home-held`; a home under `/workspace` or through a
   link refused. M, ~+450 / −250 on #315.
5. **Core · `credentialsHome`, `GET`, release.** Create writes the logins at that home and none into
   the environment; `GET` lists homes; SDK methods; a `next` prerelease and Mend's pin. M, ~400.
6. **Mend · mend#526 merged as it is.** The pi refusal stays until 17, so the shared layout keeps
   #526's protection. S, open.
7. **Mend · the person layout behind the flag.** `person-home.ts` (paths, the environment, the pins,
   the layout `sh` with `/root` image links and launcher links); `harness_layout` on the launch
   (migration); `SessionOptions.env` at every `openSession` (cold, claimed, retained, shell,
   Services as their starter); install and setup as the launcher. Tests: the environment per process
   kind; in a container, each harness writes nothing outside `R` and `P`; pnpm across two people. M,
   ~800.
8. **Mend · git and Mend identity per process.** The per-(launch, person) token file; the server
   refuses the container token on transport and helper routes; transport signs as the token's
   person; helper routes authorise it; `mend-git-credential`; `R/.config/git/config`; the `ssh`
   wrapper; reserved paths. Tests: a joiner's push signs as the joiner, in key and bridge modes; a
   joiner's `mend land` is refused; the container token refused. M, ~650.
9. **Mend · logins per person.** `credentialsHome`; POST at a person's first process, in parallel
   with layout; DELETE at their last; reconciliation by `GET`; refusal before start; re-post on an
   authentication failure; removal of pi and opencode copies. Tests: a join never reads the holder's
   login; release on end; an orphaned home released at startup. M, ~450.
10. **Mend · deliveries per person.** Dotfiles by exec, shell profile, skills, pi profile, memory,
    Codex carry, secret files and their record, all into `R`. Tests per delivery; two people's pi
    profiles live in one executor. M, ~650.
11. **Mend · readers per person.** `HARNESS_STATE` prefixes; harvest, `locateLiveTranscript`,
    carried list, opencode reader; memory read-back per process's person; Codex's database read back
    live. Tests: two people's transcripts and memory in one capture, each read back only for its
    person. M, ~600.
12. **Mend · a restart path that never starts a new conversation.** Stop and start a conversation's
    agent as a given person; links for the conversation's files; `claude --resume`, Codex
    `thread/resume` by `path`; a failed resume fails the turn (no `thread/start` fallback on this
    path); the person recorded on the process. Tests with a fake harness: a missing rollout fails;
    the process record survives a host restart. M, ~550.
13. **Mend · steering as a process per payer.** Dispatch: quiescence (open turn, running tasks), the
    waiting line, stop and start as the sender; payer from the process record for every turn; Codex
    for a steerer with generation off; queued steerer turns cancelled when shared control is turned
    off or the member is removed; Slack checks the sender; automatic landing after the owner's turns
    only. Engine tests: B's turn runs in a process with B's home and A's conversation; A's
    background task delays B's turn and finishes on A's login; payer recorded per process;
    cancellations. M, ~700.
14. **Mend · VS Code Remote-SSH as the connecting person.** `SetEnv` in the generated config; `R`
    prepared before connecting; the launcher as default. S, ~250.
15. **Mend · the migration job and retirement.** The server-side memory read-back with its crediting
    rule and completion record; transcript copy on resume; opencode's scrubbed copy; pre-release
    executors marked to retire and relaunched at their first idle point; the refusal as fallback.
    Tests: a worktree with an old shared home migrates with nothing lost; an ambiguous one credits
    nobody; the opencode scrub check refuses a copy with another session's row; retirement waits for
    a running task. M, ~700.
16. **Mend · what the product says.** The API's live people per executor; the lines of decision 13
    in the web composer, worktree menu, session page and Shared control, the CLI's join notice, the
    desktop, phone, VS Code and t3 gateway; the settings copy for GitHub; docs: Known issues,
    provider logins, agent memory, secret files, shared control, release notes. M, ~550.
17. **Mend · the flip.** `person` becomes the default; #526's pi refusal kept only for `shared`
    executors; relocation of `/root` harness directories into the harness home only for `shared`. S,
    ~150.
18. **Mend · removing what is dead.** The hand-over at launch, withholding, the owner record,
    `agent_memory_homes` writes (reads stay for 15 until 0.37), the joiner memory flags that 13 does
    not reuse; ADR 0010's join rule; stale Known issues. The credential tables and Codex's
    generation-off plumbing stay. L, ~−1,500 / +200.

Then the box with the default flipped: two people in one worktree, a join, a steered Claude and
Codex turn, a turn waiting on a background task, a Remote-SSH session, a migrated worktree and a
retired pre-release executor, before 0.36 is tagged.

## Considered

- **An in-place login switch in the conversation's process** (the first draft of this ADR, and ADR
  0013's design). Review found it unsound: Codex keeps a cached token after a write; a harness's
  background work outlives the turn and would run on whoever's login the file held next; a refresh
  push can land after a switch; MCP servers, secret files and git identity stay the owner's; and
  Claude writes `.credentials.json` itself. A process per payer has none of these.
- **`HOME=/root` with harness variables only** (the first draft). Leaves git author, global config,
  signing keys, `.netrc`, `.ssh` and every dotfile-based credential the launcher's, which a joiner's
  tools use by default.
- **One home per person, all of it saved,** with sealantd's tables stripping logins. The tables fail
  open, and the owner's rule is that logins and settings are never saved.
- **Pruning other people's directories at launch.** In capture mode the head is the only copy; the
  next capture records the deletion.
- **An `_unattributed` directory for processes Mend does not start.** The owner chose the launcher
  as the defined default.

## Decision log

- 2026-10-05: per-person homes approved for 0.36 by the owner. Separate POSIX users per person are
  not part of 0.36; the product says plainly that people in one workspace can read each other.
- 2026-10-05: no person ever runs on anyone else's login, joins and steering both (owner). ADR
  0013's switch ships in 0.36.
- 2026-10-05, after review: every process runs entirely as one person, and a conversation is shared
  data that different people's processes may continue (owner). Steering restarts the agent as the
  sender at a quiescent point; there is no in-place switch. `HOME` is per person.
- 2026-10-05: build on sealant#315 and sealant#316. #315's resolution, copy, control-connection
  write and push record carry over; its switch semantics do not, since a home never changes person.
- 2026-10-05: memory of an old shared home goes to the saved `agent_memory_homes` record, else to
  the only person who had sessions there, else to nobody; it is never deleted. opencode's shared
  database is never given whole to anyone.
