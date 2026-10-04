# The next channel

How prereleases of sealantd, Core and Mend are published, pinned, promoted and withdrawn. The design
and its reasons are in [ADR 0015](../adr/0015-next-channel.md); what someone trying a preview does
is on the docs site, [Try a preview](https://docs.mend.run/getting-started/try-a-preview/).

## Versions

A commit on main has one `next` version, `B-next.N`. B is what the next Version Packages pull
request would release from that commit: the highest stable tag `vX.Y.Z` bumped by the largest
pending changeset of the released package (patches only: `X.Y.(Z+1)`; any minor: `X.(Y+1).0`; none:
`X.Y.(Z+1)`), or the package's own version once the Version Packages pull request has merged and the
tag has not. N counts the commits since `vX.Y.Z`. Each later commit on main gets a higher version:
pending changesets only accumulate until the Version Packages pull request, which replaces them with
the version they produce.

```sh
node scripts/next-version.mjs --package apps/cli origin/main                     # Mend
node scripts/next-version.mjs --package packages/runtime-client origin/main      # sealantd
node tooling/scripts/next-version.mjs --package packages/sdk origin/main         # Core
```

It refuses a shallow clone, where N would come out too small.

A preview build is `B-next.N.preview.R`: B and N of its branch's merge base with main, R the
workflow run. It sorts after that commit's `next` build and before the next commit's.

A patch release has its own next builds: after `v0.36.0`, a fix with a patch changeset is
`0.36.1-next.N`, so the box proves the patch as the version it will be released as, and a server on
it can upgrade to `0.36.1`. A minor changeset on main moves later builds to `0.37.0-next.M`; a
server on one of those cannot take `0.36.1` (that would be a downgrade) and waits for `0.37.0` or
later.

## What publishes when

| Repository | Trigger                                   | Publishes                                                                                                               |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| sealantd   | `ci` passes on a main commit (`next.yml`) | `ghcr.io/sealant-sh/sealantd:<version>`; `@sealant/runtime-protocol`, `@sealant/runtime-client` on npm `next`           |
| Core       | every merge to main (`next.yml`)          | `sealant-api`, `sealant-worker`, `sealant-ssh-gateway` `:<version>`; `@sealant/sdk`, `@sealant/api-contracts` on `next` |
| Mend       | a `vX.Y.Z-next.N` tag (`release-cli.yml`) | `mend`, `mend-api`, `mend-web` `:<version>`; a GitHub prerelease with the setup assets; `@sealant/mend` on `next`       |

`latest`, on npm and on GHCR, moves only from a stable `vX.Y.Z` tag. In Core and sealantd the npm
credential is held only by a publish job that runs no repository code: it takes the packed tarballs,
checks each is a `-next.N` version newer than the current `next`, and runs `npm publish --tag next`.
`next` only moves forward: an older commit re-run after a newer one published is skipped.

## Cut a Mend next build

On an up-to-date, full (not shallow) checkout, as an admin (only admins create `v*` tags):

```sh
git fetch origin main --tags
version=$(node scripts/next-version.mjs --package apps/cli origin/main)
git tag "v$version" origin/main
git push origin "v$version"
```

The release workflow checks the tag first (`scripts/check-release-pins.mjs`): it must be the version
that commit computes, the commit must be on main, no higher next tag may exist, the Core pins must
agree with each other, with GHCR and with the setup assets. Then images, packaged acceptance, the
GitHub prerelease, and npm after your approval in the `release` environment.

Deploy it on the box with `deploy-box.yml` (`version` and the commit), or by hand with
`scripts/preview-deploy.sh <version> <commit>`.

## Move the box onto the next channel, once

The box ran previews numbered `0.36.0-preview.K` before this channel. `preview` sorts after `next`,
so a plain upgrade to `0.36.0-next.N` is refused. On the box:

```sh
mend server upgrade --version 0.36.0-next.N --from-preview
```

Before anything stops, it reads the migrations Mend's and Sealant's databases applied and compares
them with the target image's `/app/migrations.txt`. If the target lacks one (a preview that ran an
unmerged branch's migration), it refuses and names it: choose a next build that contains it. A
failure before the target starts recovers the preview's own image. After the move, upgrades follow
the next channel as usual. `scripts/preview-deploy.sh` does not pass the flag; run this by hand.

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
   refuses to start while a prerelease sealantd is pinned (by tag or by digest), or while an npm
   prerelease of `X.Y.Z` was built from a commit the tag does not contain.
3. Mend pins that stable Core, cuts one more next build of `X.Y.Z`, and runs it on the box.
4. Mend merges its Version Packages pull request and tags `vX.Y.Z`. The release refuses:
   - a prerelease pin, a CLI package that does not carry the version, a commit not on main;
   - a next tag of `X.Y.Z` on a commit the release does not contain (a server on it would lose that
     work by "upgrading");
   - no next build of `X.Y.Z` it contains, or one that never reached npm;
   - any change since that build other than `.changeset/`, `CHANGELOG.md` files, the CLI package's
     `version` line, the chart's `version`/`appVersion` lines (`appVersion` must be the release),
     `docs/`, `apps/docs/`, `apps/marketing/` and top-level Markdown, never a `package.json` among
     them. A move counts as a deletion and an addition.

   If anything else merged in between, cut a new next build of main, prove it, and tag again.

Tag Core and sealantd right after their Version Packages merge: every merge after it publishes
another `X.Y.Z-next.N`, and the release refuses once one exists that the tag would not contain.

## Withdraw a bad prerelease

With an npm login that has 2FA (the workflows cannot do this):

```sh
npm dist-tag add @sealant/mend@0.36.0-next.60 next
npm deprecate @sealant/mend@0.36.0-next.61 "Withdrawn: <reason>. Use 0.36.0-next.62."
```

The `dist-tag add` is what moves `next` back; deprecating alone does not. The same for
`@sealant/sdk` and `@sealant/api-contracts` (Core) or the two runtime packages (sealantd). Never
unpublish. Leave the images; nothing floats, so nothing pulls them unasked. Edit a withdrawn Mend
prerelease's notes on GitHub to say which version replaces it; do not delete it. A server already on
the bad version moves forward only, to a fixed next build. A bad Core prerelease pinned in Mend:
revert the pin pull request.

## Once, before the first publish

- In sealant-sh/sealant and sealant-sh/sealantd: an environment `next` whose deployment branch
  policy is `main` only (a new environment allows every branch until you set it), with no required
  reviewer.
- On npmjs.com, for `@sealant/sdk` and `@sealant/api-contracts` (repository sealant-sh/sealant) and
  `@sealant/runtime-protocol` and `@sealant/runtime-client` (sealant-sh/sealantd): a second trusted
  publisher, workflow `next.yml`, environment `next`.
- On `main` in both repositories: require a pull request with review from code owners. `.github/`
  and the release scripts are owned by the owner (CODEOWNERS); without the rule, anyone who can
  merge could change `next.yml` and publish under any dist-tag.
- Nothing for Mend: its next builds use `release-cli.yml` and `release`, already registered.
