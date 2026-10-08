# Per-person harness homes: a Linux user per person, one shared conversation

Status: accepted 2026-10-05, for 0.36; rewritten 2026-10-06 on the owner's direction after three
adversarial design reviews (round 1: 7 P1, 9 P2, 12 P3; round 2: 5 P1, 9 P2, 12 P3; round 3: 5 P1, 9
P2, 10 P3), then revised after round 4 (4 P1, 7 P2, 15 P3) and round 5's fix check (1 P1, 5 P2, 10
P3). The design is final; the build starts with Delivery 2. Amended 2026-10-07 with what the
platform's builds and reviews settled (sealantd#144–#148, sealant#327–#332, mend#551–#559; see the
decision log). Earlier drafts gave every process a `HOME` of its own inside root; this one gives
every person a Linux user. Amends [ADR 0003](0003-organizations-and-tenancy.md) (a session runs as
its owner), [ADR 0009](0009-agent-memory-per-person-per-project.md) (memory in capture mode, and
under shared control), [ADR 0010](0010-secret-files.md) (where secret files go) and
[ADR 0013](0013-whoever-sends-a-turn-pays.md) (the steering switch, which ships in 0.36). Read
against Mend `c9b645b0b` with mend#526 (`ac3bdce06`) open, Sealant Core `bc9ec42` (SDK 0.38.1) with
sealant#315 and sealant#316 open, and sealantd `07ada50`.

## Context

