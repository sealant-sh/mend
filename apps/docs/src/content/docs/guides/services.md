---
title: Development services
description:
  What a Service is, how its bytes travel, and why it feels local without opening anything to a
  network.
sidebar:
  order: 7
---

A Service is a long-running process you declare on a session: the dev server, a database, Storybook.
It runs inside the session workspace, next to the agent and the worktree, and like every other
session process it keeps running when you disconnect. Mend never scans the workspace for listeners
and never exposes anything you did not name; a Service exists because you declared it.

## Opening the app

A workspace is a container with no published ports. When Vite listens on port 3000 in there, that
port exists only inside the container, and your machine cannot see it. So you declare it:

```sh
mend service run --port 3000 --http -- pnpm dev
```

Mend supervises the command, waits for port 3000 to answer, and opens a port on your machine (your
laptop, not the Mend host), loopback only: `http://127.0.0.1:43127`. Open it. That is your app, hot
reload and all, because Mend pipes raw bytes and rewrites nothing. Pass `--no-connect` to start the
Service without opening that port here.

Mend waits up to a minute for the port to answer. A script that starts a slow Service (a build, an
install, a cold boot) passes `--wait`: Mend keeps waiting while the Service's process runs and its
port has not answered, up to `--timeout` (10 minutes by default), and exits 0 once it answers, 2
when the process ended first, and 124 when it is still starting at the timeout. A waited start opens
no port here; `mend service connect` does that afterwards. The exit codes are in the
[CLI reference](/reference/cli/#service-commands).

One exception: when the CLI's server URL is `localhost`, `mend service run` treats the server's own
forward as your machine and prints it instead of tunnelling. On the Docker deployment that forward
lives inside the application container, so run `mend service connect <name>` there to bring the port
to your loopback.

Behind that port, Mend bridges each TCP connection through to the dev server:

```text
browser ──TCP──▶ Mend's listener on your machine (:43127)
         ──WS───▶ Sealant API
         ──pipe─▶ sealantd, inside the container
         ──TCP──▶ Vite on 127.0.0.1:3000   (an ordinary local connect)
```

The dev server needs no configuration and no rebinding to `0.0.0.0`. To it, every connection looks
like a client on its own loopback.

That is the only port in the picture, and it lives on your machine, bound to `127.0.0.1`. It is not
opened on the Mend host and not on any network interface. When the server is remote, the CLI stays
running to hold the port locally and bridges the bytes over the authenticated connection it already
has to the server; Ctrl-C closes the bridge, not the Service. There is nothing to expose, nothing to
firewall, and nothing ever touches the public internet.

A Service the agent or the web started needs no command of yours. While `mend attach` (or
`mend codex`, `mend rejoin`, the dashboard) is attached to a session on a remote server, every live
Service of that session declared `--http` or `--https` is tunneled the same way, on its own port
when that port is free here: `web → http://localhost:5173`. The tunnel closes when the Service stops
or when you detach. `--no-tunnel` turns this off. The web app, looking at a remote server, shows
`mend service connect <name>` where an Open link to the server's loopback would not load.

## Declaring

You can declare a Service from three places, and the result is the same:

- **A recipe in `mend.toml`.** The repository's own declaration: every session can start `web` by
  name, and the recipe travels with the code.
- **The CLI**, wrapping the command you already run in `mend service run`.
- **The agent itself.** Each workspace has a scoped-down `mend` on its PATH that can run, adopt,
  list, stop, and restart Services for its own session. When the agent starts a dev server, it can
  declare it properly instead of leaving a listener nobody can reach. It cannot open ports or change
  exposure; that authority stays on the server.

A Service can also adopt a port that something else already listens on inside the workspace.
Adoption makes it reachable without supervision: there is no Mend-owned process to restart and no
log beyond what started it.

## Writing `mend.toml`

Recipes live in a `mend.toml` at the repository root, one table per Service:

```toml
[setup]
run = ["pnpm install --frozen-lockfile"]
inputs = ["pnpm-lock.yaml"]

[service.web]
command = "pnpm dev --port 3000 --host 127.0.0.1"
port = 3000
browserScheme = "http"
cwd = "apps/web"
env = { NODE_ENV = "development" }
ready = { http = "/", timeout = "120s" }
depends = ["db"]

[service.db]
command = "docker compose up db"
port = 5432
address = "docker"

[service.cache]
# no command: adopt a listener something else starts (a compose sidecar, a daemon)
port = 6379

[service.game]
command = "node server.js"
port = 9000
protocol = "udp"

[preview]
service = "web"
```

The fields, and what Mend refuses in each:

- `port` is the only required field: where the process listens inside the workspace, 1–65535.
- `command` is the shell command Mend supervises. Leave it out for an adopt-only recipe: Mend binds
  the listener but supervises nothing.
- `protocol` is `"tcp"` unless you say `"udp"`.
- `browserScheme` (`"http"` or `"https"`) is what gives a Service its Open action. TCP alone never
  implies HTTP, and a UDP recipe cannot declare one.
- `cwd` is the directory the command runs in, relative to the repository root. An absolute path, a
  path with `..`, and one with a NUL byte are refused.
- `env` sets the recipe's own environment variables, strings only. `MEND_*` names and `PORT` are
  Mend's, and are refused.
- `ready` says when the Service is up. `{ http = "/health" }` waits for any HTTP answer for that
  path (a 403 counts), over TLS for an `https` Service, whose own certificate Mend takes without
  checking it. `{ timeout = "2m" }` changes how long to wait, from 1 second to 10 minutes, for an
  adopted port too. Without it, Mend waits up to a minute for the port to accept. An HTTP check is
  refused on UDP and on a recipe with no command. The same rule holds after the start: a port that
  only accepts connections never reads as up for an HTTP check.
- `host` is the `Host` your app sees on a preview's requests: `"rewrite"` (the default,
  `localhost:<port>`) or `"preserve"` (the preview's own host, for an app that builds its links from
  it, such as WordPress). It needs `browserScheme = "http"`.
