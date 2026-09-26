---
title: Troubleshooting
description:
  Check a machine with mend doctor, collect a redacted debug bundle, read the server's state and
  logs, and recognise the failures Mend names.
sidebar:
  order: 4
---

Start with `mend doctor` on the machine where something looks wrong. It reads, it never repairs, and
every line that needs an action ends with the one command that takes it. When that is not enough,
`mend doctor --bundle` collects what a maintainer would otherwise ask for one output at a time.

## Check a machine

```sh
mend doctor
```

One line per fact, in the order a first run needs them:

```text
✓ server      https://mend.example.com · mend 0.33.0
✓ signed in   token accepted
✓ sealant     connected · http://127.0.0.1:4000
✓ claude      connected
○ codex       not connected → mend connect codex
✓ github      connected · octocat
○ grant       expired 2026-09-20 → mend connect claude
✓ projects    2 adopted
✓ claude cli  on PATH · credential present
○ codex cli   not on PATH
✓ gh cli      on PATH · credential present
✓ exposure    declared private · https origin · arrived via a trusted proxy · 5 gate items open → mend operator exposure
```

`✓` means observed working, `○` not set up yet, and `✗` that the workbench cannot run like this. Any
`✗` line makes the command exit with status 1. No request waits longer than three seconds; a line
whose check could not run says `not checked`.

| Line                                | What it reads                                                                                                                                                                            |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server`                            | The server's `/health`: its URL and version, or `cannot reach <url>`.                                                                                                                    |
| `signed in`                         | Whether the saved token is accepted: `token accepted`, or `no token saved` and `token rejected`, which point to `mend login`. Another answer prints the status `GET /projects` returned. |
| `sealant`                           | Whether the server reaches the platform: `connected`, or `unauthorized`, `unreachable` or `mismatched` with the platform's message.                                                      |
| `claude`, `codex`, `github`         | Your connected accounts on the platform: `connected` with the account's login or email, `not connected`, or the account's status.                                                        |
| `grant`                             | Mend's own Claude grant on this machine. Printed only when Mend keeps one (see below).                                                                                                   |
| `projects`                          | How many projects you have adopted, or `none adopted → mend adopt`.                                                                                                                      |
| `claude cli`, `codex cli`, `gh cli` | Whether each tool is on this machine's `PATH`, and whether it holds a credential here to forward.                                                                                        |
| `exposure`                          | How the instance is reached, as declared and as observed. See [Exposure and the public gate](/operate/exposure/).                                                                        |

### The Claude grant line

`mend connect claude` gives Mend a Claude login of its own, kept in a directory Mend owns, so your
own Claude login is not signed out when Mend refreshes. The `grant` line reads that copy on this
machine:

| Line                                           | Meaning                                               |
| ---------------------------------------------- | ----------------------------------------------------- |
| `✓ grant Mend's own · expires <date>`          | The grant holds a refresh token that has not expired. |
| `○ grant expired <date> → mend connect claude` | The refresh token's expiry has passed.                |
| `✗ grant signed out → mend connect claude`     | The grant holds no refresh token.                     |
| `✗ grant unreadable → mend connect claude`     | The stored grant could not be parsed.                 |

The line is missing when you connected with `--use-my-login` or `--from-stdin`: Mend then keeps no
grant of its own. It reads the machine that connected the grant, because the platform does not yet
report a grant's freshness over the API. The web app says nothing about it, and a launch does not
refuse a session whose grant has expired.

Running `mend connect claude` again with an expired or signed-out grant prints
`Mend's Claude grant is expired <date>; logging in again` (or `signed out`) and logs in once more.

## Collect a debug bundle

```sh
mend doctor --bundle
mend doctor --bundle --out ./mend-bundle.tgz --tail 1000
```

`--bundle` writes one `tar.gz` instead of printing the checklist. `--out` picks the path (default
`~/.config/mend/bundles/mend-bundle-<time>.tgz`), and `--tail` sets how many lines to keep per
container log and per recorded process, from 1 to 2000 (default 500). The command prints the path,
each file with its size, and
`Contains logs and configuration; secrets are redacted, but read it before sharing.`

What goes in:

- `cli.json`: this CLI's version, Node and the operating system, the terminal and shell, the
  configured server and device, whether a token is saved (not the token), and the names of the
  `MEND_` variables in its environment.
- `doctor.txt`: the `mend doctor` lines.
- `server-health.json`: the server's `/health` answer.
- The local server's configuration: its compose file and the names of its `.env` keys, never their
  values.
- `docker.txt`: `docker version`, `docker info`, the contexts, and the Mend and workspace containers
  with their inspect facts (their environment as names only).
- The local server's container logs, and `workspace-logs.txt` for the running workspace containers.
- `sessions.json`: every session with its processes, exit codes and argv, and the recorded terminal
  output of each.
- `accounts.txt`: your connected accounts.
- `tools.txt`: the versions and paths of `claude`, `codex`, `gh`, `git` and `docker` on this
  machine.

Each part is collected on its own. One that fails leaves a `<name>.error.txt` saying why, and the
bundle is still written. On a client with no local server, the server parts fail with
`no Mend server is installed on this machine (mend server setup installs one)`.

One redactor runs over every file before it is written. It replaces:

- `Authorization`, `Proxy-Authorization`, `X-Api-Key`, `Cookie` and `Set-Cookie` values, and
  `Bearer` tokens;
- Slack (`xox…`, `xapp-…`), OpenAI (`sk-…`), GitHub (`ghp_…`, `github_pat_…` and the rest) and AWS
  access key shapes, and JWTs;
