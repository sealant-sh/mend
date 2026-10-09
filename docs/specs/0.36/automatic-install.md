# Automatic install

- **Release:** 0.36
- **Status:** on main (mend#529 merged 2026-10-04 23:46 UTC, `7102a9d1b`).
- **PRs:** mend#529. Reviews: /tmp/review-529.md (round 1) and /tmp/review-529-r2.md (round 2).
- **Decision records:** docs/adr/0002-session-capture-store.md, amended 2026-09-13, decisions 2 and
  9 (the per-project shared dependency cache with one writer, the install job) and decision 23 (the
  cache lives at `projects/<project>/cache/<platform>/`). No ADR of its own.
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`.

## Why it exists

In capture mode Mend ran a project's install command, the saved one or one detected from the
lockfile, whenever a workspace had no dependency tree for its platform. A person could replace the
command but could not turn the install off. Cases where that hurts:

- a repository whose install is slow, network-heavy, or needs credentials the workspace lacks: every
  first launch of a worktree pays for it (about 14 s of a ~90 s start on the box for the `mend`
  project; `start-time.md`) or fails it;
- a monorepo where the agent should install only the part it works on;
- a project where the person wants the agent to decide.

The old card was a bare text field, "install command", and did not say what Mend would run. The
owner asked for an on/off switch and liked the card's three states (release-roadmap memory note,
2026-10-05).

## What it does

A person who manages the project (an organization owner, or the project's creator) opens the
project's Setup page in the web app. The card titled **Dependencies** has a switch row labelled
`automatic install`. The card has three states:

1. **On, detected** (the default; no custom command saved). The status line reads what a launch
   would run, as read from the ref a launch bases on:
   - `detected · pnpm install --frozen-lockfile · from pnpm-lock.yaml on origin/main`;
   - `detected from the lockfile at launch` while the detection is loading, or when the request
     failed;
   - `not read · detected from the lockfile at launch` when no tree could be read;
   - `no lockfile recognised on origin/main · detected again at launch`.
2. **On, custom.** The status line reads `runs · <cmd> · custom`. The optional field
   `custom command (optional)` with a `save` button stays visible while the switch is on. Saving an
   empty field clears the custom command ("A custom command replaces the detected one. Empty:
   detected.").
3. **Off.** The status line reads `off · no install runs, in sessions or for the shared cache`, plus
   ` · custom command kept` when a custom command is saved. The custom field is hidden.

Copy above the switch:

- Capture mode: "On, Mend installs dependencies before the agent starts when neither the saved state
  nor this project's shared cache has them, and fills the shared cache the same way. Off, Mend runs
  no install; an agent can install by hand. A tree already saved or cached is restored either way."
- Co-located mode: "Capture mode only. This server runs sessions co-located with the store, where a
  worktree keeps its own dependencies and Mend runs no install. The setting is kept for capture
  mode."

What Mend does:

- **On, capture mode:**
  - at each launch whose worktree head has no dependency tree for the executor's platform, Mend runs
    the custom command, else the detected one, in `/workspace/repo` before the agent starts;
  - when the switch goes from off to on, or the command is saved while on, Mend queues the install
    job, which fills the project's shared dependency cache for one platform.
- **Off:** Mend runs no install command for the project, in a session or in the install job. A
  dependency tree already in the worktree's saved state, or in the shared cache a standby restores,
  is restored either way. An agent (or the person) can install by hand; that tree is captured with
  the session's work like any other bytes.
- **Co-located mode** (`MEND_SESSION_STORE=colocated`, deprecated): Mend never installs, whatever
  the switch says.

Defaults:

- On for every project, existing and new (migration 0110: `DEFAULT true`).
- A saved `install_command` is kept across the migration and across off/on.

Detection order (packages/sessions/src/dependency-cache.ts:204–228; the first file present at the
tree's top level wins):

| Command                          | Decided by                                 |
| -------------------------------- | ------------------------------------------ |
| `pnpm install --frozen-lockfile` | `pnpm-lock.yaml`                           |
| `bun install --frozen-lockfile`  | `bun.lock`, `bun.lockb`                    |
| `yarn install --immutable`       | `yarn.lock`                                |
| `npm ci`                         | `package-lock.json`, `npm-shrinkwrap.json` |
| `npm install`                    | `package.json`                             |
| `cargo fetch --locked`           | `Cargo.lock`                               |
| `cargo fetch`                    | `Cargo.toml`                               |
| `uv sync --frozen`               | `uv.lock`                                  |
| `poetry install`                 | `poetry.lock`                              |
| `go mod download`                | `go.sum`, `go.mod`                         |

**In scope.**

- `projects.install_enabled`, the API to read and set it, and the detection endpoint.
- The engine guard on every session launch path, and the install-job guard.
- The web Dependencies card in both server modes.
- Queueing the install job on off→on and on command save while on.
- The shared dependency cache's single writer (the install job) and its reader (a standby's plan).

**Out of scope.**

- A CLI, phone, desktop, VS Code, Slack or t3 gateway surface for the switch. None has an
  install-command surface today. Desktop only gained the field in a fixture.
- Choosing which parts of a monorepo to install.
- A session-visible line saying "install skipped · automatic install off". The skip is logged only
  (see Divergences).
- Restore behaviour: never governed by the switch.
- Co-located mode installs: there are none.
- Seeding a cold launch from the shared cache (see Divergences: the docs claim it does).

## How it works

### Storage and contract

- Migration `0110_project_install_enabled` (packages/db/src/migrations.ts:3026, registered :3169):
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS install_enabled boolean NOT NULL DEFAULT true`.
  Drizzle: packages/db/src/schema/workbench.ts:459.
- Domain: `Project.installEnabled` decodes a missing key as `true`
  (packages/domain/src/workbench/project.ts:227, `withDecodingDefaultKey`), so a new client reading
  an old server sees "on".
- Repo: `ProjectsRepo.setInstallEnabled` (packages/db/src/repos/projects.ts:399) sets the value and
  bumps `updated_at`.
- Contract (packages/api-contracts/src/projects.ts):
  - `PUT /projects/:id/install-command` (:156), payload `{ installCommand: string | null }`,
    unchanged;
  - `GET /projects/:id/install-detection` (:165) answers
    `ProjectInstallDetection { ref, read, command, from }`
    (packages/api-contracts/src/workbench-views.ts);
  - `PUT /projects/:id/install-enabled` (:172), payload `{ installEnabled }`.
- Web server router: apps/web/src/server/routers/projects.ts; client helpers in
  apps/web/src/lib/api.ts.

### API handlers

apps/api/src/routes/workbench.ts:

- `installCommand` (:858):
  - checks `ProjectAccess.manageProject`;
  - trims the payload and saves it;
  - while `installEnabled`, enqueues `dependency-install` with
    `{ projectId, requestedByUserId: caller }` and idempotency key
    `dependency-install:<project>:<updatedAt>`. Enqueue errors are ignored.
- `installDetection` (:882):
  - checks `ProjectAccess.project` (anyone who can see the project);
  - lists the top level of `refs/remotes/origin/<default>`, falling back to `<default>`, through
    `Store.listTopLevel(storePath, ref, FILE_LISTING_LIMIT)`. Never fetches;
  - runs `detectInstall` on the names;
  - any failure of both reads answers `read: false`, `ref: <default>`.
- `installEnabled` (:907):
  - `manageProject` returns the project before the write (`before`);
  - saves the new value;
  - enqueues the job only when `before.installEnabled` was false and the new value is true. on→on,
    on→off and off→off queue nothing.

### Session launch (engine)

`installDependenciesIfNeeded`, packages/sessions/src/engine.ts:2045. It has one caller,
`launchInternalBody` (:11946). That covers cold launch, hot-pool adoption, resume, follow-up
relaunch and the install job's own session. The project is read fresh at each launch.

1. Co-located (`capture === null`): return, nothing runs.
2. `!project.installEnabled`: log
   `session engine: dependency install skipped · automatic install off`, return. This happens before
   the platform probe and the manifest read.
3. Probe the platform (`uname -s; uname -m; ldd --version`, `PLATFORM_PROBE_SCRIPT`) and read it as
   `<os>-<arch>-<libc>`. Unknown: skip, logged.
4. Read the worktree's head manifest:
   - unreadable: skip, and the session line gets
     `dependency install skipped · capture <n> manifest unavailable` (:867, said at :12122);
   - the head carries a bulk section for this platform (`bulk`, or one in `other_bulk`): log
     `dependency tree observed for this platform`, return.
5. Command: `project.installCommand`, else
   `detectInstallCommand(git ls-tree --name-only <session.baseSha>)` from the bare store. None:
   skip, logged.
6. Run `sh -lc <script>` with cwd `/workspace/repo` through `sealant.exec`, as the session's owner.
   The script is the command itself, except for a plain `pnpm install` (`installScript`,
   `dependency-cache.ts`). That one gets `--fetch-timeout=15000` and the environment
   `npm_config_update_notifier=false` and fetch-retry waits of 2 s and at most 10 s (under
   `npm_config_` and `pnpm_config_`). Each is added only when neither the environment nor `.npmrc`,
   `pnpm-workspace.yaml`, `~/.npmrc` or the user's pnpm config sets it. Log
   `dependency install · completed|exited · exit <n> · fetch retries <k>`, where `k` is the number
   of output lines that report a stalled or retried download (stderr's last 400 characters on
   failure).
7. A nonzero exit does not fail the launch. Any error is logged as `dependency install did not run`,
   and the agent starts.

### The install job and the shared cache

packages/jobs/src/dependency-install.ts.

- `DependencyInstaller.install(job)` skips, with a reason, when:
  - not in capture mode;
  - the project is gone;
  - `installEnabled` is false ("automatic install is off");
  - no account may run the install.

  The account is the job's `requestedByUserId`, else the project's creator, and only one that
  `mayRunIn` the project's organization (ADR 0003).

- `InstallRunnerEngineLive.run`:
  - provisions a session of harness `shell`, label `INSTALL_SESSION_LABEL`, owned by that account,
    in a fresh worktree;
  - launches `sh -lc true`. The engine's launch runs the install first (capture 0 has no dependency
    tree);
  - polls every 5 s until it settles, up to `INSTALL_SESSION_DEADLINE` (30 minutes).
