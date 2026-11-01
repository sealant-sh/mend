---
title: Resources
description: Declare Postgres, Redis or any image, then choose where to start and use it.
sidebar:
  order: 7.5
---

:::note[Design agreed on November 1, 2026] This guide describes the agreed resource model for the
next implementation. The October 31 build has different start, file and env behavior. Updating this
guide does not change that build. :::

Suppose your app needs Postgres, Redis and a mail catcher. Declare them once in the worktree's
`.mend/mend.toml`, then start each where you want it. A project resource is one instance every
worktree can use. A worktree resource is a copy for one branch, shared by all sessions in that
worktree. There is no session level.

Resources are optional. Your app can use a [Service](/guides/services/), external infrastructure,
its own env, project secrets or Doppler instead.

## Declare what the app needs

Create `.mend/mend.toml` in your repository:

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

[service.web]
command = "pnpm dev"
port = 3000
browserScheme = "http"
depends = ["@db", "@cache", "@mail"]
env = { DATABASE_URL = "${MEND_DB_URL}", REDIS_URL = "${MEND_CACHE_URL}", SMTP_URL = "${MEND_MAIL_URL}" }
```

A `[resource.<name>]` table describes a resource. It does not choose a level or start anything.
Editing or merging the file changes nothing already running. Service recipes share the file;
`depends = ["@db"]` names a resource, while `depends = ["db"]` names a Service recipe.

Mend still reads a root `mend.toml` in existing repositories. If both files exist, `.mend/mend.toml`
wins; Mend does not combine them. `.mend/` holds Mend's repository files, including files a future
setup session may write, such as a feature map or verification file.

You can also use `mend resource add` or the web's Add. Both write a table into the worktree's
`.mend/mend.toml`. The file is the only source of definitions. There is no add-to-settings step or
`mend resource add --from-file` import.

The web Resources page lists definitions from the project's default branch plus whatever is running.
A running resource still appears after someone removes its table. Removing that table never deletes
the resource or its data.

## Start at project or worktree level

From the worktree, start the resources every branch should share:

```sh
mend resource start db --project
mend resource start cache --project
mend resource start mail --project
```

Start reads the definition from that worktree's file at that moment. Without a level flag, a
terminal asks "project or worktree?". Without a terminal it refuses and prints a hint to pass
`--project` or `--worktree`. Agents always pass a flag. The web's Start offers the same choice.
There is no approval step.

In `mend resource`, `--project` and `--worktree` on their own choose the level. `mend resource`
finds the project and worktree from the Mend checkout you run it in. Outside one, name them with
`--project-id <name>` and `--worktree-id <name>`.

Nothing starts just because a session launches. The first start is always explicit. A Service
recipe's dependency does not perform that first start either.

If this branch needs its own database or mail catcher, start them at worktree level:

```sh
mend resource start db --worktree
mend resource start mail --worktree
```

For Postgres, the worktree gets its own database on the project's Postgres server. Mend copies the
shared database when it has data, or starts the database empty otherwise. Later starts keep that
database's data. For Redis, Mailpit and every other image, worktree level means its own container.

The same definition can run at both levels at once. A worktree resource of the same name wins in its
worktree. The project resource keeps running for everyone else.

A running project resource remembers the definition it started from. If your worktree's file
differs, its status line says so. Starting it again from that worktree asks whether to restart it
with the new definition, and names the worktrees that use it; the agent passes `--restart`. Editing
the file alone never restarts it.

A worktree's own Postgres database always lives on the project's running server, even when your file
asks for a different version. The start says so, and testing the new version means restarting the
project server for everyone.

A Service whose recipe references a `MEND_*` variable that has no value does not start. It names the
resource to start instead (`web needs MEND_DB_URL · @db is not running for this worktree`). Mend
never starts the resource for it and never leaves the variable empty.

## Choose what each worktree sees

Project resources are visible to every worktree by default. The project setting **new worktrees use
project resources: on/off** changes that default for new worktrees. Existing worktrees keep their
choices. Each worktree can turn each project resource on or off. Visibility does not start anything.

Postgres defaults to the shared database. Its choices are `shared`, `own` and `off`: the project's
shared database, this worktree's own database, or no project database supplied to the worktree.
Before changing the schema, start your own worktree database. The agent's workspace note tells it to
do the same.

## Use the env you want

For every resource the worktree uses, Mend supplies:

| Variable           | Value                                 |
| ------------------ | ------------------------------------- |
| `MEND_<NAME>_URL`  | The resource's connection URL         |
| `MEND_<NAME>_HOST` | The host reachable from the workspace |
| `MEND_<NAME>_PORT` | The resource's connection port        |

Postgres also supplies `MEND_<NAME>_USER`, `MEND_<NAME>_PASSWORD` and `MEND_<NAME>_DATABASE`. `NAME`
is the TOML table name upper-cased, with `-` written as `_`: `[resource.db]` gives `MEND_DB_URL`;
`[resource.db-main]` gives `MEND_DB_MAIN_URL`. A name whose env would collide with Mend's own names
is refused.

Mend sets no `DATABASE_URL`, `PG*`, `REDIS_URL` or other conventional resource variable, and never
overrides a variable your app or project sets. You choose whether to use what Mend offers. For an
app that expects `DATABASE_URL`, an agent or a person can run:

```sh
DATABASE_URL=$MEND_DB_URL pnpm dev
```

Your repo's `.env` can map it if your env loader supports expansion. Mend does not expand that file.
A Service recipe can map it directly, as in the full example above:

```toml
env = { DATABASE_URL = "${MEND_DB_URL}" }
```

Recipe `env` values may reference `MEND_*` resource variables. Mend resolves those references when
it starts the Service. A recipe cannot set a `MEND_*` variable itself. The mapping to an app
variable is your choice; a resource dependency alone does not make that mapping.

### Values do not update inside running processes

The workspace note lists what is available, for example:

```text
@db · Postgres · project · MEND_DB_URL
MEND_* resource values are fixed when a process starts. After a switch, already-running processes, including your own shell, keep the old values. Run mend resource env to print the current values, or restart the process to receive them. Printing values does not update your shell.
Before changing the database schema, start your own worktree database: mend resource start db --worktree.
```

When the worktree switches levels, Mend tells the agents in that worktree which variables changed
and how to get their new values. The command that made the switch prints the message, so an agent
that ran it reads it there. Every other conversation-mode agent in the worktree receives it as a
message. Mend never types into an agent running in a terminal; the switch answer names that session
so you can pass the message on, and the agent's workspace note already says that values are fixed
when a process starts. For example:

```text
@db switched from project to worktree. Changed: MEND_DB_URL, MEND_DB_DATABASE. Your already-running processes, including your own shell, still have the old values. Run mend resource env to print the current values, or restart the process to receive them. Printing values does not update your shell. Mend restarted this worktree's Services with the current values.
```

The message lists only variables whose values changed. Mend restarts the worktree's Services with
the new values and reports what happened. Other running processes, including the agent's own shell,
keep the old values. `mend resource env` prints the current exports; printing does not apply them to
the caller's shell. Apply those exports or restart the process to use the current values.

## Stop, idle and data

Use `mend resource stop <name>` or Stop on the web. A resource a person or agent stops stays stopped
until someone explicitly starts it. Launching a session or waking a preview does not undo that stop.

After nothing uses a running resource for 30 minutes, Mend stops it and keeps its data. Only this
idle stop wakes on use: a session launching in a worktree that uses it, or a preview waking,
restarts it. This exception never performs a first start.

Stops and idle stops keep data. Removing a worktree dumps its own database before dropping it and
archives its resource volumes. Deleting a project archives volumes for the organization's owners.
Removing a definition from the file never deletes a running resource or its data.

## Load a database

A load replaces a Postgres database's data and saves the previous data as a dump first. Choose the
shared database or this worktree's own database as the target. For example, load a dump into the
shared database:

```sh
mend resource load db --from ./staging.dump --target shared
```

The CLI accepts a plain SQL or custom-format dump. Given a source database URL, it runs `pg_dump` on
your machine and streams the result up. The web accepts an uploaded dump or a source URL Mend's
server can reach and pull. The agent can load from its session too.

Mend shows size and progress and names the saved dump of the previous data. A source URL's password
is never logged, recorded or shown back. A load into shared replaces the data other worktrees on
shared use; choose your own database when that is where you want the data.

## A database for before captures

Inside a session, `mend resource base db` makes a separate Postgres database for the base copy on
the project's already-running `@db` server. It copies the shared `app` database when it has tables,
as an own database does. Use `--empty` to start empty. Running the command again keeps the existing
base database and prints the same `MEND_DB_*` shell exports.

Apply those exports only to the base app's launch, mapping `MEND_DB_URL` to its database variable.
For example, in a subshell:

```sh
(
  base_env=$(mend resource base db) || exit
  eval "$base_env"
  DATABASE_URL=$MEND_DB_URL pnpm --dir "$dir" dev --port 3001
)
mend resource base db --drop
```

Stop the base app before dropping its database. Drop saves and checks a dump first. The base
database appears as `base copy database` in `mend resource list`; removing the worktree also saves
and drops it if the agent forgets. This command does not change the after app's database selection
or start a resource. It refuses resources other than Postgres and project servers that are not
running.

## Read the status line

A resource is written with its `@`, so `@db` cannot be confused with a session's Service:

```text
@db · running · project · shared database · observed
@db · Postgres · worktree · MEND_DB_URL
@db · project · definition differs from this worktree
```

The same status line appears in the web app, CLI, phone, VS Code, Slack and the agent's workspace
note. It reports what Mend observed. It does not judge the contents of a database. Resource writes
happen outside the worktree, so they do not appear in the change's diff.

## What the agent can do

The agent can add, start, stop, switch, reset and load, with the same authority as its session's
owner. It uses `mend resource` inside the session and needs no extra approval. It always passes a
level flag for Start, starts its own worktree database before changing a schema, and reads the
switch message before using values its shell already holds.

The platform refuses privileged mode, added capabilities, host network or mounts, the Docker socket
and devices for everyone. Resources reach the workspace over the project network; their ports are
not published on the host.
