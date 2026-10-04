---
title: Try a preview
description: Install a next build of Mend before its release, and move to the release when it ships.
sidebar:
  order: 3
---

A preview is a `next` build: Mend from `main`, published before the release it leads to. Its version
reads like `0.36.0-next.56`. It passed the same packaged acceptance as a release; it has not been
used for long, and it can change before the release.

## Before you install

- **A server moves forward only.** `mend server upgrade` refuses a lower version, because database
  migrations do not run backwards. A server on `0.36.0-next.56` can take a later next build or
  `0.36.0`, never `0.35.1` or `0.36.0-next.50`.
- **Use a server you can rebuild,** or back up its Docker volumes first. The upgrade's SQL dump does
  not cover repositories, session captures or SSH identity.
- **Everything else is the same.** A preview server is set up, operated and upgraded with the
  commands in [Install Mend](/getting-started/install/).

## Install a preview

```sh
npm install --global @sealant/mend@next
mend version
```

`mend version` prints the version npm installed. Then, on the server machine:

```sh
mend server setup
```

Setup installs the server at the CLI's version: `ghcr.io/sealant-sh/mend:<version>` and the setup
assets of the GitHub prerelease `v<version>`. The image carries the Sealant runtime that version
pins, which may itself be a prerelease.

Clients on other devices install the same CLI with the same `npm install` line. When a client and
its server differ, `mend version` says `versions differ — the server's API wins`; keep them on the
same version.

## Move to a later preview

```sh
npm install --global @sealant/mend@next
mend server upgrade --version "$(npm view @sealant/mend@next version)"
```

The upgrade backs up the databases, stops Mend's writers and starts the new version, as it does for
a release.

## Move to the release

When the release ships:

```sh
npm install --global @sealant/mend@latest
mend server upgrade --version latest
```

`--version latest` resolves the newest release, never a preview, and the release is higher than
every preview of it. After that the server follows releases until you install `@next` again.

## If a preview is withdrawn

A preview found broken after publishing is deprecated on npm, and `npm install @sealant/mend@next`
goes back to the previous one. A server already on the withdrawn version cannot go back: upgrade to
the next preview that replaces it. Its GitHub prerelease says which one.

## Report what you find

`mend doctor --bundle` writes one redacted diagnostic archive. Attach it to an issue at
[github.com/sealant-sh/mend](https://github.com/sealant-sh/mend/issues) with the version from
`mend version`. Read [Troubleshooting](/operate/troubleshooting/).