- After the session settles, the job reads the session's head capture. It promotes its `bulk`
  section, and only that one (never `other_bulk`), into `projects/<project>/cache/<platform>/` by
  server-side copy. `root.json` is written last (`promoteBulkToCache`, dependency-cache.ts:125). The
  record is replaced whole by the next promotion.
- Nothing else calls `promoteBulkToCache`. A session's own capture is never promoted.
- The job does not check `installEnabled` again after the session ran (see Divergences).
- Reader: a standby (hot-pool) executor's `plan.get`.
  - The engine answers it through `standbyApiFor(... plan: (platform) => prepare(...))`
    (engine.ts:2253–2261).
  - That calls `prepareStandby(projectId, alias, epoch, baseSha, platform)`
    (packages/sessions/src/session-repository-captured.ts:529).
  - `prepareStandby` splices `readDependencyCache(projectId, platform)` in as the base plan's `bulk`
    (:555–585). A record that names another platform is never served.
  - Neither path reads `installEnabled`.
- A cold launch's capture 0 always has `bulk: "pending"` (session-repository-captured.ts:299), so a
  cold launch never reads the cache. It installs, or not, by the switch.

### Web

- `apps/web/src/routes/projects.$projectId.setup.tsx:147`:
  - renders `InstallCommandSection` only inside `capabilities.manage`;
  - passes `captured = mountDelivery === "sources"`, where the server answers
    `sessionStore === "captured" ? "sources" : "bind"` (apps/api/src/routes/workbench.ts:634).
