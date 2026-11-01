# Resources: long-running services for a project or a worktree

Status: accepted 2026-10-31, amended 2026-11-01. The November 1 amendment below is the design to
build next. The October 31 build merged as Mend `f7b8776`; this document describes the agreed
replacement behavior, not a claim that it is already implemented. Earlier proposals and decision
wording remain in git history.

A resource is a long-running service a project declares, such as Postgres, Redis or any image.
Sealant runs it beside the project's sessions. Sessions reach it by name over the project network;
Mend never carries its bytes. A Service keeps its existing meaning, a session's declared port.
Resources are development resources. Their status says what Mend observed, never that data is safe.

## The design that ships

### Amendment of 2026-11-01

Yiannis decided this model on 2026-11-01. It replaces the October 31 stories 1 to 4 and 6 where they
made adding or launching start resources, fixed a definition to one level, defaulted Postgres to
`own`, or supplied conventional env names. Stories 5 and 7 to 9 keep their data, status, agent and
load behavior. The rewritten stories below are the complete set.

It also replaces the October 31 "Definitions" and "Env per process" rules and the earlier "Two
scopes", "What a person writes and sees", "Env" and "Lifecycle" sections. The decisions table below
records the current outcomes for S1, S2, S8, S10, S11, S14, G9, G11 and G12. The October 31 removal
of approvals, grants, snapshots and generation fences still holds for S12, S13, S15, G1, G4, G7 and
G8. Obsolete instructions have been removed so they cannot be mistaken for the design.

The file is definitions only, like a compose file. Starting reads the worktree's definition at that
moment. Nothing starts merely because someone edits a file, adds a definition or launches a session.
The first start is always explicit. Only an idle-stopped resource wakes on use.

#### What changes from the 2026-10-31 build

- Session launch no longer starts resources, except to wake something stopped only for idleness.
- There is no add-to-settings step or `mend resource add --from-file`. The file holds definitions.
- Start asks for project or worktree level. `--project` and `--worktree` answer up front.
- A project setting controls whether new worktrees use project resources, with per-resource switches
  in each worktree.
- Any resource can run at project and worktree level at the same time.
- Postgres defaults to the shared database. The agent is told to start a worktree database before
  changing the schema.
- Mend supplies only `MEND_<NAME>_*` resource env. Conventional names are no longer supplied.
- Service recipe `env` values may reference `MEND_*` resource variables.
- The file moves to `.mend/mend.toml`. Root `mend.toml` still works; `.mend/` wins when both exist.

### The stories

1. **Declare, then start.** A member writes `[resource.<name>]` in the worktree's `.mend/mend.toml`,
   or uses `mend resource add` or the web's Add to write that table. None of these starts anything
   or changes a running resource. Start reads that worktree's file. The terminal asks "project or
   worktree?"; `--project` or `--worktree` answers it up front. Without a terminal and without a
   flag, it refuses with the one-line hint
   `choose a level: mend resource start <name> --project or --worktree`. Agents always pass a flag.
   The web's Start offers the same choice. There is no approval step. The platform still refuses
   privileged mode, added capabilities, host network or mounts, the Docker socket and devices.
2. **Use what is available.** Every process Mend starts in a worktree gets `MEND_<NAME>_URL`,
   `_HOST` and `_PORT` for the resources that worktree uses. Postgres adds `_USER`, `_PASSWORD` and
   `_DATABASE`. `NAME` is the table name upper-cased, with `-` written as `_`. Mend sets no
   `DATABASE_URL`, `PG*`, `REDIS_URL` or other conventional resource env. The app or agent chooses
   whether and how to use these values. Mend never overrides a variable the app or project sets.
3. **Two levels, shared files.** A project resource is one instance every worktree can use. A
   worktree resource is a copy for one branch. Sessions in that worktree share it, just as they
   share files; there is no session level. Any definition can run at both levels at once. A worktree
   resource of the same name wins in its worktree, while the project resource keeps running for
   everyone else. Postgres uses its own database on the project's Postgres server, copied from the
   shared database when that has data and empty otherwise. Every other image, including Redis, gets
   its own container at worktree level.
