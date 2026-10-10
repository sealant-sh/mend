---
title: npm mirror
description:
  The read-through cache of registry.npmjs.org beside the Mend server, which each session's
  dependency install goes through.
sidebar:
  order: 4
---

When [automatic install](/guides/project-environment/#automatic-install) is on and a session's
worktree has no dependency tree for its platform yet, Mend installs the dependencies before the
agent starts. Without a mirror that means downloading every tarball from registry.npmjs.org, each
time: about 2,000 for Mend's own repository. The npm mirror keeps the tarballs it fetched and serves
them again from the server's disk, so a second install on the same lockfile downloads no tarball
from the internet. Package metadata, when an install asks for it, is revalidated upstream after five
minutes, and `npm audit` requests (`npm ci` and `npm install` send one) pass through to the registry
uncached.

The mirror is nginx's `proxy_cache` in front of the public registry. It caches `GET` and `HEAD`,
passes audit `POST`s through, sends no credential upstream, and serves a copy it already holds while
the registry fails. It never decides what is installed. The package manager checks every tarball
against its lockfile's integrity hash, as it does from the registry itself, and the mirror never
rewrites the tarball URLs in package metadata. A lockfile written through it names
registry.npmjs.org, the same as one written without it.

## On the Docker install

`mend server setup` runs it as the `npm-mirror` service, on by default, and `mend server upgrade`
adds it to an install from before it. The service publishes no host port. Sessions reach it at
`http://npm-mirror:4873/` on the Compose network, and Mend receives that address as
`MEND_NPM_MIRROR_URL`.

```sh
mend server setup --npm-mirror-max-size 20g   # change the cap (default 10g)
mend server setup --no-npm-mirror             # turn it off; the next setup keeps it off
mend server setup --npm-mirror                # turn it on again
```

Its cache lives in the volume `mend_mend-npm-mirror` and is capped at `--npm-mirror-max-size`. When
the cap is reached, or less than 5 GiB is free on the disk it lives on, nginx removes the tarballs
used least recently. Metadata is fresh for five minutes and then revalidated; it is cached by the
whole request, query included, so a search for one package never answers another. Turning the mirror
off removes its container; the volume stays until you remove it, and setup prints the command.

`mend server status` reports what it observed:

```
npm mirror · running · 743 MiB cached of 10 GiB · 412 GiB free on its disk · last 24 h: 4010 tarball requests · 2006 served from the cache (50%) · 2004 fetched from registry.npmjs.org · observed
```

The traffic counts come from the mirror's own log of the last 24 hours, one line per request. Its
log is capped at five files of 20 MB.

## What goes through it

Mend's dependency install (see [Automatic install](/guides/project-environment/#automatic-install))
adds `--registry=http://npm-mirror:4873/` to a plain `pnpm install`, `npm ci` or `npm install`, when
all of these hold:

- Nobody set a registry. A `registry` in the command, the repository's `.npmrc` or
  `pnpm-workspace.yaml`, your user config, pnpm's config, the image's global `npmrc`, or
  `npm_config_registry` in the environment wins. That includes a line that names registry.npmjs.org
  explicitly.
- Nobody set a login for registry.npmjs.org: `//registry.npmjs.org/:_authToken`, an unscoped
  `_auth`, `_authToken`, `_password`, `username` or `always-auth`, or `npm_config__auth*`. Packages
  behind such a login are private, and the mirror never forwards a credential, so the install stays
  on the registry.
- The command passes no flag that could choose its own configuration. The mirror is offered only
  when every flag is one that changes neither where the package manager reads its configuration nor
  where it fetches from: `--frozen-lockfile`, `--prefer-offline`, `--ignore-scripts`, `--prod`,
  `--no-audit`, `--reporter=…`, `--fetch-timeout=…` and the like. `--userconfig`, `--globalconfig`,
  `--prefix`, `--dir`, `--config.…` or any flag not on that list leave the command as written.
- The mirror answers `/-/ping` within three seconds.

Scoped registries are left alone. With `@corp:registry=https://npm.corp.example/` in `.npmrc`, the
`@corp` packages and their login go to that registry, and everything else goes through the mirror.

Yarn, Bun and any other command run as written. So do installs the agent runs during the session:
the mirror is offered to Mend's own install only.

## When the mirror is down

The install falls back to the registry in two ways:

- When the mirror does not answer its ping, the install runs without it.
- When an install through the mirror fails, for any reason, Mend runs the command once more exactly
  as written, against the registry. That covers a mirror that broke part-way and one that served
  bytes the lockfile's integrity refuses (npm's `EINTEGRITY`). It is the only rerun: a project's own
  failure therefore runs twice, and the outcome is the second run's.

The install script states its choice in one line of its output, `mend: npm mirror · used`,
`mend: npm mirror · not used · a registry is set`,
`… the command passes --userconfig=…, which may choose its own config`, or `… did not answer`. The
server log line for the install carries `npmMirror: used | not used | fell back | off`. A fallback
is also logged on its own line, `dependency install · retried without the npm mirror`.

## On Kubernetes

The chart runs it as an optional component:

```yaml
mirrors:
  npm:
    enabled: true
    maxSize: 10g # nginx's cap
    storage: 12Gi # the claim, a little larger
```

It renders a Deployment (one replica, `nginxinc/nginx-unprivileged`, uid 101), a ReadWriteOnce
claim, a ClusterIP Service and a NetworkPolicy that admits workspace Pods only. The API tier
receives `MEND_NPM_MIRROR_URL` and hands it to the install a workspace runs; it never connects to
the mirror. The Sealant chart's workspace egress policy must allow port 4873 to it; the chart's
notes print the entry.

## Exposure

The mirror publishes no port. Like Sealant and the database, it sits on the deployment's own
network, and the public exposure gate's `core-private` item names it when sessions are pointed at it
(see [Exposure](/operate/exposure/)).
