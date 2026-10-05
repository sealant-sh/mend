# Per-person harness homes: one worktree, a home for each person in it

Status: accepted 2026-10-05, for 0.36. Amends
[ADR 0009](0009-agent-memory-per-person-per-project.md) (memory in capture mode),
[ADR 0010](0010-secret-files.md) (where secret files go) and
[ADR 0013](0013-whoever-sends-a-turn-pays.md) (the steering switch ships in 0.36 and writes into one
process's login directory). Read against Mend `c9b645b0b` with mend#526 (`ac3bdce06`) open, Sealant
Core `bc9ec42` (SDK 0.38.1) with sealant#315 and sealant#316 open, and sealantd `07ada50`.

## Context

In capture mode (ADR 0002) a worktree has one live executor, a container with `HOME=/root`, and
every session in the worktree runs in it: a join, a sibling shell and a resume are processes in the
lease holder's executor. sealantd saves `/workspace/harness-home` as the capture's `harness/`
section, less the paths in `HARNESS_CREDENTIALS` and `HARNESS_MACHINE_STATE` (sealantd#136). It does
not save `/root`. Mend's relocation (`relocateHarnessHomeScript`) links `~/.claude`, `~/.codex`,
`~/.pi`, `~/.local/share/opencode` and `~/.local/state/opencode` into that home, which is why they
are saved, and restored for whoever comes next.

So every agent in a worktree shares one harness home, and over the week of 2026-09-28 that one home
caused one class of bugs:

- credential files saved and restored for the next person (sealantd#136, mend#526);
- one person's pi profile carried into the next person's pi; mend#526 refused the second pi, and the
  owner rejected that, because two people must be able to work in one worktree at once;
- memory credited to the wrong person (mend#528, six review rounds, `agent_memory_homes`);
- Codex building one person's memory from other people's conversations (mend#528's withholding);
- opencode's database holding in-app logins next to the conversations it resumes;
- a joiner's agent spending the holder's login, since Core injects one login per workspace at
  create.

### What each harness reads

Checked 2026-10-05 in an unprivileged container with no network and a fake model, at the versions
the images install (Claude Code 2.1.289, Codex 0.160.0, opencode 1.18.34, pi 1.0.2). Each harness
moves all of its state with its own variables, and every tool call it makes inherits them:

| Harness  | Variables                                                              | Written elsewhere with only the first                                                               |
| -------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Claude   | `CLAUDE_CONFIG_DIR`                                                    | MCP logs in `~/.cache` (`XDG_CACHE_HOME`), task output and sockets in `/tmp` (`CLAUDE_CODE_TMPDIR`) |
| Codex    | `CODEX_HOME` (must exist before Codex starts), `CODEX_SQLITE_HOME`     | a daemon socket in `/tmp`, per `CODEX_HOME`; the daemon is off in Mend's launches (#527)            |
| opencode | `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_CACHE_HOME` | nothing; it still reads `~/.claude/skills` and `~/.agents/skills` through `$HOME`                   |
| pi       | `PI_CODING_AGENT_DIR`                                                  | nothing; it reads `~/.agents/skills` through `$HOME`                                                |

Setting the `XDG_*` variables per person also moves other tools' state: `gh`'s login (wanted),
caches (colder), and pnpm's store, which breaks `pnpm add` in a `node_modules` another person
installed (`ERR_PNPM_UNEXPECTED_STORE`) unless the store is pinned.

## Decision

### 1. One shared worktree, a home per person

`HOME` stays `/root`. Every process Mend starts for a person carries environment variables that
point each harness at that person's own directories. Three places, by what they hold:

- **The person's home**, `/root/.mend/homes/<account id>` (written `R` below). Outside every capture
  root, gone when the executor ends. Logins, settings, caches, Codex's databases, pi's installed
  packages.
- **The person's saved directory**, `/workspace/harness-home/people/<account id>` (`P`). Inside the
  harness home, so saved with every capture and restored into every executor of the worktree.
  Conversations and memory only. Each is a real directory in `P`, reached from `R` through a
  directory link: sealantd stores a link as a link and never follows it, so the bytes must sit on
  the saved side.
- **A conversation's login directory**, `/root/.mend/logins/<session id>` (`L`). Only for a Claude
  or Codex agent run as a conversation (protocol mode), the only agents someone else can steer. It
  holds that process's login files, its seeded settings, and links to everything else in `R`.
  Section 5 says why.

The environment, on every process start (agent cold start, claimed standby, join, resume, follow-up,
retained run, shell):

| Variable                                | Person's processes | A conversation's agent | Why                                                       |
| --------------------------------------- | ------------------ | ---------------------- | --------------------------------------------------------- |
| `CLAUDE_CONFIG_DIR`                     | `R/.claude`        | `L/.claude`            | Claude's whole state, its login included                  |
| `CLAUDE_CODE_TMPDIR`                    | `R/.t`             | `R/.t`                 | task output and sockets; short for `AF_UNIX`              |
| `CODEX_HOME`                            | `R/.codex`         | `L/.codex`             | Codex's state, its login included; made before start      |
| `CODEX_SQLITE_HOME`                     | `R/.codex`         | `R/.codex`             | the thread index and memory database stay the person's    |
| `PI_CODING_AGENT_DIR`                   | `R/.pi/agent`      | `R/.pi/agent`          | pi                                                        |
| `XDG_DATA_HOME`                         | `R/.local/share`   | `R/.local/share`       | opencode's database and logins                            |
| `XDG_CONFIG_HOME`                       | `R/.config`        | `R/.config`            | opencode's config, other tools' config                    |
| `XDG_STATE_HOME`                        | `R/.local/state`   | `R/.local/state`       | opencode's state                                          |
| `XDG_CACHE_HOME`                        | `R/.cache`         | `R/.cache`             | Claude's MCP logs, opencode's cache                       |
| `GH_CONFIG_DIR`                         | `R/.config/gh`     | `L/gh`                 | the GitHub login                                          |
| `npm_config_store_dir`, `COREPACK_HOME` | the executor's     | the executor's         | resolved once in `prepareExecutor`, so caches stay shared |

Services get none of these. They belong to the worktree, run with no person's login, and a `claude`
a service runs finds none.

The variables are paths, not secrets, and ride `SessionOptions.env`, which the SDK already has
("Extra environment for the session process (not for secrets)"). One `sh` per person per executor
makes the directories and links, folded into the launch's existing file exec (#513).

### 2. What is saved per person, and what is never saved

| Saved in `P`, per person                                                                                            | Never saved (in `R` or `L`)                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude `projects/` (transcripts, auto memory)                                                                       | every login: Claude, Codex, GitHub, MCP tokens, pi and opencode `auth.json`                                                     |
| Codex `sessions/` (rollouts), `memories/`                                                                           | settings: Claude `settings.json` and `.claude.json`, Codex `config.toml`, pi `settings.json` and `models.json`, opencode config |
| pi `sessions/`                                                                                                      | Codex's databases (`state_5`, `logs_2`, `memories_1`, …) and daemon state                                                       |
| opencode's data directory (database, snapshots), its `auth.json` and `mcp-auth.json` links into `R/.mend/opencode/` | pi's installed packages and `git/` clones; caches; temp                                                                         |
| Mend's records for that person (`.mend/`: delivered memory, carried transcripts)                                    | Claude `backups/`, `file-history/`, `shell-snapshots/`, `session-env/`, `ide/`                                                  |

- **Logins, tokens and settings are written in at launch,** by Core (logins, section 3) and by Mend
  (seeds, pi profile, section 7). A setting someone edits by hand inside an executor lasts until
  that executor ends. mend#526's "kept, with a reason" list (`config.toml`, Claude `settings.json`
  `env`, pi `models.json` and `settings.json`) is no longer saved at all.
- **Codex's memory database** (`memories_1.sqlite`) is read back from the live executor when the
  agent ends, through `node:sqlite` `VACUUM INTO` (the runtime mend#528's program already uses
  there). When the executor is gone first, the stored copy stands, and Codex summarises those
  conversations again later (ADR 0009 Codex consequences).
- **opencode's database stays one file with conversations and in-app logins.** It is saved because
  resume needs it (#503). It is now that person's alone: no other person's opencode opens it. A
  console or integration login someone makes inside opencode is the one login still saved, in their
  own directory, readable by anyone working in the worktree (Known issues; PLATFORM-FEEDBACK
  2026-10-04). Mend's own logins never reach that database.
- **The credential tables stay as a second layer.** sealantd applies `HARNESS_CREDENTIALS` and
  `HARNESS_MACHINE_STATE` under each `people/<id>/` as well as at the root, so a credential a
  harness writes into a saved directory, or a link replaced by a plain file, is still never saved.
  Mend's copy of the tables and the test that holds them to sealantd's stay.

### 3. Logins: one Core primitive, any home

**No person ever runs on anyone else's login.** One Core call puts a given person's login at a given
home inside a running workspace and keeps it refreshed. Everything else in this ADR uses it.

```
POST   /v1/workspaces/:id/credentials { onBehalfOf, home, claude?, codex?, github? }
DELETE /v1/workspaces/:id/credentials { home }
workspaces.create({ …, credentialsHome })
```

- **Built on sealant#315 and sealant#316, not beside them.** sealant#315 is the switch ADR 0013
  asked for: a copy without a refresh token, written over the control connection, a record the
  refresh push follows, the spec left alone. It writes to `$HOME` and records one held account per
  instance. Before it merges it gains:
  - a `home` (absolute, outside `/workspace`, no `..`; the write proves no component is a link, as
    ADR 0010's write does), defaulting to `$HOME`, so the call stays what ADR 0013 specified;
  - the held login recorded per instance, home and provider, so several people's logins live in one
    workspace and each one's refresh reaches only its own home;
  - GitHub as a provider, written as `gh`'s `hosts.yml` under `<home>/.config/gh/` (or `L/gh/`); git
    reaches it through `gh auth git-credential`, set for github.com in the image;
  - a provider the person has not connected is removed from that home, never left holding someone
    else's.

  sealant#316 is needed as it is: a setup token in `CLAUDE_CODE_OAUTH_TOKEN` is one value for the
  whole container and cannot be per home or switched.

- **New in Core:** `credentialsHome` on create writes the launch's logins at that home and sets no
  login in the container's environment (no `GITHUB_TOKEN`, `GH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`);
  `DELETE` removes a home's login files and its records, so pushes stop.
- **How Mend uses it:**
  - A cold launch or claimed standby names its first process's home in `credentialsHome`: `L` for a
    conversation, `R` for a terminal or shell. No extra call on the cold path.
  - Any other home gets its login when its first process starts: a join, a shell, a second session
    of the same person, a resume in a retained executor. One Core call.
  - A session that needs a provider the person has not connected, or whose login is `invalid`, is
    refused before it starts: "Connect Claude to start a session here." A shell starts without.
  - When a conversation's agent ends, Mend releases `L`. When a person's last process in an executor
    ends, Mend releases `R`. An executor that ends takes its records with it, as today.

### 4. Joins

A person who starts a session in a worktree where another person's session runs gets their own
process in the same executor, with their own home, their own login (section 3), their own pi
profile, skills, memory and secret files (section 7), and their own saved directory. Two people work
live in one worktree, on one change, each on their own logins. ADR 0010's "a joiner receives no
secret files of its own" and ADR 0009's "what a joined agent writes goes to the executor's owner" no
longer hold.

### 5. Steering: ADR 0013's switch ships in 0.36

Shared control lets B send turns into A's agent process. That process's environment was fixed when
it started, so B's turn reads whatever login sits at the paths that process reads. If that were
`R_A`, B's login would sit where A's shells and A's other sessions read it: A could run `claude` in
a shell on B's login while B's turn ran. So a conversation's agent reads its login from its own
directory, `L`, which nothing else reads.

- **Which home the agent reads:** A's, through `L`. `L/.claude` and `L/.codex` hold A's seeded
  settings and link to A's `projects/`, `sessions/`, `memories/` and skills; `CODEX_SQLITE_HOME` is
  `R_A/.codex`. B's turn therefore runs on A's settings, memory, skills and secret files and writes
  A's transcript and A's memory, as ADR 0009 decision 1 and ADR 0010 decision 1 already say for a
  steered turn. Only the login is B's.
- **Where B's login goes:** `L`, through the section 3 call with `home: L`, `onBehalfOf: B`, for the
  harness's provider and GitHub. `dispatchNext` makes it before B's turn when `L` holds someone
  else's, and writes A's back when the turn ends unless the next queued turn is B's (ADR 0013 "Back
  to the owner"). Codex restarts `app-server` in the same `L` and resumes the thread (ADR 0013).
- **What it touches:** exactly one process. ADR 0013 open question 2 (a switch in a joined worktree
  changes both sessions' login) is closed: a joiner's session has its own `L` or `R`.
- **Terminal sessions** stay as ADR 0013 and mend#518 made them: only the owner types, so a terminal
  agent reads `R` and is never switched.
- **No fallback:** a steerer with no login for the provider is refused at submit, as ADR 0013 says.
- **Restarts:** what `L` holds is Core's record, not Mend's memory. An agent process that starts in
  `L` (a relaunch, a Codex restart, a resume) gets the login of whoever sends its first turn, the
  owner's when nobody has, written before it starts. A Mend server that restarts while a steerer's
  turn runs takes `L` as holding an unknown login, as a failed or unconfirmed write does
  (sealant#316), and writes before the next turn whoever's it is. A turn never starts on a login
  nobody confirmed.
- The turn records its payer from Core's answer (mend#519's columns).

### 6. Memory per person (replaces mend#528's hand-over)

Each person's memory sits in their own `P`, so the question mend#528 answered with
`agent_memory_homes`, "whose memory does this home hold", no longer arises.

- **Delivery** (ADR 0009 decision 2) writes the person's memory into their own `R`, which links into
  `P`, at every process start of theirs, joins included.
- **Read-back** (decision 3) reads `harness/people/<owner>/…` from the flushed head capture, for the
  session's owner only. A joined session reads back its own person's directory.
- **Codex** builds memory only from conversations in the person's own `sessions/`, so nothing is
  withheld: `withholdCodexThreadsExec`, the joiner's `features.memories=false` flags and the
  stripping of `--enable memories` go. A `codex` someone types in their own shell runs in their own
  home, which closes ADR 0009's "Not covered".
- **Carried conversations** (decision 8) are laid into the person's own `sessions/`; "never carries
  from its own worktree" becomes "never carries one already in the person's directory".
- **Goes:** the hand-over (`handOverAgentMemoryExec` at every launch), the forced capture after it,
  `.mend/agent-memory-owner`, and new `agent_memory_homes` writes. The table and the read-back-then-
  move step stay for the migration (section 9) and are dropped in 0.37.

### 7. pi profile, seeds, skills and secret files per person

- **pi profile (replaces mend#526's refusal):** delivered into `R/.pi/agent` at each of the person's
  launches. `R` is never saved and never shared, so no profile is foreign and nothing is moved
  aside. `PI_PROFILE_IN_USE` goes; two people's pi run live in one worktree. pi's packages install
  per person per executor, as they already do per executor.
- **Seeds** read the variables: Claude writes `$CLAUDE_CONFIG_DIR/.claude.json`, `settings.json` and
  the credentials file Mend seeds (`harness-seeds.ts`); Codex's trust seed writes
  `${CODEX_HOME}/config.toml`; the ChatGPT-login program reads `${CODEX_HOME}/auth.json`. With
  `CLAUDE_CONFIG_DIR` set, Claude ignores `~/.claude.json`.
- **Skills** go to `R/.claude/skills`, `R/.codex/skills`, `R/.pi/agent/skills`, and to opencode's
  config directory (`$XDG_CONFIG_HOME/opencode/skills`; checked against opencode 1.18 before it
  ships). Mend writes nothing to `/root/.claude/skills` or `/root/.agents/skills`.
- **Secret files (amends ADR 0010 decision 3):** each person's set goes into their `R`, joins
  included.
  - A file under `.config/`, `.local/share/`, `.local/state/` or `.cache/` is where the person's
    tools read it.
  - Five paths get a variable that points at the person's copy whether or not they have one:
    `.aws/credentials` (`AWS_SHARED_CREDENTIALS_FILE`), `.aws/config` (`AWS_CONFIG_FILE`),
    `.kube/config` (`KUBECONFIG`), `.npmrc` (`NPM_CONFIG_USERCONFIG`), `.docker/` (`DOCKER_CONFIG`).
    A person's tools never read another person's copy of these.
  - Any other path (`~/.ssh/…`, `~/.netrc`) is also written to `/root` for the person whose launch
    made the executor, as today, since tools find it only through `HOME`. Nobody else's is written
    there; the session line names a joiner's files that were not.
  - `SECRET_FILE_RESERVED_PATHS` grows by `.mend/homes` and `.mend/logins`.

### 8. Readers

Every reader goes by the session owner's prefix: `HARNESS_STATE`'s transcript patterns become
`^people/<id>/\.claude/projects/…` and the like; `harvestFromCaptureAlone`, `hasLiveHarnessState`,
`locateLiveTranscript`, `readHarnessFileScript`, `CARRIED_TRANSCRIPTS` and the opencode reader take
the owner's directory; `latestTranscript` reads the variables. Two sessions of the same person in
one worktree still share a directory, as two sessions in a worktree do today; pinning provider
session ids at launch is the follow-up.

### 9. Executors started before this release, and the migration

**The layout is recorded per launch** (`harness_layout`: `person`, or null for launches before this
release), and every delivery and reader goes by the executor's. An executor started before this
release keeps the shared home until it ends. It takes no second person: a join, and a shared-control
turn from anyone but its owner, are refused there with "This worktree's workspace started before
Mend 0.36 and shares one home; it takes another person once it ends."

**A worktree whose saved home is the old shared one** is migrated by the first `person` launch into
it, in the launch's file exec, before the agent starts. Nothing is deleted:

- **Memory goes to one person,** read back once more and then moved to
  `.mend/agent-memory-kept/<stamp>-shared-home-…`, as mend#528 moves it. Whose:
  1. the person `agent_memory_homes` names in a saved record: whose launch delivered into it;
  2. else the owner of the session whose launch made the executor that last held the worktree (the
     lease's launch): their memory is what that launch delivered;
  3. else the owner of the worktree's first session, the change's owner (ADR 0007).

  Not the first session's owner first: in a worktree people took turns in, that person's memory was
  moved aside at the next hand-over, and the home held the last launcher's.

- **Conversations stay where they are and are copied on demand.** A session started before this
  release reads its transcript at the old path by its own provider session id, never "the newest". A
  resume copies that one file into its owner's `P` first.
- **opencode's shared database** is copied into the first person who launches opencode in the
  worktree and has none. A pre-release opencode session of someone who already has their own there
  cannot be resumed and says so; its conversation stays in the old home.
- **Everything else at the old root** (settings, Codex's databases, kept sets, a pi profile) stays,
  unused, until the worktree is removed. Nothing links `/root` to it any more.
- **Repeatable:** the step acts on what the old paths still hold. A launch whose executor is lost
  before saving leaves the old memory in the restored head, and the next launch reads back the same
  files, which the merge takes as unchanged.

### 10. What the product says

Everyone still runs as root in one container. While people share a workspace, each person and their
agents can read the others' homes, logins included; a person's saved conversations and memory are
restored into every executor of the worktree, where anyone working there can read them. That is no
wider than today for the saved parts, and narrower for logins (nobody's is saved), but it is not a
boundary between people. The owner decided 2026-10-05 that separate POSIX users per person are not
part of 0.36.

- **Where two people meet in a worktree,** in the product's own words for it ("join a worktree" in
  the CLI, the composer's Worktree picker, the worktree's New session menu): "Anna's session is
  running in this worktree. You share its workspace: each of you runs on your own login, and either
  agent can read the other's files, logins included."
- **On a session while another person's process is live in its executor:** "Shared workspace with
  Anna · each of you on your own login · either agent can read the other's files."
- **Beside the Shared control switch:** "Each turn runs on its sender's login, written into this
  workspace for the turn, where this session's agent can read it."
- The API's session view carries the live people in the executor, so the web app, CLI, desktop,
  phone and VS Code draw the same line.
- Known issues: "People in one worktree can read each other's files".

## Start-time impact

- **Cold launch:** no added Core call (`credentialsHome`). The person layout adds a few commands to
  the launch's existing file exec. Removed: mend#528's hand-over (a capture read, an `sh` exec and a
  forced capture for another person's home), the Codex withholding exec on every Codex launch, and
  mend#526's pi profile clearing. Same or fewer execs than today.
- **Join:** one Core call for the joiner's login, and the joiner's deliveries (skills, memory, pi
  profile, secret files), which a join skips today. Measured on the box before the flip merges,
  against the interactive bar.
- **Steered turn:** ADR 0013's cost, unchanged: a Core call before and after a steerer's turn, and a
  Codex restart.
- **Per person per executor:** pi installs its packages again; Codex unpacks its `.system` skills;
  `XDG_CACHE_HOME` caches (uv, pip, go) start cold. pnpm's store and corepack stay shared.

## Consequences

- Two people work live in one worktree, each on their own login, pi profile and memory.
- A joiner's agent no longer spends the holder's login, and a steerer's turn no longer spends the
  owner's. GitHub included.
- `GITHUB_TOKEN` and `GH_TOKEN` are no longer in the workspace's environment. `gh` and git find the
  person's GitHub login; a tool that reads only `GITHUB_TOKEN` does not.
- A setting edited by hand inside an executor lasts until it ends.
- The capture holds one directory per person who has worked in the worktree. Size grows with people,
  not with sessions; Codex's 427 MB daemon package is not in it (#527).
- A person's dotfiles still apply only for the cold launcher (sealantd writes them to `/root`), and
  a joiner's shell reads the launcher's.
- A secret file outside the mapped paths (`~/.ssh`, `~/.netrc`) is the launcher's in the executor,
  and a joiner's agent can use it. Known issue.

## Follow-ups

- **Separate POSIX users per person**, or an executor per person (ADR 0002's accepted relaxation):
  the step that makes people in one worktree unable to read each other. It needs Core to write a
  login owned by a uid, and sealantd to read every person's directory to save it.
- **A `HOME` per person,** with per-person dotfiles; it ends the launcher-only secret files and
  dotfiles above.
- **Provider session ids pinned at launch** (Claude and pi `--session-id`), so two sessions of one
  person in one worktree never read each other's transcript.
- **Restoring only the people live in an executor:** sealantd restores a prefix on demand and
  carries the rest forward. Only if someone asks for absent people's conversations to be absent.

## Delivery

Ordered; each is one pull request. Sizes are lines changed, tests included. Every Mend PR before 11
keeps main working: the launch still records the shared layout until 11.

1. **Mend · this ADR** (docs). Amendment notes in ADR 0009, 0010 and 0013; PLATFORM-FEEDBACK. ~500.
2. **sealantd · the tables under `people/*/`.** `is_harness_excluded_path` also matches a path with
   a leading `people/<one component>/` stripped; the listing, the materializer's never-restore rule
   and the watcher use it. Round-trip test: a person directory holding every listed path saves and
   restores none of them; a link in `P` is saved as a link. sealantd ADR 0015 table note. S, ~150.
3. **Core · sealant#315, amended before merge:** `home`, the held login per instance, home and
   provider, GitHub as a provider, an unconnected provider removed from the home. Tests: two homes
   in one instance each refreshed with their own account; a push for A never reaches B's home; a
   home under `/workspace` or through a link refused. M, ~+350 on #315.
4. **Core · sealant#316 as it is:** a setup token as a credentials file. S, open.
5. **Core · `credentialsHome` and release.** Create writes the logins at that home and none into the
   environment; `DELETE …/credentials { home }`; the SDK methods; the image's git helper for
   github.com through `gh`. Then a `next` prerelease and Mend's pin. M, ~400.
6. **Mend · mend#526, trimmed and merged.** `PI_PROFILE_IN_USE` and the foreign-profile clearing are
   dropped from the branch (the owner rejected the refusal); the credential and machine-state
   tables, their sealantd test and the Codex shell-snapshot fix stay. S, net removal on the branch.
7. **Mend · layout and environment.** `person-home.ts` (paths, variables, the `sh` that makes `R`,
   `P`, `L` and their links, opencode's login links); `harness_layout` on the launch (migration);
   `SessionOptions.env` at every `openSession` (cold, claimed, `launchInRetainedWorkspace`, shell;
   none for services); seeds read the variables; pnpm and corepack pinned in `prepareExecutor`.
   Tests: the variables per process kind; the layout script in a container (Claude, Codex, opencode
   and pi write nothing outside `R`, `P`, `L`). M, ~700.
8. **Mend · logins per person.** `credentialsHome` at create; the call at a person's first process
   in an executor; release when `L` or a person's last process ends; refusal of an unconnected
   provider before start. Engine tests: a join injects the joiner's login into their home and never
   reads the holder's; a release on end. M, ~450.
9. **Mend · deliveries per person.** Skills, pi profile, memory, Codex carry and secret files into
   the person's `R` (and `P` through it); the five mapped secret paths; launcher-only top-level
   files. Tests per delivery, and one with two people's pi profiles live in one executor. M, ~600.
10. **Mend · readers per person.** `HARNESS_STATE` prefixes; harvest, `locateLiveTranscript`,
    carried list, opencode reader; memory read-back from `harness/people/<owner>/`; Codex's memory
    database read back from the live executor. Tests: two people's transcripts and memory in one
    capture each read back only by their owner. M, ~600.
11. **Mend · the migration and the flip.** First `person` launch into a shared home: memory read
    back to the person section 9 names and moved aside; transcript copied on resume; opencode
    database copied once; pre-release executors refuse a second person. New launches record
    `person`; relocation stops linking `/root/.claude` and the rest into the harness home. Engine
    test: two people live in one worktree, each on their login, memory and pi profile; a worktree
    with an old shared home migrates with nothing lost. M, ~550.
12. **Mend · the steering switch (ADR 0013 Delivery 4).** In `dispatchNext`: the call with `home: L`
    for the sender, the switch back, the Codex restart, the refusal at submit, the payer from Core's
    answer. Tests: B's turn writes only `L`; A's shell and A's other session keep A's login; Codex
    restarts once per change of payer. M, ~700.
13. **Mend · what the product says.** The API's live people per executor; the lines of section 10 in
    the web composer, worktree menu, session page and Shared control; the CLI's join notice; the
    desktop, phone and VS Code; docs: Known issues, provider logins, agent memory, secret files,
    shared control. M, ~450.
14. **Mend · removing what is dead.** mend#528's hand-over at launch, withholding, joiner memory-off
    flags, the owner record and `agent_memory_homes` writes (the reads stay for 11's migration until
    0.37); mend#526's remaining pi clearing reduced to a per-person delivery; ADR 0010's join rule
    in code; Known issues sections they leave stale. The credential tables stay. L in deletions,
    ~−1,500 / +200.

Then the box: pinned Core and sealantd with 2–5, two people in one worktree, a join, a steered turn,
and a stop's save, before 0.36 is tagged.

## Considered

- **One home per person, all of it saved** (`P` holds everything, sealantd's tables strip the
  logins). Saves settings, and it would let Mend drop the links. Rejected: the tables fail open, and
  the owner's rule is that logins and settings are never saved.
- **Prune other people's directories at launch.** In capture mode the head is the only copy: the
  next capture records the deletion and their conversations and memory are lost. It cannot serve a
  join either.
- **Only `R`, nothing saved.** Every executor replacement would lose conversations and memory.
- **The steering switch writing into `R_A`.** A's shells and other sessions read `R_A`, so they
  would run on B's login during B's turn.
- **Per-person `HOME`.** Breaks pnpm's store, rustup and other tools that resolve `$HOME`, and
  sealantd's dotfiles go to `/root`. A follow-up with per-person dotfiles.

## Decision log

- 2026-10-05: per-person homes approved for 0.36 by the owner. Separate POSIX users per person are
  not part of 0.36; the product says plainly that people in one workspace can read each other.
- 2026-10-05: no person ever runs on anyone else's login, joins and steering both (owner). ADR
  0013's switch, held until the SDK had it, ships in 0.36 on the same Core call as joins.
- 2026-10-05: build on sealant#315 and sealant#316 rather than a second endpoint. #315 already has
  the copy, the control connection and a record the push follows; it lacks a target home and more
  than one held login, which are cheaper to add before it merges than to migrate after. #316 is
  needed unchanged.
- 2026-10-05: memory of an old shared home goes to the saved `agent_memory_homes` record, else the
  lease's launcher, else the change's owner, and is never deleted.
