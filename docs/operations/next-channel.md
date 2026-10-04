# The next channel

How prereleases of sealantd, Core and Mend are published, pinned, promoted and withdrawn. The design
and its reasons are in [ADR 0015](../adr/0015-next-channel.md); what someone trying a preview does
is on the docs site, [Try a preview](https://docs.mend.run/getting-started/try-a-preview/).

## Versions

A commit on main has one `next` version: `X.(Y+1).0-next.N`, where `vX.Y.Z` is the highest stable
tag the commit contains and N counts the commits since that minor's first release (`vX.Y.0`).

```sh
node scripts/next-version.mjs origin/main          # Mend, sealantd
node tooling/scripts/next-version.mjs origin/main  # Core
```

A preview build is `X.(Y+1).0-next.N.preview.R`: N of its branch's merge base with main, R the
workflow run. It sorts after that commit's `next` build and before the next commit's.

## What publishes when

| Repository | Trigger                                   | Publishes                                                                                                               |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| sealantd   | `ci` passes on a main commit (`next.yml`) | `ghcr.io/sealant-sh/sealantd:<version>`; `@sealant/runtime-protocol`, `@sealant/runtime-client` on npm `next`           |
| Core       | every merge to main (`next.yml`)          | `sealant-api`, `sealant-worker`, `sealant-ssh-gateway` `:<version>`; `@sealant/sdk`, `@sealant/api-contracts` on `next` |
| Mend       | a `vX.Y.Z-next.N` tag (`release-cli.yml`) | `mend`, `mend-api`, `mend-web` `:<version>`; a GitHub prerelease with the setup assets; `@sealant/mend` on `next`       |

`latest`, on npm and on GHCR, moves only from a stable `vX.Y.Z` tag.

## Cut a Mend next build

On an up-to-date checkout, as an admin (only admins create `v*` tags):

```sh
git fetch origin main --tags
version=$(node scripts/next-version.mjs origin/main)
git tag "v$version" origin/main
git push origin "v$version"
```

The release workflow checks the tag first (`scripts/check-release-pins.mjs`): it must be the version
that commit computes, the commit must be on main, and the Core pins must agree with each other and
with GHCR. Then images, packaged acceptance, the GitHub prerelease, and npm after your approval in
the `release` environment.

Deploy it on the box with `deploy-box.yml` (`version` and the commit), or by hand with
`scripts/preview-deploy.sh <version> <commit>`.

## Pin a Core prerelease in Mend

When Core's `next.yml` has published `0.39.0-next.12` (the run's summary names it):

```sh
node scripts/sealant-pins.mjs pin 0.39.0-next.12
pnpm format:fix
```

It reads the three image digests from GHCR, rewrites every file that names the Core version or a
digest (the root `Dockerfile`, the catalog, `scripts/bundle-supervisor.mjs`, the setup assets and
their fixtures, `scripts/bundle-packaging.test.mjs`) and runs `pnpm install` for the lockfile. Open
that as its own pull request; the change that needs the new API stacks on it.

## Pin a sealantd prerelease in Core

By hand, in one pull request: the image tag in
`packages/workspaces/src/buildkit/buildkit-builder.ts` and `apps/cf-bridge/Dockerfile`, the exact
`@sealant/runtime-*` versions in `packages/workspaces/package.json`, then `pnpm install`. Core
trusts the recovery boot of `ghcr.io/sealant-sh/sealantd:0.20.0-next.N` as it does a release's.

## Release

A stable release promotes what the box already ran:

1. sealantd tags `vX.Y.Z` on the commit Core pins.
2. Core pins that stable sealantd, merges its Version Packages pull request, and tags. Its release
   refuses to start while a prerelease sealantd is pinned.
3. Mend pins that stable Core, cuts one more next build, and runs it on the box.
4. Mend merges its Version Packages pull request and tags `vX.Y.Z`. The release refuses a prerelease
   pin, a CLI package that does not carry the version, and any change since the newest next tag
   other than `.changeset/`, `CHANGELOG.md` files, the CLI package's `version` line,
   `deploy/helm/mend/Chart.yaml`, `docs/`, `apps/docs/`, `apps/marketing/` and top-level Markdown.
   If anything else merged in between, cut a new next build of main, prove it, and tag again.

## Withdraw a bad prerelease

With an npm login that has 2FA (the workflows cannot do this):

```sh
npm dist-tag add @sealant/mend@0.36.0-next.60 next
npm deprecate @sealant/mend@0.36.0-next.61 "Withdrawn: <reason>. Use 0.36.0-next.62."
```

The same for `@sealant/sdk` and `@sealant/api-contracts` (Core) or the two runtime packages
(sealantd). Never unpublish. Leave the images; nothing floats, so nothing pulls them unasked. Edit a
withdrawn Mend prerelease's notes on GitHub to say which version replaces it; do not delete it. A
server already on the bad version moves forward only, to a fixed next build. A bad Core prerelease
pinned in Mend: revert the pin pull request.

## Once, before the first publish

- In sealant-sh/sealant and sealant-sh/sealantd: an environment `next`, deployable from `main` only,
  no required reviewer.
- On npmjs.com, for `@sealant/sdk` and `@sealant/api-contracts` (repository sealant-sh/sealant) and
  `@sealant/runtime-protocol` and `@sealant/runtime-client` (sealant-sh/sealantd): a second trusted
  publisher, workflow `next.yml`, environment `next`.
- Nothing for Mend: its next builds use `release-cli.yml` and `release`, already registered.