- `InstallCommandSection` (apps/web/src/components/project-setup.tsx:1230):
  - queries `projects.installDetection`;
  - the switch handler ignores a click while busy or a no-op;
  - each write invalidates the projects queries.
- `AutomaticInstallView` (apps/web/src/components/automatic-install.tsx) is a pure view of its
  props. `OnOffSwitch` (apps/web/src/components/on-off-switch.tsx) marks the lit option with
  `aria-pressed`.
- The section anchor stays `id="install-command"` so old links work.

### Concurrency and restarts

- A flip applies to the next launch. A launch already past step 2 runs its install.
- A job already queued when the switch goes off finds it off and runs nothing.
- A job whose install session launched before the flip still promotes.
- A switch that goes off between the job's check and the install session's launch: the engine guard
  catches it, and the job ends `the install session's head capture carries no dependency tree` or
  `captured nothing`.
- Jobs run on pg-boss (`JobRunner.work("dependency-install")`) and survive a Mend restart. A Mend
  restart mid-install leaves the install session to the engine's boot pass (`start-time.md`). The
  job's poll dies with the process; pg-boss retries the job.

## Happy path

Ada owns the organization. Ben is a member. Project `shop` (pnpm) is shared. The server runs in
capture mode.

1. Ada opens `/projects/shop/setup`. The Dependencies card shows `automatic install` on and
   `detected · pnpm install --frozen-lockfile · from pnpm-lock.yaml on origin/main`.
