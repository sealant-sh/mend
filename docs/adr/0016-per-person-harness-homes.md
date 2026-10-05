# Per-person harness homes: every process runs entirely as one person

Status: accepted 2026-10-05, for 0.36. Revised twice that day after adversarial design reviews.
Round 1 (7 P1, 9 P2, 12 P3) found the storage half sound and the identity half not; round 2 (5 P1, 9
P2, 12 P3) found the shape sound and the following not yet buildable: steered Codex turns, shared
toolchain directories and OpenSSH. One question stays open until an experiment answers it: whether a
provider accepts a conversation's history replayed under another account (gate G, Delivery). Amends
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

### What each harness and tool reads

Checked 2026-10-05 in an unprivileged container with no network and a fake model, at the versions
the images install (Claude Code 2.1.289, Codex 0.160.0, opencode 1.18.34, pi 1.0.2, OpenSSH 9.2p1).

- With `HOME` set per person, every harness keeps all of its state under it, and every tool call
  inherits it. Claude still writes task output and sockets to `/tmp/claude-<uid>` unless
  `CLAUDE_CODE_TMPDIR` is set; Codex's daemon socket is per `CODEX_HOME`, and Mend runs Codex
  without the daemon (#527).
- **OpenSSH ignores `$HOME`.** `~` and `%d` expand to the passwd entry's `/root` in `ControlPath`,
  `UserKnownHostsFile`, `IdentityFile` and `Include`, even with `-F` naming the person's config.
  `-F` also drops `/etc/ssh/ssh_config`, and `-F` with a missing file exits 255.
- **Codex `thread/resume { path }`** canonicalises the path and records the real rollout path in the
  resuming process's `state_5.sqlite`, whatever link it was reached through. The thread's
  `memory_mode` comes from the rollout, defaulting to `enabled`; `memories.generate_memories=false`
  only stamps threads the process creates. Memory selection runs on every `turn/start`.
- **Claude `--resume`** from another `CLAUDE_CONFIG_DIR` refuses a linked `<id>.jsonl` given by id
  (it checks with `AT_SYMLINK_NOFOLLOW`), and accepts the full path, appending to the link's target.
- **Codex background terminals** (unified exec: dev servers, watchers, long tests) outlive
  `turn/completed` while the thread reports `Idle`. Only the experimental
  `thread/backgroundTerminals/list` shows them, and stopping `app-server` ends them.
- **Credentials in toolchain directories:** `cargo login` writes `$CARGO_HOME/credentials.toml`;
  `huggingface-cli login` writes `~/.cache/huggingface/token`; `gcloud auth login` writes under
  `~/.config/gcloud`; firebase-tools writes refresh tokens under `~/.config/configstore`.

## Decision

**Every process runs entirely as one person.** A conversation is shared data that different people's
processes may continue. "Entirely" means that person's home, logins, MCP servers and their tokens,
settings, memory, secret files, dotfiles, git identity (author, committer, signing key, global
config, credentials), SSH keys and connections, and the Mend identity the SSH shim and the `mend`
helper present. Nothing a process can find without being pointed at it on purpose is another
person's.

The owner decided 2026-10-05 that separate POSIX users per person are not part of 0.36. Everyone
still runs as root in one container, so a process can read any other person's files on purpose
(decision 13). The principle is about what a process uses, by default and by every path Mend
controls, not about what root can read.

### 1. Who each process runs as

| Process                                                                                      | Runs as                                                                                                                |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| An agent Mend starts (cold, claimed standby, join, resume, follow-up, retained run, handoff) | the person whose turn it runs: the session owner, or a steerer (decision 6)                                            |
| A shell                                                                                      | the person who opened it                                                                                               |
| A Service                                                                                    | the person who started it, also after a restart by someone else; a `mend.toml` service started at launch, the launcher |
| Dependency install and setup commands                                                        | the launcher (they are the launch's work)                                                                              |
| Every exec Mend makes for a person (layout, deliveries, read-backs)                          | that person: `env HOME=R …`, since the platform's exec has no environment                                              |
| Anything else: `docker exec`, an image's own setup, VS Code Remote-SSH                       | the launcher, the executor's defined default (decision 10)                                                             |

A terminal attach starts no process: it joins one that already runs as someone. The person a process
runs as is recorded on the process when it starts, never inferred later. A person's live Service
keeps their home held (decision 5).

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
- **The executor's shared parts**, `/root`: the image's own files and the shared toolchains of
  decision 3. In the person layout Mend and Core write nothing personal into `/root` except the
  launcher links of decision 10, and Mend builds no image with a person's dotfiles in it.

`R` is seeded by one `sh` per person per executor, run as `env HOME=R`, folded into the launch's
existing file exec (#513), in this order:

1. its links into `P`; a link into `P` that cannot be made fails the launch, so no conversation is
   ever written only to `R`;
2. links to the shared toolchain directories the image has, from an allowlist only: `.nix-profile`,
   `.nix-defexpr`, `.rustup`, `.bun`, `.nvm`, `.pyenv`, `.local/bin`, `.local/lib`;
3. a copy (`cp -a`) of everything else the image put in `/root`: top-level dotfiles (`.bashrc`,
   `.profile`, …) and the entries under `.config`, `.local/share` and `.local/state`, except
   personal names (harness directories, `.ssh`, `.gnupg`, `.gitconfig`, `.git-credentials`,
   `.netrc`, `.aws`, `.kube`, `.docker`, `.npmrc`, `.cargo`, `.config/gh`, `.config/git`, `.mend`)
   and except anything leading into `/root/.mend`. `.cache` is never linked or copied;
4. `R/.cargo` with links to `/root/.cargo/bin`, `registry` and `git` when the image has them;
5. the person's dotfiles (decision 11), Mend's shell profile, then the person's secret files, each
   winning over what came before;
6. removal of any link in `P` that leads outside `P` (a leftover from an executor lost mid-write).

A copy is the person's from then on: what they change, or a tool writes there, reaches nobody else.

### 3. The environment

Every process Mend starts gets, through `SessionOptions.env` (paths, never secrets):

- `HOME=R`, `CLAUDE_CODE_TMPDIR=R/.t` (short for `AF_UNIX`), `CARGO_HOME=R/.cargo`;
- `PATH`: `/run/mend/bin`, then the image's own `PATH`, resolved once in `prepareExecutor`;
- `MEND_SESSION_ID` and `MEND_SESSION_TOKEN_FILE` (decision 4);
- the shared toolchains and caches, each pinned to its `/root` location for every tool the image
  carries, whether or not the directory exists yet (most are made on first use):

| Variable                                                                  | Holds                                  | Why it holds no credential                                                           |
| ------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------ |
| `npm_config_store_dir`, `PNPM_HOME`                                       | pnpm's content store; global binaries  | pnpm keeps auth in `.npmrc`, which is the person's                                   |
| `npm_config_cache`                                                        | npm's tarball cache                    | npm keeps auth in `.npmrc`                                                           |
| `COREPACK_HOME`                                                           | downloaded package managers            | none written there                                                                   |
| `RUSTUP_HOME`                                                             | Rust toolchains                        | rustup has no logins; cargo's are in `CARGO_HOME`, which is per person               |
| `MISE_DATA_DIR`, `MISE_CACHE_DIR`                                         | installed runtimes and their downloads | mise's settings, trust and tokens live in `~/.config/mise` and `~/.local/state/mise` |
| `UV_PYTHON_INSTALL_DIR`, `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, `UV_CACHE_DIR` | uv's Pythons, tools, cache             | uv's credentials are under `~/.local/share/uv/credentials`, which is not pinned      |
| `PIP_CACHE_DIR`                                                           | wheels                                 | pip's index credentials are in `pip.conf` or `.netrc`                                |
| `GOMODCACHE`                                                              | Go modules                             | Go's auth is `.netrc` or `GOAUTH`                                                    |
| `BUN_INSTALL`, `NVM_DIR`, `PYENV_ROOT`                                    | runtimes                               | none written there                                                                   |

Tools that keep credentials keep them per person: cargo (`credentials.toml`, `config.toml`), npm,
pnpm and bun (`.npmrc`), pip (`pip.conf`), uv (`credentials/`), mise (`config.toml`), gcloud
(`~/.config/gcloud`), huggingface (`~/.cache/huggingface`), firebase-tools
(`~/.config/configstore`), Docker (`~/.docker`), kubectl (`~/.kube`), AWS (`~/.aws`), nix
(`~/.config/nix`), `gh` (`~/.config/gh`), git (`~/.gitconfig`, `~/.git-credentials`), curl and git
over HTTP (`~/.netrc`). A tool missing from both lists writes under `HOME`, which is per person,
unless the image links its directory through the allowlist. A test logs in to cargo and gcloud and
writes a token into `~/.cache` as one person, and checks that none of it reaches another.

Dependency install and setup run through the platform's exec as `env HOME=R_launcher … sh -c …`. The
container's own environment holds no person's identity: no `GITHUB_TOKEN`, `GH_TOKEN`,
`CLAUDE_CODE_OAUTH_TOKEN`, or `MEND_SESSION_TOKEN` usable for git or the helper.

### 4. Git, SSH and the Mend identity per process

- **The Mend identity.** Each (launch, person) gets its own session-channel token, written 0600 to
  `R/.mend/session-token` and named by `MEND_SESSION_TOKEN_FILE`; `MEND_SESSION_ID` names the
  session the process belongs to. The shim and the helper read them from there, and default to
  `$HOME/.mend/session-token` when the variable is unset (decision 10). The server accepts such a
  token only with a session id that is live in that launch's executor and that the token's person
  may act on, and revokes it when the person's home is released. The container-wide token stays for
  sealantd's capture channel only, and the server refuses it on `/git/transport` and on every helper
  route. A capture-mode executor has no `/run/mend/mend.sock` (the token-less socket); a test holds
  that.
- **Git over SSH** to origin goes through the shim as today, and the server signs as the token's
  person, with their Mend key or their bridge. A steerer's process pushes as the steerer. For a host
  the shim does not carry, it runs the `ssh` wrapper below, never `/usr/bin/ssh`.
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
- **SSH: `/run/mend/bin/ssh`** (first on `PATH`), since OpenSSH resolves `~` from the passwd entry:
  - it always passes `-F R/.ssh/.mend-config`, a file it regenerates when `~/.ssh/config` changes:
    `Include /etc/ssh/ssh_config`, then the person's config with every leading `~/` and `%d`
    rewritten to `R` (in `Include`, `IdentityFile`, `CertificateFile`, `UserKnownHostsFile`,
    `ControlPath`, `IdentityAgent`);
  - it passes `-o ControlPath=R/.ssh/.cm-%C` (a command-line value beats the config) and
    `-o UserKnownHostsFile=R/.ssh/known_hosts`, so one person's master connection is never reached
    by another's `ssh`;
  - it passes `-o IdentityFile=R/.ssh/<name>` for each default key the person has (`id_ed25519`,
    `id_ecdsa`, `id_rsa`);
  - it clears `SSH_AUTH_SOCK` unless the socket lies under `R`.

  `scp`, `sftp` and `rsync` reach it through `PATH` (`rsync -e ssh`, `scp -S ssh`); git reaches it
  through the shim. `/root/.ssh` holds nothing personal, so a tool that calls `/usr/bin/ssh` by its
  path finds no key and no master connection: never someone else's (Known limits). A login shell
  that resets `PATH` loses the wrapper the same way, failing closed.

- **`.netrc`, `.git-credentials`, `.aws`, `.kube`, `.npmrc`, `.docker`, gcloud** are read through
  `$HOME` and are the person's.

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
  - GitHub as a provider, written as `<home>/.config/gh/hosts.yml`. A person's own `gh auth login`
    there is overwritten by the next push;
  - a provider not named is not written; nothing else is ever in a home;
  - pushes, POST and DELETE for one (instance, home) under one row lock, re-read before each write.

  #316 is needed as it is: a setup token in `CLAUDE_CODE_OAUTH_TOKEN` is one value for every process
  in the container.

- **New in Core:** `credentialsHome` on create writes the launch's logins there and sets no login in
  the environment. `DELETE` removes the login files from the home and the record, so pushes stop.
  `GET` lists the homes. Credential sync-back, which reads `$HOME`, reads the home of each record,
  or does nothing for an instance launched with `credentialsHome`.
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
  - When a person's last process in an executor ends (Services included), Mend releases their home
    (DELETE, retried until it succeeds or the executor ends), revokes their Mend token, and removes
    the copies Mend's ChatGPT-login program made for pi and opencode. At startup Mend compares `GET`
    with its live processes and releases homes nobody holds.
  - Mend's ChatGPT-login program writes its copies in place, into the real files in `R`
    (`R/.mend/opencode/auth.json`, `R/.pi/agent/auth.json`), never by a rename through a path that
    resolves into `P`. A rename would replace opencode's link in `P` with a regular file, which
    sealantd's tables under `people/*/` then keep out of the capture; a test holds that no regular
    `auth.json` ever exists under `P`.
  - An authentication failure in a person's process makes Mend POST that person's login once more,
    which writes Core's current copy.

### 6. Steering: a process per payer

Shared control lets B send turns to A's conversation. B's turn runs in a process started as B,
continuing A's conversation. There is no login swap inside a running process and no switch back.

- **What B's turn uses:** B's login, B's settings, B's MCP servers and their tokens, B's skills,
  secret files, git identity and Mend identity, and for Claude B's memory; A's conversation history
  is its context. It writes into A's conversation and, for Claude, into B's memory. The model is the
  conversation's. A steered Codex turn does not read or write B's Codex memory (below).
- **A steer process gets its own harness directory,** `R_B/.mend/steer/<process id>` (`S`), outside
  every capture root, deleted when the process ends. The steer process's `CLAUDE_CONFIG_DIR` or
  `CODEX_HOME` is `S`; `HOME` is `R_B`. `S` holds:
  - links to the conversation's files in `P_A`, by provider session id: Claude
    `projects/-workspace-repo/<id>.jsonl` and `<id>/`; the Codex rollout at its dated path;
  - links to B's login and settings files in `R_B` (Claude `.credentials.json`, `settings.json`,
    skills, plugins; Codex `auth.json`, `.credentials.json`, `config.toml`, skills), and a copy of
    B's `.claude.json`;
  - for Claude, `projects/-workspace-repo/memory` linked to `P_B`'s memory directory;
  - Codex's own databases, made fresh: its thread index learns only this one rollout, and B's own
    `state_5` never learns A's thread.

  Nothing in `P_B` changes for a steer, so no capture holds a link to A's conversation in B's
  directory.

- **Resume:** Claude with `--resume <full path of the link in S>` (verified: it appends to A's
  file); Codex with `thread/resume { path }`. A resume that fails fails the turn and leaves no
  process on a new conversation; this path never falls back to `thread/start` or a new Claude
  session.
- **Codex steer processes run with memory off** (`features.memories=false`, memory overrides in the
  argv dropped, mend#528's plumbing kept). `memories.generate_memories=false` does not stop a
  resumed thread from being summarised, so it is not used.
- **A payer change restarts the agent, at a quiescent point.** When the next queued turn's sender is
  not the person the conversation's process runs as, dispatch waits until that process is quiescent:
  - no open turn;
  - for Claude, no task in any state but finished: running, pending, paused, scheduled and looping
    prompts (`CronCreate`, `/loop`) all count;
  - for Codex, an empty `thread/backgroundTerminals/list` (`app-server` is initialised with
    `capabilities.experimentalApi`), polled on every task and terminal change.

  Then it stops the process gracefully (closing stdin; never SIGKILL first), moves the queue to the
  new process, starts it as the sender, resumes, and sends the turn.
  - While it waits, the turn shows what it waits for: "Waits for Alice's 2 background tasks and 1
    background terminal to finish before Bob's turn starts." Mend never stops background work to
    make way. The person the process runs as, or the session owner, may end it (Codex
    `thread/backgroundTerminals/terminate`, Claude's task stop); the sender, or the owner, may
    withdraw the turn. No timeout kills anything.
  - Turns keep their order: a waiting turn holds the turns queued behind it, the owner's included,
    and the line says so.
  - So A's background work only ever runs in A's process on A's login, and B's in B's. A background
    task that opens a turn of its own opens it in the process that runs it, paid by that process's
    person.
  - "Accept for session" approvals end with the process; the next process asks again.

- **One live agent process per conversation,** recorded in the database. Every start path takes it:
  dispatch, handoff, takeover, resume, retained run, follow-up. A start that finds another live
  process for the conversation waits for it to be stopped by the rules above, or is refused.
- **Handoff and takeover** (protocol to terminal and back, `mend attach`) follow the same rules:
  they wait for quiescence or name what would stop and require the session owner to confirm, and
  they start the new process as the person attaching. They no longer cancel open turns.
- **The payer of every turn is the person its process runs as,** recorded from the process record:
  turns from a sender, turns a harness opens itself, and turns Mend starts (a keep-alive, a landing
  follow-up), which run in the owner's process.
- **Terminal sessions** stay as ADR 0013 and mend#518 made them: only the owner types.
- **Refusals:** a steerer with no login for the provider is refused at submit, as ADR 0013 says. A
  login found invalid at dispatch fails the turn with the same words.
- **When shared control is turned off,** or the steerer is removed from the organization, their
  queued turns are cancelled with the reason, and a running turn of theirs finishes in their own
  process.
- **Automatic landing** (ADR 0007) follows the owner's own turns only. A steered turn's change lands
  when the owner lands it.
- **Slack** checks the sender's login, not the owner's (`credentialProblem` in the resume path).
- **If gate G finds that a provider rejects a conversation replayed under another account** (Codex's
  encrypted reasoning and Claude's signed thinking are the suspects), steering that provider's
  conversations works as follows in 0.36, and the rest of this decision stands:
  - a steered turn runs in the sender's own conversation of that harness, in the same session,
    started fresh as the sender and given, before the prompt, the text of the turns of the other
    conversation since it last ran: each prompt and each final answer, no reasoning and no tool
    output. No model is called to make it;
  - each person's conversation continues in its own process; switching back gives the other the same
    text for the turns it missed;
  - the session shows both conversations, marked at each switch: "Bob's turn ran in his own
    conversation. Claude cannot continue reasoning made on Alice's account; it was given the
    conversation's prompts and answers since Bob last ran." The change is the worktree's, so both
    see each other's edits;
  - the provider session id of the session stays the owner's; the steerer's conversation is recorded
    beside it, in the steerer's `P`.

### 7. Joins

A person who starts a session in a worktree where another person's session runs gets their own
processes in the same executor, every one of them theirs: home, logins, dotfiles, git and Mend
identity, pi profile, skills, memory, secret files, saved directory. Two people work live in one
worktree, on one change, each entirely as themselves. ADR 0010's "a joiner receives no secret files
of its own" and ADR 0009's "what a joined agent writes goes to the executor's owner" no longer hold.

### 8. What is saved per person, and what is never saved

| Saved in `P`, per person                                                                          | Never saved (in `R`)                                                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude `projects/` (transcripts, auto memory)                                                     | every login: Claude, Codex, GitHub, MCP tokens, pi and opencode `auth.json`, the Mend session token, tool logins (decision 3)   |
| Codex `sessions/` (rollouts), `memories/`                                                         | settings: Claude `settings.json` and `.claude.json`, Codex `config.toml`, pi `settings.json` and `models.json`, opencode config |
| pi `sessions/`                                                                                    | dotfiles, secret files, git config, SSH keys and connections                                                                    |
| opencode's data directory; its `auth.json` and `mcp-auth.json` are links into `R/.mend/opencode/` | Codex's databases and daemon state; pi's packages and `git/` clones; caches; temp; steer directories                            |
| Mend's per-person records (`.mend/`)                                                              | Claude `backups/`, `file-history/`, `shell-snapshots/`, `session-env/`, `ide/`                                                  |

- Settings are written in at launch (seeds, pi profile). One edited by hand inside an executor lasts
  until it ends. mend#526's "kept, with a reason" list is no longer saved.
- Codex's memory database is read back from the live executor at each Codex process's end, through
  `node:sqlite` `VACUUM INTO`. When the executor is gone first, the stored copy stands (ADR 0009
  Codex consequences).
- **The credential tables are load-bearing,** not only a second layer: sealantd applies
  `HARNESS_CREDENTIALS` and `HARNESS_MACHINE_STATE` (including the sibling-suffix rule) under each
  `people/<id>/` as well as at the root, and keeps anything a link-breaking write left in `P` out of
  captures. Mend's copy and the test that holds it to sealantd's stay.

### 8a. The opencode in-app login: an exception for the owner to approve

**What happens.** opencode 1.18.34 keeps its conversations in a SQLite database in its data
directory, which resume needs, so it is saved in `P`. The same database has three login tables:
`account` (written only by the hidden `opencode console login`), `credential` (written only by the
desktop and web v2 connect flow) and `control_account` (legacy, unwritten). Mend uses neither flow;
the TUI's `/connect` and `opencode auth login` write `auth.json`, which is in `R`. opencode runs
only in a terminal in Mend, so no one else's opencode ever opens `P_X`'s database.

**What it breaks.** Rule 1 holds: no one else's process uses that login. Rule 2, "logins are never
saved", does not: a login a person makes with one of those two flows is in every capture taken while
it exists, which stays in the worktree's history until the worktree is removed, and `P_X` is
restored into every executor of the worktree, where anyone working there can read it.

**What Mend does to shrink it.** When each opencode process ends, Mend deletes every row of
`account`, `control_account` and `credential` from that person's database and runs `VACUUM`, with
`node:sqlite`, before the read-back. The login then survives only in captures taken while that
process ran; the person logs in again next time, as with `auth.json`. A database that fails the
delete or the `VACUUM` is reported on the session line and left as it is.

**For the owner's approval:** "An opencode login made with `opencode console login` or the v2
connect flow is saved in the captures taken while that opencode process runs, in that person's own
directory, readable by anyone working in the worktree. Mend deletes it from the database when the
process ends. This is logged as an exception to 'logins are never saved' until sealantd scrubs those
tables from captures (PLATFORM-FEEDBACK 2026-10-04)." Known issues says the same. Without approval,
the alternative is to keep opencode's database unsaved, which makes opencode sessions not resumable.

### 9. Memory per person (replaces mend#528's hand-over)

- **Delivery** (ADR 0009 decision 2) writes a person's memory into their own `R`, which links into
  `P`, at every process start of theirs.
- **Read-back** (decision 3) runs when a process ends, for the person it ran as, from
  `harness/people/<person>/` in the flushed head. A Claude steer process credits the steerer: ADR
  0009 decision 1's "a turn someone else steers writes the owner's memory" is amended. A Codex steer
  process has memory off and credits nobody.
- **Codex** builds memory only from rollouts in the person's own `sessions/` and the threads in
  their own index; a steer process's index is in `S` and is deleted with it.
  `withholdCodexThreadsExec` goes.
- **Carried conversations** (decision 8) go into the person's own `sessions/`, never one already
  there.
- **Goes:** the hand-over at launch, its forced capture, `.mend/agent-memory-owner`, new
  `agent_memory_homes` writes. The table stays for the migration until 0.37.

### 10. Processes Mend does not start

- **The defined default is the launcher.** In the person layout `/root`'s personal names are links
  into `R_launcher`: `.claude`, `.codex`, `.pi`, `.local/share/opencode`, `.local/state/opencode`,
  `.config/gh`, `.config/git`, `.gitconfig`, `.cargo/credentials.toml`, `.mend/session-token`. A
  `docker exec`, an image's own setup or anything else with `HOME=/root` therefore runs on the
  launcher's logins and identity, and its conversations are saved in the launcher's `P`. Not linked:
  `.ssh` and `.gnupg`, which tools find through the passwd entry whatever `HOME` says, so a person's
  own process could reach them by default.
- **VS Code Remote-SSH runs as the launcher.** Core's gateway admits only the workspace's owner, the
  person whose launch made the executor, so that is who connects; their connection gets `HOME=/root`
  and the links above, and the Claude Code extension and its terminals save into their `P`. A joiner
  cannot open Remote-SSH into an executor someone else launched (Known limits).

### 11. Secret files and dotfiles per person (amends ADR 0010 decision 3)

- Each person's secret files go into their own `R`, at their path under `HOME`, joins included. The
  record of what was written (`~/.mend/secret-files`) is therefore per person. `.config/gh/`,
  `.config/git/` and `.mend/` are reserved, beside today's reserved paths. Since `.cache` and image
  entries are copies, not links, a secret file under `.cache/…` or `.config/<tool>/…` is written.
- **Dotfiles apply as files only, for every person.** Mend resolves each person's dotfiles as today
  (repository and snapshot) and applies them into their `R` by exec, as `env HOME=R`: chezmoi with
  `apply --destination R --exclude scripts`, stow into `R`, or a copy. `install.sh` and chezmoi run
  scripts do not run, for the launcher either: as root they could change `/etc`, global npm config
  or `/root`, which would become everyone's default. The person layout passes no dotfiles to create,
  so nothing personal lands in `/root`. Mend's default shell profile is written into `R` too.

### 12. Readers

Every reader goes by a prefix: `HARNESS_STATE`'s transcript patterns become `^people/<id>/…`;
`harvestFromCaptureAlone`, `hasLiveHarnessState`, `locateLiveTranscript`, `readHarnessFileScript`,
`CARRIED_TRANSCRIPTS` and the opencode reader take the session owner's directory for a conversation,
and the process's person for memory. Readers skip links. Two sessions of one person in one worktree
still share a directory; pinning provider session ids at launch is a follow-up.

### 13. What the product says

While people share a workspace, each person, and their agents, can read the others' homes, logins
included, and a person's saved conversations and memory are restored into every executor of the
worktree. Nothing of anyone else's is used by default, and nobody's login is saved (decision 8a
aside), but root is not a boundary between people.

- **Where two people meet in a worktree,** in the product's words for it ("join a worktree" in the
  CLI, the composer's Worktree picker, the worktree's New session menu): "Anna's session is running
  in this worktree. You share its workspace: everything you run uses your own logins and settings,
  but either of you can read the other's files, logins included."
- **On a session while another person's process is live in its executor:** "Shared workspace with
  Anna · each of you runs as yourself · either of you can read the other's files."
- **Beside the Shared control switch,** replacing "using your provider logins and Git access": "Each
  turn runs as its sender, with their logins, settings and memory, continuing this conversation.
  When the sender changes, the agent restarts once its background work finishes."
- The API's session view lists the people live in its executor, so every client draws the same line.
- Known issues: "People in one worktree can read each other's files", and the limits below.

### 14. Executors started before this release, and the migration

- **The layout is recorded per launch** (`harness_layout`: `person`, or null for launches before
  this release). Every delivery and reader goes by the executor's.
- **A pre-release executor is replaced, never stopped under work.** At upgrade every `shared`
  executor is marked to retire.
  - It is replaced automatically only when no terminal agent, PTY or shell process is live in it and
    its protocol agents are quiescent (decision 6): Mend sends its final flush, relaunches the
    worktree in the person layout and resumes its conversations.
  - Otherwise the owner of the worktree's change sees "Replace this workspace now", with the list of
    what would stop: terminal sessions (they end resumable), shells, Services. Services from
    `mend.toml` restart in the new executor as at launch; Services started by hand are stopped and
    listed.
  - Until it is replaced, a join and a turn from anyone but its launcher are refused: "This
    worktree's workspace started before Mend 0.36 and shares one home; it takes another person once
    it is replaced." People who joined before the upgrade keep running there on the launcher's
    identity until then; the release notes say so.
- **The migration of an old shared home is a server-side job per worktree,** off every launch path.
  It reads the head capture, as read-back does, and records completion in the database; it moves
  nothing and execs nothing. The old root paths are inert after the flip and stay in the capture
  until the worktree is removed.
  - **Memory** is read back into one person: the person a saved `agent_memory_homes` record names;
    else, when every session the worktree ever had was one person's, that person; else nobody, and
    the files stay in the old home, listed on the worktree as "memory from before 0.36, not
    credited" (claiming them is a later feature). A job that fails retries; no launch waits for it.
  - **Transcripts** of pre-release Claude, Codex and pi sessions are found at the old path by their
    exact provider session id, and copied into the session owner's `P` when the session resumes,
    only if `P` does not have it yet: a second resume never overwrites newer turns with the old
    copy.
  - **opencode conversations from 0.36 prereleases** (no released Mend could resume opencode) stay
    readable in the session's record and in the capture. Nothing is copied, and the old database is
    opened by no one. Only their owner can resume them, and only in the pre-release executor that
    holds them, before it is replaced; in the person layout a resume is refused: "This opencode
    conversation was saved before 0.36 in a home shared with others; it can be read but not
    resumed."

## Start-time impact

- **Cold launch:** no added Core call (`credentialsHome`). The layout, dotfiles and shell profile
  join the launch's file exec. Removed: mend#528's hand-over (a capture read, an `sh` exec and a
  forced capture), the Codex withholding exec, and the migration (now server-side).
- **Join:** one Core call, run in parallel with the joiner's layout and deliveries, which a join
  skips today. pi's package install is a cache hit after the first person in an executor (shared
  `npm_config_cache`); a mise project's runtimes are shared (`MISE_DATA_DIR`). Measured on the box
  for a Claude, a pi and a mise-project join, against the interactive bar.
- **Codex's first start per person per executor** re-indexes that person's rollouts, since `state_5`
  is not saved: Codex's one-time backfill parses every rollout under `P/.codex/sessions` and can
  block for up to 30 s. Measured on the box with a person who has months of rollouts before the
  flip; if it is material, `state_5*` moves into `P` (it holds no credential, and sealantd detects
  torn databases). A steer process indexes one rollout.
- **Payer change:** one agent process stop and start, plus waiting for background work. No Core call
  when the sender already has a home there. Measured for Claude and Codex.

## Known limits

- **Root reads everything.** People sharing a workspace can read each other's files, logins
  included, and everyone's saved conversations and memory for that worktree (decision 13).
- **SSH by absolute path.** A tool that runs `/usr/bin/ssh` itself, or a login shell that resets
  `PATH`, finds no key and no master connection. Never someone else's.
- **No `GITHUB_TOKEN` in the environment.** A repository `.npmrc` with `${GITHUB_TOKEN}` (GitHub
  Packages) fails until the person exports `GITHUB_TOKEN=$(mend-git-credential token)` in their
  dotfiles. The settings copy "Gives `gh` inside every session a GH_TOKEN" changes with it. A
  person's own `gh auth login` is overwritten by Core's next push.
- **Processes Mend does not start are the launcher's,** VS Code Remote-SSH included, which reaches
  only workspaces you launched.
- **Dotfiles apply as files only.** `install.sh` and chezmoi run scripts do not run in the person
  layout.
- **`mise trust` and `direnv allow` are per person.**
- **Personal config inside the worktree is shared by design:** `.claude/settings.local.json`,
  `.env`, a repository `.npmrc`, `env` in `.mcp.json`. They are the change's files.
- **A conversation resumed by hand** (`claude --resume`, `codex resume` in your own shell) while
  Mend's process for it runs gives it two writers.
- **Pre-release executors** keep the shared home until they are replaced (decision 14).
- **The opencode in-app login exception** (decision 8a), if the owner approves it.
- **A payer change waits** for background work, holds the turns queued behind it, costs a process
  restart, and ends "accept for session" approvals. A steered Codex turn has no Codex memory.
- **A tool not in decision 3's lists** whose directory the image links through the allowlist shares
  what it writes there.
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
- **Remote-SSH as the connecting person,** once Core's gateway admits more than the owner: the
  gateway sets `HOME` from Core's per-home record for the authenticated principal.
- **Dotfiles scripts per person:** a sealantd verb that applies dotfiles to a given home.
- **Provider session ids pinned at launch** (Claude and pi `--session-id`).
- **Claiming uncredited memory** from before 0.36.
- **sealantd scrubbing opencode's login tables** from captures.
- **Restoring only the people live in an executor.**

## Delivery

Ordered; each is one pull request; sizes are lines changed, tests included.

- **Core and sealantd (2–5)** run in parallel with Mend 6–8. Delivery 2 is load-bearing (decision 8)
  and lands in executors before Mend's 10.
- **Mend 7–11 are one stack behind `MEND_HARNESS_LAYOUT=person`** (default `shared`), built and
  exercised on a scratch instance. While the flag is on, Codex's `thread/start` fallback on a failed
  resume is off. The box turns the flag on only after 11 (which carries the pre-release transcript
  copy) and 12 (the no-fork restart path) have merged.
- **Gate G** runs before 12 and 13 are written.
- Main keeps working at every step.

1. **Mend · this ADR.** Amendment notes in 0003, 0009, 0010, 0013; PLATFORM-FEEDBACK. ~800.
2. **sealantd · the tables under `people/*/`.** `is_harness_excluded_path` also matches with a
   leading `people/<one component>/` stripped, sibling-suffix rule included; listing, never-restore
   and the watcher use it. Round-trip test: a person directory holding every listed path, and a
   regular `auth.json` where a link was, saves and restores none of them; a link in `P` is saved as
   a link. Then a `next` release, Core's pin and the image builds. S, ~150.
3. **Core · sealant#316 as it is.** S, open.
4. **Core · sealant#315 reshaped into per-home injection.** `home`; the record per instance and home
   with one person for its life (`home-held`); GitHub as `hosts.yml`; POST, DELETE (removing the
   files) and push under a row lock; the switch semantics removed. Tests: two homes in one instance
   refreshed with their own accounts; a push never reaches another home; `home-held`; DELETE removes
   the files; a home under `/workspace` or through a link refused. M, ~+500 / −250 on #315.
5. **Core · `credentialsHome`, `GET`, sync-back per home, release.** Create writes the logins at
   that home and none into the environment; `GET` lists homes; sync-back reads each record's home;
   SDK methods; a `next` prerelease and Mend's pin. M, ~450.
6. **Mend · mend#526 merged as it is.** The pi refusal stays until 16, so the shared layout keeps
   #526's protection. S, open.

**G · Gate: replay under another account.** On the box, with two real logins per provider (two
Claude accounts, two ChatGPT accounts): A's turn that produces reasoning or thinking (and, for
Codex, a compaction); a resume as B through a steer directory and a turn; a resume as A and a turn.
Record for each provider whether every turn succeeds and whether the history is intact. If a
provider rejects it, decision 6's fallback is built in 13 for that provider. The result is recorded
in this ADR's decision log before 12 is written.

7. **Mend · the person layout behind the flag.** `person-home.ts` (paths, the environment, the pin
   table, the allowlist, the layout `sh` with links, copies, `R/.cargo` and the stale-link sweep,
   the launcher links); `harness_layout` on the launch (migration); `SessionOptions.env` at every
   `openSession`; every exec for a person as `env HOME=R`; install and setup as the launcher; `PATH`
   prepended; the Codex fallback off under the flag. Tests: the environment per process kind; in a
   container, each harness writes nothing outside `R` and `P`; pnpm across two people;
   `cargo login`, `gcloud auth login` and a `~/.cache` token in `R_bob` never reach `R_alice`. M,
   ~900.
8. **Mend · git, SSH and Mend identity per process.** The per-(launch, person) token file, its
   session binding and revocation; the container token refused on transport and helper routes; no
   `mend.sock` in capture mode; transport signs as the token's person; helper routes authorise it;
   `mend-git-credential`; `R/.config/git/config`; the `ssh` wrapper with its generated config,
   `ControlPath`, known hosts and identities; the shim runs the wrapper for other hosts. Tests: a
   joiner's push signs as the joiner in key and bridge modes; a joiner's `mend land` refused; the
   container token refused; two people with `ControlMaster auto` and the same host get two masters.
   M, ~750.
9. **Mend · logins per person.** `credentialsHome`; POST at a person's first process, in parallel
   with layout; DELETE at their last, retried; reconciliation by `GET` at startup; refusal before
   start; re-post on an authentication failure; the ChatGPT-login copies written in place and
   removed on release. Tests: a join never reads the holder's login; release on end; an orphaned
   home released at startup; no regular `auth.json` under `P`. M, ~450.
10. **Mend · deliveries per person.** Dotfiles as files only (chezmoi without scripts, stow, copy),
    shell profile, skills, pi profile, memory, Codex carry, secret files and their record, all into
    `R` as `env HOME=R`; the opencode login-row delete and `VACUUM` at each opencode process's end.
    Tests per delivery; two people's pi profiles live in one executor; a dotfiles `install.sh` does
    not run. M, ~750.
11. **Mend · readers per person.** `HARNESS_STATE` prefixes; harvest, `locateLiveTranscript`,
    carried list, opencode reader, all skipping links; memory read-back per process's person;
    Codex's database read back live; the pre-release transcript copy on resume, only when absent.
    Tests: two people's transcripts and memory in one capture, each read back only for its person; a
    second resume does not overwrite. M, ~650.
12. **Mend · a restart path that never starts a new conversation.** The steer directory `S` and its
    removal; stop and start a conversation's agent as a given person, gracefully; Claude
    `--resume <full path>`, Codex `thread/resume { path }`; a failed resume fails the turn; the
    person recorded on the process; one live agent process per conversation, taken by every start
    path. Tests with a fake harness: a missing rollout fails; the process record survives a host
    restart; a second start for a live conversation waits. M, ~650.
13. **Mend · steering as a process per payer.** Dispatch: quiescence (open turn, Claude tasks in any
    unfinished state, Codex background terminals through the experimental API), the waiting line,
    the queue moved to the new process, re-dispatch on task and terminal events; handoff and
    takeover through the same rules; payer from the process record for every turn; Codex steer
    processes with memory off; queued steerer turns cancelled when shared control is turned off or
    the member is removed; Slack checks the sender; automatic landing after the owner's turns only;
    and, for a provider gate G found rejecting, decision 6's fallback. Engine tests: B's turn runs
    in a process with B's home and `S`, A's conversation appended; A's background terminal delays
    B's turn and keeps running on A's login; a takeover waits; cancellations. M, ~850 (+~350 for the
    fallback).
14. **Mend · the migration job and replacement of pre-release executors.** The server-side memory
    read-back with its crediting rule and completion record; executors marked to retire, replaced
    automatically only when nothing interactive is live; "Replace this workspace now" with what
    would stop; the refusal; the opencode pre-release refusal. Tests: a worktree with an old shared
    home migrates with nothing lost; an ambiguous one credits nobody; an executor with a live shell
    is not replaced automatically. M, ~600.
15. **Mend · what the product says.** The API's live people per executor; the lines of decision 13
    in the web composer, worktree menu, session page and Shared control, the CLI's join notice, the
    desktop, phone, VS Code and t3 gateway; the waiting line everywhere a turn shows; the settings
    copy for GitHub; docs: Known issues (with the opencode exception), provider logins, agent
    memory, secret files, dotfiles, shared control, release notes. M, ~600.
16. **Mend · the flip.** `person` becomes the default; #526's pi refusal kept only for `shared`
    executors; relocation of `/root` harness directories into the harness home only for `shared`. S,
    ~150.
17. **Mend · removing what is dead.** The hand-over at launch, withholding, the owner record,
    `agent_memory_homes` writes (reads stay for 14 until 0.37), the joiner flags 13 does not reuse;
    ADR 0010's join rule; stale Known issues. The credential tables and Codex's memory-off plumbing
    stay. L, ~−1,500 / +200.

Then the box with the default flipped: two people in one worktree, a join, a steered Claude and
Codex turn, a turn waiting on a background task and on a Codex background terminal, `ssh` with
`ControlMaster` as two people, a migrated worktree and a replaced pre-release executor, before 0.36
is tagged.

## Considered

- **An in-place login switch in the conversation's process** (the first draft of this ADR, and ADR
  0013's design). Codex keeps a cached token after a write; a harness's background work outlives the
  turn and would run on whoever's login the file held next; a refresh push can land after a switch;
  MCP servers, secret files and git identity stay the owner's; Claude writes `.credentials.json`
  itself.
- **`HOME=/root` with harness variables only** (the first draft). Leaves git author, global config,
  signing keys, `.netrc`, `.ssh` and every dotfile-based credential the launcher's.
- **Linking every image entry of `/root` into each home** (the second draft). A link shares
  everything any tool later writes under it, logins included (`.cache`, `.config/gcloud`,
  `configstore`).
- **Links in the steerer's saved directory** (the second draft). Codex records the real path in the
  steerer's thread index for good, and captures taken mid-steer restore the links.
- **A scrubbed copy of opencode's old shared database** (the second draft). Its event log, child
  sessions, other projects, share secrets, files outside the database and free pages all keep other
  people's data; no released Mend could resume opencode anyway.
- **Remote-SSH as the connecting person through `SetEnv`** (the second draft). Core's gateway admits
  only the workspace's owner, the SSH config is per server, and a reconnect after replacement
  arrives before Mend prepares the home.
- **One home per person, all of it saved,** with sealantd's tables stripping logins. The tables fail
  open, and the owner's rule is that logins and settings are never saved.
- **Pruning other people's directories at launch.** In capture mode the head is the only copy; the
  next capture records the deletion.

## Decision log

- 2026-10-05: per-person homes approved for 0.36 by the owner. Separate POSIX users per person are
  not part of 0.36; the product says plainly that people in one workspace can read each other.
- 2026-10-05: no person ever runs on anyone else's login, joins and steering both (owner). ADR
  0013's switch ships in 0.36.
- 2026-10-05, after review 1: every process runs entirely as one person, and a conversation is
  shared data that different people's processes may continue (owner). Steering restarts the agent as
  the sender at a quiescent point; there is no in-place switch. `HOME` is per person.
- 2026-10-05: build on sealant#315 and sealant#316. #315's resolution, copy, control-connection
  write and push record carry over; its switch semantics do not, since a home never changes person.
- 2026-10-05, after review 2 (owner's cuts): Remote-SSH stays the launcher's; the opencode scrubbed
  copy is dropped; a steer process gets its own harness directory outside every saved path; image
  entries are copied, and only toolchains on an allowlist are linked; the `ssh` wrapper passes the
  person's config, `ControlPath`, known hosts and keys explicitly; dotfiles apply as files only;
  pre-release executors are replaced automatically only when nothing interactive runs.
- 2026-10-05: memory of an old shared home goes to the saved `agent_memory_homes` record, else to
  the only person who had sessions there, else to nobody; it is never deleted.
- Open: gate G's result, per provider. Open: the owner's approval of decision 8a.
