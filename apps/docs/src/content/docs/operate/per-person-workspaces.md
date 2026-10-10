---
title: Per-person workspaces
description:
  Each person gets their own Linux user and home in a workspace, by default;
  MEND_HARNESS_LAYOUT=shared opts out. What it needs, what sudo means there, how older workspaces
  are replaced, and the performance limits.
sidebar:
  order: 4
---

In a remote workspace, a worktree has one live executor, and every session in the worktree runs in
it. Without per-person workspaces every process there runs as root in one shared home, on the logins
of whoever launched it. With them, each person who runs anything in the workspace gets their own
Linux user and home, and everything they run runs as them: their logins, Git and Mend identity,
dotfiles, secret files, memory and MCP servers.

Per-person workspaces ship in Mend 0.36, on by default; an operator can opt out. Design and
rationale:
[ADR 0016](https://github.com/sealant-sh/mend/blob/main/docs/adr/0016-per-person-harness-homes.md).

## On by default, and opting out

`MEND_HARNESS_LAYOUT` is `person` unless set. To keep every new worktree on one shared home, set
`MEND_HARNESS_LAYOUT=shared` on the server and restart it.

- The setting decides only worktrees that have no layout yet. A worktree's layout is recorded with
  its first per-person launch.
- **There is no way back.** A worktree that has run per person always runs per person, whatever the
  setting says later. A launch that cannot run per person on such a worktree is refused with the
  reason, never run with a shared home:

  ```text
  This worktree's sessions are saved per person, and its image cannot run per-person users (no sudo). Pick an image that can, or start a new worktree.
  ```

  Nothing in the worktree changes on a refusal; fixing the image makes the next launch work. A Mend
  older than 0.36 cannot resume that worktree's sessions.

- With `MEND_HARNESS_LAYOUT=shared` and no layout recorded anywhere, Mend reads no layout from the
  store.
- The default holds for every server on the capture store, a loopback `mend server setup` on one
  machine included: whoever runs there runs as their own user. A server on the deprecated co-located
  store (`MEND_SESSION_STORE=colocated`) runs every session with one shared home, whatever the
  setting.
- A standby workspace for [Hot sessions](/guides/project-environment/#hot-sessions) starts in the
  layout its owner's new worktrees would run in. A per-person standby starts as its owner: their
  user, their logins in their own home, and its restore giving the worktree to them and the `mend`
  group. It serves only its owner's session in a new worktree of theirs whose launch is decided per
  person; the workspace's preparation runs at that claim, as a cold per-person launch's does. Where
  new worktrees run with a shared home (an image or runtime that cannot run per person, or
  `MEND_HARNESS_LAYOUT=shared`), standbys start with one shared home, as before. A launch whose
  standby does not match starts cold. Once a standby is claimed, its layout stands: if Mend learns
  in between that the image cannot run per person, the launch runs with one shared home in that
  standby, with the reason, rather than failing.

### What a workspace needs

A launch runs per person only when every part says it can. Otherwise a worktree with no layout yet
runs with a shared home, and the session says why.

- **The Sealant control plane** reports its per-person routes, the dotfiles verb, partial login
  writes, pi's and opencode's logins and the capture owner map. Core `0.39.0-next.706` is the first
  that reports them all.
- **The workspace's sealantd** reports `exec.user`, `dotfiles.user` and `restore.owner_map`.
- **The image** has a setuid `sudo`, `useradd`, `setfacl`, and no user or group with an id in
  40000–49999 other than the `mend` group (gid 40000). Sealant's managed images carry them.
- **The runtime** supports ACLs on `/workspace` and does not impose no-new-privileges on the
  executor, since `sudo` cannot work under it. A per-person workspace checks this before it makes
  anyone (`NoNewPrivs` in `/proc/self/status`), so a Docker host with `"no-new-privileges": true` in
  `daemon.json` runs a new worktree with a shared home and says why.
- **Kubernetes** imposes no-new-privileges (`allowPrivilegeEscalation: false`), so on a Kubernetes
  workspace runtime every new worktree runs with a shared home and says why; nothing is probed.

Core records what each image can do when it builds it, and Mend records what each executor's prepare
found, per image digest and runtime. When neither knows yet, the launch runs with a shared home and
its prepare checks the image, so the next launch on that image can run per person. A workspace
started before 0.36 is replaced (below) only once a per-person workspace has run on that image, or
on a worktree that already runs per person.

A shared workspace's check cannot see what only a per-person workspace meets, so Mend weighs a
remembered "no" by its reasons:

- **Reasons a shared workspace sees** (no `sudo`, `useradd`, `setfacl` or `setpriv`, no ACLs on
  `/workspace`, a sealantd without the capabilities, a uid or name taken): the next shared launch
  checks again, and its answer replaces the "no". Fixing the image heals on its own.
- **A person who could not be made, or an image that could not be checked:** kept for a day, then
  checked again.
- **No-new-privileges, an owner map refused, a runtime that cannot run per person (Kubernetes,
  Cloudflare), or Core's own "no":** kept until the image's digest changes. After fixing the host
  (removing `"no-new-privileges": true` from `daemon.json`, say), clear Mend's answer for the image
  in Postgres, and the next launch checks again:

  ```sql
  SELECT image_key, runtime, missing, observed_at FROM image_layout_capabilities WHERE NOT person;
  DELETE FROM image_layout_capabilities WHERE image_key = '<image_key>' AND runtime = '<runtime>';
  ```

Core reports the runtime it places each image on; on Kubernetes (`k8s`, `k3s`) and Cloudflare
sandboxes every new worktree runs with a shared home before any launch is tried.

**nix images take one person.** Their passwd is in the read-only store, which cannot hold a setuid
`sudo`. A custom image without `sudo`, `useradd` or ACL support also takes one person.

## Who each process runs as

| Process                                                      | Runs as                                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| An agent Mend starts (new, join, resume, follow-up, handoff) | the person whose turn it runs: the session owner, or the steerer under shared control |
| A shell                                                      | the person who opened it                                                              |
| A Service                                                    | the person who started it, across restarts; a `mend.toml` Service, the launcher       |
| Dependency install and setup commands                        | the launcher                                                                          |
| VS Code Remote-SSH, `ssh`                                    | the launcher, as their own user; nobody else can open Remote-SSH into that workspace  |
| `docker exec` and anything else Mend did not start           | root: no person's login, no Mend token, nothing under `/root` saved                   |

Each person has the same login name (`m` and 8 characters), uid (40000–49999) and home
(`/home/<name>`) in every workspace and project. Their home is 0700 and is not saved; the
conversation state Mend saves for them lives in `/workspace/harness-home/people/<account id>`,
linked from their home. Logins are never saved, with one narrow exception: a login made inside
opencode (see [Known issues](/reference/known-issues/#harnesses)).

The worktree is shared: everyone in the `mend` group can write it. Toolchains and caches live in
shared locations (`/opt`, `/var/cache`), so what one person installs everyone can use; credential
files stay in each person's home.

## What sudo means here

Everyone in a per-person workspace has passwordless sudo, which runs as root: anyone working there,
and their agents, can read and change each other's files, logins included.

Agents need `apt-get` and the like, so every person has `sudo`. Every process a person runs also
holds `CAP_FOWNER`, which lets it change the mode and times of files it does not own; pnpm needs it
to relink a restored package's binaries. Both amount to root.

This is not isolation between people. Per-person workspaces decide what each process **uses**: its
own logins, memory and settings, by default and by every path Mend controls. They do not stop one
person, or their agent, from reading another's files. The owner accepted that as the 0.36 limit. The
product says so wherever two people meet in a worktree:

```text
Anna's session is running in this worktree. You share its workspace: everything you run runs as you, on your own logins, but either of you can read the other's files, logins included.
```

and on a session while another person's process is live in its workspace:

```text
Shared workspace with Anna · each of you runs as yourself · either of you can read the other's files.
```

An executor's boundary is the executor. Isolation (no `sudo` for people, or an executor per person)
is a follow-up. The full list of limits is in
[Known issues](/reference/known-issues/#per-person-workspaces).

## Workspaces started before 0.36

A workspace that shares one home keeps it until it is replaced. When a worktree's next launch would
run per person, its live shared-home workspace is marked to retire. Until it is replaced it takes
only its launcher's sessions and turns:

```text
This worktree's workspace started before Mend 0.36 and shares one home; it takes another person once it is replaced.
```

The session line says the same, with the reason the last replacement did not go ahead, for example
`not replaced · 1 shell, 2 processes Mend did not start`.

**What Mend checks.** Once a minute it reads what it recorded (terminal agents, shells, Services,
agent turns) and checks inside the workspace, as root:

- **Processes Mend did not start.** sealantd runs as PID 1 and adopts every orphan, so a process's
  parent says nothing. A process counts as Mend's only in the session of a process Mend recorded (by
  the pid sealantd reported when it started it) or of sealantd itself. Everything else is listed: a
  `nohup` job a closed shell left, a `setsid` or `tmux new -d` job, a daemon, a `docker exec`. A
  process is named by its command name and pid only, never its arguments, and only to the change's
  owner; anyone else sees how many there are.
- **Running containers** of the workspace's Docker sidecar (`docker ps`, with the daemon address of
  the workspace's own environment). If `docker ps` cannot answer (no `docker` command, no daemon
  address, the daemon not answering, a timeout), Mend lists it as something it could not check. It
  never reads as "no containers".

**Mend replaces it on its own** only when all of that finds nothing: no terminal agent or shell,
protocol agents idle, no Service started by hand, no process Mend did not start, no running
container, nothing it could not check. It marks the workspace as being replaced, refusing every new
start, the launcher's included:

```text
This worktree's workspace is being replaced so that each person runs as themselves. Nothing was started; start again once it has been replaced.
```

Then it checks again, saves a final capture and replaces the workspace only once that save stands. A
failed check or save unmarks it and says why. A replacement that a crash or a restart interrupts is
unmarked at the next start, after ten minutes on the regular sweep, or when the owner asks again.
Mend looks for workspaces to retire only while `MEND_HARNESS_LAYOUT` is `person`, the default.

**Otherwise the change's owner chooses.** The owner sees **Replace this workspace now**, when Mend
last checked and what it checked, and one line each for what would stop: terminal sessions (they end
resumable), shells, Services started by hand, processes Mend did not start, running containers, and
anything it could not check. Mend starts the launching session's `mend.toml` Services again. The
replacement checks once more and ends nothing that was not on the list the owner saw; if more would
stop now, it is refused and nothing is stopped:

```text
What would stop has changed since you looked. Nothing was stopped; look at the list again and replace it from there.
```

Mend never stops an agent's turn: while one or background work is in flight, the action is refused:

```text
An agent's turn or background work is in flight in this workspace. Replace it once that has finished.
```

Only the change's owner replaces a worktree's workspace.

### Memory from before 0.36

A shared home's memory is credited server-side, off every launch path. Mend reads it from the
worktree's captures and credits it to:

1. the person Mend's saved record for that home names;
2. else, when every session the worktree had was one person's, that person;
3. else nobody. The worktree then says `memory from before 0.36, not credited · <n> files`.

A former member of the organization is credited nothing. Nothing is deleted from the store.

The capture that counts is the final save of the worktree's last shared-home workspace. A reading
taken while a shared-home workspace still runs is provisional, and the worktree's line adds
`· read again when this worktree runs each person as themselves`. Mend reads again when the worktree
first runs per person, and credits only what no earlier reading credited.

Claude, Codex and pi conversations from before are copied into their owner's directory when the
session resumes, only if absent. opencode conversations saved in a shared home cannot be resumed per
person; their owner can resume them only in that workspace, before it is replaced.

## Performance

The rule for this feature is no performance penalty. Every number below is a hard limit: a missed
limit blocks turning the setting on for an instance Mend runs itself and blocks the release, unless
the owner grants an exception.

Each limit applies to the median and the 90th percentile, per-person launches against shared-home
launches at the same commit, each run on a fresh worktree.

| Measure                                                                  | Limit                                                                                      |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| New session to first output (each harness), resume, Stop's save          | +5% or +1 s, whichever is larger                                                           |
| Second session of the same person                                        | +5% or +1 s, whichever is larger                                                           |
| Join by a different person (against a join that runs as the launcher)    | +3 s                                                                                       |
| Steering hand-over (send to first output, nothing in the background)     | under 5 s more than the same turn sent by the process's own person                         |
| Checkpoint save, restore time, first-turn latency                        | +5% or +1 s, whichever is larger                                                           |
| Restore bytes; capture size per worktree with one person                 | +5%                                                                                        |
| Growth per extra person                                                  | that person's conversation state and memory, plus at most 64 KB                            |
| Delivery (memory, skills, secret files) per person                       | +5% or +0.5 s, whichever is larger                                                         |
| Codex first start                                                        | +5% or +1 s, whichever is larger                                                           |
| Shell and terminal open, `git push` and `fetch`, terminal typing latency | unchanged within noise: the larger of the baseline's spread (worst minus median) and 50 ms |
| Executor disk and memory with one person                                 | +5%                                                                                        |
| Session list and session view API latency                                | +5% or +20 ms, whichever is larger                                                         |

The session list and the session view read the people live in each workspace in the same query as
the session, so the shared-workspace line adds no request.

### How it is measured

A benchmark in the repository (`scripts/bench/`) drives an instance through the API and the CLI with
two accounts on Mend's own repository. It runs each scenario at least 10 times, takes each step's
time from the session record, the server's log lines and the capture records, and writes a JSON
record and a median-and-90th-percentile table with the commit, image, harness versions and each
run's layout. A measure that misses its limit has its whole set repeated, and fails only if the
repeated set misses again.

The benchmark picks the layout per launch on a fresh worktree, so both layouts are measured at one
commit without changing `MEND_HARNESS_LAYOUT`:

- **P1** compares per-person launches against shared-home launches on a scratch instance, then on
  Mend's own instance, and checks shared-home launches on the new images against the record taken
  before any per-person code. It holds back turning the setting on there.
- **P2** repeats the comparison after a week of use with the setting on. It holds back the release.

Both records are checked in under `docs/perf/`. CI also counts the execs and platform calls of a
cold launch, a join, a resume and a hand-over, and fails when a count grows past its budget.