2. Ben opens the same page. He sees "How sessions here launch is set by the project's creator or an
   organization owner." and no card. `PUT /api/projects/shop/install-enabled` from Ben's token
   answers 404.
3. Ada switches automatic install off. The status line becomes
   `off · no install runs, in sessions or for the shared cache`. No job is queued.
4. Ben starts `mend claude` in a new worktree of `shop`. The Mend log shows
   `dependency install skipped · automatic install off`. Claude starts with no `node_modules`. Ben
   asks it to run `pnpm install --filter web`. That tree is captured with the session.
5. Ben stops and resumes the session. The resume restores `node_modules` from saved state, and no
   install runs.
6. Ada types `pnpm install --frozen-lockfile --filter web` into the field. It is hidden while off,
   so she first switches on: a `dependency-install` job is queued with `requestedByUserId = Ada`.
   Then she saves the command. Another job is queued, and the status reads
   `runs · pnpm install --frozen-lockfile --filter web · custom`.
7. The job's install session runs under Ada's account, installs, settles, and its bulk is promoted.
   The log shows `dependency-install: shared cache promoted { platform: linux-x86_64-gnu }`.
8. A standby in `shop`'s hot pool restores that tree. Ben's next session, claimed from the pool,
   starts with `node_modules` in place.
9. Ada switches off again. The status reads `off · … · custom command kept`. Switching on again
   restores `runs · … · custom` and queues one job.

## Invariants

1. With `install_enabled = false`, no session launch of the project runs an install command, and the
   install job runs no install session. Tested by removing the guard: the engine test then sees one
   call instead of zero.
2. The switch never changes what is restored. A dependency tree in the worktree's saved state, or in
   the shared cache a standby's plan names, is restored whatever the switch says.
3. Only the install job writes under `projects/<project>/cache/<platform>/`, and only from the
   `bulk` section of its own install session's head capture. A session's own capture never becomes
   another session's dependency tree.
