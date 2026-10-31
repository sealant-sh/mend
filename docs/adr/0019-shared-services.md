# Resources: long-running services for a project or a worktree, on a project network

Status: accepted 2026-10-31, as [amended that day](#amendment-of-2026-10-31). Where the amendment
and a later section disagree, the amendment holds; each section it replaces says so in its first
line. Proposed 2026-10-29. Proposes **resources**. A resource is a long-running service that Mend
runs beside a project's sessions: an image, a command, ports, env and volumes. Each resource runs at
**project** level, as one instance every worktree can use, or at **worktree** level, as one instance
per worktree. The project's workspaces and its resources share a private **project network**, so a
session reaches a resource by name and Mend never carries its bytes. Postgres, Redis and MySQL are
presets on top of that model. A preset adds what only a database can do, such as a database per
worktree on one project server.

Yiannis decided the data model on 2026-10-29 ("Should allow both with excellent ux"), accepted the
recommendations of decisions S1 to S15 the same day, and set the scope: "this is not just about DBs.
It's about making a network or something that runs any resource in either project and worktree
level." The decisions G1 to G12 that the general model raised were settled on 2026-10-30, each as
recommended, within that framing. The product words (resource, `mend resource`, `MEND_RESOURCE_*`)
are decision G9's. Every other mechanism is a proposal. Read against Mend `5d8b1ed32e` and Sealant
Core `97076a88`. Amends [ADR 0017](0017-live-preview.md) (how a preview's `depends` names a
resource).

**What this ADR does not claim.** A resource is a development resource, not production
infrastructure. Its status says what was observed
(`@db · running · answered SELECT 1 · observed 3 s ago`), never that the data is safe. Nothing here
runs until Sealant has what [Platform feedback](#platform-feedback) asks for.

## Amendment of 2026-10-31

Yiannis approved nine user stories on 2026-10-31 and asked for all of them. They keep the product
this ADR describes and drop most of the machinery it proposed for it. This section is the design
that ships. Read against Mend `1c8583cd1e` and Sealant Core `15b15a3e80`.

### The stories

1. **Add one.** A member adds Postgres, Redis or any image to a project, from the web Resources
   page, `mend resource add`, or `[resource.*]` in `mend.toml`, and it runs. There is no approval
   step. The platform still refuses privileged mode, added capabilities, host network or mounts, the
   Docker socket and devices.
2. **The database is already there.** Every process in a worktree gets `MEND_RESOURCE_<NAME>_HOST`,
   `_PORT` and `_URL`, plus `DATABASE_URL` and the `PG*` names for one Postgres and `REDIS_URL` for
   one Redis, unless the project already sets them. The resource answers by name (`db:5432`).
   Workspaces never reach each other on the network that carries it.
3. **Shared, own or off, per worktree.** Postgres defaults to `own`: the worktree's own database on
   the project's Postgres server, copied from shared when shared has data and empty otherwise. Redis
   and other images default to `shared`. The composer shows the choice on one line with **change**.
   A switch keeps both sides and restarts the worktree's Services.
4. **One per branch.** A worktree resource, such as Mailpit, runs one instance per worktree. It
   starts on first use and stops after 30 minutes idle. Neither worktree reaches the other's.
5. **Data survives.** Stopping every session keeps every row. An idle stop keeps the data. Removing
   a worktree dumps its own database before dropping it. Deleting a project keeps its resources'
   volumes and lists them for the organization's owners.
6. **Previews.** A Service with `depends = ["@db"]` gets the env, and the preview's wake starts the
   resource.
7. **One status line everywhere**, such as `@db · running · own database · observed 3 s ago`, on the
   web app, the CLI, the phone, VS Code, Slack and the agent's workspace note, from the one
   `resourceStatusLine`. It is a line in views that exist, not a new screen.
8. **The agent can do everything its person can**: add, start, stop, switch, reset and load, through
   `mend resource` inside the session.
9. **Load data from another database**, Postgres only. The CLI loads a plain or custom-format dump
   file, or a URL it dumps with `pg_dump` on the person's machine and streams up. The web Resources
   page takes an uploaded dump, or a URL Mend's server can reach, which Mend pulls. The agent does
   either from its session. The person picks the target, shared or this worktree's own database. A
   load never loses data: when the target has data, Mend saves a dump of it first and says so
   (`@db · loaded 120 MB from staging · previous data saved as a dump 14:02`). It shows size and
   progress. A URL's password is never logged, recorded or shown back.

### What it replaces

| Section of this ADR                          | Now                                                                                                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Approving a definition; decisions G1, G4, S8 | No approval. Adding is running.                                                                                   |
| The project network                          | One reach network per workspace executor, below. The product still says "the project network".                    |
| Presets: grants, `pg_hba`, test databases    | One login per server, no password, and no test or shadow databases.                                               |
| Env: credentials and rotation                | No credentials to carry, so none to rotate.                                                                       |
| Lifecycle: leases and generation fences      | Idle is derived from which live workspace reaches an instance. A person's stop holds until a person starts it.    |
| Durability: snapshots, backups, recovery     | Dumps before every destructive step, kept beside the data. No schedule, no snapshot, no point-in-time recovery.   |
| Who may do what                              | Any member adds, starts, stops and loads. The agent acts as its session's owner. A table below.                   |
| `own` for images that are not a database     | Later. `own` is a Postgres database. Other images offer `shared` and `off`, and MySQL does too until it gets own. |
| Delivery                                     | The list at the end of this section.                                                                              |

### Sealant runs the instances

Core gains a resource instance under a project's resource domain (Core #420). It is a container from
an image pinned by digest, with named volumes, a CPU and memory limit, and no harness, worktree or
TTL. The SDK grows three members on `sealant.scopes.actAs(scopeId)`:

```ts
scope.instances.up(key, spec, { cause: "use" | "person" }); // create or update by key, start, wait for ready
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
  project instance joins every linked executor's network. A worktree instance joins only the
  networks of executors linked with its worktree key. Two workspaces never share one of these
  networks, so they cannot reach each other on them, and a worktree's instance is unreachable from
  another worktree. Reach is derived from two facts Core stores (an instance's alias and worktree
  key, a workspace's link), and every launch, executor end and 30-second tick converges Docker to
  it. An executor replacement gets a new network. Core allocates each network's subnet from its own
  pool, so the Docker daemon's default pools do not run out.
- **Egress.** Each instance also joins an egress network of its own, so it can reach what Mend's
  server can (a staging database for a pull) and no other instance. The cloud-metadata route is
  refused in it on every start.
- **Idle.** An instance that no live executor reaches for 30 minutes stops, and keeps its volumes.
  `up` with cause `use` (a launch, a preview's wake) never starts an instance a person stopped.
  Cause `person` (a person's Start) does, and clears the hold.
- **Exec** runs a command in a running instance with stdin streamed in and stdout and stderr
  returned as capped tails. Nothing of its argv or stdin is logged or recorded. Mend uses it to
  create, copy, dump and restore databases, so those bytes stay inside the instance.
- **Archive** stops an instance, removes its container and keeps its volumes. A scope's archive does
  it for every instance and unlinks every workspace.
- **Docker only.** Another runtime refuses by name
  (`@db · resources run on Docker; this Sealant runs kubernetes`).

### Mend owns what people chose

- **Definitions.** Adding pins the image to its digest and writes the definition. Nothing waits for
  a manager. A project resource starts at once. A worktree resource starts in the current worktree,
  when the add came from one, and in any other worktree on first use. A `[resource.*]` table in a
  worktree's `mend.toml` adds a name the project lacks when a session in that worktree launches. It
  never replaces a definition the project has, and the line then says
  `mend.toml differs · project settings kept`, so a merge never changes what runs.
- **One server, many databases.** A project Postgres is one instance, `db` on every reach network.
  `shared` is its database `app`. `own` is a database on the same server whose name derives from the
  worktree id (`own_<12 hex of sha256>`), so a switch to `own` always lands on the worktree's own
  data, and a switch never moves a host name. A selection stores only the mode. A worktree's first
  `own` copies `app` inside the instance (`pg_dump | pg_restore`) when `app` has tables, and starts
  empty otherwise.
- **No credentials.** Postgres runs with `POSTGRES_HOST_AUTH_METHOD=trust` and Redis without a
  password. The reach network is the access boundary. A password in every process's plain env inside
  that boundary would protect nothing more, and would need a secret channel that Sealant's
  `sessions.open` does not have yet. The only secret on any resource path is a load URL's password.
- **Env per process.** Before each process opens (the agent, a resume, a shell, a Service, a setup
  command, the dependency install), `Resources.prepare` links the workspace, starts what the
  worktree uses, makes its own database, and answers the env. The env is built from Mend's rows
  alone, so a slow or failed start still gives the right names, and the line says the session
  started without it. A name the project's env or secrets set is left alone
  (`DATABASE_URL left as the project sets it`). A process started before a switch keeps its env
  until it restarts. `mend resource env` prints the current exports for it.
- **Switching** writes the mode and restarts the worktree's Services. Both databases stay.
- **Reset** saves the target's data as a dump, then empties it (an own database is copied from
  shared again when shared has tables).

### Loading

A load has one row, at most one live per target, and these steps, each of which a restart of Mend
resumes from what exists:

1. **Stage.** An upload (the CLI's file or local `pg_dump`, the web page's file, the agent's helper)
   streams through Mend into the instance's dumps volume. A pull runs `pg_dump` inside the instance
   against the URL, with the password on its stdin.
2. **Restore** the staged dump into a new database beside the target. A custom-format dump goes
   through `pg_restore --no-owner --no-acl`, a plain one through `psql`. A failure drops the new
   database and leaves the target as it was.
3. **Install.** Refuse new connections to the target, end the open ones, rename the target aside and
   rename the new database into its name. Writes acknowledged before this step are in the old
   database, which still exists.
4. **Save.** Dump the old database into the dumps volume, check the dump reads back
   (`pg_restore --list`), then drop the old database. The line names the dump's time.

Progress counts bytes received and the phase. A source of unknown size shows bytes so far, not a
percentage. A URL's password is parsed into a redacted value at the API boundary, goes only to the
pull's stdin, and is stripped from every message, row and line. The line names the source by host
and database.

### Removal

- **A worktree.** Before its store goes, each own database it has is dumped into the dumps volume,
  checked and dropped. A server that is stopped is started for it. Its worktree instances are
  archived.
- **A project.** Mend archives the project's scope and keeps a row naming the organization, the
  project, its creator and the kept volumes with their sizes. Organization owners see the list in
  organization settings. Nothing deletes them.

### Who may do what

| Act                                       | Who                                                                  |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Read status, add, start, stop, load       | any member who can see the project                                   |
| Remove or replace a definition            | the person who added it, or a manager (`canManageProject`)           |
| Switch a worktree's choice, reset its own | the worktree's change owner                                          |
| Load into or reset the shared database    | any member who can see the project; the previous data is saved first |
| Any of the above from inside a session    | the agent, as the session's owner                                    |

### Later

Recorded, not built: per-process leases and generation fences; per-person Postgres logins; secret
rotation; `own` for images that are not a database (and for MySQL); nightly or off-machine backups;
test and shadow databases; resource-to-resource reach; refusing connections that an instance opens
to a workspace; narrowing `mend_default`; Compose apps in a workspace's Docker sidecar reaching a
resource; the resource env in Remote-SSH logins; purging archived volumes.

### Delivery

One ready PR per step, each with the check that proves it. Sealant Core steps ship first; each push
to Core main publishes an `@sealant/sdk-next` that Mend then pins.

1. This amendment.
2. Mend: no approval. A member's add pins the image and is the definition (migration 0173).
3. Core: instance, link and network tables.
4. Core: the Docker lowering (names, flags, refusals, volume cover), as pure code with golden tests.
5. Core: the Docker runtime (up, stop, archive, exec, reach), with a real-daemon test that two
   linked workspaces reach `db` and not each other, and a worktree instance only from its worktree.
6. Core: routes and the SDK.
7. Core: executor hooks, crash restart and the idle stop.
8. Mend: pin the SDK, run resources, and give every process its env. Selections, own databases,
   switch and reset. The agent acts as its owner.
9. Mend: worktree removal dumps, project archive and the owners' list.
10. Mend: load from a file, a local URL, an upload and a server-side URL.
11. Mend: `@db` in a preview's `depends`, and the wake.
12. Mend: the status line on the phone, VS Code, Slack and the workspace note.

## Context

### What was asked

Yiannis asked for this six times, in his own words:

> also enable long running services that are used between worktrees. Think like a db running or
> something like that but i'm open to ideas/feedback.

(2026-09-26, in the message that asked for live previews.)

> Shared long running resources across multiple worktrees in one project (like shared dbs, redis
> etc)

(2026-10-11. In the same message he added "https://tilt.dev/ integration with them would be huge",
which the roadmap holds for 0.38.)

> Long running services across multiple worktrees/sessions (dbs/redis/message brokers etc)

(2026-10-17.) On 2026-10-24, asked whether a preview should get a separate database per worktree or
one shared one, he answered:

> Don't we have the whole shared resources thing? I was thinking it should be about this. It should
> be part of the shared resources thing. Ofc a session can spin up any infra, but in general if the
> user wants they should be able to to get the shared ones instead

On 2026-10-25: "I think shared long running shit should start now. I feel like that and live
previews might need each other". On 2026-10-29, on the data model: "Should allow both with excellent
ux". The same day, after the first draft of this ADR covered databases only:

> this is not just about DBs. It's about making a network or something that runs any resource in
> either project and worktree level. Besides that recs is fine

His words set the forces. A resource is any long-running service, not only a database. It runs at
project level or at worktree level. The project's sessions reach it over a network of the project's
own. A session can still run its own infra, and using a resource is the person's choice. For
databases, both one shared database and a database per worktree are required, easy to pick, safe to
switch and visible on every client. The Linear done-when for P-SLNT-46 ("Two sessions in different
worktrees use the same project Postgres and Redis, and the data survives both sessions stopping")
does not appear in any of his messages, and reads as agent wording.

### What exists

Everything that runs code in Mend runs in a Sealant workspace. In the default capture store there is
one workspace per worktree, and every session in the worktree is a process in it (ADR 0002). A
**Service** is a declared port with an optional command (`[service.<name>]` in `mend.toml`). It
belongs to one session: `services.sessionId` is not null and cascades
(`packages/db/src/schema/workbench.ts:1608-1616`). The sessions of one worktree reach each other's
Services on `localhost`.

- **Nothing runs at project scope.** Project env, secrets and image settings are copied into each
  workspace once, when it is created (`packages/sessions/src/engine.ts`, `createWorkspace`). A
  workspace's env is fixed after that. A process's env is not.
- **Every workspace is one person's.** Mend's own principal type, `SealantPrincipalValue`, is `user`
  or `none` (`packages/sealant/src/principal.ts:22-24`), because the SDK attributes every call to a
  Sealant user. The SDK requires a harness to create a workspace.
- **Nothing lasts through an executor replacement except the capture.** Mend replaces an executor at
  the platform's deadline, or after 7 h 30 when there is none (`FALLBACK_REPLACEMENT_AGE_SECONDS`,
  `packages/domain/src/workbench/capture-drain.ts:27`). That includes Docker. Only `/workspace/repo`
  and the harness homes survive. A database in the workspace's Docker sidecar loses its data then.
- **The SDK has no supported route out of a workspace.** A forward's host is the closed set
  `127.0.0.1`, `localhost` or `docker`, and forwards only go into a workspace. Core keeps the set
  closed on purpose, so that no caller can make a workspace dial an arbitrary host (Core #151,
  #153). The SDK has no named or durable volume either.
- **On the Docker bundle, every workspace already joins `mend_default`**
  (`SEALANT_DOCKER_WORKSPACE_NETWORK`, `deploy/docker/compose.v2.yaml:48`, attached by Core's
  `docker-runtime-adapter.ts:2468-2477`). Workspaces use it to reach Mend's session channel and the
  object store. It is not a contract. Every workspace on it, of every project, can reach every
  other, and Mend's own Postgres is on it too. On Kubernetes, reach is the instance-wide
  `networkPolicies.workspaceEgressAllow` (`docs/KUBERNETES.md:336`).
- **Compose apps run in the workspace's Docker sidecar.** Core's Docker adapter runs nested
  containers in the sidecar's own network namespace, on the sidecar's own network, and the sidecar's
  daemon listens there on 2375 with no authentication. Nested containers do not use the workspace's
  resolver.
- **Removal deletes the store before the row.** `apps/api/src/routes/workbench.ts:770-771` removes
  the project's store, then `projects.remove` hard-deletes the row. Worktree removal checks
  sessions, processes, forwards and capture holders (`apps/api/src/routes/worktrees.ts:666-703`).
- **ADR 0017 step 9a is merged** (mend#1169). It parses `depends`, and refuses `"@db"` and
  `{ shared = "db" }` with `@db · shared services are not available yet`
  (`packages/sessions/src/recipes.ts:85-86`, `:225-230`). It gives a session dependency no env.

### What stands

- **No relay.** Mend never carries a service's bytes over the session channel or any relay of its
  own (ADR 0017, "Services shared between worktrees", decision log 7). A missing SDK feature is a
  `PLATFORM-FEEDBACK.md` entry, not a workaround (AGENTS.md).
- **Commands are the owner's.** Only a session's owner runs a command or a recipe. A steerer may
  restart or stop (ADR 0013). A preview's start after a turn runs the recipe as the turn's sender,
  whoever changed it (ADR 0017, decision log 4, reversed 2026-10-31).
- **Losing a person's data is a blocker.** For a resource, that includes everything on its volumes.
- **A preview's `depends` names a Service of its own session or a shared service of the project**,
  and either resolves to an address and credentials in the preview Service's env (ADR 0017, decision
  3). A preview stop never ends a stateful dependency (ADR 0017, decision log 5).
- **One executor per worktree** (ADR 0002). Nothing may need a second executor on a worktree.

## Decision

### A resource is a Sealant service, not a session's Service

A **resource** is a long-running service a project declares once. Sealant runs each instance as a
service of its own, with no harness, no worktree and no TTL (decision S6). Its volumes are retained,
and no executor replacement touches them, because the instance never runs in an executor. The
project-scoped principal owns it (decision S7). Mend is never in the path of its bytes.

```ts
// packages/domain/src/workbench/resource.ts
export interface ResourceDefinition {
  readonly id: ResourceId;
  readonly projectId: ProjectId;
  readonly name: ResourceName; // one DNS label, see "Names"
  readonly scope: "project" | "worktree";
  readonly preset: "postgres" | "redis" | "mysql" | null; // null for any other image
  readonly image: ImageRef; // resolved to a digest when approved
  readonly command: readonly string[] | null; // replaces the image's CMD; its entrypoint always runs
  readonly ports: readonly ResourcePort[]; // { name, port, protocol: "tcp" | "udp" }
  readonly env: readonly ResourceEnv[]; // literal values or project secret references
  readonly volumes: readonly ResourceVolume[]; // { name, mountPath }
  readonly limits: ResourceLimits; // cpu, memory, disk (decision G3)
  readonly ready: ReadyCheck; // a TCP accept, a probe command, or a preset's own check
  readonly exports: readonly ResourceExport[]; // env a consumer gets, see "Env"
  readonly approved: ApprovedRevision | null; // the digest of every field above, and who approved it
}

/** A project resource's choice for one worktree. A worktree resource has no choice. */
export type WorktreeSelection =
  | { readonly mode: "off"; readonly revision: Revision } // this worktree runs its own infra
  | { readonly mode: "shared"; readonly revision: Revision } // the project instance
  | {
      readonly mode: "own";
      readonly revision: Revision;
      readonly target: OwnTarget;
    };

/** What "own" means depends on the definition. */
export type OwnTarget =
  | { readonly kind: "database"; readonly database: DatabaseId } // a preset, on the project instance
  | { readonly kind: "instance"; readonly instance: InstanceId }; // its own instance of the definition

/** An instance's compute can be absent. Its volumes are never absent until a person purges them. */
export type InstanceState =
  | { readonly kind: "declared" }
  | {
      readonly kind: "starting";
      readonly volumes: RetainedVolumes;
      readonly generation: number;
    }
  | {
      readonly kind: "running";
      readonly volumes: RetainedVolumes;
      readonly generation: number;
    }
  | {
      readonly kind: "stopping";
      readonly volumes: RetainedVolumes;
      readonly generation: number;
    }
  | {
      readonly kind: "stopped";
      readonly volumes: RetainedVolumes;
      readonly reason: StopReason;
    }
  | {
      readonly kind: "blocked";
      readonly volumes: VolumeEvidence;
      readonly reason: Refusal;
    }
  | { readonly kind: "archived"; readonly volumes: VolumeEvidence }
  | { readonly kind: "purged"; readonly confirmedBy: AccountId };
```

- **A Service stays what it is.** A session's own `[service.db]` keeps running in its workspace, and
  `depends = ["db"]` keeps naming it. A resource is a separate thing with separate tables. Nothing
  redirects a recipe name to it, so "a session can spin up any infra" stays true.
- **The platform owns each instance's life.** Sealant creates, starts, stops and attaches it to the
  project network, and fences each volume to one writer. Mend owns the definitions, each worktree's
  selection, the databases inside a preset's instance, the grants, the leases and the status line.
- **One module owns it in Mend.** `Resources` (`packages/sessions/src/resources/`) hides approval,
  instances, selections, grants, leases and crash recovery behind one launch operation. The engine
  calls it when it starts a process in a worktree that uses a resource, and gets back the env for
  that process.
- **Names.** A resource name is one DNS label, `^[a-z][a-z0-9-]{0,30}$`. Names a workspace already
  resolves are reserved: `docker`, `localhost`, `host`, `mend`, `garage`, `postgres` and anything
  ending in `.internal`.

### Two scopes, and what each worktree gets

Every resource declares its scope. This table is the one policy. Every example below follows it.

| Definition                        | Scope    | Choices for a worktree | Default (decision S1)                                           |
| --------------------------------- | -------- | ---------------------- | --------------------------------------------------------------- |
| Postgres or MySQL preset          | project  | `shared`, `own`, `off` | `own`: a database of the worktree's own on the project instance |
| Redis preset                      | project  | `shared`, `off`        | `shared`. `own` comes in a later step (decision S10)            |
| Any other image                   | project  | `shared`, `own`, `off` | `shared` (decision G11)                                         |
| Any image except the Redis preset | worktree | none                   | its own instance, started on first use                          |

- **Project.** One instance for the project, started on first need. Each worktree has a selection,
  set from the default at its first launch. `own` is a database of the worktree's own for a database
  preset, and an instance of the same definition that belongs to the worktree for any other image.
  `off` means the worktree runs its own infra, and its processes get nothing from the resource.
- **Worktree.** One instance per worktree, of the same definition. It starts when something in the
  worktree first uses it (a `depends`, a person's **Start**), not on every launch, and stops when
  the worktree has no live workspace and the idle time has passed (decision S11). It suits a mail
  catcher, an object store or a queue that each branch should have to itself.
- **Starting an own instance.** It starts empty, or, for a non-preset definition, from a snapshot of
  the project instance's volumes (decision G7). A database preset copies consistently (below).
- **Switching keeps every byte.** A switch points the selection at the other target. The other
  target, with its volumes and databases, stays as it is, and nothing merges one into the other
  (decision S3).
- **A launch without the composer** (from Slack, `mend claude`, VS Code or the phone) applies the
  default without copying anything. A database preset's `own` starts empty. Mend posts the choice
  line with **change** to the surface that launched it. A copy runs only on a person's choice.

### The project network

Its reach rules stand. Its Docker mechanism is replaced by the amendment's reach networks, and the
rows for an instance opening connections, instance-to-instance reach, the sidecar and `mend_default`
are later.

Each project has one private network. Its members are the project's workspaces and the instances of
its resources (decision S6). The reach rules are default-deny. Only the rows marked allowed pass, in
either direction of a new connection.

| From                    | To                                                                  | Rule                                                                  |
| ----------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| a workspace             | the project's instances, and its own worktree's instances           | allowed                                                               |
| a workspace             | another worktree's own or worktree instances                        | refused (decision G6)                                                 |
| a workspace             | another workspace                                                   | refused on the project network (decision G5)                          |
| an instance             | a workspace                                                         | refused. Replies to a workspace's own connection pass.                |
| an instance             | another instance of the project                                     | allowed when its definition lists the other resource in `depends`     |
| an instance             | the internet                                                        | the platform's workspace egress policy, cloud metadata always refused |
| anything on the network | Mend, another project, a host interface, the sidecar daemon on 2375 | refused                                                               |

- **The existing `mend_default` route stays until Sealant narrows it.** Workspaces need it for the
  session channel and the object store, and today it lets every workspace reach every other, across
  projects. The project network adds no reach to that, and G5's rule cannot hold on Docker until
  Sealant restricts a workspace's `mend_default` interface to Mend's own endpoints. That is part of
  the network ask, and a delivery check.
- **Compose apps reach it through the sidecar.** Nested containers live in the sidecar's network
  namespace, so the platform attaches the sidecar to the project network as the workspace's second
  member, drops 2375 from that attachment, and gives nested containers a resolver for the project's
  names. A Compose-run WordPress then reaches `@db`.
- **Names on the network.** Each instance has a stable name: `db.project.mend.internal` for the
  project instance, `db.<worktree8>.mend.internal` for a worktree's own. The short name `db`
  resolves, for a workspace, to the instance its selection named when the workspace's processes last
  started (decision G10). A switch moves the short name only when every process using the old target
  has restarted (see Lifecycle).
- **Nothing is published.** A resource's ports exist on the project network only, never on a host
  interface, and `mend service connect` does not reach them. A person cannot open a resource's own
  web UI (RabbitMQ's, Mailpit's) from their browser until a later platform ask (Consequences).
- **Attachment follows the workspace.** A workspace joins the project network when it is bound to
  its worktree: at create, at claim for a standby, or, for a workspace already running, when the
  project's first resource is approved. An executor replacement attaches the new executor and
  detaches the old one.
- **Membership is revocable.** When a member leaves the organization, or a project becomes private
  and they are not its creator, their workspaces leave the project network and their open
  connections close.

| Runtime     | Instance                                                                      | Project network                                                                                             |
| ----------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Docker      | a container with named volumes that workspace cleanup never removes           | a network per project with the rules above enforced by the platform, the sidecar attached with 2375 dropped |
| Kubernetes  | a StatefulSet of one, retained PersistentVolumeClaims and a ClusterIP Service | NetworkPolicies per project, without growing `workspaceEgressAllow`                                         |
| Firecracker | an instance host outside the VM, on retained storage                          | a route per VM into the project's network, which the Firecracker runtime work defines                       |

A runtime without the contract refuses a resource by name, before any work starts:
`@db · resources need a newer Sealant on this runtime · this session can run its own [service.db]`.
There is no fallback to `mend_default`, to an operator endpoint or to a relay.

### Presets

Replaced in part by the amendment: one server per Postgres resource with `own` as a database on it,
no password, no grants, no `pg_hba` rules and no test or shadow databases.

A preset is a definition that Mend knows the inside of. It fixes the image family, the engine
settings, the ready check and the exports, and it adds what a generic image cannot have.

- **Postgres.** `own` on the project instance is a database on that instance, not a second server.
  It starts empty, as a copy of the shared database, or from a seed snapshot (decision S2). A copy
  is a consistent dump, restored straight into the new generation's final database name, which no
  grant can reach until Mend moves the worktree's pointer to it. Nothing is renamed.
  `CREATE DATABASE … TEMPLATE` is not used, because it refuses while anyone is connected to the
  template. A copy or a reset makes a new generation and keeps the previous one.
- **One pointer to the shared data.** The shared database is one pointer on the definition. A reset
  or a restore of shared data creates a new database and moves the pointer, which makes a new
  selection revision for every worktree on shared. Mend rebinds them as it does on a switch.
- **Grants per person.** A grant is a database role for one person, one workspace incarnation and
  one selection revision. Each physical database has its own owner role, which only that database's
  current grants may use through `SET ROLE`. Mend writes a `pg_hba.conf` rule per grant and database
  through `exec` as the server's superuser, so a grant can log in only to the databases Mend listed
  for it, and no grant can change that by granting itself `CONNECT`. No grant is a superuser.
  Dropping a grant never orphans or drops data.
- **What a grant may reach.** The database its selection revision names. The worktree's own test and
  shadow databases (below). The `postgres` maintenance database, for connecting only, because Django
  and Rails connect there to create test databases.
- **Test and shadow databases** (decision S15). In `own` mode, the worktree has a creator role with
  `CREATEDB`, which its grants may use. A database it creates belongs to that role. Mend finds such
  databases by owner on each launch and every few minutes, revokes `CONNECT` from `PUBLIC` on each,
  adds their `pg_hba.conf` rules for the worktree's grants, and dumps and removes them with the
  worktree. Database names are server-wide, so a fixed name such as `myapp_test` collides between
  worktrees. The second worktree's tool fails with "already exists", and its status line names the
  collision. Mend gives `MEND_RESOURCE_DB_SUFFIX` (`_3f2a`) for a project to add to such names.
- **MySQL.** It has no database rename and no database owner, so a copy restores straight into the
  final name as Postgres does. Grants use per-database privileges. Test databases are tracked by a
  per-worktree name prefix. The details are step 11's design.
- **Redis** is shared only at first (decision S10). A grant is a Redis ACL user per person and
  workspace incarnation. The exports are `_URL` and `REDIS_URL`.
- **Engine settings are part of the preset.** Postgres runs with `fsync` and `synchronous_commit`
  on. MySQL runs with `innodb_flush_log_at_trx_commit=1`. Redis runs with `appendonly yes`,
  `appendfsync always` and `maxmemory-policy noeviction`. An acknowledged write survives a crash of
  the instance, and delivery tests an abrupt kill after acknowledged writes on each.
- **Versions.** A minor version change restarts the instance on its volumes. A major version change
  is an operation, never a restart: dump, a new instance on new volumes, restore, move the pointer,
  keep the old instance stopped until a person purges it. Before the dump, Mend fences the old
  instance against new consumers and ends the ones that remain, as worktree removal does, so no
  write lands after the dump. The old instance stays stopped until the new one has the restore.
- **A shared database can be damaged by any worktree on it.** A migration from any worktree can
  alter or drop a table another worktree created, through the shared database's owner role. The
  status line says so. Point-in-time recovery for Postgres ships with shared mode (Durability).

### What a person writes and sees

Any member who can see the project proposes a resource, in project settings or with
`mend resource add`, and a manager approves it (decision G1). The command is new, because
`mend service <word>` already runs any word that is not a verb as a recipe name
(`apps/cli/src/main.ts`, `serviceCommand`).

```sh
$ mend resource add db --preset postgres --version 17
@db · postgres 17 · project · proposed by Maria · waiting for approval
$ mend resource add mail --image axllent/mailpit:v1.21 --port smtp=1025 --port http=8025 --scope worktree
@mail · mailpit · worktree · proposed by Maria · waiting for approval
```

A project can also propose definitions in `mend.toml`, which review like code. A file's table is a
proposal until it is approved in project settings (decision S8):

```toml
[resource.queue]
image = "rabbitmq:4-management"
scope = "project"
ports = { amqp = 5672 }
volumes = { data = "/var/lib/rabbitmq" }
env = { RABBITMQ_DEFAULT_USER = "app", RABBITMQ_DEFAULT_PASS = { secret = "RABBITMQ_PASSWORD" } }
exports = { URL = "amqp://app:{env.RABBITMQ_DEFAULT_PASS}@{host}:{port.amqp}/" }

[service.web]
command = "pnpm dev --port 3000"
port = 3000
browserScheme = "http"
depends = ["@db", "@queue"]
```

The session composer shows each project resource's choice for the worktree on one line before the
first start, with **change** beside it (decision S1). The same status function builds the line for
the CLI, the web app, the phone, the VS Code extension, Slack and the agent's workspace note
(decision S5). Every line writes the resource with its `@`, so it never reads as a session's own
Service:

```text
$ mend resource list
settings
  @db · postgres 17 · project · its own database · copied from shared 14:02 · observed 3 s ago  postgres:17  rdef_4c1e
  @queue · rabbitmq 4 · project · shared · reached by 3 worktrees · observed 3 s ago  rabbitmq:4-management  rdef_9a07
  @mail · mailpit · worktree · running · observed 3 s ago  axllent/mailpit:v1.21  rdef_e2b3
proposals
  @cache · redis 8 · project · proposed by Tom · waiting for approval  redis:8  rprop_51d0
```

```sh
$ mend resource use queue own
@queue · its own instance, empty · waiting for this terminal to restart (mend claude, pid 4211)
$ mend resource use db shared
@db · shared database · restarted web · any worktree on shared can change or drop its tables
```

### Env

Replaced in part by the amendment: the names stand, and there are no credentials to carry or rotate.

Every process Mend starts in a worktree whose selection for a resource is `shared` or `own`, and
every process in a worktree that uses a worktree resource, gets its address as process env: the
agent, its shells and its Services. A process started before the worktree chose the resource gets it
through `mend resource exec -- <command>`. A worktree on `off` gets nothing.

- A resource name becomes an env name in upper case, with `-` written as `_`. Every resource gives
  `MEND_RESOURCE_<NAME>_HOST`, which is the instance's stable name, never the short name, and
  `MEND_RESOURCE_<NAME>_PORT` for its first port or `MEND_RESOURCE_<NAME>_PORT_<PORTNAME>` for each
  named port.
- A definition's `exports` add named values built from the address, its ports and its own env, such
  as `MEND_RESOURCE_QUEUE_URL`. An export built from a secret is itself a secret, with every rule
  below. A preset's exports are fixed: `_URL`, `_DATABASE`, `_USERNAME` and `_PASSWORD`, plus
  `DATABASE_URL` and the `PG*` names when exactly one Postgres is in use, and `REDIS_URL` likewise
  for Redis. A conventional name the project's own env already sets is not set, and the status line
  says `DATABASE_URL left as the project sets it`.
- A recipe that needs other names maps them in the table form, whose key is `shared` as step 9a
  reserved it (decision G9):

  ```toml
  depends = [
  	{ shared = "db", env = { TEST_DATABASE_URL = "url" } },
  	{ shared = "queue", env = { AMQP_URL = "url" } },
  ]
  ```

  A mapping names an export (`url`, `host`, `port`, `port.<name>` or a definition's own export). Two
  mappings that set the same name are refused, and so is a mapping that sets a name another binding
  provides.

- A recipe `env` that sets a name a resource binding provides is refused by name
  (`DATABASE_URL comes from @db`).
- Mend and Sealant never write credentials into `launch_env`, a capture, a status line or a log, and
  a restart computes them again. A process that receives them can still write them to a file, such
  as a `.env` in the worktree, and the agent can read them. ADR 0018 §7 states the same limit for
  keys.
- **Exports follow the instance's applied secrets.** Many images read a secret only when they first
  initialize their volume, as RabbitMQ does with `RABBITMQ_DEFAULT_PASS`. Mend records which secret
  revision each instance applied, and exports that one. Changing the secret does not change what
  consumers get. Rotating it needs the definition's `rotate` command, or a reset, and the status
  line says `@queue · secret changed · not applied · consumers keep the applied one`.
- A generic resource's credentials, if it has any, come from its own env and the project's secrets.
  Mend cannot make per-person grants inside an image it does not know, so for a generic resource the
  project network is the only access boundary. Presets add per-person grants.

### Approving a definition

Replaced by the amendment: there is no approval. The refused options stand, refused by Sealant.

A resource runs an image, so it is a command under ADR 0013, and it runs only after a person
approves it.

- **The approved revision** is a digest over every field of the definition, with the image resolved
  to its digest. An instance runs only an approved revision. A changed definition runs only after it
  is approved again. Until then, the running instance keeps the old revision.
- **Who approves** a project resource is a manager. Who may declare an image that is not a preset is
  decision G1. Who approves a worktree resource is decision G4. As built, a worktree's change owner
  approves a worktree resource for that worktree once a manager has approved the same definition for
  the project. The worktree's approval pins the image the project's approval pinned, and asks no
  registry again.
- **What no definition may ask for.** Privileged mode, added capabilities, host network, host
  mounts, the Docker socket or the sidecar's daemon, and devices. The platform refuses them, not
  only Mend. Which registries an image may come from is decision G2.
- **Limits.** Every instance has CPU, memory and disk limits (decision G3). The project's budget
  refuses a new instance and never stops a running one. An instance that hits its own memory or disk
  limit is killed or stops writing by the runtime, not by Mend. Mend reports
  `@db · stopped · memory limit reached` and warns at 80 % of the disk limit.

### Lifecycle

Replaced by the amendment: no leases and no generation fence. Idle is derived from reach, and a
person's stop holds against automatic starts.

An instance starts on first need: a launch in a worktree that uses it, a preview's wake, or a
person's **Start**. Concurrent starts from several worktrees coalesce on one operation key, so the
platform starts it once. A launch never starts an instance a person stopped. It gets
`@db · stopped by Maria · this session starts without it`.

- **Leases are per process, not counted.** Every live process that Mend gave a resource's address
  holds a lease on the instance its env named, until it exits. A person's keep-running hold and a
  running operation (a copy, a snapshot, a restore) hold one too. Each holder writes its own row.
  Mend never trusts an in-memory counter. When Mend cannot tell whether a holder is alive, the
  instance stays up.
- **Admission and stopping are fenced by one generation.** A new lease and a stop decision both
  update the instance row's `generation` in the same transaction that reads the leases. Before the
  consumer is admitted, Mend sends Sealant `setDesired(running)` with the new generation. A stop
  sends the generation it decided on, and Sealant refuses a stop for a generation older than the
  last one it was sent. A launch that took a lease after the idle check is never stopped from under
  it.
- **Idle stops compute only.** After 30 minutes with no lease (decision S11), Mend asks for a
  graceful stop. A person's **Stop** keeps the instance stopped against automatic starts, as it does
  for a preview (ADR 0017, decision log 6).
- **A switch waits for its consumers.** A switch makes a new selection revision. Mend restarts the
  Services that use the resource once each Service's owner has the right to restart it (ADR 0013). A
  Service it may not restart, and a process it cannot restart, such as a terminal agent or a shell,
  keeps the old target. The short name keeps resolving to the old target, and the status line names
  what it waits for. When the last process on the old revision has exited or restarted, the short
  name moves, and Mend drops the old revision's grants. So no process writes to two targets.
- **What may never happen to its volumes** on idle, a stop, an executor replacement, a Mend restart
  or a budget: deleting or reformatting a volume, dropping or resetting a database, Mend stopping
  the instance before its shutdown timeout, or stopping it while an operation runs. A missing volume
  makes the instance `blocked · data volume missing`. Mend never starts it on an empty one. This
  governs what Mend and Sealant do. It cannot stop a process on the network from writing to a
  resource it reaches, which is why Durability keeps snapshots and point-in-time recovery.
- **After a crash**, every transition and operation was recorded before the platform call, under a
  deterministic key. On start-up, Mend reads the platform's status first and finishes or rolls back
  each half-done step by its key. A half-made database or volume copy is unpublished, and recovery
  drops it.
- **Readiness.** A TCP accept on the first TCP port, a probe command the definition gives, or a
  preset's own check. A UDP-only resource with no probe command is reported `running · not probed`.

### Durability

Replaced by the amendment: dumps before every destructive step, no schedules, snapshots or
point-in-time recovery.

A resource's data lives in its volumes and nowhere else. It is never in a capture or in git.

- **Backups go to a backup volume** of each instance, separate from its data volumes and from the
  data disk limit. The first slice keeps it on the same machine, and the status says
  `last backup 03:00 · on this machine only`. Copies off the machine come in a later step (decision
  S13).
- **Generic volumes** get a snapshot nightly and before every reset, restore, purge or definition
  change that touches a volume. A definition with several volumes is snapshotted as one group, at
  one instant, or the instance is quiesced across the whole group. A snapshot of a running instance
  is crash-consistent, as if the power failed, and its status says so. A definition may add a
  `backup` command that the platform runs inside the instance first (decision G8). The last seven
  nightly snapshots are kept. Snapshots taken before an operation are kept until purged.
- **Presets** get a logical dump on the same schedule, with a checksum and a restore check. Postgres
  in shared mode also keeps a physical base backup and a WAL archive on the backup volume. Postgres
  recovers a whole server, never one database, so a point-in-time recovery runs in a separate
  recovery instance. Mend dumps the shared database from it at the chosen moment and restores it
  into a new database on the live instance, which the shared pointer then names. The worktrees' own
  databases are never rewound.
- **Removing a worktree** first fences each of its instances and databases against new consumers,
  ends the consumers that remain, and stops each worktree or own instance gracefully. A preset's own
  databases are then dumped to the project instance's backup volume, checked and dropped. A worktree
  or own instance is not deleted. Its volumes stay, stopped and `archived`, until a person purges
  them (decision S4). Until backups leave the machine, they are the only copy, so Mend never deletes
  them on its own.
- **Removing a project** with resources first archives them in the same way. Every instance is
  fenced, stopped, dumped or snapshotted, and checked. Their records move to an organization-owned
  archive that keeps the project's name, its creator and its visibility. Reading, restoring and
  purging an archive use the same rules as the project had (`canSeeProject`, `canRemoveProject`,
  evaluated on those kept fields). The project delete checks that every resource is archived before
  it removes the store, so it cannot remove the store and then fail on the row (decision S4).
- **Purge** is the only act that destroys data. It names each volume, database, snapshot and dump
  with its size, and needs a fresh confirmation. Purging live data also needs a verified copy first.
  Purging a kept copy needs only the confirmation.

### Who may do what

Replaced by the amendment's table.

| Act                                                                                | Who                                                                                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Declare, approve or change a project resource, start or stop its project instance  | a manager: the project's creator, or an organization owner who can see the project (`canManageProject`). Images beyond presets: G1. |
| Approve a worktree resource for one worktree                                       | decision G4                                                                                                                         |
| Start or stop a worktree's own or worktree instance                                | the worktree's change owner, or a manager                                                                                           |
| Reset or restore shared data or a project instance's volumes, purge                | an owner, or the creator of a private project (`canRemoveProject`, the rule for acts that destroy others' work)                     |
| Switch the worktree's selection, reset or restore its own database or instance     | the worktree's change owner (the owner of its first session, ADR 0007), with restart rights for each Service it restarts            |
| Use a resource, and start it by launching                                          | any member who can see the project                                                                                                  |
| Read status, copy shared data into a new generation of the worktree's own database | the agent. It cannot approve, start, stop, switch to shared, reset or purge.                                                        |

This is decision S12, restated for any resource. As in ADR 0017 decision log 6, only Mend's
person-facing surfaces (the web app, the phone, VS Code, the CLI on a person's machine) decide a
selection, a start, a stop or a reset. A `mend resource` call through the session's socket or
channel, whichever token carries it there, can only read status or make the agent's copy. The copy
keeps the previous generation, so it cannot lose data. A personal token copied into a workspace and
used on the account API counts as the person, as ADR 0017's build accepts: Mend's authentication
proves the account, not the device a call came from.

A resource spends nobody's login, because no harness runs in it, so ADRs 0013, 0016 and 0018 have
nothing to charge. Its compute and disk belong to the project-scoped principal (decision S7). The
operator gets no read access to any project's resource data through Mend.

### Naming it in a preview (amends ADR 0017)

ADR 0017 left four seams to this ADR.

1. **`depends` names a resource** as `"@db"`, or as the table `{ shared = "db", env = { … } }` that
   step 9a already reserves (decision S8). A recipe name matches `^[a-z0-9][a-z0-9._-]{0,63}$`, so
   neither form can clash with one, dots included. If decision G9 renames the table key to
   `resource`, the step that ships resources moves step 9a's reservation and
   `docs/SESSION-SERVICES.md` with it, and keeps `shared` as a synonym.
2. **The approval digest** gains, in plan order, the resource's stable id, its `@` name and its full
   env mapping, each env name with the export it takes. The definition's image, command, credentials
   and address stay out, so a rotation or a manager's approval of a new revision never unapproves a
   worktree's preview. The selection's mode stays out too (decision S9).
3. **Env** is merged in this order, a later layer winning: the workspace's env, the project's, the
   resource bindings', the recipe's, then Mend's own person and identity env. A recipe `env` that
   sets a name a binding provides is refused by name. For a session dependency (`depends = ["db"]`),
   this ADR proposes the same mapping form with `host` and `port`, and `MEND_SERVICE_<NAME>_HOST`
   and `_PORT` by default. Then one app variable binds to either kind. Whether step 9 adds it is the
   previews thread's call.
4. **Wake.** ADR 0017 step 12's wake calls `Resources` to make sure each instance in the preview's
   `depends` runs, inside the 3-minute hold ADR 0017 specifies, with one start per instance however
   many worktrees ask. A wake never creates or copies a database or a volume. An instance a person
   stopped is not started by a wake, and the viewer's page says who stopped it
   (`preview · web · @db stopped by Maria · your request was not delivered`). A preview stop never
   reaches a resource. Readiness is a probe from the preview's own workspace over the project
   network, never a Mend forward.

### What it does not do

- It never carries a resource's bytes through Mend, and never publishes a resource's port.
- It never lets one project reach another project's resources.
- It never merges one database or volume into another.
- It never deletes data on a timer, an idle stop, a replacement, a worktree removal or a budget.
- It never runs an image, a command or an option that a person did not approve.
- It never changes which instance a worktree uses because a file changed on a merge.

## Decisions

### Decided by Yiannis, 2026-10-29

He accepted every recommendation, and S10 with it. The outcome column restates each for the general
model. Where the restatement goes beyond what he accepted, it is marked as decision G11 or G12.

| #   | Decision                                      | Outcome                                                                                                                                                                    |
| --- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Where the choice is made, and the default     | A default per project resource, with a per-worktree switch in the composer. Database presets default to `own`. Other images default to `shared` (G11). `off` is new (G11). |
| S2  | How a worktree's own database starts          | Empty, a copy of shared, or a seed, chosen with the size shown. The default is a copy when shared has data, empty otherwise, and empty outside the composer.               |
| S3  | Switching                                     | A switch points the selection and keeps both sides. A managed "make this the shared data" comes later.                                                                     |
| S4  | Cleanup                                       | Never drop without a checked copy. Own databases are dumped and dropped. Instances' volumes are archived, never deleted, until purged.                                     |
| S5  | How clients show it                           | One status line from one function on every client.                                                                                                                         |
| S6  | Where it runs                                 | A Sealant service per instance, Docker first, other runtimes refused by name.                                                                                              |
| S7  | Who owns it and pays                          | A project-scoped infrastructure principal in Sealant.                                                                                                                      |
| S8  | Where it is declared, how a recipe names it   | Settings hold the approved definition. A `[resource.*]` table in `mend.toml` is a proposal. `depends` takes `"@name"` or the table form.                                   |
| S9  | Does a switch re-ask for a preview's approval | No. The mode stays out of the digest.                                                                                                                                      |
| S10 | A worktree's own Redis                        | Redis is shared only at first, then an own instance per worktree. Redis with worktree scope waits for the same step (G12).                                                 |
| S11 | Idle                                          | 30 minutes with no lease.                                                                                                                                                  |
| S12 | Who may do what                               | The table under "Who may do what".                                                                                                                                         |
| S13 | Backups                                       | On the machine first, off the machine before Mend calls the data durable.                                                                                                  |
| S14 | The first slice                               | Postgres with both modes and Redis shared, on Docker, as presets on a project network.                                                                                     |
| S15 | Test and shadow databases                     | In `own` mode, the worktree's creator role may create databases, and Mend tracks them.                                                                                     |

### Settled 2026-10-30, each as recommended

| #   | Decision                                             | Options                                                                                                                                  | Outcome and evidence                                                                                                                                                        |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Who may declare an image that is not a preset        | a manager (`canManageProject`); an owner (`canRemoveProject`); any member, approved by a manager                                         | Any member may propose it, in settings or `mend.toml`, and a manager approves it. An image is a command, and ADR 0013 makes commands an owner's to run.                     |
| G2  | Which images                                         | any image, pinned by digest; only registries the operator lists; presets only in 0.37                                                    | Any image by digest, with the refused options, and an operator setting that may narrow the registries. Presets only would break "any resource".                             |
| G3  | Resource limits                                      | operator defaults per instance, a manager may raise them up to an organization cap; fixed limits; no limits                              | The first. Proposed defaults: 1 CPU, 1 GiB of memory and 10 GiB of data disk per instance, backups not counted. A budget refuses new instances, never stops running ones.   |
| G4  | Who approves a worktree resource                     | a manager only; the worktree's change owner, for their worktree; the change owner, for images a manager already approved for the project | The third. It keeps "any image" a manager's call, and lets a person run an approved image for their own branch without waiting.                                             |
| G5  | Workspace to workspace on the project network        | refused; allowed between the project's workspaces                                                                                        | Refused. Two people's workspaces would otherwise reach each other's dev servers and debug ports. On Docker it holds only once Sealant narrows `mend_default`.               |
| G6  | Who reaches a worktree's own instance                | its own worktree only; every worktree of the project                                                                                     | Its own worktree only. That is what makes it the worktree's.                                                                                                                |
| G7  | How a non-preset own instance starts                 | empty; a crash-consistent snapshot of the project instance's volumes; both                                                               | Both, with the snapshot labelled crash-consistent. Mend cannot copy an unknown image's data consistently.                                                                   |
| G8  | Backups of a non-preset resource                     | nightly crash-consistent snapshots; snapshots plus an optional `backup` command; none                                                    | Snapshots plus the optional command. A snapshot is all Mend can promise for an image it does not know.                                                                      |
| G9  | The product words                                    | `resource`, `project resource`, `worktree resource`, `project network`, `mend resource`, `MEND_RESOURCE_<NAME>_*`; keep `shared service` | `resource`. A worktree resource is not shared, and "resource" is his word. The table key stays `shared` unless he wants `resource` too, which moves step 9a's reservation.  |
| G10 | How a session names a resource                       | a short name on the project network that resolves to the worktree's target, plus env; env only                                           | The name plus env. A Compose file can then say `db:5432` and work on shared and own alike. The short name moves only once old consumers have restarted.                     |
| G11 | Defaults beyond databases                            | other images default to `shared`; to `own`; and an `off` choice for every project resource                                               | `shared` for other images, and `off` everywhere. A cache or a queue is usually shared, and `off` keeps "a session can spin up any infra" true for a worktree that wants it. |
| G12 | Redis at worktree scope before its own-instance step | allowed from the first slice; waits with S10's step                                                                                      | It waits. S10 put per-worktree Redis in a later step, and a worktree-scope Redis is the same thing.                                                                         |

## Amendments

**ADR 0017**, "Recording how to run the project": `depends` also takes `"@<name>"` and
`{ shared = "<name>", env = { … } }`, which name a resource (ADR 0019).

**ADR 0017**, decision 3, "The binding": add "The address and credentials of a resource, and the
order in which env layers merge, are ADR 0019's."

**AGENTS.md**, when this ADR is accepted. The Product Language Contract gains `resource`,
`project resource`, `worktree resource`, `project network`, `the shared database` and
`its own database`, as decision G9 settled them. A `Service` keeps its meaning, a session's declared
port.

## Platform feedback

This PR adds four entries to `PLATFORM-FEEDBACK.md` and corrects one. They give the 2026-10-24
entries "Workspaces reaching a project's long-running service" and "Service storage that survives
executor replacement" a concrete surface. Those entries stay, marked as superseded. Where an ask
follows from one of the decisions, the entry names it.

1. **A service resource.** A harness-free workload from any image pinned by digest (G2), with a
   command, ports, env, retained named volumes, a backup volume and limits (G3). No TTL, idempotency
   keys, a fenced single writer per volume and a generation that a stop must match. Refused at the
   platform: privileged mode, added capabilities, host network, host mounts, the Docker socket and
   devices. `exec` inside it, with secret input that is never recorded. Volume snapshots taken as
   one group per instance, a restore into new volumes, an optional command run before a snapshot
   (G8), and a temporary recovery instance from a base backup.
2. **A project network.** One private network per project scope, with the default-deny reach rules
   above (G5, G6), the sidecar attached with 2375 dropped and a resolver for nested containers, a
   per-workspace short name (G10), attach and detach with live connections closed, carried across an
   executor replacement and available at a standby's claim. A workspace's `mend_default` interface
   narrowed to Mend's own endpoints. Never an arbitrary host, and never another project.
3. **A project-scoped principal.** An application-owned scope that owns instances, volumes and the
   project network under a compute and storage budget, with no login of any person, that may attach
   workspaces owned by the project's members, and whose instances and volumes can move to an
   organization-owned archive when the project is removed.
4. **Secret env for one process.** Env for `sessions.open` and `exec` that the platform never
   records and masks in output.
5. **Correction.** The entry "Workspaces reaching a project's long-running service" says ADR 0017
   proposes an operator endpoint until links ship. The merged ADR 0017 does not.

Later asks, recorded when their steps start: backups off the machine (S13), a forward into an
instance so a person can open its web UI from their browser, and the Kubernetes and Firecracker
providers.

## Considered

- **Databases only.** The first draft of this ADR. Yiannis rejected the scope on 2026-10-29.
- **A link per resource instead of a project network.** It isolates each workspace and resource
  pair, but a Compose app, a second port or a new resource each needs a new link, and names do not
  resolve. A project network with default-deny rules keeps the isolation that matters.
- **A short name that moves at once on a switch.** A process that reconnects by name would write to
  the old target, then the new one, without a restart.
- **A container beside Mend on `mend_default`.** It could run on the box this week. It has no
  isolation between projects, Mend's own Postgres is on the same network, it exists only on Docker,
  and Mend would own lifecycles and backups outside Sealant.
- **An endpoint the operator provisions.** Small for Mend, but the operator must run, back up, copy
  and delete everything.
- **A hidden project session or workspace that hosts the resources**, as `DependencyInstallJob`
  hosts installs. It is still one person's workspace with a harness, it is still replaced at 7 h 30,
  and no other workspace has a supported route to it.
- **Worktree resources as a session's Compose services.** They would die at the next executor
  replacement and reach nothing outside their workspace.
- **One owner role per worktree, or per shared database across generations.** An old grant could
  take the owner role and grant itself `CONNECT` to the next generation.
- **Deleting a worktree instance's volumes after a snapshot.** Until backups leave the machine, the
  snapshot is on the same machine and may be on the same disk, and writes after it would be lost.
- **The mode in `mend.toml`** (`@db:own`). A merge from main would change which data a worktree
  reads.
- **The earlier plan's bridge over the session channel** (Obsidian, "Mend live preview plan" §4).
  ADR 0017 withdrew it, because it is a relay that stands in for a missing platform feature.

## Known gaps

The second review left these open. None loses data as written. Each is settled in the build step
named, or by the decision named.

- **Snapshot retention.** "The last seven nightly snapshots are kept" reads as deletion by age,
  against "Purge is the only act that destroys data". Step 8 settles it.
- **WAL, dumps and generations** have no bounded retention, so a full backup volume can stop the
  primary. Step 8 sets a bound and a warning.
- **`mend resource exec` from inside a workspace** contradicts "a call from inside a workspace can
  only read status or make the agent's copy". Step 4 settles which calls a workspace may make.
- **Instance-to-instance reach** names a `depends` that `ResourceDefinition` does not have. Step 6
  adds the field and its approval.
- **Test databases created between sweeps** cannot connect until the next sweep writes their
  `pg_hba.conf` rule. Step 5 settles it, for example with an event trigger.
- **Conventional names** (`DATABASE_URL`, `PG*`) still override an app's `.env`, and appear or
  disappear when a second Postgres is added. Step 4 settles it.
- **Switching by short name.** A Compose consumer that restarts while another consumer delays the
  move resolves the old target, then follows the move later without a restart. Step 6 settles it.
- **Rotating a generic resource's secret** has no check that the instance applied it before Mend
  exports it. Step 6 settles it.
- **The agent's copy** is also a reset of its own target, which the table forbids it. Step 5 settles
  it.
- **Docker enforcement of the reach rules**, and workspace egress to the internet, are not named in
  the matrix. The Sealant network step names them.
- **The session-dependency env seam** stays with the previews thread (ADR 0017 step 9).

## Consequences

- Nothing runs until Sealant ships the service resource, the project network and the project
  principal on Docker. Until then, `@db` is refused by name, and a session runs its own
  `[service.db]` as it does today.
- Writes to a project resource never appear in Review, because they land outside every worktree. The
  status line says so.
- Any worktree on a shared database, and its agent, can change or drop the shared tables. Any
  process on the project network can write to a generic resource it reaches. Snapshots and
  point-in-time recovery bound the damage. Nothing prevents it.
- A generic resource has no per-person credentials. Its access boundary is the project network.
- A copy into a worktree's own database spreads whatever rows shared holds, sensitive ones included.
- A person cannot open a resource's web UI, or point a desktop client at it, until the later forward
  ask ships.
- A switch can wait on a terminal that never restarts. The status line names it, and the person can
  restart or end it.
- Archived volumes, kept snapshots, dumps and generations use disk until a person purges them.
  Project and organization settings show their sizes.
- Tilt (0.38) can describe resources once they exist. This ADR does not depend on it.

## Delivery

Replaced by the amendment's delivery list.

One ready-for-review PR per step. Each ends in something a person can check. Sealant steps are
marked **[Sealant]**. Steps 2 and 3 are needed for 0.37 and ship in its release chain (sealantd,
then Core, then the Mend pin). Step 12's Sealant work is not promised for 0.37. ADR 0017's steps are
named as "ADR 0017 step N".

1. This ADR, its decisions written in, and the platform feedback.
2. **[Sealant]** The project-scoped principal, its right to attach its members' workspaces, and
   archiving its instances to an organization. Check: an SDK client acting as a project scope
   creates nothing it cannot attribute, and a removed member's workspace is refused.
3. **[Sealant]** The service resource with retained and backup volumes, limits, refused options,
   `exec` with secret input, a generation-fenced stop, grouped snapshots and the recovery instance.
   The project network on Docker, with its reach rules and the narrowed `mend_default`. Secret env
   per process. Check: two workspaces of one project reach an instance by name, neither reaches the
   other on either network, and an instance cannot open a connection to either. A Compose container
   reaches the instance, and nothing reaches 2375. Both executors are replaced, and the data is
   still there.
4. In Mend: definitions and approval, `mend resource add|list|start|stop`, the web card, the
   Postgres and Redis presets at project scope with `shared` and `off`, grants per person,
   point-in-time recovery and the engine settings. A project or worktree delete is refused while it
   has resources, until step 8 archives them. Check: the P-SLNT-46 done-when. Two worktrees read
   each other's rows, both sessions stop, and the rows are there after the next start. A kill of
   each instance after acknowledged writes loses none of them.
5. Selections and `own` for Postgres: create, copy into a new generation, switch both ways with
   consumers waited for, and S15. Check: write row A in shared and row B in the worktree's own
   database, switch away and back, and each database still holds exactly its own rows.
6. Resources from any approved image at project scope, with `shared`, `own` and `off`. Check: an
   approved Mailpit reaches every worktree by name on the box, and an own instance is reached only
   from its worktree.
7. Worktree resources, started on first use and stopped with their worktree. Check: two worktrees
   each run their own Mailpit, and neither reaches the other's.
8. Leases per process, the generation fence, idle stop, crash recovery, nightly snapshots and dumps,
   worktree cleanup and the project archive. Check: kill Mend during a copy, and after restart there
   is one database and no unpublished copy. Remove a worktree, and its instance's volumes are
   archived. Delete a project, and its archive is in organization settings.
9. The status line on the phone, the VS Code extension, Slack and the agent's workspace note.
10. Previews: `@name` in `depends`, the digest, the env and its mappings, after ADR 0017 step 9. The
    wake, after ADR 0017 step 12.
11. The MySQL preset, for ADR 0017 step 14 (WordPress), and an own Redis instance per worktree.
12. **[Sealant]** Backups off the machine, a forward into an instance, then Kubernetes, then
    Firecracker with that runtime.

## Decision log

These are choices this ADR proposes beyond the decisions. Yiannis may overturn any.

1. **A resource is a definition, and a database is a preset of it.** Taken, per his 2026-10-29
   scope.
2. **One project network with default-deny rules, not a link per pair.** Taken, so that names
   resolve and Compose apps work, while workspaces stay apart (decision G5).
3. **A database preset's `own` is a database on the project instance, not a second server.** Taken,
   because Yiannis's "both" then costs a database, not a server.
4. **Grants per person, workspace incarnation and selection revision, an owner role per physical
   database, and `pg_hba.conf` rules Mend writes.** Taken, because a grant must reach only what its
   revision named, and no grant may widen that itself.
5. **Credentials as fresh process env, and exports from the applied secret.** Taken, because
   workspace env is fixed at create, and a rotated or unapplied secret must not reach consumers.
6. **Leases per process, a switch that waits for its consumers, and a generation that fences every
   stop.** Taken, so that no process writes to two targets and no consumer is stopped from under it.
7. **Idle and removal stop compute, never data.** Taken, so that what someone wrote survives.
8. **Preset engine settings that keep every acknowledged write.** Taken, because a retained volume
   keeps only what the instance wrote to it.
9. **Refused options are refused by the platform.** Taken, so that a definition approved by mistake
   still cannot reach the host.