4. **Choose what a worktree sees.** Project resources are visible to every worktree by default. The
   project setting "new worktrees use project resources: on/off" controls the default for new
   worktrees. Each worktree can turn each project resource on or off. Postgres defaults to `shared`;
   starting its worktree database selects `own`. `off` hides that project resource from the
   worktree. Visibility never starts a resource. Switching keeps both sides and their data, restarts
   the worktree's Services and tells the agent which env values changed. Existing processes,
   including the agent's own shell, keep their old values until restarted or explicitly given
   current values. The exact messages are under [Env](#env).
5. **Data survives.** Stopping every session keeps every row. Stops and idle stops keep the data.
   Removing a worktree dumps its own database before dropping it and archives its resource volumes.
   Deleting a project archives its resource volumes and lists them for the organization's owners.
   Removing a table from the file never deletes a running resource or its data.
6. **Idle stops and previews.** After nothing uses a resource for 30 minutes, it stops and keeps its
   data. A session launching in a worktree that uses it, or a preview waking, restarts it only if it
   stopped for idleness. A resource that a person or agent stopped stays stopped until someone
   explicitly starts it. A Service with `depends = ["@db"]` uses the worktree's selected resource;
   declaring that dependency never performs its first start. Stopping a preview leaves its resources
   running.
7. **One status line everywhere**, such as `@db · running · project · shared database · observed`,
   on the web app, CLI, phone, VS Code, Slack and agent's workspace note, from one
   `resourceStatusLine`. The workspace note also names the available variables, for example
   `@db · Postgres · project · MEND_DB_URL`. These lines describe observations.
8. **The agent can do everything its person can.** It can add, start, stop, switch, reset and load
   through `mend resource` inside the session, acting as its owner. It needs no additional approval.
   Before changing the schema, it starts its own worktree database.
9. **Load data from another database**, Postgres only. The CLI loads a plain or custom-format dump,
   or a URL it dumps with `pg_dump` on the person's machine and streams up. The web Resources page
   accepts an uploaded dump or a URL Mend's server can reach and pull. The agent does either from
   its session. The caller picks the shared database or this worktree's own database. A load
   replaces its data and saves the previous data as a dump first. The status names that dump and
   reports size and progress. A URL's password is never logged, recorded or shown back.

### The file and the Resources page

Definitions live in `.mend/mend.toml`, versioned with the worktree. Root `mend.toml` remains a
fallback for existing repositories. When both exist, Mend reads `.mend/mend.toml`; it does not merge
the two files. `.mend/` holds Mend's repository files, including files a future setup session may
write, such as a feature map or verification file.

A `[resource.<name>]` table describes the image, ports, env and volumes, with a preset where Mend
knows the resource's internals. It declares no level. The same definition can start at project level
and worktree level. For example:

```toml
[resource.db]
preset = "postgres"
image = "postgres:17"

[resource.cache]
preset = "redis"
image = "redis:8"

[resource.mail]
image = "axllent/mailpit:v1.21"
ports = { smtp = 1025, http = 8025 }
volumes = { data = "/data" }
env = { MP_DATABASE = "/data/mailpit.db" }
exports = { URL = "smtp://{host}:{port.smtp}" }
```

Writing, editing or merging this file starts nothing and changes nothing running. There is no
separate settings copy of a definition and no import step. `mend resource add` and the web's Add
write a table into the worktree's `.mend/mend.toml`. The web Resources page lists definitions from
the default branch plus whatever is running, including resources whose tables have been removed.

A running project resource remembers the definition it started from. If a worktree's file differs,
its status line says `@db · project · definition differs from this worktree`. Starting it again from
that worktree asks whether to restart it with the new definition, and names the worktrees that use
it; the agent answers with `--restart`. A file edit alone cannot restart it. Removing its table
cannot remove its data or stop it.

A name is a lowercase DNS label, with digits and hyphens allowed after the first letter and no
trailing hyphen. Existing network names remain reserved. A name whose generated env collides with
Mend's own `MEND_*` names is refused.

### Project and worktree levels

| Resource                 | Project level                        | Worktree level                                                                                 |
| ------------------------ | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Postgres                 | One server and its shared database   | Its own database on that same server, copied from shared when shared has data, empty otherwise |
| Redis or any other image | One container every worktree can use | Its own container for that worktree                                                            |

Both levels can run at once. Worktree A's `@mail` uses its own container when one exists; worktree B
can keep using the project's `@mail`. Starting A's resource never replaces the project resource. The
same rule selects A's own Postgres database while B keeps using the shared database.

The project visibility setting defaults to on. Turning it off changes what new worktrees use;
existing worktrees keep their choices. A worktree can turn each project resource on or off. These
choices describe availability, not start instructions. Keep `shared`, `own` and `off` for the
Postgres database choice; prefer project and worktree for the two levels.

### Env

Yiannis's rule is: "from mend here is what you have, you want it? use it, if not that's fine". A
project can ignore resources and use a Service, its real env, project secrets or Doppler instead.

Mend gives each new process the current values for the resources its worktree uses. That includes
the agent, a resume, a shell, a Service, setup and dependency installation. Preparing env does not
perform a first start or undo a person's or agent's stop. A worktree that has a project resource off
gets no env for that project resource.

| Resource              | Variables Mend supplies                                            |
| --------------------- | ------------------------------------------------------------------ |
| Every resource        | `MEND_<NAME>_URL`, `MEND_<NAME>_HOST`, `MEND_<NAME>_PORT`          |
| Postgres, in addition | `MEND_<NAME>_USER`, `MEND_<NAME>_PASSWORD`, `MEND_<NAME>_DATABASE` |

`NAME` is the TOML table name upper-cased with `-` written as `_`. `[resource.db-main]` therefore
gives `MEND_DB_MAIN_URL`. Postgres's `_PASSWORD` is empty in the password-free model below. The
prefix is `MEND_<NAME>`, replacing the former `MEND_RESOURCE_<NAME>`. Mend no longer sets
`DATABASE_URL`, `PG*`, `REDIS_URL` or any other conventional resource env. A name that would collide
with Mend's own names is refused. App and project variables are never overridden.

The app or agent opts in. An agent can run:

```sh
DATABASE_URL=$MEND_DB_URL pnpm dev
```

A repository's `.env` can map the variable if its env loader supports expansion. Mend does not
expand that file. A Service recipe can map resource variables directly:

```toml
[service.web]
command = "pnpm dev"
port = 3000
browserScheme = "http"
depends = ["@db"]
env = { DATABASE_URL = "${MEND_DB_URL}" }
```

Recipe `env` may reference `MEND_*` resource variables. Mend resolves those references using the
worktree's current resource values when it starts the Service. A recipe still cannot set a `MEND_*`
variable itself. `depends` names the resource; it does not imply a conventional app variable.
Existing explicit dependency mappings are also opt-ins, never automatic conventional env.

#### The workspace note and switch message

The workspace note lists available resources, for example `@db · Postgres · project · MEND_DB_URL`.
It includes these exact instruction lines:

```text
MEND_* resource values are fixed when a process starts. After a switch, already-running processes, including your own shell, keep the old values. Run mend resource env to print the current values, or restart the process to receive them. Printing values does not update your shell.
Before changing the database schema, start your own worktree database: mend resource start db --worktree.
```

The schema line uses the declared Postgres resource's name in place of `db`.

When a worktree switches levels, Mend tells the agent in the session which variables changed, using
their names and no values. List only variables whose values changed. On a Postgres switch within one
server, host, port, user and password can stay the same. For a change only to URL and database, the
exact message is:

```text
@db switched from project to worktree. Changed: MEND_DB_URL, MEND_DB_DATABASE. Your already-running processes, including your own shell, still have the old values. Run mend resource env to print the current values, or restart the process to receive them. Printing values does not update your shell. Mend restarted this worktree's Services with the current values.
```

The resource name, direction and list reflect the actual switch. A message reports Services
restarted only when Mend observed that restart. If a restart fails, it names the Service and reports
the failure instead. A switch changes the values for new processes; it cannot rewrite env inside any
process already running. `mend resource env` prints current exports. The caller must apply them or
start another process. Mend restarts the worktree's Services, as in the October 31 build, and gives
them current values. Other processes, including the agent's own shell, retain their old values. Both
targets and their data stay in place.

### Sealant runs the instances

Core gains a resource instance under a project's resource domain (Core #420). It is a container from
an image pinned by digest, with named volumes, a CPU and memory limit, and no harness, worktree or
TTL. The SDK exposes instance and workspace operations on `sealant.scopes.actAs(scopeId)`:

```ts
scope.instances.up(key, spec, { cause: "use" | "person" }); // explicit start, or wake an idle-stopped instance
(scope.instances.get(key), scope.instances.list({ archived }));
scope.instances.stop(key, { kind: "person", by }); // graceful; the container and volumes stay
scope.instances.exec(key, { argv, user, stdin }); // streamed stdin, capped output, never recorded
scope.instances.archive(key); // container removed, volumes kept and listed
scope.workspaces.link(workspaceId, { worktreeKey }); // this workspace reaches the scope's instances
scope.archive(); // every instance archived, every workspace unlinked
```

- **The spec cannot ask for what is refused.** It has no field for privileged mode, capabilities,
  host network, host paths, devices, the Docker socket or shared namespaces, and Core's decoder
  names each one it is sent. Volumes are named Docker volumes only. Every `VOLUME` the image
  declares gets a named volume too, so no data lands in an anonymous volume that a removal deletes.
  Core never runs `docker rm -v`, `docker volume rm` or a prune on them.
- **Reach.** Each workspace executor that is linked to a scope gets an internal Docker network of
  its own. Every instance the workspace may reach joins it under its alias, so `db` answers on it. A
  project instance joins the linked executors' networks where that worktree uses it and has no
  worktree container of the same name. A worktree instance joins only the networks of executors
  linked with its worktree key. Two workspaces never share one of these networks, so they cannot
  reach each other on them, and a worktree's instance is unreachable from another worktree. Mend's
  selections and visibility determine what a workspace may reach. Sealant reconciles those
  attachments on launch, executor end and its existing tick. An executor replacement gets a new
  network. Core allocates each network's subnet from its own pool, so the Docker daemon's default
  pools do not run out.
- **Egress.** Each instance also joins an egress network of its own, so it can reach what Mend's
  server can (a staging database for a pull) and no other instance. The cloud-metadata route is
  refused in it on every start.
- **Idle.** An instance that no live executor reaches for 30 minutes stops, and keeps its volumes.
  `up` with cause `use` only wakes an idle-stopped instance. It never creates a first instance or
  starts one a person or agent stopped. Cause `person` is an explicit Start by a person or agent,
  and clears that hold.
- **Exec** runs a command in a running instance with stdin streamed in and stdout and stderr
  returned as capped tails. Nothing of its argv or stdin is logged or recorded. Mend uses it to
  create, copy, dump and restore databases, so those bytes stay inside the instance.
- **Archive** stops an instance, removes its container and keeps its volumes. A scope's archive does
  it for every instance and unlinks every workspace.
- **Docker only.** Another runtime refuses by name
  (`@db · resources run on Docker; this Sealant runs kubernetes`).

### What Mend remembers

The file is the only source of definitions. A running resource's remembered start definition is a
record of what runs, not a second editable definition in settings. Mend also remembers worktree
visibility, selected level and whether a stop was explicit or idle. A process launch links the
workspace and supplies current env; it wakes only an idle-stopped resource already selected there.

Postgres uses one server for a project's named resource. The shared database is `app`; a worktree's
own database has a name derived from its worktree id. Its first explicit start copies shared inside
the instance with `pg_dump | pg_restore` when shared has tables and starts empty otherwise.
Subsequent starts keep its data. Reset saves the target as a dump, then empties it; an own database
is copied from shared again when shared has data.

Postgres runs with `POSTGRES_HOST_AUTH_METHOD=trust` and Redis without a password. The reach network
is the access boundary. There are no per-person grants, test or shadow databases in this design.
Generic resource env can refer to project secrets. A load URL's password is never logged or
recorded.

### Loading

A load is Postgres-only and replaces a chosen target's data from a plain SQL or custom-format dump,
or from another database. The target is the shared database or this worktree's own database. Only
one load per target runs at a time.

The CLI accepts a file or runs `pg_dump` against a URL on the person's machine and streams the dump
up. The web accepts an uploaded dump or pulls from a URL Mend's server can reach. The agent can do
either from its session. Mend stages and restores the incoming data separately. Before replacing the
target's data, it saves the previous data as a checked dump. The status line names that dump. A
failed restore leaves the target's previous data in place.

Progress reports bytes received and the phase. A source of unknown size shows bytes so far rather
than a percentage. A URL's password is never logged, recorded or shown back; the status names the
source by host and database.

### Removal

- **A worktree.** Before its store goes, each own database it has is dumped into the dumps volume,
  checked and dropped. A server that is stopped is started for it. Its worktree instances are
  archived.
- **A project.** Mend archives the project's scope and keeps a row naming the organization, the
  project, its creator and the kept volumes with their sizes. Organization owners see the list in
  organization settings. Nothing deletes them.

### Who may do what

| Act                                                | Who                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| Read status, add, start, stop, load                | Any member who can see the project                               |
| Switch a worktree's choice, reset its own database | The worktree's change owner                                      |
| Load into or reset the shared database             | Any member who can see the project; previous data is saved first |
| Any of the above inside a session                  | The agent, as the session's owner                                |

There is no resource approval step. File edits are ordinary worktree changes. Deleting a table
removes a definition, never a running resource or data. The operator has no default read access to
organization content. The resource's compute and storage belong to the project's Sealant scope; no
harness or person's inference login runs in a resource.

### Services and previews

A session's `[service.db]` remains its own Service; `depends = ["db"]` names that recipe.
`depends = ["@db"]` names the resource selected for the worktree, whether project or worktree level.
The explicit table mapping with `shared` or its synonym `resource` remains an opt-in env mapping. It
does not choose a level.

A dependency never does a resource's first start. A preview wake only restarts a resource that
stopped for idleness. A person or agent's stop holds until an explicit Start; the status says who
stopped it. A preview stop never stops a resource. Recipe env references, described above, let the
app use a conventional name without Mend supplying one by default.

### What stays out of scope

Per-process leases and generation fences, per-person Postgres logins, secret rotation, scheduled or
off-machine backups, snapshots and point-in-time recovery, test and shadow databases,
resource-to-resource reach, narrowing `mend_default`, Compose containers in the workspace's Docker
sidecar reaching a resource, resource env in Remote-SSH logins and purging archived volumes remain
later work. Worktree containers for images other than Postgres are part of this design, not later.

## Context

Yiannis asked for long-running resources between worktrees repeatedly in September and October 2026.
On October 29 he clarified: "this is not just about DBs. It's about making a network or something
that runs any resource in either project and worktree level." He approved the October 31 stories and
decided the replacement definition, start, visibility and env rules on November 1.

One workspace executor holds a worktree's processes. Sessions in that worktree share its files. A
session can still run its own infrastructure as a Service or use external infrastructure. A resource
is optional. Resources run through the public Sealant SDK, never Sealant internals or a Mend relay.
[ADR 0017](0017-live-preview.md) covers previews and [SESSION-SERVICES.md](../SESSION-SERVICES.md)
covers Services; this ADR defines the resource behavior those documents refer to.

## Decisions

These rows retain the original decision identifiers. Their outcomes include the October 31 and
November 1 amendments and supersede the earlier recommendations.

| #   | Decision                    | Current outcome                                                                                                                                                                             |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Choice and default          | Start asks project or worktree. Project visibility defaults on for new worktrees, with a project setting and per-worktree switches. Postgres defaults shared.                               |
| S2  | First own Postgres database | On explicit worktree start, copy shared when it has data, empty otherwise. No first copy at session launch.                                                                                 |
| S3  | Switching                   | Select the other level and keep both sides. Restart Services and tell the agent which env variables changed and how to get current values. Existing processes keep old env.                 |
| S4  | Cleanup                     | Dump an own database before dropping it. Archive instance volumes on worktree or project removal; project archives are listed for organization owners.                                      |
| S5  | Status                      | One observed status line on every client and in the workspace note.                                                                                                                         |
| S6  | Runtime                     | Sealant instances on Docker. Other runtimes refuse by name.                                                                                                                                 |
| S7  | Ownership and cost          | A project-scoped Sealant principal owns compute and storage.                                                                                                                                |
| S8  | Definitions and recipes     | Only the worktree's `.mend/mend.toml`, with root fallback. Add writes the file. Start reads it. No settings import or approval. `depends` names `@name`; recipe env may reference `MEND_*`. |
| S9  | Preview approval on switch  | A level switch asks no preview approval. Resource level stays outside the preview digest.                                                                                                   |
| S10 | Worktree Redis              | Its own container, available in this design. The definition may also run at project level.                                                                                                  |
| S11 | Idle                        | Stop after 30 minutes without use, keep data and restart on need only after an idle stop. An explicit stop holds.                                                                           |
| S12 | Permissions                 | The permissions table above. Agents can perform every act their person can. No approval.                                                                                                    |
| S13 | Backups                     | Save previous database data before replacement; no scheduled, snapshot or off-machine backup in this design.                                                                                |
| S14 | Scope of delivery           | Postgres, Redis and any image at both levels, with explicit starts.                                                                                                                         |
| S15 | Test and shadow databases   | Later. No tracking or per-worktree creator grants in this design.                                                                                                                           |
| G1  | Who declares any image      | Any member who can see the project can add a definition. No manager approval.                                                                                                               |
| G2  | Which images                | Any image, pinned by digest at start, subject to platform refusals and operator registry policy.                                                                                            |
| G3  | Limits                      | Platform limits and project budgets apply. A budget refuses new work and never stops running work.                                                                                          |
| G4  | Worktree start approval     | None. A person or agent explicitly starts it.                                                                                                                                               |
| G5  | Workspace reach             | Workspaces do not reach each other on resource reach networks. Narrowing `mend_default` remains later.                                                                                      |
| G6  | Worktree resource reach     | Only that worktree reaches its own resource.                                                                                                                                                |
| G7  | Non-Postgres worktree data  | Its own container and volumes. No snapshot copy from the project container is promised.                                                                                                     |
| G8  | Generic backups             | Retained volumes, no scheduled snapshots.                                                                                                                                                   |
| G9  | Product words and env       | Resource, project resource, worktree resource, `@name`, project network, `mend resource`, `MEND_<NAME>_*`. No conventional resource env.                                                    |
| G10 | Addressing                  | Resolve by name on the project network and supply namespaced env. After a switch new processes get current values; old processes keep old env.                                              |
| G11 | Visibility                  | Project resources visible by default; project setting controls new worktrees; each worktree can turn each one off. A same-name worktree resource wins locally.                              |
| G12 | Levels                      | Every definition can run at both project and worktree levels at once. There is no session level.                                                                                            |

## Decided edge cases

- **The web's Add asks for a worktree.** It lists the project's worktrees, the person's most recent
  first, and writes the table into that worktree's `.mend/mend.toml`. A project with no worktree
  shows the table to copy instead of writing anywhere. Add never writes a settings definition and
  never commits to a branch.
- **A worktree start on a differing Postgres definition uses the running server.** The worktree's
  own database is made on the project's server as it runs, and the start says so:
  `@db · own database on the project server (postgres:16) · this worktree's file asks postgres:17`.
  Running the new definition means restarting the project server, which is a separate, explicit
  start at project level. In a terminal it names the worktrees that use the server before it asks;
  the agent passes `--project --restart`. Mend never starts a second Postgres server for a worktree
  to avoid the difference.
- **A Service whose `${MEND_*}` reference has no value does not start.** The Service start fails
  with the resource to start:
  `web needs MEND_DB_URL · @db is not running for this worktree · mend resource start db --project or --worktree`.
  Mend never starts the resource for it, never leaves the variable empty, and never substitutes a
  conventional name.

## Platform boundary and delivery

The October 31 runtime, reach networks, retained volumes, exec, loading and archive mechanisms
remain the foundation. Mend uses only `@sealant/sdk`; any missing capability is recorded in
[PLATFORM-FEEDBACK.md](../../PLATFORM-FEEDBACK.md), never implemented by reaching into Sealant.
Resource ports remain on the project network, never host-published or relayed through Mend. A
browser or desktop database client reaching a resource directly needs later platform work.

Implementation of this amendment must cover file lookup and writes, explicit starts and idle-only
wake, both levels for every definition, visibility defaults, definition-difference reporting,
namespaced env and recipe references, workspace-note instructions and switch messages. A feature PR
needs an independent check on the box under AGENTS.md. This documentation PR changes no code and
needs no box check.

## Consequences

- The file can travel with a branch without changing running infrastructure. A Start is the point at
  which someone chooses the level and the definition to run.
- A worktree can use project resources immediately after someone starts them, or choose its own.
  Shared Postgres is the default, so the workspace note tells agents to start their own before
  changing the schema.
- Resource env is an offer. Apps that expect `DATABASE_URL` or another conventional name opt in.
- A switch does not rewrite any running process's env, including the agent's shell. The agent
  receives a message with the changed names and instructions to print current values or restart.
- Shared data can be changed or dropped by any worktree that uses it. Data writes happen outside the
  worktree and do not appear in Review. Retained volumes and saved dumps are not a promise of
  recovery from every application write or machine failure.
- Stops keep data. Archives and dumps keep using disk; no timer deletes them in this design.