- `address = "docker"` marks a port Docker publishes, as a compose service's. Mend dials it by port,
  never claiming its process, and its preview says `port-scoped`.
- `depends` names recipes of the same session to start first, in order. One already running is not
  started again, but Mend waits for it to answer its own `ready` first. The first that fails or
  never answers stops the start and says which, and the ones already started keep running. A name no
  recipe has, the recipe itself, and a cycle are refused. Shared services (`"@db"`,
  `{ shared = "db" }`, `{ resource = "db" }`) are not available yet, and say so.
- `[preview]` names the Service the worktree's preview shows. It must be a recipe with
  `browserScheme = "http"`.
- `[setup]` is what a start runs before anything else: `run` is a list of shell commands, run in
  order at the repository root as the person the Service runs as, and `inputs` lists files whose
  contents decide when to run them again. An empty `run`, a step that is not a string, and an input
  path that is absolute, has `..` or names the repository itself are refused.

## Setup

When a start runs any command, Mend runs `[setup]` first, then the dependencies, then the Service.
It runs setup again only when something it covers changed: a step, the contents of an input (an
input that appears or goes counts), or the workspace image. Otherwise the start says
`setup · unchanged since it last ran here` and goes on. `mend service <name> --setup` runs it
anyway, for example after `git clean -fdx` removed what it installed.

- **Where it is remembered.** Per worktree when Mend runs beside your files, which every session in
  that worktree shares, and per workspace in a captured workspace. Removing a worktree forgets it.
  One start at a time runs setup in one place: a second start waits for the first, then reads its
  inputs again and uses the first one's result if they still match.
- **What an input can be.** A file in the repository. One that links outside it, a directory, or
  anything else that is not a regular file refuses the start and says which. In a captured workspace
  Mend reads each input there as you, and keeps only its hash, never its contents.
- **How long a step may run.** Thirty minutes. A step that runs longer is stopped, and the start
  says so; the next start runs setup again.
- **When a step fails.** The start stops, and says the step, its exit code and the end of its
  output. Your next start runs setup again. A start Mend makes on its own, such as restarting
  Services after it replaces a workspace, does not: it says setup failed and asks for your start.
- **When it is refused.** A bad `[setup]` refuses no recipe: they all still list, your start goes on
  without setup and says so, and a start Mend makes on its own is refused.
- **Stopping it.** Stop the Service (`mend service stop <name>` works before the Service has
  started), or all of the session's Services, while setup runs: the running step and everything it
  started end, and the next start runs setup from the beginning.