- passwords in URLs;
- the value of any key whose name contains `password`, `secret`, `token`, `api_key`, `private_key`
  or `credential`;
- the value of every `NAME=value` line.

The archive is created with mode 0600. It still contains logs and configuration. Read it before you
attach it to an issue.

## Read the server

On the machine that runs a Docker install:

```sh
mend server status
mend server logs --tail 200
```

`mend server status` prints the pinned version and URL, the active generation, and
`docker compose ps` for Mend, Postgres and Garage. When the Mend container is running, it asks
`/api/health` and expects the exact pinned version:

| Output                                                                                                     | Meaning                                                                     |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `Mend 0.33.0 is reachable at http://localhost:3105`                                                        | Health answered `ok` with the pinned version.                               |
| `Mend is stopped. No health claim was made.`                                                               | The Mend container is not running.                                          |
| `Mend is running but exact-version health for 0.33.0 was not observed. Check mend server logs --tail 100.` | The container runs, and health did not answer, or answered another version. |
| `No Mend server is configured. Run mend server setup explicitly to install one.`                           | This machine has no installation.                                           |

`mend server logs` prints the last lines of every container in the installation, 1 to 1000 per
service (default 100). It has no follow mode. The Mend container supervises the Mend API and web
tier and the pinned Sealant API, worker and SSH gateway, so all of their start-up lines and refusals
are there.

A second server command while one runs reports
`Server is busy: <dir> is locked (<owner>). Wait for the owning command. Never remove a live lock.`
followed by the recovery steps for a stale lock.

On Kubernetes, read the API Pod's log with `kubectl logs`; `mend server` commands manage only the
Docker install.

## Failures Mend names

### Git in bridge mode: no signer

When your git access mode is `bridge`, the server's git operations sign with the ssh-agent of a
machine running a `mend` command. With nobody sharing, an operation that needs your key fails fast:

```text
no signer connected — run `mend keys share` on the machine that holds your key
```

Run any attaching `mend` command or the dashboard on the machine that holds the key (they share the
agent while they run), or run `mend keys share` there. `mend keys mode` shows the current state:
`signer connected · <machine>`, or
`no signer connected — mend shares the agent whenever it runs (or: mend keys share)`. The server
takes one signer at a time. See [Git access](/guides/git-access/).

A session whose git transport is bound to its project's remote (the default) refuses to sign for
another host:

```text
this session's Git access is bound to github.com; pushes and fetches to gitlab.com run without Mend's signer
```

### The database runs out of connections

Mend opens three connection pools to its database, plus one connection for `LISTEN`:

| Pool                           | Variable                      | Default |
| ------------------------------ | ----------------------------- | ------- |
| Mend's queries                 | `MEND_DATABASE_POOL_MAX`      | 6       |
| The job queue (pg-boss)        | `MEND_JOBS_POOL_MAX`          | 3       |
| Sign-in sessions (Better Auth) | `MEND_AUTH_DATABASE_POOL_MAX` | 3       |

At full load that is 13 connections. Sealant's API and worker open their own pools to their
database. When both databases live on one Postgres server, both sets of caps must fit under its
`max_connections`, less the connections reserved for superusers. When they do not, Postgres refuses
connections with `remaining connection slots are reserved`, the requests and jobs that asked for
them fail, and Mend logs `jobs: pg-boss error` or `auth: database pool error` with that message. The
API keeps running and retries; it does not exit. Lower the caps, or raise the server's
`max_connections`.

### The server refuses to start

Some settings are checked before anything serves, and a contradiction stops the API with a sentence
that names it. These appear in `mend server logs` (or the API Pod's log):

- `MEND_EXPOSURE=public is refused: the public exposure gate …` followed by each open item and its
  fix. See [Exposure and the public gate](/operate/exposure/).
- `MEND_EXPOSURE_DECLARED names <item>: only core-private and edge-tls can be declared; …`
- `MEND_TENANCY=multi is refused: the multi mode gate … is not complete.` followed by each open
  item; `mend operator gate` lists the same items.
- `MEND_TENANCY=single is refused: <n> organizations exist on this instance.`
- `MEND_EXECUTOR_NETWORK must be "private" or unset, got "<value>".`
- `MEND_SESSION_ENDPOINT_URL (the address workspaces use to reach the session channel) must be set with MEND_SESSION_ENDPOINT_LISTEN.`
- `MEND_BLOB_STORE must be dir:// or s3://, got "<value>".` and
  `MEND_BLOB_STORE s3:// needs a bucket.`

A server started with `MEND_SESSION_STORE=colocated` still starts, and logs that the co-located
store is deprecated and to unset the variable.

### A request is refused by a budget

A refused request names the budget and its limit, for example
`budget reached · 4 launches starting at once for one account · nothing running was stopped`. It
answers 429 (413 for a body) with `Retry-After` for a request window. Nothing running is stopped.
Wait for the window, settle sessions you no longer need, or raise the budget. See
[Budgets](/operate/exposure/#budgets).

### A socket will not open through a proxy

When a proxy between the CLI and Mend refuses `POST /api/upgrade-tickets`, the CLI does not fall
back to putting its token in a URL:

```text
POST /api/upgrade-tickets answered 404, but this server mints upgrade tickets: something between this client and Mend is refusing it. The saved token was not put in a URL.
```

Let the proxy forward every `/api` path to Mend's web tier. A server with `MEND_URL_BEARERS=refuse`
answers an older client that sends `?token=` with
`a bearer in the URL is refused; mint an upgrade ticket (POST /api/upgrade-tickets)`: update that
client.
