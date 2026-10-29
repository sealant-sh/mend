# Shared services: one server per project that every worktree reaches

Status: proposed 2026-10-29. Proposes **shared services**. A shared service is a Postgres or a Redis
that runs once per project, outside every worktree's workspace, and that every session in the
project can use instead of a copy of its own. Yiannis decided the data model on 2026-10-29: a shared
database service offers both one shared database and a database per worktree, with "excellent ux"
for both. The fifteen decisions under [Decisions](#decisions) are still his. Where the text below
depends on one, it names the decision and the default it assumes, and that default is pending. Every
other mechanism is a proposal. Read against Mend `44b0a44a9` and Sealant Core `97076a88`. Amends
[ADR 0017](0017-live-preview.md) (how a preview's `depends` names a shared service).

**What this ADR does not claim.** A shared service is a development resource, not a production
database. Its status says what was observed
(`@db · running · answered SELECT 1 · observed 3 s ago`), never that the data is safe. Nothing here
runs until Sealant has what [Platform feedback](#platform-feedback) asks for.

## Context

### What was asked

Yiannis asked for this five times, in his own words:

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
ux".

His words set the forces. A service is used between worktrees and runs long. It covers databases,
Redis and message brokers. A session can still run its own infra, and the shared one is the person's
choice. Both data models are required, and both must be easy to pick, safe to switch and visible on
every client. The Linear done-when for P-SLNT-46 ("Two sessions in different worktrees use the same
project Postgres and Redis, and the data survives both sessions stopping") does not appear in any of
his messages, and reads as agent wording.

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
  (`SEALANT_DOCKER_WORKSPACE_NETWORK`, `deploy/docker/compose.v2.yaml:48`). That network is not a
  contract. A server on a workspace's own interface is reachable from every other workspace on it,
  of every project, and Mend's own Postgres is on it too. On Kubernetes, reach is the instance-wide
  `networkPolicies.workspaceEgressAllow` (`docs/KUBERNETES.md:336`).
- **Project removal deletes the store before the row.** `apps/api/src/routes/workbench.ts:770-771`
  removes the project's store, then `projects.remove` hard-deletes the row.

### What stands

- **No relay.** Mend never carries a service's bytes over the session channel or any relay of its
  own (ADR 0017, "Services shared between worktrees", decision log 7). A missing SDK feature is a
  `PLATFORM-FEEDBACK.md` entry, not a workaround (AGENTS.md).
- **Commands are the owner's.** Only a session's owner runs a command or a recipe. A steerer may
  restart or stop (ADR 0013). An automatic start runs only a recipe digest the owner approved (ADR
  0017, "After the agent is done").
- **Losing a person's data is a blocker.** For a database, that includes its rows.
- **A preview's `depends` names a Service of its own session or a shared service of the project**,
  and either resolves to an address and credentials in the preview Service's env (ADR 0017, decision
  3). A preview stop never ends a stateful dependency (ADR 0017, decision log 5).
- **One executor per worktree** (ADR 0002). Nothing may need a second executor on a worktree.

## Decision

### A shared service is a Sealant service, not a session's Service

A **shared service** is one server for one project, such as `@db` (Postgres 17) or `@cache` (Redis
7). It assumes decision S6's recommendation: Sealant runs it as a resource of its own, with no
harness, no worktree and no TTL. It has one retained volume, which no executor replacement touches,
because the server never runs in an executor. A workspace reaches it over a **link**, which the
platform makes and revokes, with an address and credentials of its own. Mend is never in the path of
its bytes.

```ts
// packages/domain/src/workbench/shared-service.ts
export interface SharedService {
  readonly id: SharedServiceId;
  readonly projectId: ProjectId;
  readonly name: SharedServiceName; // "db". Recipes and status lines write it as "@db"
  readonly engine: "postgres" | "redis";
  readonly approved: ApprovedDefinition; // the image digest, version and config the managers approved
  readonly sharedDatabase: DatabaseId; // the one pointer to the shared data
  readonly defaultMode: DataMode; // decision S1
}

export type DataMode = "shared" | "worktree";

/** One row per (worktree, service). Every session of the worktree uses the same one. */
export type WorktreeSelection =
  | { readonly mode: "shared"; readonly revision: Revision } // follows `sharedDatabase`
  | {
      readonly mode: "worktree";
      readonly revision: Revision;
      readonly database: DatabaseId;
    };

/** Databases a worktree owns, kept across switches. A copy or a reset adds a generation. */
export interface WorktreeDatabase {
  readonly id: DatabaseId;
  readonly worktreeId: WorktreeId;
  readonly generation: number;
  readonly source: "empty" | "copy-of-shared" | "seed" | "restore";
  readonly state: "live" | "kept" | "dumped";
}

/** Compute can be absent. Data is never absent until a person purges it. */
export type SharedServiceState =
  | { readonly kind: "declared" }
  | {
      readonly kind: "starting";
      readonly storage: RetainedStorage;
      readonly generation: number;
    }
  | {
      readonly kind: "running";
      readonly storage: RetainedStorage;
      readonly generation: number;
    }
  | {
      readonly kind: "stopping";
      readonly storage: RetainedStorage;
      readonly generation: number;
    }
  | {
      readonly kind: "stopped";
      readonly storage: RetainedStorage;
      readonly reason: StopReason;
    }
  | {
      readonly kind: "blocked";
      readonly storage: StorageEvidence;
      readonly reason: Refusal;
    }
  | { readonly kind: "archived"; readonly storage: StorageEvidence }
  | { readonly kind: "purged"; readonly confirmedBy: AccountId };
```

- **A Service stays what it is.** A session's own `[service.db]` keeps running in its workspace, and
  `depends = ["db"]` keeps naming it. A shared service is a separate thing with separate tables.
  Nothing redirects a recipe name to it, so "a session can spin up any infra" stays true.
- **The platform owns the server's life.** Sealant creates, starts, stops and links it, and fences
  the volume to one writer. Mend owns the project's definition, each worktree's selection, the
  databases inside the server, the grants and the status line.
- **One module owns it in Mend.** `SharedServices` (`packages/sessions/src/shared-services/`) hides
  approval, database allocation, links, grants, leases and crash recovery behind one launch
  operation. The engine calls it when it starts a process in a worktree that uses a shared service,
  and gets back the env for that process.
- **Engines.** Postgres and Redis first, then MySQL for WordPress (ADR 0017 step 14). Mend can copy,
  dump and restore only an engine whose data it knows, so the set is closed. A message broker
  (RabbitMQ, with a virtual host per worktree) is a later engine, not in this design's delivery.

### Where it runs

Each runtime gets the same contract from Sealant. Docker comes first, because the box runs Docker.

| Runtime     | Server                                                                         | Link                                                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker      | a container with a named volume that workspace cleanup never removes           | one network per link, joined by the service container and that workspace. Two linked workspaces never share a network. Containers the workspace runs through its Docker sidecar reach the link too, and the sidecar's daemon port 2375 never does. |
| Kubernetes  | a StatefulSet of one, a retained PersistentVolumeClaim and a ClusterIP Service | a NetworkPolicy from that workspace's Pod to the service Pod. `workspaceEgressAllow` does not grow.                                                                                                                                                |
| Firecracker | a service host outside the VM, on retained storage                             | a route from that VM to the service address, which the Firecracker runtime work defines                                                                                                                                                            |

The Docker link must reach Compose containers, because ADR 0017 serves Compose-run apps and
WordPress is one. Core's Docker adapter runs those containers inside the sidecar's network
namespace, so a link that only the workspace container joins would leave them without a route. How
the platform reaches them without opening 2375 to the service is part of the link ask.

A link is made when a workspace is bound to its worktree: at create, or at claim for a standby that
was created before its worktree was known. An executor replacement links the new executor and
unlinks the old one.

A runtime without the contract refuses the binding by name, before any work starts:
`@db · shared services need a newer Sealant on this runtime · this session can run its own [service.db]`.
There is no fallback to `mend_default`, to an operator endpoint or to a relay.

### Both data models on one server

Every shared database service offers both modes, per worktree. The server is the same. Only the
database a grant connects to differs.

- **Shared.** The worktree follows the service's one `sharedDatabase` pointer. A reset or a restore
  of shared data changes that pointer and makes a new selection revision for every worktree on
  shared, which Mend rebinds as it does on a switch (below). Objects belong to a group role
  (`shared_owner`), which every grant on shared uses through `SET ROLE`, so a migration from any
  worktree can alter a table another worktree created. The same right lets any worktree on shared,
  and its agent, drop those tables. The status line says so, and point-in-time recovery (below)
  ships with shared mode.
- **Its own database.** The worktree gets a database of its own on the same server
  (`wt_<worktree8>_<generation>`). It starts empty, as a copy of the shared database, or from a seed
  snapshot (decision S2). On Postgres, a copy is a consistent `pg_dump` and restore inside the
  server, into a staging database that is renamed when it is complete. `CREATE DATABASE … TEMPLATE`
  is not used, because it refuses while anyone is connected to the template. A copy or a reset
  always makes a new generation and keeps the previous one, so neither can lose data. Its objects
  belong to the worktree's owner role (`wt_<worktree8>_owner`), which its grants use through
  `SET ROLE`, so dropping a grant never orphans or drops data.
- **Test and shadow databases.** Prisma's `migrate dev` needs a shadow database, and Django's and
  Rails's test runners create one. Whether a worktree's grant may create databases is decision S15.
  Under S15's recommendation the worktree's owner role has `CREATEDB`, so a database a tool creates
  belongs to that role, not to the grant that ran the tool.
- **Switching keeps every byte.** A switch points the selection at the other database. The other
  database stays as it is, and nothing merges one into the other (decision S3).

### Grants, and what a switch does to running processes

A grant is a database role for one person, one workspace incarnation and one selection revision. Two
people's sessions in one worktree get two grants. Mend creates and rotates the passwords.

- **A grant connects only to the database its selection revision named.** No grant is a superuser.
  Each database revokes `CONNECT` from `PUBLIC`.
- **A switch makes a new revision.** Mend restarts the Services that use it, once each Service's
  owner has the right to restart it (ADR 0013). A Service whose owner has not allowed it, and a
  process Mend cannot restart, such as a terminal agent or a shell, keeps its old grant until it
  exits. Its status line says so
  (`@db · switched · this terminal keeps the shared database until it restarts`). When the last
  process on the old revision exits, Mend drops its grant.
- **Revocation is per person.** When a member leaves the organization, or a project becomes private
  and they are not its creator, Mend drops their grants and terminates their backends
  (`pg_terminate_backend`). `NOLOGIN` alone would leave open connections. The service and its data
  stay. Other people's grants in the same worktree are untouched.

### What a person writes and sees

A manager declares the service once, in project settings or with the `mend shared` command. The
command is new, because `mend service <word>` already runs any word that is not a verb as a recipe
name (`apps/cli/src/main.ts`, `serviceCommand`):

```sh
$ mend shared add db --engine postgres --version 17
@db · postgres 17 · declared · new worktrees get their own database (empty while shared is empty)
```

A recipe that orders its start after a shared service names it with `@`, which a recipe name can
never start with:

```toml
[service.web]
command = "pnpm dev --port 3000"
port = 3000
browserScheme = "http"
depends = ["@db", "@cache"]
```

The session composer shows each worktree's choice on one line before the first start, with
**change** beside it (decision S1). The same status function builds the line for the CLI, the web
app, the phone, the VS Code extension, Slack and the agent's workspace note (decision S5). Every
line writes the service with its `@`, so it never reads as a session's own Service:

```text
$ mend shared list
@db     postgres 17 · running · its own database wt_3f2a_2 · copied from shared 14:02 · observed 3 s ago
@cache  redis 7 · running · shared · writes reach 3 worktrees · not shown in Review · observed 3 s ago
```

```sh
$ mend shared use db shared
@db · shared database · restarted web · any worktree on shared can change or drop its tables
$ mend shared use db worktree
@db · its own database · back on wt_3f2a_2 (14 MB, last used 2 d ago)
```

**Env.** Every process Mend starts in a worktree whose selection names a shared service gets that
service's address and credentials as process env: the agent, its shells and its Services. A process
started before the worktree chose the service gets them through `mend shared exec -- <command>`.

- A service name becomes an env name in upper case, with `.` and `-` written as `_`. `@db` gives
  `MEND_SERVICE_DB_URL`, `_HOST`, `_PORT`, `_DATABASE`, `_USERNAME` and `_PASSWORD`. Two names that
  give the same env name are refused when the second is declared.
- When exactly one Postgres is in use, the process also gets `DATABASE_URL` and the `PG*` names, so
  `psql` works with no flags. Redis gets `REDIS_URL` the same way.
- A recipe that needs other names maps them in the table form:

  ```toml
  depends = [
  	{ shared = "db", env = { TEST_DATABASE_URL = "url" } },
  	{ shared = "reports", env = { REPORTS_DATABASE_URL = "url", REPORTS_PGHOST = "host" } },
  ]
  ```

  The fields are `url`, `host`, `port`, `database`, `username` and `password`. With two Postgres
  services in use, `DATABASE_URL` is set only through a mapping. Two mappings that set the same name
  are refused, and so is a mapping that sets a name another binding provides. How a session
  dependency exports its address is step 9's to decide.

- A recipe `env` that sets a name a shared binding provides is refused by name
  (`DATABASE_URL comes from @db`).
- Mend and Sealant never write the credentials into `launch_env`, a capture, a status line or a log,
  and a restart computes them again. A process that receives them can still write them to a file,
  such as a `.env` in the worktree, and the agent can read them. ADR 0018 §7 states the same limit
  for keys.

### Lifecycle

A shared service starts on first need: a launch in a worktree that uses it, a preview's wake, or a
person's **Start**. Concurrent starts from several worktrees coalesce on one operation key, so the
platform starts it once.

- **Leases are derived, not counted.** A shared service is in use while a live workspace's selection
  names it, a person's keep-running hold stands, or an operation (a copy, a dump, a restore) runs.
  Each consumer writes its own row. Mend never trusts an in-memory counter. When Mend cannot tell
  whether a consumer is alive, the service stays up.
- **Admission and stopping are fenced by one generation.** A new lease and a stop decision both
  update the service row's `generation` in the same transaction that reads the leases. Before the
  consumer is admitted, Mend sends Sealant `setDesired(running)` with the new generation. A stop
  sends the generation it decided on, and Sealant refuses a stop for a generation older than the
  last one it was sent. So a launch that took a lease after the idle check can never be stopped from
  under it.
- **Idle stops compute only.** After N minutes with no lease (decision S11), Mend asks for a
  graceful stop. A person's **Stop** keeps the service stopped against automatic starts, as it does
  for a preview (ADR 0017, decision log 6).
- **What may never happen to its data** on idle, a stop, an executor replacement, a Mend restart or
  a budget: deleting or reformatting the volume, dropping or resetting a database, killing the
  server before its shutdown timeout, or stopping it while an operation runs. A missing volume makes
  the service `blocked · data volume missing`. Mend never starts an empty replacement in its place.
  This governs what Mend and Sealant do. It cannot stop a process that holds a grant from running
  SQL that drops its own tables, which is why shared mode ships with point-in-time recovery.
- **After a crash**, every transition and operation was recorded before the platform call, under a
  deterministic key. On start-up, Mend reads the platform's status first and finishes or rolls back
  each half-done step by its key. A half-made database is a staging database, which recovery drops.

### Durability

The data lives in the service's volume and nowhere else. It is never in a capture or in git.

- **Engine settings are part of the approved definition.** Postgres runs with `fsync` and
  `synchronous_commit` on. Redis runs with `appendonly yes`, `appendfsync always` and
  `maxmemory-policy noeviction`, so an acknowledged write survives a crash of the server. Delivery
  tests an abrupt kill after acknowledged writes on both.
- **Point-in-time recovery for shared Postgres.** A physical base backup and a WAL archive on the
  service's volume. Postgres recovers a whole server, never one database, so recovery runs in a
  separate recovery server that Sealant starts beside the live one. Mend dumps the shared database
  from it at the chosen moment and restores it into a new database on the live server, which the
  `sharedDatabase` pointer then names. The worktrees' own databases are never rewound.
- **Backups** are logical dumps, nightly and before every reset, restore, purge or major-version
  upgrade, with a checksum and a restore check (decision S13). The first slice keeps them on the
  service's own volume. The status says `last backup 03:00 · on the data volume only`, because
  losing that volume loses them too.
- **Removing a worktree** dumps each database it owns, checks that the dump restores, drops the live
  database and keeps the dump until a person purges it (decision S4). Until backups leave the
  machine, those dumps share the volume's fate.
- **Removing a project** with shared services first archives them. Every database is dumped and
  checked, the service stops, and its records move to an organization-owned archive that keeps the
  project's name as a label. Purge for that archive is in the organization's settings. The project
  delete checks that every shared service is archived before it removes the store, so it cannot
  remove the store and then fail on the row (decision S4).
- **Purge** is the only act that destroys data. It names each database and dump with its size, needs
  a fresh confirmation, and runs only after a verified dump.

### Who may do what

This table is decision S12's recommendation.

| Act                                                                                | Who                                                                                                                      |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Declare, change the definition, stop                                               | a manager: the project's creator, or an organization owner who can see the project (`canManageProject`)                  |
| Reset or restore shared data, purge                                                | an owner, or the creator of a private project (`canRemoveProject`, the rule for acts that destroy others' work)          |
| Switch the worktree's mode, reset or restore its own database                      | the worktree's change owner (the owner of its first session, ADR 0007), with restart rights for each Service it restarts |
| Use it, and start it by launching                                                  | any member who can see the project                                                                                       |
| Read status, copy shared data into a new generation of the worktree's own database | the agent. It cannot switch to shared, reset or purge.                                                                   |

Approving the definition is ADR 0013's command rule applied to a server. The managers approve the
resolved image digest, version and engine settings, and the service runs only what they approved. A
changed definition runs only after they approve it again. A shared service spends nobody's login,
because no harness runs in it, so ADRs 0013, 0016 and 0018 have nothing to charge. Who owns its
compute and disk is decision S7. The operator gets no read access to any project's shared data
through Mend.

### Naming it in a preview (amends ADR 0017)

ADR 0017 left four seams to this ADR.

1. **`depends` names a shared service** as `"@db"`, or as a table `{ shared = "db", env = { … } }`
   (decision S8). A recipe name matches `^[a-z0-9][a-z0-9._-]{0,63}$`, so neither form can clash
   with one, dots included.
2. **The approval digest** gains, in plan order, the shared service's stable id, its `@` name and
   its full env mapping, each env name with the field it takes. The service's command, image,
   credentials and address stay out, so a rotation or a manager's approval of a new definition never
   unapproves a worktree's preview. Whether the mode belongs in the digest is decision S9.
3. **Env** is merged in this order, a later layer winning: the workspace's env, the project's, the
   shared binding's, the recipe's, then Mend's own person and identity env. A recipe `env` that sets
   a name the shared binding provides is refused by name.
4. **Wake.** Step 12's wake calls `SharedServices` to make sure the service runs, inside the
   3-minute hold ADR 0017 specifies, with one start per service however many worktrees ask. A wake
   never creates or copies a database. A worktree's selection exists from its first launch, and a
   copy runs only on a person's choice. A service a person stopped is not started by a wake, and the
   viewer's page says who stopped it
   (`preview · web · @db stopped by Maria · your request was not delivered`). A preview stop never
   reaches a shared service. Readiness is a probe from the preview's own workspace over its link,
   never a Mend forward.

On 2026-10-29 the previews thread took three requests into step 9: it reserves the two `depends`
forms and refuses them with `@db · shared services are not available yet`, it leaves the env slot in
the order above, and it keeps a dependency's credentials out of `launch_env`. Whether step 9 also
puts a session dependency's address in env (`MEND_SERVICE_DB_HOST` for `depends = ["db"]`) is
decided when step 9's design starts.

### What it does not do

- It never carries a shared service's bytes through Mend. `mend service connect` does not reach a
  shared service.
- It never merges one database into another.
- It never deletes data on a timer, an idle stop, a replacement or a budget.
- It never runs an image or a command the managers did not approve.
- It never changes which database a worktree uses because a file changed on a merge.

## Decisions

Each is Yiannis's. Options and evidence went to him on 2026-10-29. S15 and the archive option in S4
came out of this ADR's review and follow.

| #   | Decision                                      | Options                                                                                                                                                                                                                       | Recommendation and evidence                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Where the choice is made, and the default     | a project default per service with a per-worktree switch in the composer; written in `mend.toml`; per session                                                                                                                 | The first. A merge would otherwise change which data a worktree reads, and a worktree's sessions share one workspace. Default: databases get their own per worktree, Redis shares. One branch's migration breaks another's app, and WordPress keeps its URL in its database. |
| S2  | How a worktree's own database starts          | a copy of shared; empty; a named seed snapshot                                                                                                                                                                                | Offer all three when choosing, with the size shown. Default to a copy when shared has data, empty otherwise. The panel split: Opus chose a copy, Sol and Astra empty.                                                                                                        |
| S3  | Switching                                     | point the selection and keep both; also a managed "make this the shared data"; automatic copy or replace                                                                                                                      | The first now, the second later. No database merge exists, so the third loses writes.                                                                                                                                                                                        |
| S4  | Cleanup when a worktree or project goes       | keep the live database until purged; dump, verify, drop, keep the dump until purged; the same with a 30-day dump. For a project: an organization-owned archive; or refuse the delete until purge                              | Dump, verify, drop, keep the dump. For a project, the organization-owned archive. No deletion by age, because losing data is a blocker, and refusing the delete would push people to purge.                                                                                  |
| S5  | How clients show the mode                     | a persistent line on every client; a badge with details                                                                                                                                                                       | The line, from one status function, as ADR 0017 does for previews.                                                                                                                                                                                                           |
| S6  | Where it runs                                 | a Sealant service resource, Docker first; a container on `mend_default`; an operator endpoint                                                                                                                                 | The first. `mend_default` has no isolation between projects, an operator endpoint leaves copies and backups to the operator, and AGENTS.md rules out workarounds. All three panel members chose it.                                                                          |
| S7  | Who owns it and pays                          | a project-scoped infrastructure identity in Sealant; a synthetic Sealant user per organization; the first person to start it                                                                                                  | The first. A person-owned service breaks for everyone when that person leaves, and a synthetic user is a principal pretending to be a person.                                                                                                                                |
| S8  | Where it is declared, how a recipe names it   | project settings and `"@db"`; `[shared.db]` in `mend.toml` and `{ shared = "db" }`; both                                                                                                                                      | Both: settings hold the approved definition, a `[shared.*]` table is a proposal, `depends` takes either form.                                                                                                                                                                |
| S9  | Does a switch re-ask for a preview's approval | no, the mode stays out of the digest; yes                                                                                                                                                                                     | No. A switch already needs the change owner and restart rights for each Service it restarts. Sol and Astra leaned yes.                                                                                                                                                       |
| S10 | A worktree's own Redis                        | a small server per worktree; a logical database number; key prefixes under ACL; shared only at first                                                                                                                          | Shared only at first, then a server per worktree. Redis deprecates the ACL rule that restricts `SELECT`, and prefixes need app changes. This is an exception to "both" for Redis that he must accept.                                                                        |
| S11 | Idle                                          | 30 min; 15 min; never on Docker                                                                                                                                                                                               | 30 min, as for previews. Postgres starts in seconds.                                                                                                                                                                                                                         |
| S12 | Who may do what                               | the table under "Who may do what"; managers for everything; any member for everything except purge                                                                                                                            | The table. It follows ADR 0013, ADR 0007's change owner, and `canRemoveProject` for acts that destroy others' work.                                                                                                                                                          |
| S13 | Backups                                       | on the service's volume; also off the machine to Sealant's object store                                                                                                                                                       | The volume first, off-machine before Mend calls the data durable.                                                                                                                                                                                                            |
| S14 | The first slice                               | Postgres in both modes and Redis shared on Docker; Postgres shared only; wait for every runtime                                                                                                                               | The first. It proves the P-SLNT-46 done-when on the box and exercises both modes.                                                                                                                                                                                            |
| S15 | Test and shadow databases                     | in its own-database mode, the worktree's owner role may create databases, and Mend lists, dumps and removes them with the worktree; Mend makes `_shadow` and `_test` databases on request and gives their URLs in env; refuse | The first. Prisma, Django and Rails then work unchanged. The cost is databases Mend did not name, which it finds by owner.                                                                                                                                                   |

## Amendments

**ADR 0017**, "Recording how to run the project": `depends` also takes `"@<name>"` and
`{ shared = "<name>", env = { … } }`, which name a shared service (ADR 0019).

**ADR 0017**, decision 3, "The binding": add "The address and credentials of a shared service, and
the order in which env layers merge, are ADR 0019's."

**AGENTS.md**, when this ADR is accepted. The Product Language Contract gains `shared service`,
`the shared database` and `its own database`. A `Service` keeps its meaning, a session's declared
port.

## Platform feedback

This PR adds four entries to `PLATFORM-FEEDBACK.md` and corrects one. They give the 2026-10-24
entries "Workspaces reaching a project's long-running service" and "Service storage that survives
executor replacement" a concrete surface. Those entries stay, marked as superseded.

1. **A service resource.** `services.ensure`, `observe` and `setDesired` for a harness-free workload
   with an approved image digest and engine settings, one retained volume, no TTL, idempotency keys,
   a fenced single writer and a generation that a stop must match. A stop never removes the volume.
   `exec` inside it, with secret input that is never recorded. A temporary recovery instance started
   from the volume's base backup, for point-in-time recovery.
2. **Links.** `services.link` and `unlink` from a workspace to a named service on one port, with an
   address for that workspace, one network per link, reach for the workspace's own nested containers
   without exposing its Docker daemon, and links carried across an executor replacement. Never an
   arbitrary host.
3. **A project-scoped principal.** An application-owned scope that owns services and their storage
   under a compute and storage budget, with no login of any person, and that may link to workspaces
   owned by the project's members (decision S7).
4. **Secret env for one process.** Env for `sessions.open` and `exec` that the platform never
   records and masks in output.
5. **Correction.** The entry "Workspaces reaching a project's long-running service" says ADR 0017
   proposes an operator endpoint until links ship. The merged ADR 0017 does not.

Backups off the machine (decision S13) and the Kubernetes and Firecracker providers are later asks,
recorded when their steps start.

## Considered

- **A container beside Mend on `mend_default`.** It could run on the box this week. It has no
  isolation between projects, Mend's own Postgres is on the same network, it exists only on Docker,
  and Mend would own the server's lifecycle and backups outside Sealant.
- **An endpoint the operator provisions.** Small for Mend, but the operator must create, back up,
  copy and delete every database, and the two data modes become the operator's problem.
- **A hidden project session or workspace that hosts the server**, as `DependencyInstallJob` hosts
  installs. It is still one person's workspace with a harness, it is still replaced at 7 h 30, and
  no other workspace has a supported route to it.
- **A Sealant workspace with no harness, plus links between workspaces.** It puts capture, executors
  and owner maps on a thing that must never be replaced. A service resource is smaller.
- **One grant per worktree.** It cannot revoke one person without disconnecting the others, and it
  cannot keep a terminal on its old database after a switch.
- **The mode in `mend.toml`** (`@db:worktree`). A merge from main would change which data a worktree
  reads.
- **The earlier plan's bridge over the session channel** (Obsidian, "Mend live preview plan" §4).
  ADR 0017 withdrew it, because it is a relay that stands in for a missing platform feature.

## Consequences

- Nothing runs until Sealant ships the service resource, links and the project principal on Docker.
  Until then, `@db` is refused by name, and a session runs its own `[service.db]` as it does today.
- Writes to a shared database never appear in Review, because they land outside every worktree. The
  status line says so.
- Any worktree on shared data, and its agent, can change or drop the shared tables. Point-in-time
  recovery bounds the damage. Nothing prevents it.
- A copy into a worktree's own database spreads whatever rows shared holds, sensitive ones included.
- Kept dumps, generations and archives use disk until a person purges them. Project and organization
  settings show their sizes.

## Delivery

One ready-for-review PR per step. Each ends in something a person can check. Sealant steps are
marked **[Sealant]**. Steps 2 and 3 are needed for 0.37 and ship in its release chain (sealantd,
then Core, then the Mend pin). Step 11's Sealant work is not promised for 0.37.

1. This ADR, the decisions written in once Yiannis answers, and the platform feedback.
2. **[Sealant]** The project-scoped principal and its right to link to its members' workspaces
   (conditional on S7). Check: an SDK client acting as a project scope creates nothing it cannot
   attribute, and a removed member's workspace is refused a link.
3. **[Sealant]** The service resource, retained volume, generation-fenced stop, links on Docker (one
   network per link, nested containers included, 2375 unreachable) and secret env per process.
   Check: two workspaces write one Postgres, both executors are replaced, and the rows are still
   there. A Compose container in one workspace reaches it, and nothing on the link reaches 2375.
4. In Mend: the principal, the `project_shared_services` tables, `mend shared add|start|stop|list`
   and the web card. Check: `@db · running · observed` on the box.
5. Selections, grants per person, links at bind, env at process start, shared mode for Postgres with
   point-in-time recovery, and Redis shared with its persistence settings. Check: the P-SLNT-46
   done-when. Two worktrees read each other's rows, both sessions stop, and the rows are there after
   the next start. A kill of each server after acknowledged writes loses none of them.
6. A worktree's own Postgres database: create, copy into a new generation, switch both ways, cleanup
   by dump, and S15. Check: write row A in shared and row B in the worktree's own database, switch
   away and back, and each database still holds exactly its own rows, and each process connects to
   the database its selection names.
7. Leases, the generation fence, idle stop, crash recovery, nightly dumps and the project archive.
   Check: kill Mend during a copy, and after restart there is one database and no staging database.
   Delete a project, and its archive is in organization settings.
8. The status line on the phone, the VS Code extension, Slack and the agent's workspace note.
9. Previews: `@db` in `depends`, the digest, the env and its mappings, after step 9. The wake, after
   step 12.
10. MySQL, for ADR 0017 step 14 (WordPress).
11. **[Sealant]** Backups off the machine, then Kubernetes, then Firecracker with that runtime.

## Decision log

These are choices this ADR proposes beyond the fifteen decisions. Yiannis may overturn any. The
first three restate recommendations that depend on a pending decision, and say which.

1. **A Sealant service resource, not a session Service or a workspace.** This is S6's
   recommendation, pending. All three members of the design panel (Opus, Sol and Astra) proposed it
   independently.
2. **No fallback route.** This follows from S6's recommendation, pending. Rejected with it:
   `mend_default`, an operator endpoint, a relay.
3. **Switching never merges.** This is S3's recommendation, pending.
4. **One server per service, both modes inside it.** Taken, because Yiannis's "both" then costs a
   database, not a server.
5. **A closed set of engines.** Taken, because Mend can copy, dump and restore only what it knows
   the shape of.
6. **A grant per person, workspace incarnation and selection revision.** Taken, because a grant per
   worktree can revoke neither one person nor one revision.
7. **Credentials as fresh process env.** Taken, because workspace env is fixed at create and a
   rotated password must not come back from a record.
8. **Idle stops compute, never data, and a generation fences every stop.** Taken, so that what
   someone wrote survives, and a new consumer is never stopped by a stale idle check.
9. **Engine settings that keep every acknowledged write.** Taken, because a retained volume keeps
   only what the server wrote to it.