- **A restored workspace.** A captured workspace that comes back as a new workspace runs setup at
  its first start, even if the capture already holds what setup made. Mend does not share setup's
  output across workspaces until restoring has been measured against installing.

Setup holds up no other Service's start or stop, however long it takes, and keeps its workspace
running while it does. `mend service <name> --wait` shows each step as it runs.

A start with dependencies can take a while, so Mend runs it to the end on its own: closing the
terminal, pressing Ctrl-C at the spinner, or an edge cutting the request does not stop it. A Stop of
one of its Services does. `mend service <name> --wait` follows it and names each dependency as it
starts and answers, for as long as `--timeout` allows.

Each started Service also gets `PORT` (its port) and, when its preview has an address,
`MEND_PREVIEW_URL`. For each recipe it `depends` on it gets `MEND_SERVICE_<NAME>_HOST` and
`MEND_SERVICE_<NAME>_PORT`, where that dependency answers inside the workspace, with the name
upper-cased and anything outside `A-Z0-9` turned into `_` (`db-main` gives
`MEND_SERVICE_DB_MAIN_HOST`). A Docker-published dependency gets the host Mend reaches it on. Two
dependencies that would give the same names refuse the recipe. A restart runs what the Service ran
before, with the same directory, environment and dependencies, even after `mend.toml` changed; a new
start reads the file again. Nothing in the file starts on its own.

A problem with one recipe refuses that recipe alone, naming the key, and the others still run.
`mend service <name>` tells you why a refused one does not. A key Mend does not know is ignored and
listed, never refused. These keys are read from Mend 0.37 on: an older server ignores them, runs the
command at the repository root, and does not say so.

The table name is the lookup key (`mend service web`): lowercase letters and digits plus `.`, `_`,
and `-`, up to 64 characters.

Mend reads the file from the session's worktree, not from the project's main branch. In a captured
workspace (the default store) the worktree lives only in the workspace, so Mend reads
`/workspace/repo/mend.toml` from the live workspace. A session with no live workspace lists only the
project's recipes, and `mend service <name>` asks you to resume it first. Two things follow. An
agent can add a recipe as part of its change, and the addition reviews like any other edit. And two
sessions on different branches can carry different recipes. A file that is not valid TOML is a named
error, never a guess; a missing file means no declared recipes. Recipes declared on the project in
the web app join the same set, and on a name collision the file wins, because it travels with the
code.

`mend service init` scaffolds the file from the package and Compose files it finds, and shows you
the result before writing it. A workspace package gets its own `cwd`, a known dev server gets
`browserScheme = "http"`, a Compose service gets `address = "docker"` (a UDP one stays on loopback),
and when exactly one Service opens in a browser it becomes the `[preview]`. A folder or Compose
service whose name is not a recipe name gets one (`My_App` becomes `my_app`). With a lockfile at the
root, it adds a `[setup]` that installs from it without changing it
(`pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile` or, on Yarn 2 and later,
`yarn install --immutable`, `bun install --frozen-lockfile` or `npm ci`), with the lockfile as its
input.

## Records and status

Every start is an attempt with a recorded log you can replay and then follow live.
`mend service list` prints each Service's id and its current attempt's process id, which
`mend logs --process` and `mend wait --process` take; `mend logs --service <name>` reads the current
attempt's log. Restarting adds another attempt under the same Service identity and endpoint, so
history accumulates instead of being replaced. Status words are observations: "reachable" means the
declared target answered when Mend checked, not a guarantee about the next request.

A live Service also keeps the session workspace retained after the agent settles, the same way a
detached shell does. Stopping the agent does not stop its Services. The session then reads, for
example, `agent stopped · 3 services keep the workspace up`, in the web app, the dashboard, and the
output of `mend stop`. Stop them when you are done, or let them hold the workspace deliberately:

- **Stop services** on the session page in the web app;
- `mend stop --services [session]` from the terminal;
- `⇧K` in the dashboard, on a row whose agent has stopped while its Services keep the workspace up.

Once nothing is live, the workspace closes.

## Commands

Every command is listed in the [CLI reference](/reference/cli/#service-commands):
`mend service run`, `add` (adopt a port something in the workspace already listens on), `list`,
`logs`, `restart`, `stop`, and `connect`, recipe scaffolding with `mend service init`,
`mend stop --services` for all of a session's Services at once, and the in-workspace helper's
smaller set.