4. A cache record is served only for the platform it names.
5. Only `manageProject` (organization owners and the project's creator) can set the switch or the
   command. `GET install-detection` needs only `project` (visibility).
6. The install job runs on the account that asked for it, else the project's creator. It runs only
   on an account allowed in the project's organization, and never on anyone else's credentials. One
   person's credentials are never spent by or exposed to another. A session's install runs as that
   session's owner.
7. What the install job promotes is the dependency tree only: never the harness home, secret files
   or the executor's home, which no capture root covers.
8. `PUT install-enabled` queues a job only on off→on. Re-sending `true` queues nothing.
9. `GET install-detection` never fetches from origin and never writes to the store.
10. The card says what was observed, and only that: `not read` is never shown as
    `no lockfile recognised`, and nothing predicts what an agent will do ("an agent can install by
    hand").
11. No loss of work product: turning the switch off or on deletes no saved state, no cache, and no
    saved custom command.
12. In co-located mode no install runs, and the card says "Capture mode only".

## Edge cases and failure behaviour

- **The repository changes package manager after adoption.** The card reads `origin/<default>` as
  last fetched, which `freshenBase` moves on every launch. It matches what a launch on the default
  branch detects, from the session's `baseSha`.
- **A session based on another branch or ref.** The engine detects from that session's `baseSha`.
  The card only speaks for the default branch and may name another command.
- **Empty repository, missing default branch, git error.** `read: false`,
  `not read · detected from the lockfile at launch`.
- **A top level over 20,000 entries** (`FILE_LISTING_LIMIT`). The card's listing is capped; the
  engine's `ls-tree` is not. A lockfile past the cap reads "no lockfile recognised" on the card
  while launches install.
- **The install command fails** (exit ≠ 0). The launch goes on, the agent starts, the log carries
  the exit code and stderr tail, and the session line says nothing. In the install job, the
  session's head may still carry a partial bulk; it is promoted if present.
- **The install hangs.** The session's exec has no bound of its own besides the SDK's 30-minute exec
  timeout (`EXEC_TIMEOUT_MS`; Mend's `SealantClient.exec` adds none). The agent does not start until
  it returns, and the session reads `starting` meanwhile. The install job gives up waiting for its
  session after 30 minutes.
- **Two `PUT install-enabled {true}` at the same moment from off.** Both may read `before = off` and
  queue two jobs. The web disables the switch while busy. Accepted (review round 2, P3).
- **`PUT install-command` with an unchanged command while on.** It queues a job (existing
  behaviour).
- **The switch goes off while the install job's session is running.** The session's install has
  already run. The job promotes the result (see Divergences).
- **The platform probe fails** (no `uname`). Install skipped, logged.
- **An image without `sh -l` support or the package manager.** The exec exits nonzero; same as a
  failed install.
- **Older data.** Projects from before 0110 read on. Jobs queued before accounts carried a signer
  run as the project's creator. An old client ignores `installEnabled`. A new client against an old
  server reads it as on.
- **Permissions.** Owner and creator: read and write. A member of a shared project: no card, 404 on
  the PUTs, can read detection. An operator: no default read access to organization content (ADR
  0003); the route enforces project visibility.
- **Clients.** Web only. CLI, phone, desktop, VS Code, Slack and the t3 gateway neither show nor set
  the switch. Sessions started from any client obey it.
- **Hot pool on, switch off.** A standby still restores the cached tree, if a cache exists from
  earlier, and the agent starts with it. No new cache is filled while off.

## Known limits

- No session-visible word that the install was skipped by the switch, or that it failed. Logs only.
- The shared cache is read only by standby executors. A cold launch on a fresh worktree installs (or
  not) every time.
- The cache holds one platform's tree per promotion; each platform needs an install job that ran on
  it.
- The install session's worktree stays in the project after the job (the job does not remove it).
  Not verified as visible in the worktree list.
- Review round 2 P3 (concurrent PUTs) is accepted.

## How to verify

**Tests.**

- packages/sessions/test/engine.test.ts:20587, describe "automatic install": on runs the saved
  command, off runs none (fails without the guard).
- packages/jobs/test/dependency-install.test.ts:214, "automatic install off: the job runs no install
  session and promotes nothing".
- apps/api/src/routes/workbench.test.ts:598, describe "automatic install routes":
  - the four transitions;
  - install-command while off;
  - detection origin-first, local fallback, `read: false`.
- apps/api/src/routes/project-access.test.ts: the access matrix for both new endpoints.
- packages/db/test/migrations.test.ts:622: 0110 defaults existing and new projects to on and keeps
  the command.
- apps/web/src/components/automatic-install.test.tsx: pending, detected, no lockfile, not read,
  custom, off, co-located.
- packages/sessions/test/dependency-cache.test.ts: `detectInstall` order and the deciding file.
- packages/api-contracts/src/contract.test.ts: the new endpoints.
- Not covered by tests:
  - the switch going off between the job's check and its session's launch;
  - the job promoting after a mid-run flip;
  - the hot-pool claim path on its own;
  - the card's 20,000-entry cap against a deep top level.

**By hand on the box.**

```sh
# read the switch and the detection (CLI bearer from ~/.config/mend/cli.json)
curl -sH "Authorization: Bearer $T" https://alpha.mend.run/api/projects/<id>/install-detection
# turn it off, then on, and watch the job queue
curl -sX PUT -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"installEnabled":false}' https://alpha.mend.run/api/projects/<id>/install-enabled
mend claude    # in a fresh worktree of that project; then on the box:
ssh -J root@100.94.101.28 root@10.0.0.40 \
  'docker logs --since 5m mend-mend-1 2>&1 | grep -E "dependency install|dependency tree observed|dependency-install"'
# job state
ssh … "docker exec mend-postgres-1 psql -U mend -d mend -Atc \
  \"select name, state, created_on from pgboss.job where name='dependency-install' order by created_on desc limit 5\""
```

**Signals.**

- `session engine: dependency install skipped · automatic install off`
- `… dependency tree observed for this platform`
- `… dependency install · running { command }`
- `… dependency install · completed|exited · exit N · fetch retries K`
- `dependency-install: shared cache promoted { platform, captureId, packs }`
- `dependency cache: the record under this platform names another platform's tree · not served`

## Divergences found while writing

1. apps/docs/src/content/docs/guides/project-environment.md:189–191 says "Standby workspaces and
   cold launches read that cache". packages/sessions/src/dependency-cache.ts:33–35 says the same of
   "a cold launch whose head carries no bulk". In code the only reader is `prepareStandby` through a
   standby's `plan.get` (engine.ts:2253–2261, session-repository-captured.ts:555). Capture 0 of a
   cold launch is always `bulk: "pending"` (session-repository-captured.ts:299), and
   `installDependenciesIfNeeded` installs without looking at the cache. The card's copy ("when
   neither the saved state nor this project's shared cache has them") inherits the same claim.
2. engine.ts:14689–14693: the only engine caller of `prepareStandby` that is not the standby's own
   `plan.get` passes `platform: undefined`, so that pre-claim plan never carries the cache. That is
   probably intended (the executor names its platform in `plan.get`). Noted because a reviewer
   following divergence 1 will land here.
3. packages/jobs/src/dependency-install.ts:94–96 checks `installEnabled` once, before the install
   session. After `runner.run` returns it promotes without looking again. A switch turned off while
   the session ran still fills the shared cache. The card says "off · no install runs … for the
   shared cache". The install did run before the flip, so this is arguably fine. Intent unclear.
4. engine.ts:2048–2052 and :12122: with the switch off, a launch that would have installed says
   nothing on the session line (log only). A failed install (exit ≠ 0) also says nothing there. Only
   the "manifest unavailable" skip is said
   (`dependency install skipped · capture n manifest unavailable`). A person who opens a session
   with no `node_modules` has no observed reason beside it.
5. apps/api/src/routes/workbench.ts:886–893 versus engine.ts:2093–2098: the card lists up to
   `FILE_LISTING_LIMIT` top-level names; the launch's `ls-tree` has no limit. Past the cap the card
   can say "no lockfile recognised" while launches install. This only matters with more than 20,000
   top-level entries.
6. apps/docs/src/content/docs/reference/feature-status.md:33: "Mend runs it on a platform mismatch
   and to fill the shared cache". It also runs when the head has no dependency tree at all, which is
   every fresh worktree. Wording only.