In capture mode (ADR 0002) a worktree has one live executor, a container whose processes all run as
root with `HOME=/root`, and every session in the worktree runs in it: a join, a sibling shell and a
resume are processes in the lease holder's executor. sealantd saves `/workspace/harness-home` as the
capture's `harness/` section, less the paths in `HARNESS_CREDENTIALS` and `HARNESS_MACHINE_STATE`
(sealantd#136), and the worktree as `tree/`. It records each entry's mode and mtime, not its owner,
and restores everything as root. Mend's relocation links `~/.claude`, `~/.codex`, `~/.pi` and
opencode's directories into the harness home, so they are saved and restored for whoever comes next.

Everything else that says who a process is belongs to the person whose launch made the executor:
Core injects that person's logins at `$HOME` and their GitHub token as `GITHUB_TOKEN`/`GH_TOKEN` for
the whole container; sealantd applies their dotfiles to `/root`; `applyGitAuthor` sets
`git config --system user.*` to them; the SSH transport shim and the `mend` helper authenticate with
a session token issued for that launch, so the server signs `git push` as them; their secret files
are written into `/root`.

Over the week of 2026-09-28 the shared home caused one class of bugs: credential files restored for
the next person (sealantd#136, mend#526); one person's pi profile in the next person's pi (mend#526
refused the second pi, which the owner rejected); memory credited to the wrong person (mend#528, six
review rounds); Codex building one person's memory from other people's conversations; opencode
keeping in-app logins beside the conversations it resumes. Every joiner, and every steerer's turn,
ran on the launcher's or the owner's identity.

### Why a Linux user, not a `HOME` per process

Three review rounds of "a `HOME` per process, everyone root" kept finding tools that do not take
their home from `$HOME`: OpenSSH (`~` and `%d` in `ControlPath`, `IdentityFile`,
`UserKnownHostsFile`), `scp` and `sftp` (which run `/usr/bin/ssh`), `ssh-keygen` (which writes to
the passwd home), the JVM (`user.home` from `getpwuid`), and with them Maven, Gradle and sbt. Each
needed a wrapper, a pin or a copy, and the copies of `/root` taken at join time carried whatever the
launcher had written there since. A user per person gives every tool the right home natively.

## Decision

**Every process runs entirely as one person, as that person's own Linux user.** Each person who runs
anything in a workspace gets a uid and a home from the passwd entry. "Entirely" means that person's
home, logins, MCP servers and their tokens, settings, memory, secret files, dotfiles, git identity
(author, committer, signing key, global config, credentials), SSH keys and connections, and the Mend
identity the SSH shim and the `mend` helper present.

**A conversation is shared data that different people's processes may continue:** under shared
control, one conversation, each turn run by a process of its sender's user on its sender's login.

**Everyone has passwordless sudo.** Agents need `apt-get` and the like. This is deliberately not
isolation: anyone, and their agents, can read and change anyone's files. The owner accepted that as
the 0.36 limit on 2026-10-06; the product says so (decision 13). The rules below are about what a
process uses, by default and by every path Mend controls.

### 1. Users, group and who each process runs as

- **A Linux identity per account, stable instance-wide.** Mend allocates each account a login name
  (`m` plus 8 base32 characters of a hash of the account id, checked for collisions) and a uid from
  a reserved range (40000–49999: inside `useradd`'s normal range, above the image users bases ship),
  recorded in Postgres the first time the account runs anything in a workspace. The same person has
  the same name, uid and home path (`/home/<name>`) in every executor and every project, so absolute
  paths a harness records into a conversation stay valid.
- **One shared group,** `mend` (gid 40000), holds every person; `docker` group membership where the
  image has the Docker sidecar.
- **Users are made at executor prepare,** as root, through the platform's exec, one `useradd` at a
  time (fixed uid, primary group `mend`, the image's login shell, home from `/etc/skel` with mode
  0700 set explicitly): for the launcher, and for every current member with a saved directory in the
  restored head, so every recorded path resolves. A person who joins later is added at their first
  process. Prepare first checks the image's passwd and group for the reserved ids and names; a
  collision is a capability the image lacks (below). Before it makes anyone, it checks that the
  restore applied the owner map: the restored worktree's group must be `mend` (40000), or the launch
  is refused (decision 8, mend#552).
- **The person layout needs the platform to say it can, before create.** An executor can run
  `person` when its sealantd reports `exec.user`, `dotfiles.user` and `restore.owner_map`, the image
  has a setuid `sudo`, `useradd`, `setfacl` and no user or group in the reserved range other than
  `mend`, the runtime supports ACLs on `/workspace`, and nothing imposes no-new-privileges on the
  executor, since `sudo` cannot work under it. sealantd leaves no-new-privileges unset in a
  per-person executor (decision 8); an orchestrator can still impose it (Kubernetes
  `allowPrivilegeEscalation: false`). Core's image probe records both as `setuid-sudo` and
  `sudo-no-new-privileges`, and Mend's probe matches it: `sudo` must carry its setuid bit, and in a
  `person` executor prepare reads the executor's no-new-privileges state (`NoNewPrivs` in
  `/proc/self/status`, or sealantd's `noNewPrivileges`) and treats it set as missing. Any other
  executor has no-new-privileges set by sealantd itself, so only a `person` executor can answer.
  Outside that setup a person's `CAP_FOWNER` (below) amounts to root that `sudo` does not already
  give (sealantd#147). Mend needs that answer before create, because create already commits to a
  layout: `credentialsHome`, whether the launcher's dotfiles go to `/root` at boot, and the owner
  map (decisions 5, 8, 11). So:
  - **Core reports it per image.** Core's image build runs `sealantd capabilities --json` and the
    tool and passwd probe inside the built image and records the result on the image; it reports ACL
    support per runtime. The SDK exposes both (Delivery 8, 9).
  - **Mend learns it once per image.** Mend records what each executor's prepare actually found, per
    image digest and runtime, and that record wins over Core's report when they disagree.
  - **Unknown means `shared`** for a worktree that has no layout yet: the launch runs as today and
    its prepare records the answer, so the next launch on that image can be `person`.
  - **A wrong prediction never leaves an agent without a login.** If Core said yes and prepare finds
    otherwise on a worktree with no layout yet, Mend releases the create-time home (DELETE),
    re-POSTs the launcher's logins with `home: /root` (one partial POST: a provider disconnected
    since the create is left out, and only one the harness needs refuses the launch), records
    `shared` and corrects the record; the agent starts only after the login is written. Their
    dotfiles are not applied: Core's `dotfiles.apply` runs only as a person and refuses root, and
    the create, made for a `person` launch, applied none at boot. The session records each source as
    not applied, with that reason; every later session of the worktree joins the same executor
    without them, and a workspace started next on that image (decided `shared` before create from
    the recorded answer) applies them at boot. This is paid once per image digest, inside the
    cold-launch budget. On a worktree already `person`, prepare refuses (decision 14).
  - **The control plane and the workspace must say they can.** Before anything else Mend reads
    Core's own report of what it can do (`sealant.features()`, kept five minutes): its as-user
    routes (`processUserRoutes`), the dotfiles verb, partial puts, pi's and opencode's logins and
    the capture owner map, every one of them, since a Core from before any reports it `false`.
    Without them a fresh worktree runs `shared` with the reason and a `person` worktree is refused
    with it, before create. At prepare the workspace's own answer (`workspace.processUser()`) must
    be `supported`: `unsupported` (the image's sealantd) is recorded against the image like a
    probe's finding; `unknown` is not a yes and is not held against it. Core 0.39.0-next.706 is the
    first to report them all.
- **The layout is sticky per worktree** (decision 14): once a worktree has had a `person` launch,
  every later launch of it is `person` or refused with the reason. The flag decides only worktrees
  with no layout yet. Every server-side rule that differs between layouts (the container token's
  refusal included) keys on the executor's recorded layout.
- **Processes start as the user,** through the SDK's `user` option on sessions and exec (new, Core
  and sealantd): uid, gid, supplementary groups and `HOME`, `USER`, `LOGNAME` and `SHELL` from the
  passwd entry, umask `0002`, a private `TMPDIR=/tmp/u-<uid>` and `XDG_RUNTIME_DIR=/run/user/<uid>`
  (both 0700), so sockets and temporary files a tool leaves to the umask are not reachable through
  the shared `/tmp`.
- **The image's person environment is sealantd's to apply.** sealantd applies
  `/etc/sealant/person-env` (Core's images write it; its first line is `# person-env 1`, and a file
  without that marker applies nothing) to every process it runs as a person: executions, sessions
  and the `dotfiles.apply` bootstrap, never root's. Precedence: the filtered daemon environment,
  then the file (its `PATH_PREPEND` goes in front of the base `PATH`), then the passwd identity,
  then the caller's `env`. Mend applies nothing from it (sealantd#147, sealant#330).
- **What reaches a person from the executor's environment.** A person's process inherits the
  daemon's environment less the named harness and provider logins (`CLAUDE_CODE_OAUTH_TOKEN`,
  `GH_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and their kin, even when a project sets one,
  since a harness would bill them instead of the person's own login), every `SEALANT_*` key and the
  keys Core's injector declares (`SEALANT_HARNESS_ENV_KEYS`). The project's secrets (the launcher's
  secret environment, Mend's `--secret` values) reach every person under any name. sealantd's
  secret-name rule applies only to `person-env`, never to this inheritance (sealantd#147).
- **`CAP_FOWNER` in a per-person executor.** Where sealantd runs as root without no-new-privileges
  and holds `CAP_FOWNER` in its bounding set, a person's process holds that one capability, ambient,
  so every program it runs keeps it: a person can change the mode and times of files they do not
  own, which pnpm needs to relink a restored package's bins (`ERR_PNPM_CMD_SHIM_CHMOD` without it).
  It amounts to root, which the person already has through `sudo`; that is the owner-approved
  posture (2026-10-06), and the reason the person layout requires a setuid `sudo` and no
  no-new-privileges (above). Under no-new-privileges sealantd withholds it, and
  `runtime.getCapabilities` reports `personCapabilities` and `personCapabilitiesWithheld` with the
  reason, which Mend surfaces on the executor.

| Process                                                                                      | Runs as                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| An agent Mend starts (cold, claimed standby, join, resume, follow-up, retained run, handoff) | the person whose turn it runs: the session owner, or a steerer (decision 6)                                                                         |
| A shell                                                                                      | the person who opened it                                                                                                                            |
| A Service                                                                                    | the person who started it, across restarts; a `mend.toml` service started at launch, the launcher                                                   |
| Dependency install and setup commands                                                        | the launcher                                                                                                                                        |
| Mend's own execs for a person (deliveries, read-backs)                                       | that person                                                                                                                                         |
| VS Code Remote-SSH                                                                           | the launcher's user: Core's gateway admits only the workspace's owner and runs their session as the user Mend names for the workspace (Core change) |
| `docker exec` and anything else Mend did not start                                           | root, which is nobody: no login, no Mend token, nothing saved (Known limits)                                                                        |

A terminal attach starts no process. The person a process runs as is recorded on the process when it
starts. A person's live process, Services included, keeps their user's logins held (decision 5).

### 2. Homes, saved directories and the shared worktree

- **The home,** `/home/<name>` (`R`), the user's passwd home, 0700. Not saved; gone when the
  executor ends. Logins, settings, dotfiles, secret files, caches, Codex's logs database, pi's
  packages, `~/.mend/` (the Mend session token and Mend's per-home records; a real directory, never
  linked into anything saved).
- **The saved directory,** `/workspace/harness-home/people/<account id>` (`P`), owned by the user,
  mode 0710 (the group may pass through to `conversations/`, not list or read the rest). Saved with
  every capture. It holds everything of a harness's home that is conversation state, as today's
  relocated home saves it, each reached from `R` through a link (sealantd stores a link as a link):
  - Claude: `projects/` (transcripts, tool results, sub-agents, auto memory), `plans/`, `todos/`,
    `tasks/` (the agent's task list), the `agents/`, `commands/` and `skills/` the agent writes
    (Mend's delivered skills are delivered again), `history.jsonl`;
  - Codex: `sessions/`, `archived_sessions/`, `memories/`, `session_index.jsonl`, `history.jsonl`,
    `rules/` (approvals), and its thread index and memory database (`P/codex-db`, named by
    `CODEX_SQLITE_HOME`; see Performance);
  - pi: `sessions/`, `settings.json`;
  - opencode: its data directory and `.local/state/opencode`.

  Logins stay out: they are files in `R`, not under these links, and sealantd's tables are the
  backstop. So does Claude's file history (`file-history/`, what `/rewind` restores): it holds a
  copy of every file Claude edits, secret files included, so it is never saved, here or anywhere
  else, `people/*/` included (`HARNESS_CREDENTIALS`, sealantd#136 and #144). It stays in `R` and
  ends with the executor. Mend's per-person saved records are `P/.mend-saved/`, addressed by their
  absolute path, never through `~/.mend`.

- **The conversations a session shares,** `P_owner/conversations/<session id>/` (`C`): owned by the
  session's owner, group `mend`, setgid, mode 2770 with a default ACL granting the group `rwX`,
  under `P/conversations/` (2710). Claude creates its transcript 0600, which masks the ACL, so Mend
  restores group access before each process of the session starts (a `chmod -R g+rwX C`, as the
  owner with only `CAP_FOWNER`, in the step that stages its harness directory, decision 6), and
  sealantd restores `C` group-readable and -writable whatever the recorded modes. `C`'s default ACL
  does not survive a restore: sealantd sets default ACLs only on the worktree root, `/opt` and
  `/var/cache` (decision 8). That is harmless: people's umask `0002` makes new entries
  group-writable, the setgid bit gives them the group, and Mend's per-process `chmod` repairs a file
  a harness made 0600.
- **The worktree is shared.** `/workspace/repo` and its git directory are owned by the change's
  owner and group `mend`, group-writable, setgid on directories, with a default ACL for the group;
  every restored entry inside them is root's, in group `mend`, with the owner's bits copied to the
  group, as sealantd restores them (decision 8), and people's umask `0002` keeps new ones so. Mend
  sets `core.sharedRepository=group` in the worktree's git config, and the image's `/etc/gitconfig`
  sets `safe.directory = *`, since files belong to several uids and git before 2.46 has no prefix
  wildcard for nested and linked repositories; with `sudo` open, a narrower list protects nothing. A
  file a tool creates with an explicit mode (`install -m 644`, `tar x`, `open(…, 0644)`) is not
  group-writable whatever the ACL; Mend repairs those in the worktree when another person's process
  starts there, and the next restore heals the rest. The repair is one root exec started after that
  process starts, off the critical path, and counted in the join's exec budget (Performance). It
  touches `/run/mend/repair.next`, walks the worktree and its git directory for entries changed
  since the last repair (`find -cnewer /run/mend/repair`: the ctime, which the kernel sets at
  creation, since `tar x` and every unpacking tool restore the archive's older mtimes), runs
  `chmod g+rwX` on them and `g+s` on directories, then renames `repair.next` over `repair`, so its
  own `chmod` does not make the next repair walk everything again. The first marker is made when the
  executor starts.
- **Toolchains are shared, credentials are per user** (decision 3).
- **`/root`** is root's: the image's own files. In the person layout Mend and Core write nothing
  personal there.

### 3. Toolchains: shared locations in the images, credential stores per user

Images install toolchains under `/opt` and their caches under `/var/cache`, owned by root and group
`mend`, mode 2775, and name them in the image's `ENV`, so every process inherits them. Built images
lose default ACLs set at build time, so sealantd sets the group's default ACL on those top
directories at boot, as root, when the person layout is requested; `sudo` runs with
`Defaults umask=0002, umask_override`; people's umask is `0002`. Anything one person installs is
then usable by everyone; a toolchain tree unpacked with explicit modes (mise, uv's Pythons, rustup,
Playwright) can be extended or repaired by another person only after a `chmod`, which their
`CAP_FOWNER` allows (decision 1), or with `sudo` (Known limits). Core's images change to:

| Tool                                                                | Shared (image `ENV`)                                                                                                                                                                                                                                 | Per user (in `R`, natively)                               |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| mise                                                                | `MISE_DATA_DIR=/opt/mise`, `MISE_CACHE_DIR=/var/cache/mise`, shims on `PATH`                                                                                                                                                                         | `~/.config/mise`, trust in `~/.local/state/mise`          |
| uv                                                                  | `UV_PYTHON_INSTALL_DIR=/opt/uv/python`, `UV_TOOL_DIR`, `UV_TOOL_BIN_DIR`, `UV_CACHE_DIR`                                                                                                                                                             | `~/.local/share/uv/credentials`                           |
| Rust                                                                | `RUSTUP_HOME=/opt/rust/rustup`, binaries in `/opt/rust/cargo/bin`; `/etc/skel/.cargo/registry` links to `/var/cache/cargo/registry`                                                                                                                  | `CARGO_HOME=~/.cargo` (`credentials.toml`, `config.toml`) |
| pnpm, npm, corepack, bun                                            | `PNPM_HOME=/opt/pnpm` (global bins in `/opt/pnpm/bin`, on `PATH`), `npm_config_store_dir=/var/cache/pnpm`, `npm_config_cache=/var/cache/npm`, `npm_config_prefix=/opt/npm-global` (on `PATH`), `COREPACK_HOME=/opt/corepack`, `BUN_INSTALL=/opt/bun` | `~/.npmrc`, `~/.bunfig.toml`                              |
| Browsers for tests                                                  | `PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright`, `PUPPETEER_CACHE_DIR`, `CYPRESS_CACHE_FOLDER`, `npm_config_devdir`                                                                                                                                    | none                                                      |
| Go, pip                                                             | `GOMODCACHE`, `GOCACHE`, `PIP_CACHE_DIR` under `/var/cache`                                                                                                                                                                                          | `~/.netrc`, `pip.conf`                                    |
| JVM                                                                 | `/etc/skel/.gradle/{caches,wrapper}` and `/etc/skel/.m2/repository` link to `/var/cache`                                                                                                                                                             | `~/.gradle/gradle.properties`, `~/.m2/settings.xml`       |
| nvm, pyenv                                                          | `NVM_DIR=/opt/nvm`, `PYENV_ROOT=/opt/pyenv`                                                                                                                                                                                                          | none                                                      |
| nix                                                                 | none: nix images run in the `shared` layout and take one person (their passwd is in the read-only store, the store cannot hold a setuid `sudo`, and non-root nix needs the daemon)                                                                   | `~/.config/nix`                                           |
| gcloud, AWS, kubectl, Docker, gh, Hugging Face, firebase, git, curl | none                                                                                                                                                                                                                                                 | their usual paths under `~`                               |

`sudo` keeps the toolchain variables (`Defaults env_keep`), so `sudo npm i -g` lands where a
person's own install would. A tool not in the table keeps its state under the user's home: per
person, by default. What each base lacks today, which Core's image PRs add: Ubuntu 24.04 `sudo` and
`acl`; Arch (Mend's default) `sudo`; Fedora 41 `acl` and `util-linux` (`setpriv`); the MicroVM
images the same as their bases. A custom image that installs toolchains under `/root` keeps them
root's; Mend makes `/root` traversable (0755) in the person layout so they still run, and each
person's own installs land in their home (Known limits). A custom image without `sudo`, `useradd` or
ACL support runs in the `shared` layout and takes one person; a worktree that is already `person`
refuses it (decision 14).

**A pnpm tree belongs to the layout that installed it.** pnpm records its store in
`node_modules/.modules.yaml`, and the two layouts use different stores (root's environment is the
image's as before; a person's comes from `person-env`), so a tree installed in one layout and used
in the other fails, in both directions (`ERR_PNPM_UNEXPECTED_STORE` on pnpm 10 and 11; sealant#330).
So Mend keys the project's dependency cache by layout as well as platform (or by the store a tree's
`.modules.yaml` records), and never serves one layout's tree to the other. When a worktree first
moves to a `person` executor and its tree records another store, Mend runs
`pnpm install --force --prefer-offline` once, as the launcher (who runs dependency installs), before
setup commands. It is paid once per worktree, on its first `person` launch.

### 4. Git, SSH and the Mend identity

- **The Mend identity.** Each (launch, person) gets its own session-channel token, written 0600 to
  `~/.mend/session-token`; `MEND_SESSION_ID` names the session the process belongs to, and
  `MEND_SESSION_TOKEN_FILE` names the token's file, since a process may run with another `HOME` (a
  shared Codex conversation's app-server). The shim and the helper read the token from there, and
  never fall back to the container-wide token or a socket. A person's process Mend started without
  that environment (a setup command, the dependency install, a Remote-SSH login) finds the file in
  its passwd home, read from passwd, never `$HOME`.
- **The token reaches the home through a pickup, never an exec's arguments** (Core keeps every
  exec's argv; ADR 0010 decision 5, mend#555). The exec that makes a person (prepare for the
  launcher and every member it makes, the first process for anyone else) carries one single-use
  pickup ticket per person, purpose `session-token`, bound to that person, the session and the
  launch. Inside the same exec, node redeems it over the session channel, writes the token through a
  pinned directory and gives it to the person, and sets the person's git author as them (below). A
  redemption that fails for a passing reason is tried once more: a ticket whose answer failed goes
  back, redeemable again, and a retry from the same channel whose answer was lost gets that same
  answer, never a second token and never a theft warning. A person who still cannot be given their
  identity refuses the launch with words to try again, never to change the image. The token is
  minted when the ticket is redeemed, so a person prepare does not make gets none, and a ticket left
  unredeemed dies with its exec. A person's token redeems only that person's tickets.
- **What the server accepts.** A person's token, only with a session id that is live in that
  launch's executor and that the token's person may act on: they may steer it, are still a member of
  its organization, and can see its project; checked on every request. Its row names no session
  (`person:<account>`), so no older Mend takes it for a session's own token. It is revoked with its
  launch, and when the person's logins are released (Delivery 14). The container-wide token is for
  sealantd's capture channel and the launch's pickups only, and the server refuses it on
  `/git/transport` and on every helper route. A capture-mode executor has no token-less
  `/run/mend/mend.sock`.
- **Flag off, nothing read.** Mend reads once at startup whether any launch or worktree has a layout
  recorded. With the flag off and none, every launch is `shared` and no layout is read from the
  store, by any launch, join, process start or channel request, until one is recorded.
- **No shared login in a person's environment.** Until Core stops putting the launcher's
  `GITHUB_TOKEN`, `GH_TOKEN` and `CLAUDE_CODE_OAUTH_TOKEN` into the container (Deliveries 7–8),
  every process Mend starts as a person has them set empty; sealantd withholds the named logins from
  a person's process as well (decision 1).
- **Git over SSH** to origin goes through the shim; the server signs as the token's person, with
  their Mend key or their own bridge.
- **The helper** (`mend land`, `repo add`, `runService`, `runServiceRecipe`) authorises the token's
  person under that person's rules: only the change's owner lands (ADR 0007), only the owner runs a
  command in a terminal session (ADR 0013). A Service runs as the person who started it, and so does
  its restart, whoever asks for it: a steerer who restarts the owner's Service sets off a process on
  the owner's logins, as the API already allows.
- **Git over HTTPS to GitHub** uses Mend's credential helper, `/run/mend/bin/mend-git-credential`
  (system config for `https://github.com`), which reads `~/.config/gh/hosts.yml` in the user's
  passwd home, the file Core writes. No `gh` needed in the image. `mend-git-credential token` is for
  a command that needs the token (`GH_TOKEN=$(mend-git-credential token) gh …`), so it never reaches
  a terminal.
- **Git author and config.** `git config --system user.*` is no longer written. The person's author
  goes into Mend's own file, `~/.mend/git-author` (a `[user]` section, empty when they have none),
  rewritten at every identity pickup, so a changed setting applies at the next one. Their
  `~/.config/git/config` includes it at its very top, added once, as the person, through a link
  their dotfiles made, under git's own `config.lock`: every `user.*` they set themselves (their
  dotfiles, `git config --global`) comes after it and wins, nothing else in the file changes (a
  leading BOM, which git reads only at byte 0, is dropped; the mode is kept), a file git cannot
  parse is left alone and reported, and a failure never fails the launch. When the include cannot be
  added, the author is set in the file directly where it sets none, and that is reported. Git finds
  the file through `$XDG_CONFIG_HOME` or `$HOME` (a tool that moves them commits with no author);
  the person's `~/.gitconfig` wins over it, as global config wins today.
- **SSH, `scp`, `sftp`, `ssh-keygen`, GnuPG and the JVM** read the passwd home, which is the
  person's. No wrapper.

### 5. Logins: one Core primitive, a home for each person

**No person ever runs on anyone else's login.** One Core call puts a given person's logins into a
given home of a running workspace, owned by that home's user, and keeps them refreshed.

```
POST   /v1/workspaces/:id/credentials   { onBehalfOf, home, claude?, codex?, github? }
DELETE /v1/workspaces/:id/credentials   { home }
GET    /v1/workspaces/:id/credentials   → the homes, each with its person and accounts
workspaces.create({ …, credentialsHome })
```

- **Built on sealant#315 and sealant#316.** #315's resolution as at create, copy without a refresh
  token, write over the control connection, record the push follows, unchanged spec and service-key
  authorisation carry over. Its switch semantics go. It gains:
  - `home` (absolute, outside `/workspace`, no `..`, no link on the way; a person's home, a
    conversation home under `/run/mend/conv`, or `/root` for a `shared` executor's launcher when a
    predicted `person` layout fails at prepare, decision 1); files are written owned by the home
    directory's owner, 0600;
  - the record per instance and home: one person and one account per provider while held. A POST
    naming another person for a held home is refused (409 `home-held`). A home is released (DELETE,
    which removes the files and the record) and taken again only while no process uses it;
  - GitHub as a provider, written as `<home>/.config/gh/hosts.yml`;
  - pushes, POST and DELETE for one (instance, home) under one row lock, re-read before each write.

  #316 is needed as it is: a setup token in the environment is one value for the whole container.

- **New in Core:** `credentialsHome` on create (no login in the environment); `DELETE`; `GET`;
  credential sync-back reads each record's home.
- **Who owns what Core writes before the user exists.** The launcher's logins are written at create,
  before prepare's first exec makes their user, so the create names the owner by number:
  `credentialsHome: { path, uid, gid }`. Core makes a missing home owned by `uid:gid`, 0700, seeded
  from `/etc/skel`, and writes every file (0600) and every directory it makes as `uid:gid`; a
  numeric owner needs no passwd entry. Every later write (a POST, a refresh push) takes the owner of
  the home directory as it stands, which is the user's from then on. Mend's side holds without that:
  when prepare or a person's first process makes a user whose home already exists, `useradd` keeps
  the directory, copies nothing from `/etc/skel` and changes no owner, so Mend copies the skeleton
  in without replacing anything and gives the user everything in the home (`chown -hR`) before any
  process runs as them. A POST into a home that does not exist yet is refused (`home-unusable`), so
  a joiner's POST runs beside their `useradd` only once POST takes the same `{ uid, gid }` and makes
  a missing home as create does; until then Mend makes the joiner's user first and posts after it.
- **Authorisation.** A service key acting for the workspace's owner may write any `onBehalfOf`
  person's login. Mend enforces that a login goes only into that person's home, or into a
  conversation home while that person's process is about to run there (decision 6).
- **How Mend uses it:** `credentialsHome = { path: /home/<launcher>, uid, gid: 40000 }` at create
  when the launch is `person`, `$HOME` when it is `shared` (decision 1 decides which before create);
  one POST before a person's first process in an executor, in parallel with their user, dotfiles and
  deliveries; a refusal before anything is written when the needed provider is not connected or
  `invalid` ("Connect Claude to start a session here"); DELETE when a person's last process ends,
  retried, except the launcher's create-time home, which stays while the executor lives (their
  Remote-SSH session uses it with no Mend process); reconciliation against `GET` at startup; one
  re-POST after an authentication failure. Every POST is partial (`partial: true`): what the person
  has connected is written, what Core leaves out (`skipped`) is not asked for again, a provider the
  harness needs refuses the start, and a join is exactly one Core call. In a `person` executor Core
  writes pi's and opencode's ChatGPT logins too (`pi` and `opencode` on the POST, made from the
  person's Codex account), following opencode's link back into the home, and a release removes them
  with the rest; the session line says when Core left one out. In a `shared` executor Mend's
  ChatGPT-login program still writes the copies at `$HOME`, since a create cannot name them.

### 6. Steering: one shared conversation, each turn on its sender's login

Shared control lets Bob send turns to Alice's conversation. The conversation stays one thread both
people drive. When the sender changes, Mend hands the conversation to an agent process running as
the new sender's user, on their login.

- **The conversation moves into `C` when shared control is turned on.** At the conversation's next
  quiescent point (below), Mend moves its files from Alice's saved directory into
  `C = P_alice/conversations/<session id>/`, never overwriting: Claude's transcript, its `<id>/`
  directory and its task list; Codex's rollout and its sub-agents' rollouts. From then on every
  process of the session reaches it there. The files belong to the session. Nothing is deleted when
  a steer ends. A session that has been under shared control ("once shared": from the move into `C`
  on) keeps its conversation in `C` and its agent in the neutral context until the session ends (it
  is archived or deleted; a Stop does not end it), also once control is turned off, so its files
  never split between `C` and a personal directory (Known limits). Everything below that says "a
  shared session" means a once-shared protocol session.
- **The conversation home.** Every agent process of a once-shared session runs with its harness
  directory at one fixed path, `/run/mend/conv/<session id>` (`H`), outside every capture root:
  `CLAUDE_CONFIG_DIR=H/.claude`, or `CODEX_HOME=H/.codex` and `CODEX_SQLITE_HOME=H/.codex`, never
  the sender's saved Codex index (so the owner's thread never enters the steerer's saved index or
  memory). `H` holds:
  - links that place the conversation in `C`: Claude `projects/`, `plans/`, `todos/`, `tasks/`,
    `jobs/` and `teams/`; Codex `sessions/`, `archived_sessions/` and `session_index.jsonl`. Each is
    one link at the top; everything below is a real directory in `C`, which Claude requires for tool
    results and where Codex writes sub-agent rollouts. The task list survives a change of sender.
    Codex's `history.jsonl` (the TUI's prompt history, which Codex re-`chmod`s to 0600 on every
    append) is not linked: it stays in `H` and ends at the next change of sender. Neither is
    Claude's `file-history/`, which is never saved (decision 2): it stays in `H` and ends at the
    next change of sender too;
  - the sender's login, written by Core (POST with `home: H`, `onBehalfOf: sender`), owned by the
    sender;
  - Mend's seeded settings for the neutral context below.

  Mend stages the next process's seed in a sibling (`H.next`, made owned by the sender, 0700, so the
  login Core writes there comes out as the sender's) while the old process stops, so nothing is
  written into a live process's directory. The old process has exited when its process group and
  cgroup are empty: Codex's plugin and git children can outlive the app-server. Then two Core calls
  and one start: DELETE releases `H`'s login (Core refuses a POST for another person on a held
  home), `H` and `H.next` are exchanged in one `renameat2(RENAME_EXCHANGE)` and the old directory is
  removed in the background, Core writes the sender's login (POST), a `chmod -R g+rwX C` as the
  owner with only `CAP_FOWNER` restores group access, and the agent starts. The agent's environment
  is built the same way as for any process of that person (`PATH`, shims, toolchain variables),
  shared or not.

  Absolute paths a harness records in the conversation (Claude's `persistedOutputPath`, sub-agent
  transcripts) point under `H`, the same path for every person, and resolve to `C` whenever a
  process of the session runs. What a process wrote under `H` but outside those links (a refreshed
  `.credentials.json` with MCP tokens, approvals, Codex's databases, a Codex goal or queued prompt)
  is that person's per-process state and ends at the next change of sender.

- **Neutral context.** In a once-shared session the agent runs with neither person's personal memory
  nor personal instructions, only the project's, so nobody's private notes enter the shared history.
  - **Claude** (`H/.claude`, seeded): no `CLAUDE.md`, `rules/`, `agents/`, `commands/`, `skills/`,
    `output-styles/`, `plugins/`, `workflows/`, `routines/`, `agent-memory/`, `loop.md` or hooks; no
    user MCP servers in `.claude.json`, and never `hasClaudeMdExternalIncludesApproved`, so a
    repository `CLAUDE.md` cannot `@~/`-import a personal file; `settings.json` with
    `autoMemoryEnabled: false`. The switches go in Mend's settings, passed inline as JSON with
    `--settings '<json>'` (no file, so nothing has to exist in an executor prepared earlier):
    `autoMemoryEnabled: false` and `env` with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`,
    `CLAUDE_CODE_DISABLE_ORG_MEMORY=1` (organization memory comes from the login, not from files),
    `CLAUDE_CODE_DISABLE_CRON=1` and `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. Claude applies the
    `--settings` `env` over the process environment, so a repository's `.claude/settings.json` or
    the worktree's `settings.local.json` with `"env": {"CLAUDE_CODE_DISABLE_AUTO_MEMORY": "0"}`
    would otherwise turn memory back on (and `""` for the cron switch, the cron tools); flag
    settings rank above project and local settings, so Mend's win over both (verified 2026-10-06
    against 2.1.289: with `--settings`, no memory section, no memory directory, no cron tools and no
    personal canary in the request, whatever the repository or local `env` says; and again on
    2026-10-07 against 2.1.292 with the settings inline). The same variables are also set in the
    process environment, for older Claude versions. What loads is the repository's: `CLAUDE.md`,
    `.claude/` (settings, agents, commands, skills, rules, hooks) and `.mcp.json`, with the sender's
    approvals and MCP logins in `H`. Skills Mend delivers for the project, not the person, are
    placed.
  - **Codex** (`H/.codex`, seeded): no `AGENTS.md`, `AGENTS.override.md`, `rules/`, `hooks.json`,
    `agents/`, personal skills, `.env` or `memories/`; `config.toml` with the session's model,
    `features.memories=false`, `features.plugins=false` (otherwise every fresh `H` starts Codex's
    curated-plugin sync, a `git clone` that outlives the app-server and writes into the old `H`), no
    personal `mcp_servers`, and `[shell_environment_policy] set = { HOME = "<sender's home>" }`. The
    app-server itself runs with `HOME=H`, so Codex's `$HOME/.agents/skills` root finds nothing
    personal, while the agent's tool commands run with the sender's home. MCP servers and Codex's
    own git calls see `HOME=H`. What loads is the repository's `AGENTS.md` and its trusted `.codex/`
    configuration (verified 2026-10-06 against 0.160: no personal canary reaches the request).
  - Memory is read back for nobody from a once-shared session's process (decision 9).
  - What Alice's agent loaded into the conversation before shared control was turned on (her memory
    and instructions included) stays in its history, which a steerer's process reads. The Shared
    control switch says so before it turns on.
- **Each turn on its sender's login.** The process that runs a turn runs as its sender's user, with
  their login in `H`, their git and Mend identity in their home, and their secret files. The payer
  of every turn is the person its process runs as: a sender's turn, a turn the harness opens itself,
  and a turn Mend starts (a keep-alive, a landing follow-up), which runs as the owner.
- **A new sender waits for the previous sender's background work.** When the next queued turn's
  sender is not the person the conversation's process runs as, dispatch waits until that process is
  quiescent, and nothing is killed. Both people see the waiting line: "Waits for Alice's 2
  background tasks, 1 sub-agent and a goal to finish before Bob's turn starts."
  - **Claude quiescent:** no open turn; `session_state_changed: idle` (Claude launched with
    `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`); an empty `background_tasks_changed` set, refreshed
    with a re-`initialize` after an attach or rehydrate; no task Mend saw as `paused` in
    `task_updated`; no pending `ScheduleWakeup`, no live `Monitor`, no session cron; then no settle
    once Claude has reported `session_state_changed: idle` with no new `system/init` or turn after
    it. Mend's Claude adapter handles `background_tasks_changed`, `session_state_changed` and tasks
    first reported outside a turn, which it drops today.
  - **Codex quiescent:** no running turn on the thread or on any thread it spawned (sub-agents; the
    app-server reports `turn/*` for child threads); an empty `thread/backgroundTerminals/list`; no
    active goal (`thread/goal/get`); then a settle of 1 s after the last `turn/completed` or
    `item/completed` with no `turn/started` (goals, the mailbox and queued prompts start turns on
    their own after `turn/completed`). `app-server` is initialised with
    `capabilities.experimentalApi`.
  - **The stop:** decide, re-check after the settle; then prepare the next process (the sender's
    login, their user, the conversation's take) and, right before the stop, ask once more whether
    the turn still waits and the process is still quiescent. If not, nothing is stopped or written,
    the take goes back to the old process, and the turn waits again. Then close stdin. A
    `turn/started` between that check and the exit is the old process's turn; the new process starts
    only after the old one has exited. A Codex turn that starts on its own after stdin is closed (a
    goal or a queued prompt) is aborted by Codex; Mend records it on the conversation as
    "interrupted by the hand-over", under the old person.
  - **Who can end background work:** the person the process runs as, and the session owner, from the
    waiting line: Claude's task stop (a monitor's too), Codex `thread/backgroundTerminals/terminate`
    and `thread/goal/clear`. A wakeup ends on its own within an hour. A session cron is waited for
    at most 10 minutes and then ends with the process, which the session line says. An agent that
    will not say what it runs is never stopped on a guess: after a minute the waiting turn fails
    with words and the agent goes on. A Codex initialised without `experimentalApi` (started before
    shared steering) takes its owner's turns only until it ends or restarts. The sender, or the
    owner, may withdraw the waiting turn.
  - **The agent's questions** (permission prompts, free-text questions) are answered only by the
    person its process runs as: an answer continues a turn on that person's login. Anyone else is
    told "Only Alice can answer this; send a turn instead." Turns keep their order: a waiting turn
    holds the ones behind it.
  - **Scheduled prompts:** Claude processes of a once-shared session start with
    `CLAUDE_CODE_DISABLE_CRON=1` in the neutral settings, so none creates or fires a cron there. A
    durable cron lives in the worktree's `.claude/scheduled_tasks.json` and fires in whichever
    Claude process next holds its lock in that worktree, so in a person-layout executor only the
    worktree's change owner's own processes run with crons on: anyone else's personal Claude
    processes start with the inline `no-cron` settings (`env` with `CLAUDE_CODE_DISABLE_CRON=1` and
    `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`), so a repository's `env` cannot turn crons back on,
    and they have no scheduled prompts (`CronCreate` and its kin are not offered) in that worktree.
    The owner's own personal processes get the inline `personal` settings, with only the
    session-state switch. When shared control is turned on, the session's session crons are
    background work the switch to the neutral context waits for.
- **One live agent process per conversation,** recorded in Postgres by (launch id, process id),
  taken by every start path (dispatch, handoff, takeover, resume, retained run, follow-up), released
  only when the platform reports the process exited or the executor ended. An unreachable executor
  means wait, never a second process. A turn submitted between a stop and the next start queues on
  the conversation, not on the stopping process.
- **Handoff and takeover** (protocol to terminal and back, `mend attach`) follow the same waiting
  rule, and start the new process as the person attaching. They no longer cancel open turns.
- **Resume never forks.** Claude resumes by the full path of the conversation's file; Codex with
  `thread/resume { path }`. A resume that fails fails the turn; this path never falls back to
  `thread/start` or a new Claude session. The Codex adapter's fallback to `thread/start` after a
  failed resume (`codex.ts:548-550`) is removed in both layouts, flag or not: a resume that cannot
  find its thread fails the turn ("Codex could not find this conversation's thread. Nothing was
  sent."), and starting a new conversation is the person's explicit choice, never a silent one. This
  is the one change Delivery 12 makes without the flag. A worktree that has been `person` never runs
  `shared` (decision 14), so its saved conversations are never resumed where they cannot be found.
- **Hidden reasoning from another account.** The owner has seen providers accept a conversation
  replayed under another account, and the design assumes they do. If a provider ever rejects a
  request because of opaque, account-bound items made on another account (Codex
  `invalid_encrypted_content` on a reasoning or remote `Compaction` item, an Anthropic
  thinking-signature error), the turn fails with the provider's reason and nothing is retried:
  "Bob's turn failed: OpenAI refused reasoning made on Alice's account. Alice can continue the
  conversation." The conversation is untouched. A safe retry would have to rewrite the conversation
  in place (Claude thinking entries re-parented onto their parents; Codex reasoning items dropped
  and a remote compaction replaced by a visible one under the new account);
  `thread/resume { history }` forks a new thread and is marked not for use, and a copy breaks
  Claude's parent chain. That rewrite is a follow-up, built only if a rejection is ever seen.
- **Refusals and cancellations:** a steerer with no login for the provider is refused at submit (ADR
  0013); turning shared control off, or removing the steerer from the organization, cancels their
  queued turns; automatic landing follows the owner's own turns only; Slack checks the sender's
  login.
- **Terminal sessions** stay as ADR 0013 and mend#518 made them: only the owner types. The Shared
  control switch on a terminal session moves nothing into `C`, starts no conversation home and
  neutralises nothing: its agent keeps running as the owner with the owner's memory and
  instructions. Everything in this decision about `C`, `H` and the neutral context applies to
  protocol sessions.
- **opencode is a one-person harness.** It is not supported under shared control: turning shared
  control on for an opencode session, or sending a turn to someone else's, is refused: "opencode
  sessions are one person's. Shared control is not available for them; start your own session in
  this worktree." It never runs in a conversation home, and nothing in this decision applies to it.
  pi, also terminal-only, follows the terminal-session rule above.

### 7. Joins

A person who starts a session in a worktree where another person's session runs gets their own
processes in the same executor, as their own user: home, logins, dotfiles, git and Mend identity, pi
profile, skills, memory, secret files, saved directory. Two people work live in one worktree, on one
change. ADR 0010's "a joiner receives no secret files of its own" and ADR 0009's "what a joined
agent writes goes to the executor's owner" no longer hold.

### 8. Saving and restoring per person (sealantd)

- **Each person's saved directory is saved and restored per person.** sealantd records mode and
  mtime, not owners, and today restores as root. It gains an owner map, passed in the capture spec
  at launch (`people/<account id>` → uid for each current member, the change owner's uid for the
  worktree, and the shared gid). On materialize, in the `chmod` it already makes for each entry:
  - in `tree/`, the bulk class, the git section and every `people/<id>/conversations/`, the owner's
    read, write and execute bits are copied to the group (never write without read), and directories
    get setgid (a raw `fchmod` would clear it): a 0600 file comes back 0660, never 0620, and a 0700
    directory 2770. The worktree metadata overlay does the same, so tracked files get it too. Every
    existing capture was made by root with umask 022, so its files are 0644 and its directories
    0755; restored as recorded under a default ACL they would be masked to read-only for the group;
  - `people/<id>/` is owned by that uid and the `mend` group, `P` itself 0710; `conversations/`
    entries are group-readable and -writable whatever their recorded mode (Claude records its
    transcripts 0600); every other entry under `people/<id>/` keeps its recorded mode, with nothing
    added, so a person's own transcripts, memory and `codex-db` stay theirs (decision 2);
  - the roots of `tree/` and the git section are owned by the change's owner and the `mend` group,
    with the group's default ACL on each root; every entry inside them stays root's and takes the
    group from the setgid root, so nothing else is `chown`ed.

  It applies the same to a file it reuses. Boot, before the restore, gives the worktree root to the
  change's owner and the group (group-writable, setgid) and sets the group's default ACL on it and
  on the image's `/opt` and `/var/cache` with one `setfacl`; a filesystem without ACLs is logged and
  the boot goes on, which prepare's probe catches (decision 1). Captures still record no owner:
  ownership comes from the path and the map, so a uid can change without touching a capture. A
  removed member's directory gets no entry in the map: it stays in the captures, owned by root, and
  no user is made for it.

- **Prepare checks that the restore applied the map.** In a `person` executor, before anyone is
  made, prepare reads the restored worktree's group (`stat -c %g /workspace/repo`; sealantd gives it
  to the change's owner and group `mend`, and `capture.status` reports `ownerMap`, sealantd#145), in
  the exec it already makes (mend#552). A worktree that is not `mend`'s came back root's, 0644:
  nobody could edit a restored file and the worktree repair never reaches it. The launch is refused
  with what was found, whatever the worktree, and nothing runs: "This workspace's restore did not
  give its files to the people working in it (the restored worktree's group is 0, not mend (40000)),
  so nobody could edit them. Nothing was started; the next launch tries again." Nothing is recorded
  against the image, and there is no fallback to `shared`.
- **sealantd reports what it can do** (`exec.user`, `dotfiles.user`, `restore.owner_map`, also
  offline through `sealantd capabilities --json`), and Mend records the `person` layout only when it
  does (decision 1).
- **The owner map also decides no-new-privileges.** sealantd sets no-new-privileges on itself (its
  plan §18) in every executor but a per-person one: a root daemon whose capture spec carries an
  owner map naming at least one person skips it, at boot and in its runtime, so every person's
  `sudo` works and their processes hold `CAP_FOWNER` (decision 1). Such an executor is root by
  design, not a sandbox; its boundary is the executor. Every other executor, and every launch
  without a map, keeps no-new-privileges. Boot logs its posture and `runtime.getCapabilities`
  reports `noNewPrivileges` (absent means unknown) (sealantd#148). A launcher passes a map only for
  a `person` launch.
- **Logins are never saved.** The homes, conversation homes and `/run` are outside every capture
  root. sealantd applies `HARNESS_CREDENTIALS` and `HARNESS_MACHINE_STATE`, sibling-suffix rule
  included, under each `people/<id>/` as well as at the root: load-bearing for anything a
  link-breaking write leaves in `P`.
- Codex's thread index and memory database are saved in `P/codex-db`, as today's relocated home
  saves them, so ADR 0009's read-back from the capture stands; Codex's logs database (`logs_*`) and
  every `*-shm` file are machine state, not saved (SQLite rebuilds a shared-memory index, and a
  stale one restored beside a different WAL is the risky case). The WAL files are saved.

### 8a. The opencode in-app login: a documented exception

Decided by the owner on 2026-10-06.

opencode 1.18.34 keeps its conversations in a SQLite database that resume needs, so it is saved in
`P`. The same database holds `account` (written only by `opencode console login` and
`opencode login`), `credential` (written through the `/api/integration/*` and `/api/credential/:id`
routes that every opencode server mounts, called by the desktop and web clients), `control_account`
(legacy, unwritten) and `session_share.secret` (a public share's update key). The TUI's `/connect`
writes `auth.json`, in the home. opencode is a one-person harness (decision 6): only its owner's
processes open `P_X`'s database.

**A login a person makes inside opencode stays in their own opencode data, which only their own
sessions use.** Mend deletes those rows when opencode exits: as the person's user, with
`node:sqlite`, it deletes every row of `account`, `control_account` and `credential`, nulls
`session_share.secret`, runs `VACUUM` and `PRAGMA wal_checkpoint(TRUNCATE)`, and closes. It does the
same in the layout step before that person's opencode starts and at prepare for every restored
`people/*/` database, for an exit Mend did not observe. A scrub that fails is reported on the
session line and the database left as it is.

This is a narrow exception to "logins are never saved": such a login is in the captures taken while
that opencode process ran, in that person's own directory, where anyone working in the worktree can
read it. Known issues says so. sealantd scrubbing those tables from captures is a follow-up
(PLATFORM-FEEDBACK 2026-10-04).

### 9. Memory per person (replaces mend#528's hand-over)

- **Delivery** (ADR 0009 decision 2) writes a person's memory into their own home, which links into
  `P`, at the starts of their processes of sessions that were never shared.
- **Read-back** runs when a process ends, for the person it ran as, from `harness/people/<person>/`,
  for processes of sessions that were never shared. A once-shared session's processes credit nobody,
  also after control is turned off, until the session ends.
- **Codex** builds memory only from rollouts in the person's own `sessions/` and their own thread
  index; `withholdCodexThreadsExec` goes. A shared session's processes use
  `CODEX_SQLITE_HOME=H/.codex`, so a conversation in `C` enters no person's saved index (decision
  6).
- **Goes:** the hand-over at launch, its forced capture, `.mend/agent-memory-owner`, new
  `agent_memory_homes` writes. The table stays for the migration until 0.37.

### 10. Remote-SSH and processes Mend does not start

- **VS Code Remote-SSH runs as the launcher's user.** Core's gateway admits only the workspace's
  owner, the launcher, and runs the session as the user Mend names for the workspace at create
  (`sshUser`, new in Core). The extension, its terminals and the Claude Code extension then run on
  the launcher's logins, save into their `P`, and find their tools in their home. A joiner cannot
  open Remote-SSH into an executor someone else launched. sealantd's `openSftp` takes no user yet,
  so an SFTP bridge runs as root; it gains one with Core's `sshUser` (Follow-ups).
- **Anything else** (`docker exec`, a custom image's own entrypoint work) runs as root, which is no
  person: `/root` holds no login and no Mend token, and nothing written under `/root` is saved.

### 11. Secret files and dotfiles per person (amends ADR 0010 decision 3)

- Each person's secret files go into their own home, as their user, joins included, through a pickup
  ticket bound to that person, never exec argv (mend#555; ADR 0010 decision 5); the delivery record
  (`~/.mend/secret-files`) is per person. `.config/gh/` and `.config/git/` are reserved.
- **Dotfiles apply for every person, as that person, scripts included.** sealantd's applier
  (repository clone, chezmoi, stow or copy, then `./install.sh` when the person's `bootstrap`
  setting is on) runs as the person's user into their home, through sealantd's `dotfiles.apply`
  verb, for every person, the launcher included. There are no user dotfiles at boot: boot applies
  only root's, into `/root`, and a `person` launch passes none (sealantd#147). The verb runs once
  prepare, or a joiner's first process, has made the person's user, and before the link step that
  places their saved directories and Mend's files in their home, so Mend's links win over anything
  the dotfiles put there. It is serialised per person (one apply at a time for a person, however
  many of their processes start together) and bounded in time. It runs in parallel with the person's
  login and deliveries. A joiner's agent starts once the files are applied, and `install.sh` runs
  beside it ("install.sh running" on the session line, and "finished after the agent started" when
  it does), so a join stays inside its budget (Performance). An agent started that way does not see
  what `install.sh` installs or changes later (Claude snapshots the shell profile at start). A
  person who needs it first turns on "Start my agents after install.sh" (a per-person setting, off
  by default), and their joins then wait for it, outside the join budget. The launcher's agent
  starts after their `install.sh` ends, as it did when `install.sh` ran at boot. A script can
  `sudo`; that is the accepted limit, not a new one.
- Mend's default shell profile is written into each home.

### 12. Readers

Every reader goes by a prefix: `HARNESS_STATE`'s patterns become `^people/<id>/…` for a session that
was never shared and `^people/<owner>/conversations/<session id>/…` for one that was;
`harvestFromCaptureAlone`, `hasLiveHarnessState`, `locateLiveTranscript`, `readHarnessFileScript`,
`CARRIED_TRANSCRIPTS` and the opencode reader take that directory (opencode's always the personal
one, since it is never shared), skip links, and go by exact provider session id. Two sessions of one
person in one worktree still share a directory outside shared control; pinning provider session ids
at launch is a follow-up.

### 13. What the product says

While people share a workspace, everyone can read and change everyone's files with `sudo`, logins
included, and a person's saved conversations and memory are restored into every executor of the
worktree. Nothing of anyone else's is used by default, and no login is saved (decision 8a's narrow
exception aside), but it is not a boundary between people.

- **Where two people meet in a worktree** ("join a worktree" in the CLI, the composer's Worktree
  picker, the worktree's New session menu): "Anna's session is running in this worktree. You share
  its workspace: everything you run runs as you, on your own logins, but either of you can read the
  other's files, logins included."
- **On a session while another person's process is live in its executor:** "Shared workspace with
  Anna · each of you runs as yourself · either of you can read the other's files."
- **Beside the Shared control switch,** replacing "using your provider logins and Git access": "Each
  turn runs on its sender's login. From now until this session ends, the agent uses no one's
  personal memory or instructions. The conversation so far, including what your agent loaded before,
  becomes visible to whoever steers."
- The waiting line, wherever a turn shows.
- The API's session view lists the people live in its executor, so every client draws the same line.
- Known issues: "People in one worktree can read each other's files", and the limits below.

### 14. The layout per worktree, executors started before this release, and the migration

- **The layout is recorded per launch** (`harness_layout`: `person` or `shared`, null for launches
  before this release, which count as `shared`) **and per worktree** (`worktrees.harness_layout`,
  null until its first `person` launch). Every step goes by the executor's.
- **There is no way back from `person`.** The worktree's record becomes `person` in the transaction
  that records its first `person` launch, and never changes again; a head capture with
  `harness/people/` counts as `person` even without the record. From then on its saved sessions,
  memory and Codex index exist only under `people/`, which a `shared` executor's harness home,
  readers and memory delivery never reach. So every later launch of the worktree is `person`,
  whatever the flag says; the flag, and every fallback in decision 1, decide only worktrees with no
  layout yet.
- **A launch that cannot run `person` on such a worktree is refused with the reason, never run
  `shared`.** Before create when the capability is known (decision 1), at prepare otherwise (the
  executor is released and nothing has run): "This worktree's sessions are saved per person, and its
  image cannot run per-person users (no sudo). Pick an image that can, or start a new worktree." The
  same for a nix image, a uid or name collision ("uid 40001 is taken in this image"), a sealantd
  without the capabilities, and a runtime without ACLs. Nothing in the worktree is changed by the
  refusal; fixing the image makes the next launch work.
- **The benchmark and the gates choose the layout per launch, on fresh worktrees.** A session start
  that creates a new worktree takes an operator-only `harnessLayout` (`person` or `shared`),
  recorded in `harness_layout` with its source; it is refused on an existing worktree whose layout
  differs, and `person` is refused where the capability is missing. The benchmark makes a new
  worktree for every run of either layout, so gates P1 and P2 compare `shared` launches against
  `person` launches at one commit without flipping the instance flag, and the box's own worktrees
  never change layout under them.
- **A pre-release executor is replaced, never stopped under work.** When a worktree's next launch
  would be `person`, its live `shared` executor is marked to retire. Before an automatic replacement
  Mend marks it `retiring` (every new start refused, the launcher's included), then checks: no
  terminal agent, PTY or shell process, protocol agents quiescent (decision 6), no Service started
  by hand, nothing in `ps` that Mend did not start, no container in `docker ps` of the sidecar. Then
  it sends the final flush and replaces the executor only after the flush is saved; a failed check
  or flush unmarks it and says why. Otherwise the change's owner sees "Replace this workspace now"
  with what would stop: terminal sessions (they end resumable), shells, Services (`mend.toml` ones
  restart; ones started by hand are listed), running containers, processes Mend did not start. Until
  it is replaced, a join and a turn from anyone but its launcher are refused: "This worktree's
  workspace started before Mend 0.36 and shares one home; it takes another person once it is
  replaced."
- **The migration of an old shared home is a server-side job per worktree,** off every launch path.
  It reads a capture and records completion; it moves nothing and execs nothing. **Its completion
  names the capture it read,** and the capture that counts is the worktree's last `shared`-layout
  capture: the final flush of the last `shared` executor, saved before the first `person` launch. A
  run before that (while a `shared` executor still writes) is provisional: its record names the
  capture it read, and the job runs again over the newer capture when the worktree turns `person`.
  Since a `person` worktree never runs `shared` again, nothing written in the old layout comes after
  the capture the final record names, and nothing is stranded.
  - **Memory** goes to the person a saved `agent_memory_homes` record names; else, when every
    session the worktree had was one person's, that person; else nobody, listed on the worktree as
    "memory from before 0.36, not credited". A re-run credits only what the earlier run did not.
  - **Transcripts** of pre-release Claude, Codex and pi sessions are copied by exact provider
    session id from the last `shared`-layout capture into the session owner's `P` when the session
    resumes, only if absent.
  - **opencode conversations from 0.36 prereleases** (no released Mend could resume opencode) stay
    readable; nothing is copied, and the old database is opened by no one in the person layout.
    Their owner can resume them only in the pre-release executor that holds them, before it is
    replaced.

## Performance

The owner's rule (2026-10-06): no performance penalty for this feature. Every number below is a hard
limit. A limit missed blocks turning the flag on for the box and blocks the release; only the owner
grants an exception.

### What is measured

Everything this decision can affect, on the box, before and after, at the same commit base, with the
same project (Mend's own repository), the same image and the same harness versions:

- **Sessions:** a new session to the first agent output, for Claude, Codex, pi and opencode; a
  resume after a Stop; a second session of the same person in a live executor; a join by a different
  person; a steered turn, from the steerer's send to the first output, with the hand-over when the
  sender changes and nothing runs in the background.
- **Saves and restores:** the Stop's save; a checkpoint save during a turn; capture size per
  worktree and its growth per extra person; restore time and bytes.
- **Delivery and agents:** memory, skills and secret-file delivery; Codex's first start (its thread
  index); the first turn's latency.
- **Interactive:** opening a shell and a terminal; `git push` and `git fetch` through the shim;
  typing latency in the web terminal (keystroke to echo).
- **Resources:** executor disk and memory; Mend API latency for the session list and a session view.

### Budgets

Each limit applies to the median and to the 90th percentile of the runs, `person` launches against
`shared` launches at the same commit, each run on a fresh worktree (decision 14).

| Measure                                                                                                                                             | Limit                                                                                                         |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| New session to first output (each harness), resume, Stop's save                                                                                     | +5% or +1 s, whichever is larger                                                                              |
| Second session of the same person                                                                                                                   | +5% or +1 s, whichever is larger                                                                              |
| Join by a different person (against today's join, which runs as the launcher)                                                                       | +3 s                                                                                                          |
| Steering hand-over (send to first output, nothing in the background; both Core calls and Codex re-index included; a conversation of realistic size) | under 5 s more than the same turn sent by the process's own person                                            |
| Checkpoint save, restore time, first-turn latency                                                                                                   | +5% or +1 s, whichever is larger                                                                              |
| Restore bytes; capture size per worktree with one person                                                                                            | +5%                                                                                                           |
| Growth per extra person                                                                                                                             | that person's conversation state (decision 2, `codex-db` and its WAL included) and memory, plus at most 64 KB |
| Delivery (memory, skills, secret files) per person                                                                                                  | +5% or +0.5 s, whichever is larger                                                                            |
| Codex first start                                                                                                                                   | +5% or +1 s, whichever is larger                                                                              |
| Shell and terminal open, `git push` and `fetch`, terminal typing latency                                                                            | unchanged within noise: the larger of the baseline's spread (worst minus median) and 50 ms                    |
| Executor disk and memory with one person (memory: peak RSS of the executor's cgroup over the scenario)                                              | +5%                                                                                                           |
| Session list and session view API latency                                                                                                           | +5% or +20 ms, whichever is larger                                                                            |

### What the design does to stay inside them

- **No new Core call on the cold path:** `credentialsHome` at create. A join's `useradd` comes
  first; its Core call, dotfiles and deliveries then run in parallel, and only the agent start waits
  for them.
- **A joiner's `install.sh` runs beside the agent,** not before it: the agent starts when the
  dotfiles' files are applied, and the session line says "install.sh running" until it ends. The
  launcher's runs before their agent, as it did at boot.
- **Codex's thread index and memory database stay saved,** as they are today:
  `CODEX_SQLITE_HOME=P/codex-db`, so a first start does not re-index (up to 30 s otherwise). The
  logs database and the `*-shm` files are set aside as machine state.
- **sealantd's ownership costs no extra pass:** files under `tree/` and the git section take their
  group from the setgid root and their modes from the `chmod` sealantd already makes, with group
  write, group execute and setgid added (decision 8); the default ACL is inherited; only
  `people/<id>/` entries, a small tree, are `lchown`ed. Measured on a 148,732-file, 2.7 GB worktree,
  the owner map costs about +0.3 s at the median (+5.5%) and +0.4 s at the p90, inside the restore
  limit's +1 s. The cost is the kernel writing the inherited default ACL on each new inode, which no
  syscall count shows, so gate P1 measures restore wall time on the box's largest worktree,
  interleaved, on the box's own filesystem (sealantd#145).
- **The hand-over:** the settle is 1 s for Codex and none for Claude once it reports
  `session_state_changed: idle`; `H`'s seed is staged while the old process stops, so only the two
  Core calls (DELETE, then POST), the directory exchange and the start wait for the exit; Codex's
  plugin sync is off in `H`; Claude and Codex start directly, with no shell profile. The Claude
  settings go inline on the command line, so `--settings` adds no exec and no file.
- **The worktree repair is asynchronous:** one exec after another person's process starts, never
  awaited by it; its walk of the worktree (`node_modules` included) costs disk reads, not latency.
- **Removed from the launch path:** mend#528's hand-over (a capture read, an `sh` exec and a forced
  capture), the Codex withholding exec, and the migration (server-side).

### Method

- **A benchmark script in the repository** (`scripts/bench/`, Delivery 2), run against the box. It
  drives the box through the API and the CLI with two accounts, runs each gated scenario at least 10
  times, takes each step's time from the session record, the server's log lines and the capture
  records (as the 2026-10-03 Stop measurement did), and writes a JSON record and a table: the median
  and the 90th percentile per measure, with the commit, image, harness versions, project and the
  layout of each run. A measure that misses its limit has its whole set of at least 10 runs repeated
  (one extra run cannot move a median); it fails only if the repeated set misses again.
- **The gate compares `shared` launches against `person` launches at the same commit** (gates P1 and
  P2), on the same box, images and harness versions, so other 0.36 work neither hides this feature's
  cost nor fails its gate. The layout is chosen per launch on fresh worktrees, with the
  operator-only `harnessLayout` (decision 14); the instance flag is never flipped to take a record.
  Both records are checked in under `docs/perf/`.
- **The `shared` layout's own cost is gated too.** Deliveries 3, 4, 9 and 10 change behaviour for
  `shared` executors as well (the tables, the restore `chmod`, the images, the pins), which a
  `shared`-against-`person` comparison cannot see. Gate P1 includes a named check: `shared` launches
  on the new images and pins against gate B's record, in the same compare mode and budgets.
- **History** (gate B): the benchmark on the box at `0.36.0-next.601`/`602`, before any per-person
  code lands, checked in as `docs/perf/0016-baseline.json` and named in the decision log. It records
  the drift of the whole release; it is not the gate.
- **CI guards:** engine tests count the execs and Core calls of a cold launch, a join, a resume and
  a hand-over and fail when the count grows past its budget (cold launch: no more than today; join:
  at most two more synchronous execs than a same-person second session, plus the one asynchronous
  worktree repair; hand-over: two Core calls, DELETE then POST, one stop, one start). The `chmod` of
  `C` and the ACL step at boot are folded into existing execs, so they count nothing new. A layout
  test fails when the bytes written into saved state per person, outside conversation state and
  memory, exceed 64 KB; conversation state is decision 2's list, `codex-db` and its WAL included.
  `codex-db/logs_*` and `codex-db/*-shm` are machine state (Delivery 3), never saved, so they count
  nothing. No step is added to the launch path's synchronous part without a measured budget in its
  PR.
- **Every PR in the plan states its expected effect.** One that touches the launch, join, resume,
  Stop or capture path carries a `shared` and a `person` run of the affected scenarios, or the unit
  budget test that covers it.

## Known limits

- **Everyone can read and change everyone's files** with passwordless sudo (decision 13), and with
  the `CAP_FOWNER` every person's process holds in a per-person executor, which amounts to root
  (decision 1).
- **`docker exec` and processes Mend did not start run as root,** with no person's login, and what
  they write under `/root` is not saved.
- **VS Code Remote-SSH reaches only workspaces you launched,** as your user.
- **No `GITHUB_TOKEN` in the environment.** A repository `.npmrc` with `${GITHUB_TOKEN}` fails until
  the person exports `GITHUB_TOKEN=$(mend-git-credential token)`; a person's own `gh auth login` is
  overwritten by Core's next push.
- **A file another person's tool created with an explicit mode** is repaired in the worktree when
  someone else's process starts there; elsewhere it needs a `chmod` (`CAP_FOWNER`) or `sudo` until
  the next restore.
- **Custom images:** toolchains under `/root` run for everyone but take each person's installs into
  their own home; an image without `sudo`, `useradd` or ACLs takes one person.
- **Shared control:** a payer change waits for background work and holds the turns behind it, costs
  a process restart, ends "accept for session" approvals and MCP logins made in the steered process;
  no personal memory, instructions, skills or MCP servers apply while control is shared; scheduled
  prompts are off in a shared session; what the owner's agent loaded before sharing is in the
  history.
- **Scheduled prompts:** in a person-layout executor only the worktree change owner's own Claude
  processes have them; anyone else has no `CronCreate` there.
- **A conversation resumed by hand** while Mend's process for it runs gets two writers.
- **Personal config inside the worktree is shared by design:** `.claude/settings.local.json`,
  `CLAUDE.local.md`, `.env`, a repository `.npmrc`, `.mcp.json` env, and the worktree's
  `.git/config` and hooks (a remote URL with a token, or a `credential.helper` an agent writes, is
  used by the other person's `git push`).
- **A session once shared stays neutral:** after shared control is turned off, its agent still runs
  without the owner's personal memory and instructions, and its conversation stays in `C`. A new
  session has them.
- **Shared Codex conversations:** a goal, a queued prompt and the TUI's prompt history live in `H`
  and end at a change of sender.
- **Full tool outputs recorded before sharing:** the paths Claude recorded under the owner's home
  before the move into `C` no longer resolve, so those full outputs are not re-readable by path; the
  transcript keeps what it showed the model.
- **A rejection of reasoning made on another account fails the turn;** there is no retry.
- **Restored worktree files belong to root and the `mend` group.** Without `CAP_FOWNER` nobody but
  `sudo` could `chmod` or `utime` them, the change's owner included; a rewrite (`git checkout`, an
  editor's save by rename) makes them the writer's (sealantd#145). A person's processes hold
  `CAP_FOWNER` in a per-person executor (decision 1, sealantd#147 and #148), which is what lets pnpm
  relink a restored package's bins (`ERR_PNPM_CMD_SHIM_CHMOD` otherwise). A toolchain unpacked with
  explicit modes by one person can be extended by another only after such a `chmod`, or with `sudo`.
  `npm i -g` lands in `/opt/npm-global`.
- **A pnpm tree from the other layout** is reinstalled once
  (`pnpm install --force --prefer-offline`) when a worktree first runs per person (decision 3).
- **Sockets and files a tool leaves to the umask** are group-reachable outside the private `TMPDIR`
  and `XDG_RUNTIME_DIR`; within the accepted sudo limit.
- **nix images take one person.**
- **There is no way back from per-person.** A worktree that has run per person is always per person:
  an image that cannot run it (nix, no `sudo`, a uid clash) is refused for that worktree, and
  turning the flag off changes nothing for it; a new worktree can use that image. A Mend older than
  this release cannot resume its sessions.
- **A removed member's saved directory** stays in the worktree's captures, owned by root, with no
  user made for it.
- **A joiner's `install.sh` runs beside their agent** unless they turn on "Start my agents after
  install.sh".
- **Pre-release executors** keep the shared home until replaced; pre-release opencode conversations
  are not resumable in the person layout.
- **opencode is one person's:** shared control is refused for opencode sessions.
- **Claude's `/rewind` file history is never saved:** it ends with the executor, and in a shared
  session at the next change of sender, so `/rewind` cannot restore edits made before a move to
  another executor.
- **A login made inside opencode** (`opencode console login`, the integration routes) is saved in
  the captures taken while that opencode process ran, in that person's own directory; Mend deletes
  it when opencode exits (decision 8a).
- **Settings edited by hand** last until the executor ends; pi's and opencode's ChatGPT logins are
  refreshed by Core in a `person` executor, and at process start in a `shared` one.

## Consequences

- Two people work live in one worktree, each as their own user, and drive one conversation together,
  each turn on its sender's login.
- Commits, pushes, pull requests, MCP calls, cloud CLIs and publishes from a process are its user's.
- The owner's private memory and instructions stay out of a shared conversation from the moment it
  is shared.
- Core's images carry toolchains in shared locations, and every workspace has `sudo`.

## Follow-ups

- **Isolation:** no sudo for people, or an executor per person (ADR 0002's accepted relaxation).
- **Remote-SSH as the connecting person,** once Core's gateway admits more than the owner.
- **Provider session ids pinned at launch** (Claude and pi `--session-id`).
- **Claiming uncredited memory** from before 0.36.
- **sealantd scrubbing opencode's login tables.**
- **An SFTP bridge as the workspace's user:** `openSftp` with a user, set from Core's `sshUser`.

## Delivery

Ordered; each is one pull request; sizes are lines changed, tests included. Every PR states its
expected performance effect (**Perf**); one that touches the launch, join, resume, Stop or capture
path carries a before-and-after run of the affected benchmark scenarios, or the unit budget test
that covers it.

- **Gates.** **B, history recorded:** the benchmark has run on the box at `0.36.0-next.601`/`602`
  and its record is checked in, before any per-person code merges. **P, budgets met:** the
  benchmark's `person` launches meet every limit in Performance against its `shared` launches at the
  same commit, each on a fresh worktree, and P1 adds the `shared`-against-baseline check; it blocks
  turning the flag on for the box (P1) and blocks the flip and the release (P2). No exception
  without the owner.
- **Platform (3–10)** runs in parallel with Mend 11; 3 and 4 are load-bearing and must be in the
  box's images before its flag goes on.
- **Mend 12–16 are one stack behind `MEND_HARNESS_LAYOUT=person`** (default `shared`), built and
  exercised on a scratch instance. The flag decides only worktrees with no layout yet; a worktree
  that has run `person` stays `person` (decision 14). Codex's `thread/start` fallback on a failed
  resume is removed in 12, in both layouts. Until 18 lands, a steer turn in a person executor is
  refused with the reason.
- **The box turns the flag on** only when all of these hold: 3, 4 and 5 (sealantd) and 7, 8, 9 and
  10 (Core, the images and the pins) are released and in the box's images, rebuilt (cold launches
  pay one image build per project once); the box's executors report the sealantd capabilities of
  decision 1, and Core reports the capability for the box's images ahead of create; 12–17 have
  merged; and gate P1 has passed on the scratch instance. Turning it on changes only the layout of
  worktrees that have none yet.

1. **Mend · this ADR.** Amendment notes in 0003, 0009, 0010, 0013; PLATFORM-FEEDBACK. ~1,350. Perf:
   none.
2. **Mend · the benchmark (`scripts/bench/`).** A Node script that drives an instance through the
   API and the CLI with two accounts on Mend's own repository: every scenario in Performance, each
   gated one run at least 10 times, each step timed from the session record, the server's log lines
   and the capture records; a new worktree for every run; `--layout shared|person` passing the
   operator-only `harnessLayout` (from 12 on; without it the instance decides, as at gate B); a JSON
   record and a median-and-p90 table with commit, image, harness versions, project and each run's
   recorded layout; a compare mode that checks a `person` record against a `shared` one (or a
   baseline) and the budgets, repeats the whole set of a missed measure, and exits non-zero on a
   repeated miss. Unit tests for the parsing, the comparison and the re-run rule. M, ~800. Perf:
   none (tooling).

**B · Gate: history recorded.** The benchmark on the box at `0.36.0-next.601`/`602`; the record in
`docs/perf/0016-baseline.json` and the decision log. It tracks the release's drift and is the
reference for P1's `shared`-layout check; gates P1 and P2 compare `shared` launches against `person`
launches.

3. **sealantd · the tables under `people/*/`.** Sibling-suffix rule included; `codex-db/logs_*` and
   `codex-db/*-shm` as machine state. Round-trip test: a person directory with every listed path,
   and a regular `auth.json` where a link was, restores none of them; a `codex-db` with its `-wal`
   and `-shm` files restores the WAL and not the `-shm`. S, ~150. Perf: none (listing filter).
4. **sealantd · ownership on restore.** The owner map in the capture spec; in the `chmod` it already
   makes, for `tree/`, git and `conversations/` only, the owner's read, write and execute bits
   copied to the group, setgid on directories; `people/<id>/` `lchown`ed to its uid with `P` 0710,
   `conversations/` group-readable and -writable whatever the recorded mode, and the rest of
   `people/<id>/` at its recorded mode; the roots of `tree/` and git owned by the change's owner;
   default ACLs on the roots and, at boot, on the image's `/opt` and `/var/cache` top directories;
   reused files included; the capability report. Tests: a capture recorded 0644/0755 is writable and
   creatable-in by a second uid after restore; a 0600 transcript in `conversations/` comes back
   group-writable; a 0600 transcript and `codex-db` outside `conversations/` come back 0600; two
   people's directories restored with their uids; no owner recorded; a restore of a 200k-entry tree
   makes no more syscalls than before plus one per `people/` entry. M, ~500. Perf: restore within
   budget, measured on the box's largest worktree.
5. **sealantd · run as a user, and dotfiles as a user.** Exec and sessions with a uid (setgid,
   initgroups, setuid, passwd `HOME`, umask, the private `TMPDIR` and `XDG_RUNTIME_DIR`); the
   dotfiles applier as a given user into their home, through a control verb (boot applies only
   root's, into `/root`), reporting when files are applied separately from `install.sh`; the
   capabilities `exec.user` and `dotfiles.user`, also printed by `sealantd capabilities --json`
   without booting, so an image build can record them. Tests: a process's ids and `HOME`;
   `install.sh` runs as the user; the offline report matches the booted one. M, ~500. Perf: process
   start unchanged within noise (unit timing of the spawn path).
6. **Core · sealant#316 as it is.** S, open. Perf: none.
7. **Core · sealant#315 reshaped into per-home injection.** `home` (a person's home, a conversation
   home, or `/root` for decision 1's fallback); files owned by the home's owner; the record per
   instance and home (`home-held`, release and retake only when idle); GitHub as `hosts.yml`; DELETE
   removing the files; one row lock. M, ~+550 / −250. Perf: one control-channel write per call;
   measured for the hand-over (DELETE then POST).
8. **Core · SDK and workspace surface.** `user` on sessions and exec; `credentialsHome`; `GET`;
   sync-back per home; the dotfiles verb; the capture owner map in the spec; `sshUser` for the
   gateway; the person-layout capability of an image (from 9's probe) and ACL support per runtime,
   readable before create. M, ~650. Perf: no new call at create (the capability is read with the
   image Mend already resolves).
9. **Core · images.** Group `mend` (gid 40000); `sudo` with `NOPASSWD` for the group, `env_keep` for
   the toolchain variables and `umask=0002, umask_override`; added where a base lacks them: `sudo`
   (Ubuntu, Arch), `acl` (Ubuntu, Fedora), `util-linux` (Fedora); toolchains under `/opt` and caches
   under `/var/cache` (2775) with their `ENV`, `npm_config_prefix=/opt/npm-global`; `/etc/skel`
   links to shared caches; `/etc/gitconfig` `safe.directory = *`; `docker` group; the same for the
   MicroVM images; nix images unchanged and documented as one-person. Image tests run in a container
   started from the built image: a second uid runs `pnpm install`, `mise install`, `cargo build`,
   `npm i -g` and Playwright against the shared paths; a root `cargo install` and `npm i -g` still
   work in the `shared` layout. The image build's probe, for Core's images and custom ones:
   `sealantd capabilities --json`, `sudo`, `useradd`, `setfacl`, and no user or group in 40000–49999
   other than `mend`, recorded on the image. M, ~550. Perf: image size, and the benchmark's `shared`
   launches on the new images against the old (no regression for `shared` executors or other Sealant
   users).
10. **Core and sealantd · release chain.** `next` prereleases, Core's pin of sealantd, image builds,
    Mend's pin. S. Perf: the benchmark's `shared` launches at the new pin match the baseline within
    budget.
11. **Mend · mend#526, merged without its pi refusal.** The owner rejects any rule that stops two
    people working in one worktree, so `PI_PROFILE_IN_USE` was taken out before it merged
    (2026-10-06). In a `shared` executor a pi that joins a live pi, anyone's, runs on the profile
    already there, as before #526, and Known issues says so; with no pi live, the launch clears the
    harness home and delivers its owner's profile, or refuses with `PI_PROFILE_NOT_DELIVERED`. In a
    `person` executor each pi runs on its own person's profile (15). S, merged. Perf: none; its pi
    launch scenario run.
12. **Mend · users and layout behind the flag.** Linux identity per account (migration: name, uid in
    40000–49999); `useradd` at prepare, serialised, for the launcher and every restored current
    member, at first process for joiners, after a passwd and group collision check; the layout
    chosen before create (decision 1): the worktree's sticky layout, then Core's image capability
    and Mend's record per image digest and runtime, then the flag; prepare's check as the backstop,
    refusing on a `person` worktree and re-posting the launcher's logins to `/root` on a fresh one
    (their dotfiles are not applied there: the verb refuses root, decision 1); `harness_layout` on
    the launch and `worktrees.harness_layout`, set with the first `person` launch and never cleared;
    the operator-only `harnessLayout` on a start that creates a worktree; the refusal lines; the
    Codex adapter's `thread/start` fallback removed; `user` on every session and exec; `P` (0710)
    with decision 2's conversation-state links, `C` and `P/codex-db`; `core.sharedRepository`; the
    worktree repair (`-cnewer` a per-repair marker, `chmod g+rwX`, one asynchronous exec); install
    and setup as the launcher; `/root` 0755; the exec-count budget test for cold launch, join and
    resume. Tests: each harness writes only under its user's home and `P`; a Claude task list, plan
    file and archived Codex thread survive a Stop and resume; two users edit the same worktree file;
    after `tar x` of an archive with old mtimes, `install -m 644` and `open(…, 0644)` by one user,
    the repair lets the other write and create in every entry, and a second repair walks only what
    changed since the first; a JVM tool and `ssh-keygen` use the person's home; bytes in saved state
    per person outside conversation state and memory under 64 KB. **No way back:** a worktree with a
    `person` launch, then the flag set to `shared`, launches `person`; the same worktree with an
    image whose capability says no `sudo` (and, separately, a nix image, uid 40001 in the image's
    passwd, a sealantd without the capabilities) is refused before create with the line and no
    executor; with the capability unknown, prepare refuses, releases the executor and runs nothing;
    a Codex session of that worktree whose rollout is missing fails the turn and the adapter never
    sends `thread/start`, and the same holds in a `shared` launch; `harnessLayout: shared` on an
    existing `person` worktree is refused, and on a new worktree is recorded with its source.
    **Capability before create:** a fresh worktree on an image whose capability is unknown launches
    `shared` with the logins at `$HOME` and records prepare's answer for the digest; Core saying yes
    and prepare saying no on a fresh worktree re-posts the launcher's logins to `/root`, records
    their dotfiles as not applied (no Core verb applies them as root), records `shared` and corrects
    the record, and the agent starts with a login. M, ~1,250. Perf: `useradd` folded into existing
    execs; the repair one asynchronous exec in the join budget; cold launch exec count unchanged,
    the capability read with the image Mend already resolves; new session and join scenarios.
13. **Mend · git and Mend identity.** The per-(launch, person) token, binding and revocation; the
    container token refused, keyed on the executor's recorded layout so pre-release executors keep
    working; no `mend.sock` in capture mode; transport signs as the token's person; helper routes
    authorise it; `mend-git-credential`; `~/.config/git/config`. Tests: a joiner's push signs as the
    joiner in key and bridge modes; a joiner's `mend land` refused; a `shared` executor's push still
    works. M, ~550. Perf: `git push` and `fetch` through the shim unchanged within noise
    (benchmark).
14. **Mend · logins per person.** `credentialsHome` only for `person` launches; POST per person in
    parallel; DELETE, retried, with the launcher's create-time home kept while the executor lives;
    reconciliation at startup; refusal before start; re-post on authentication failure; pi's and
    opencode's ChatGPT logins written by Core. Tests: a join never reads the holder's login; files
    owned by the user; no regular `auth.json` under `P`; the join adds exactly one Core call. M,
    ~400. Perf: join scenario.
15. **Mend · deliveries per person.** Dotfiles through the verb (with `bootstrap`; a joiner's
    `install.sh` beside the agent unless "Start my agents after install.sh" is on, and the line when
    it finishes late), shell profile, skills, pi profile, memory, Codex carry, secret files, as the
    user; the opencode scrub at end, in the layout step and at prepare. Tests per delivery; two
    people's pi profiles live in one executor; the scrub leaves no row and no WAL page. M, ~700.
    Perf: delivery scenarios; the scrub runs off the launch path except before opencode starts
    (measured on the opencode new-session scenario).
16. **Mend · readers per person.** Prefixes for personal and shared conversations; links skipped;
    memory read-back per process's person for sessions never shared; the pre-release transcript copy
    from the worktree's last `shared`-layout capture, only when absent. Tests: two people's
    transcripts and memory in one capture, each read back only for its person; a transcript written
    by the last `shared` executor after an earlier capture is the one copied. M, ~600. Perf: Stop
    and resume scenarios.
17. **Mend · the conversation home and the restart path.** `C` and the move into it (sub-agent
    rollouts and the task list included; never file history, which is not saved) when shared control
    turns on, kept for the rest of the session; `H` with its links (Claude `projects/`, `plans/`,
    `todos/`, `tasks/`, `jobs/`, `teams/`; Codex `sessions/`, `archived_sessions/`,
    `session_index.jsonl`), `CODEX_SQLITE_HOME=H/.codex`, the neutral seed and the Claude settings
    passed inline with `--settings '<json>'` (`neutral`: `autoMemoryEnabled: false` and `env` with
    `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `CLAUDE_CODE_DISABLE_ORG_MEMORY`, `CLAUDE_CODE_DISABLE_CRON`
    and `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS`; `no-cron`; `personal`), the same variables in the
    environment, no external-include approval; Codex `HOME=H` with `shell_environment_policy` and
    `features.plugins=false`; `H.next` made as the sender, 0700, exchanged with `H` by
    `renameat2(RENAME_EXCHANGE)` once the old process group and cgroup are empty, the old directory
    removed in the background; the `chmod -R g+rwX C` as the owner with only `CAP_FOWNER`; one live
    process per conversation with fencing; the stop protocol; no-fork resume; a rejection of foreign
    reasoning failing the turn with its line; Shared control on a terminal session changing nothing;
    the hand-over budget test (two Core calls, DELETE then POST, one stop, one start). Tests with
    fake harnesses: Alice's transcript created 0600, Bob's resume works, then Alice's (five turns,
    two uids); a steered Claude turn's large tool output and a steered Codex sub-agent's rollout
    land in `C` and stay; the task list survives a change of sender; after a steered Codex turn,
    `P_bob/codex-db/state_5` has no row for Alice's thread; every personal canary (the sender's
    home, the worktree's local settings, a repository `@~/` import) stays out of the request; an
    `env` canary (`CLAUDE_CODE_DISABLE_AUTO_MEMORY: "0"` and `CLAUDE_CODE_DISABLE_CRON: ""` in the
    repository's settings and in `settings.local.json`) leaves no memory section, no memory
    directory in `C` and no cron tools; no Codex `git` child outlives a hand-over and the exchange
    never fails on a busy directory; the owner's transcript has no path under the steerer's home; a
    missing rollout fails the turn. M, ~1,000. Perf: hand-over under 5 s, Codex's one-conversation
    re-index and both Core calls included.
18. **Mend · steering dispatch.** Quiescence for Claude (session state, background-task set, paused
    tasks, wakeups, monitors, session crons) and Codex (child threads, background terminals, goals,
    1 s settle); the Claude adapter handling the events it drops today; a Codex turn aborted by the
    stop recorded as interrupted by the hand-over; the waiting line and its actions; the queue on
    the conversation; crons off in shared sessions and for everyone but the change owner (the inline
    `no-cron` settings); handoff and takeover through the same rules; payer from the process;
    cancellations; Slack; automatic landing; shared control refused for opencode sessions, at the
    toggle and at submit. Engine tests: B's turn runs as B with A's conversation; A's sub-agent,
    goal, background terminal and monitor each delay B's turn and finish as A; a takeover waits. M,
    ~900. Perf: the steered-turn scenario; same-person turns pay nothing.

**P1 · Gate: budgets met,** `person` launches against `shared` launches at the same commit, each on
a fresh worktree, on the scratch instance, then on the box once the conditions above hold; and
`shared` launches on the new images and pins against gate B's record.

19. **Mend · the migration job and replacement.** Server-side memory crediting; the completion
    record naming the capture it read, provisional until the worktree's last `shared`-layout
    capture, and re-run over that capture when the worktree turns `person`; `retiring`, the `ps` and
    `docker ps` checks, replacement only after a saved flush; "Replace this workspace now"; the
    refusal; the opencode pre-release refusal. Tests: nothing lost; ambiguous memory credits nobody;
    memory a `shared` executor writes after a provisional run is credited when the worktree turns
    `person`, and a re-run credits nothing twice; an executor with a hand-started Service is not
    replaced automatically. M, ~700. Perf: off every launch path (a test asserts no launch waits on
    it).
20. **Mend · what the product says.** The API's live people; the lines of decision 13 and the
    waiting line in the web app, CLI, desktop, phone, VS Code and t3 gateway; the Shared control
    confirmation; the GitHub settings copy; docs: Known issues, provider logins, agent memory,
    secret files, dotfiles, shared control, sudo, performance, release notes. M, ~600. Perf: session
    list and session view API latency within budget (the live-people field read in the same query).

**P2 · Gate: budgets met** on the box, `person` launches against `shared` launches on fresh
worktrees at the commit to be flipped, after a week of use with the box's flag on; the flag is not
flipped to take the `shared` record. Both records are checked in.

21. **Mend · the flip.** `person` becomes the default; the `/root` relocation kept only for `shared`
    executors, where a joining pi still runs on the live pi's profile (11). S, ~150. Perf: none
    beyond P2.
22. **Mend · removing what is dead.** The hand-over at launch, withholding, the owner record,
    `agent_memory_homes` writes (reads stay for 19 until 0.37), joiner memory flags; ADR 0010's join
    rule; stale Known issues. The credential tables stay. L, ~−1,500 / +200. Perf: fewer execs on
    the launch path; the budget tests lowered to match.

Then the box with the default flipped: two people in one worktree editing the same files, a join, a
steered Claude and Codex conversation with a sub-agent and a background task in flight, `ssh` and a
Gradle build as two people, a migrated worktree and a replaced pre-release executor, and the
benchmark once more, before 0.36 is tagged.

## Considered

- **A `HOME` per process, everyone root** (drafts 1–3). Tools that read the passwd home (OpenSSH,
  `scp`, `ssh-keygen`, the JVM) needed wrappers and pins; copies of `/root` carried what the
  launcher wrote there; every round found another tool.
- **An in-place login switch in the conversation's process** (draft 1, ADR 0013's design). Codex
  caches its token; background work outlives the turn; a refresh push races a switch.
- **A per-steer directory deleted at the end of the steer** (drafts 2–3). Tool results and sub-agent
  rollouts written there were lost, and the steerer's memory and instructions entered the owner's
  conversation.
- **The steerer's turn with the steerer's memory and instructions** (draft 3). Their private notes
  entered a history others read and replay; the owner chose the neutral context.
- **Gate G and a separate-conversation fallback** (draft 3), then **a retry without the opaque
  blocks** (draft 4). The owner has seen cross-account replay accepted; the retry as drafted forked
  Codex threads and broke Claude's parent chain, so a rejection now fails the turn.
- **A scrubbed copy of opencode's old shared database, and Remote-SSH as the connecting person
  through `SetEnv`** (draft 2). The first leaked other people's data and was unneeded; the second
  cannot work with Core's gateway today.
- **One home per person, all of it saved,** with sealantd's tables stripping logins. The tables fail
  open, and the owner's rule is that logins are never saved.
- **Falling back to the `shared` layout for a worktree already per person** (draft 5). Its saved
  sessions are under `people/`, which the shared home never reads: Claude resumes would fail, Codex
  would fork onto an empty thread, and what the fallback window wrote would be stranded once the
  worktree went back. The layout is sticky and such a launch is refused.
- **Flipping the instance flag to take the gate's `shared` record.** It would move the box's own
  worktrees between layouts; the benchmark picks the layout per launch on fresh worktrees instead.

## Decision log

- 2026-10-05: per-person homes approved for 0.36 by the owner. No person ever runs on anyone else's
  login, joins and steering both; ADR 0013's switch ships in 0.36.
- 2026-10-05, after review 1: every process runs entirely as one person; a conversation is shared
  data that different people's processes may continue.
- 2026-10-05: build on sealant#315 and sealant#316; #315's switch semantics go.
- 2026-10-05, after review 2: Remote-SSH stays the launcher's; the opencode scrubbed copy is
  dropped.
- 2026-10-06, after review 3 (owner): a Linux user per person with passwordless sudo, accepted as
  not isolation; one shared conversation with each turn on its sender's login; a neutral context
  while control is shared; a new sender waits for the previous sender's background work and nothing
  is killed; the conversation's files belong to the session, in the owner's saved directory, and
  nothing is deleted at the end of a steer; gate G is dropped for a retry without foreign hidden
  reasoning.
- 2026-10-06: memory of an old shared home goes to the saved `agent_memory_homes` record, else to
  the only person who had sessions there, else to nobody; it is never deleted.
- 2026-10-06: performance is a hard limit (owner): the budgets in Performance gate the box's flag
  and the release; Codex's thread index stays saved, a joiner's `install.sh` runs beside the agent,
  and the hand-over's settle is 1 s or none.
- 2026-10-06, after review 4: `P` is 0710 and `C` regains group access before each process; the
  saved directory holds all conversation state saved today; sealantd adds group write and setgid in
  its restore `chmod`; shared processes use their own Codex index; the gate compares flag off
  against flag on at one commit, with at least 10 runs; the hidden-reasoning retry is dropped, and a
  rejection fails the turn; a session once shared stays neutral.
- 2026-10-06 (owner): opencode is not supported under shared control; it stays a one-person harness.
  Decision 8a is resolved: a login made inside opencode stays in that person's own opencode data,
  deleted when opencode exits, documented as a narrow exception.
- 2026-10-06, after review 5: a worktree that has run per person stays per person, and a launch that
  cannot run it is refused with the reason, never run `shared`; Codex's `thread/start` fallback is
  removed; the migration's completion names the last `shared`-layout capture; the layout is decided
  before create from Core's per-image capability and Mend's record per image; the benchmark and
  gates pick the layout per launch on fresh worktrees; Claude's switches go in a `--settings` file;
  the worktree repair goes by ctime with a marker per repair; a hand-over makes two Core calls;
  Codex's `*-shm` files are machine state. The design is final.
- 2026-10-06 (owner): no refusal of two people in one worktree. mend#526 merged without its pi
  refusal; a pi joining a live pi in a `shared` executor runs on the profile there (Delivery 11).
- 2026-10-06, after mend#551's review: a member made in another worktree but with nothing saved in
  this one is made at their first process here; the create names the launcher's home owner by
  number, and a home that exists before its user becomes the user's with the skeleton copied in
  (decision 5).
- 2026-10-06 (owner): Claude's file history is never saved anywhere, `people/*/` included, since it
  holds copies of edited secret files; it is not part of `P`, `C` or `H`'s links. A `person` launch
  whose restore did not apply the owner map is refused at prepare (decision 8).
- 2026-10-06, after the review of mend#552/#553: a person's token and git author reach their home
  through a pickup ticket bound to them (mend#555's mechanism), minted at redemption; a person's
  token is rechecked against membership and project access on every request, names no session in its
  row, and a person's process without Mend's environment finds it in its passwd home.
- 2026-10-07, after the platform's builds and reviews (sealantd#144–#148, sealant#327–#332,
  mend#551–#559): Claude's file history is never saved, and `/rewind` does not survive a move to
  another executor; sealantd's restore copies the owner's read to the group too, so a 0600 file
  comes back 0660, at about +0.3 s on a large restore, measured by wall time at gate P1; restored
  worktree entries are root's in group `mend`, only the roots go to the change's owner, and `C`'s
  default ACL is not restored, which umask `0002` and Mend's per-process `chmod` make harmless;
  there are no user dotfiles at boot, and every person, the launcher included, goes through
  `dotfiles.apply` after prepare and before the link step, serialised per person and bounded;
  prepare refuses a `person` executor whose restored worktree is not group `mend`'s (mend#552); a
  person's processes hold `CAP_FOWNER`, owner-approved, so pnpm relinks bins, and sealantd withholds
  it under no-new-privileges; the person layout needs a setuid `sudo` and no no-new-privileges, in
  Core's image probe and Mend's alike; sealantd skips no-new-privileges only in a per-person
  executor, a root daemon with an owner map naming at least one person (sealantd#148); sealantd
  applies `person-env` to every person's process and Mend applies nothing; the project's secrets
  reach every person while named provider logins, `SEALANT_*` and the injector's keys are withheld;
  the dependency cache is keyed by layout, and a worktree's first `person` launch runs
  `pnpm install --force --prefer-offline` once on a tree from the other layout; `openSftp` takes no
  user yet.
- 2026-10-08, with Core 0.39.0-next.703 (sealant#334–#341, mend#569): every person's dotfiles, the
  launcher's included, go through `dotfiles.apply`; a start waits for it bounded, and an apply that
  outlives the wait is seen through when it lands (Mend's links, then the first-process marker, the
  record and the line made true), never asked for twice; every start of a person waits for, or says,
  their `install.sh` while it runs. The fallback to `/root` applies no dotfiles (the verb refuses
  root) and writes the launcher's logins in one partial POST. Every login POST is partial; Core
  writes pi's and opencode's ChatGPT logins in `person` executors. The layout needs the control
  plane to report `features.processUser`, which 0.39.0-next.703 does not yet.
- 2026-10-08, with Core 0.39.0-next.706 (sealant#342–#344): the person layout reads
  `features().processUserRoutes` and the rest of the layout's features (never `processUser`, which
  stays false for older SDKs) and each workspace's `processUser()`; a launch runs per person only
  when both say yes. The session line says Core's launch phase while a workspace gets ready.
- 2026-10-08, Delivery 19 as built: the migration's record (`pre_release_migrations`) keeps every
  memory path and digest any run credited, so a re-run reads the old home again and credits only
  files whose digest no run credited, read back against the digest an earlier run credited; it never
  deletes from the store. A live `shared` executor is marked to retire (`executor_retirements`) by a
  sweep that runs only with the flag on, once a minute per executor and first one interval after
  boot. sealantd is PID 1 and adopts every orphan, so parentage says nothing: a process counts as
  Mend's only in the session of a process Mend recorded, by the pid sealantd reported when it
  started it (`processStarted` in its record), or in sealantd's own; everything else (a `nohup` job
  of a shell that ended, a `setsid` or `tmux -d` job, a daemon, a `docker exec`) is listed, by
  command name and pid only. A recorded pid counts only while its process started within two seconds
  of the record (no reused pid hides a session); kernel threads (no command line, read by content
  since procfs reports every size as 0) and zombies are skipped. Starts and turns admitted before
  the executor turned `retiring` (a launch under way, a turn being queued or queued, an `install.sh`
  running) would stop, so the check sees them. Containers are what `docker ps` lists with sealantd's
  own `DOCKER_HOST`; a `docker ps` that cannot answer is "could not check", never "none"
  (PLATFORM-FEEDBACK 2026-10-08). The check runs on every look, so the owner's "Replace this
  workspace now" lists all of it; the request names what the owner was shown (the set of things, not
  when it was checked), and Mend ends nothing more (it is refused when more would stop now, counted
  as a multiset). The check exec is bounded (30 s), and error text reaches the change's owner only.
  A `retiring` row nothing moves (a crash, a restart) goes back to `marked` at boot, on the sweep
  after ten minutes, or when the owner asks again; every other way a replacement does not finish
  takes it back at once, with why. A failed final flush leaves the executor's drain to ask again, as
  every kept drain does. The holder's protocol agent and its own `mend.toml` Services start again; a
  joiner's do not, and terminal sessions end resumable. Memory is credited by the home's record only
  when nothing is pending and the record is the executor's that wrote the capture read, and by the
  only-person rule only from `worktree_session_owners` (kept when a session is deleted) on a
  worktree made after it began, or on an older one whose organization has exactly one member who
  owns every session it kept (owner decision 2026-10-08); otherwise nobody. A replacement whose
  final flush was sent stays `retiring` while its drain asks again, and the Services it starts again
  are kept with the row for a restart.
- 2026-10-08, Delivery 20 as built: the lines of decision 13 are one module
  (`@mend/domain/workbench`, `shared-workspace.ts`) every client draws from. The live people are the
  distinct `runs_as` of live processes in the session's executor, so a `shared` executor lists
  nobody, and the executor's retirement state comes with them: correlated subqueries on the viewed
  session rows, in the API's session list and view query (measured +4 ms on a 300-session list where
  every executor has two people, +0.2 ms on a view). A person with no name reads "a member". Clients
  ask for the waiting line only with people live and shared control on, and for the retirement only
  when the session says there is one, so the flag off adds no request. The Shared control switch
  asks before it turns on in both layouts, in words true to each
  (`SessionControlView.turnsOnSendersLogin`, from the executor's own launch layout, or the
  worktree's record when none is live; unknown reads as the owner's logins).
- Open: gate B's history record.
