# The next channel

How prereleases of sealantd, Core and Mend are published, pinned, promoted and withdrawn. The design
and its reasons are in [ADR 0015](../adr/0015-next-channel.md); what someone trying a preview does
is on the docs site, [Try a preview](https://docs.mend.run/getting-started/try-a-preview/).

## Versions

A commit on main has one `next` version, `B-next.N`:

- **N** is every commit the commit contains (`git rev-list --count`). It grows with every commit and
  never restarts.
- **B** is the larger of what the pending changesets would release (the highest stable tag bumped by
  the largest pending changeset: patches only or none give `X.Y.(Z+1)`, any minor `X.(Y+1).0`; or
  the package's own version once the Version Packages pull request has merged and the tag has not)
  and the base of the highest next build already handed out above the last stable tag.

Neither part goes down, so each next build is higher than every one before it, whatever happens to
the changesets in between: a reverted minor, a Version Packages merge or revert, a minor landing
before a patch's tag.

```sh
node scripts/next-version.mjs --package apps/cli origin/main                                     # Mend
node scripts/next-version.mjs --package packages/runtime-client --npm @sealant/runtime-client-next origin/main  # sealantd
node tooling/scripts/next-version.mjs --package packages/sdk --npm @sealant/sdk-next origin/main      # Core
```

The builds already handed out are the repository's `vX.Y.Z-next.N` tags (Mend) and the package's
published next versions (`--npm`, Core and sealantd). The script refuses a shallow clone.

A preview build is `B-next.N.preview.R`: B and N of its branch's merge base with main, R the
workflow run. It sorts after that commit's `next` build and before the next commit's.

A patch release has its own next builds while only patch changesets are pending: after `v0.36.0`, a
fix is `0.36.1-next.N`, and a server on it can upgrade to `0.36.1`. Once a minor changeset lands,
later builds are `0.37.0-next.N`, and stay there even if the minor is reverted. A server on one of
those cannot take `0.36.1` (a downgrade) and waits for `0.37.0`. And once a `0.37.0-next.*` build
has been handed out, no next build of `0.36.1` can follow it, so the promotion rule cannot release
`0.36.1`: **after a reverted minor changeset, the next release is `0.37.0`** (add a minor changeset
to say so). For the same reason sealantd's and Core's Version Packages commit then publishes
`0.37.0-next.N`, and that is the build release step 1 means.

## What publishes when

| Repository | Trigger                                   | Publishes                                                                                                                              |
| ---------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| sealantd   | `ci` passes on a main commit (`next.yml`) | `ghcr.io/sealant-sh/sealantd-next:<version>`; `@sealant/runtime-protocol-next`, `@sealant/runtime-client-next` on npm `next`           |
| Core       | every merge to main (`next.yml`)          | `sealant-api-next`, `sealant-worker-next`, `sealant-ssh-gateway-next` `:<version>`; `@sealant/sdk-next`, `@sealant/api-contracts-next` |
| Mend       | a `vX.Y.Z-next.N` tag (`release-cli.yml`) | `mend`, `mend-api`, `mend-web` `:<version>`; a GitHub prerelease with the setup assets; `@sealant/mend` on `next`                      |

**Core's and sealantd's prereleases are separate packages and images.** The `next` trusted publisher
is registered only on the four `-next` npm packages, so even a fully compromised next job cannot
publish `@sealant/sdk` or move its `latest`; the worst it can do on npm is a bad prerelease of a
package nothing installs unpinned. **Images have no such boundary.** The next workflows push to the
`-next` image names, but the workflow token that does it (`packages: write`) can push the stable
images too; GHCR cannot scope it per image. Code-owner review does not change that: any of a
repository's writers can push a branch whose own workflow asks for `packages: write` and push from
there, without a pull request. What holds it down is narrower:

- Every action and the BuildKit and binfmt images in a job holding that token are pinned by digest.
- Mend's bundle image pins the three Core images by digest, and Core pins sealantd as
  `tag@sha256:…`. A digest pin keeps out only a tag moved **after** the pin: it trusts whatever the
  tag pointed at when someone pinned it.
- Everything else pulls by tag and is not covered: `deploy/aws` (`sealant-api:0.33.0`,
  `sealant-worker:0.33.0`), a self-hoster pulling `sealant-api:latest`, and **every Mend server**,
  which pulls `ghcr.io/sealant-sh/mend:<version>` by tag on setup and upgrade (ADR 0015, Known
  gaps).

Consumers reach a prerelease through an alias: Mend's catalog says
`"@sealant/sdk": npm:@sealant/sdk-next@0.39.0-next.N`, pinned exactly with the lockfile's integrity,
so code still imports `@sealant/sdk`. The prerelease packages depend on each other the same way
(`@sealant/sdk-next` depends on
`"@sealant/api-contracts": "npm:@sealant/api-contracts-next@<same version>"`).

In Core and sealantd:

- `plan` decides first, before any build: a version already published from this commit is done; a
  version not newer than npm's current `next` fails the run (a newer commit already published). A
  registry error, or a 404, fails the run after retries, never reads as "nothing published".
- `pack` renames the packages to their `-next` names, builds, packs, and checks that every path the
  package's `exports`, `main` and `types` name is in its tarball. It restores no pnpm store cache:
  other jobs, running unowned code, write that cache.
- `publish` holds the npm credential and runs no repository code and installs nothing. It refuses an
  artifact that holds anything but the expected tarballs (a `.npmrc` there would configure npm),
  runs every npm command from an empty directory, and does not publish the tarball it was given: it
  extracts it with npm's own copy of pacote, rewrites `package.json` from an allowlist (no `tag`, no
  `publishConfig` but `access`, no scripts; a root `binding.gyp`, which npm would turn into an
  install script, is refused), checks the `-next` name, the `-next.N` version and the commit on that
  rewritten manifest, repacks it, and publishes that with `--tag next`. It reads `next` again right
  before publishing, from the uncached dist-tags endpoint, so re-running an old failed job cannot
  move it back.

Mend's npm job is the same republish, after the owner's approval in `release`, for `@sealant/mend`.
`@sealant/mend` keeps its `next` dist-tag on its own name rather than a `@sealant/mend-next`
package: people install `npm install --global @sealant/mend@next`, `mend server setup` runs the
CLI's own version, and each Mend next build is tagged by an admin and approved by the owner, so the
stable package's credential is never in an unattended job.

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
GitHub prerelease, and npm after your approval in the `release` environment. The npm step checks
`next` again after the approval: if a newer next build was published in the meantime, it fails
rather than move `next` back.

Deploy it on the box with `deploy-box.yml` (`version` and the commit), or by hand with
`scripts/preview-deploy.sh <version> <commit>`.

A next tag counts as handed out the moment it exists: it raises B for every later build, and one off
main blocks the release of its version. **Delete a tag the pins job refused, or one pushed by
mistake,** before anything else (admins can):

```sh
git push origin --delete "v$version"
git tag --delete "v$version"
```

If its release already published to npm, leave the tag: the version is spent, and the tag records
it.

## Move the box onto the next channel, once

The box runs previews numbered `0.36.0-preview.K`, from before this channel. `preview` sorts after
`next`, so it refuses every `0.36.0-next.N` and every new-style preview `0.36.0-next.N.preview.R` as
a downgrade. The one-time path:

1. Merge the next-channel pull requests, cut the first Mend next build (above), approve it, and wait
   for `@sealant/mend@<version>` on npm.
2. On the box, as root, install that CLI, which carries `--from-preview`:

   ```sh
   npm install --global @sealant/mend@<version>
   ```

3. Upgrade, online (the setup assets come from that version's GitHub prerelease):

   ```sh
   mend server upgrade --version <version> --from-preview
   ```

   Before anything stops it reads both databases' applied migrations and compares them with the
   target image's `/app/migrations.txt`. It refuses, naming each one, when:
   - a Mend migration the box applied is not in the target (compared by id and name, as Effect
     stores them);
   - the target has a Mend migration with an id at or below the highest the box applied that the box
     never ran: Effect's migrator would skip it forever;
   - a Sealant migration the box applied is not in the target, or its SQL changed since (drizzle's
     hash).

   It cannot see a Mend migration whose code changed under the same id and name: Mend stores no hash
   of it. Before running this, check every preview the box ever ran. The server keeps one generation
   per install and upgrade under its configuration directory, each with its `serverVersion`; each
   preview image carries its commit in `org.opencontainers.image.revision`. On the box, as root,
   with a Mend checkout at `~/src/mend`:

   ```sh
   set -eu
   repo=~/src/mend
   config="${XDG_CONFIG_HOME:-$HOME/.config}/mend"
   command -v jq >/dev/null || { echo "CHECK BY HAND: jq is not installed"; exit 1; }
   ls "$config"/generations/*/server.json >/dev/null 2>&1 ||
     { echo "CHECK BY HAND: no generations under $config"; exit 1; }
   # Collected first: a failure inside a `for` list would not stop the script.
   versions=$(jq -r .serverVersion "$config"/generations/*/server.json | sort -u | grep -- '-preview\.' || true)
   [ -n "$versions" ] || { echo "CHECK BY HAND: no preview found in $config/generations"; exit 1; }
   git -C "$repo" fetch -q origin
   git -C "$repo" checkout -q --detach origin/main
   for version in $versions; do
     image="ghcr.io/sealant-sh/mend:$version"
     echo "== $version"
     # A pruned image is pulled again; one that cannot be read is checked by hand, never skipped.
     if ! docker image inspect "$image" >/dev/null 2>&1 && ! docker pull -q "$image" >/dev/null; then
       echo "CHECK BY HAND: $image can no longer be pulled"; continue
     fi
     rev=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
     if [ -z "$rev" ] || ! git -C "$repo" fetch -q origin "$rev"; then
       echo "CHECK BY HAND: no readable commit for $image (revision '${rev}')"; continue
     fi
     base=$(git -C "$repo" merge-base "$rev" origin/main)
     git -C "$repo" diff -U0 "$base" "$rev" -- packages/db/src/migrations.ts > /tmp/preview.diff
     if [ ! -s /tmp/preview.diff ]; then echo "no migration changes"; continue; fi
     # Main must carry the branch's migration change exactly. -U0 ignores what main appended after.
     if git -C "$repo" apply --check --reverse --unidiff-zero /tmp/preview.diff 2>/dev/null; then
       echo "main has these migration changes as the preview had them"
     else
       echo "CHECK BY HAND: the preview's migration changes differ from main's"; cat /tmp/preview.diff
     fi
   done
   ```

   Everything that is not a clean "no migration changes" or "main has these" says `CHECK BY HAND`:
   no `jq`, no generations (it reads `$XDG_CONFIG_HOME/mend`, or `~/.config/mend`), no preview in
   them, an image that can no longer be pulled, a missing label, an unfetchable commit, a change
   main does not carry exactly. Sealant's migrations need no such check: their hashes are compared.

4. If it refuses: the named migrations came from a branch the box ran that main does not have (or
   has in another form). Merge that branch, cut a next build that contains it, and repeat step 3;
   or, for a changed or skipped migration, restore the box from a backup taken before that preview.
   A failure before the target starts brings back the preview's own image.
5. After the move, `deploy-box.yml` and `scripts/preview-deploy.sh` work as usual for next builds
   and new-style previews.

## Pin a Core prerelease in Mend

When Core's `next.yml` has published `0.39.0-next.N` (the run's summary names it):

```sh
node scripts/sealant-pins.mjs pin 0.39.0-next.N
pnpm format:fix
```

It reads the three image digests from GHCR (`sealant-*-next` for a prerelease, the plain names for a
release), rewrites every file that names the Core version or a digest (the root `Dockerfile`, the
catalog, which becomes `npm:@sealant/sdk-next@0.39.0-next.N` and
`npm:@sealant/api-contracts-next@…`, `scripts/bundle-supervisor.mjs`, the setup assets and their
fixtures, `scripts/bundle-packaging.test.mjs`) and runs `pnpm install` for the lockfile. Open that
as its own pull request; the change that needs the new API stacks on it. Pinning a release
(`pin 0.39.0`) moves everything back to the plain names; a stable Mend release refuses while any
`npm:*-next` alias remains.

## Pin a sealantd prerelease in Core

With `node tooling/scripts/pin-sealantd.mjs <version>` in Core: it reads the image's digest from
GHCR, writes `ghcr.io/sealant-sh/sealantd-next:<version>@sha256:<digest>` (or
`ghcr.io/sealant-sh/sealantd:<version>@sha256:<digest>` for a release; never a tag alone) into
`packages/workspaces/src/buildkit/buildkit-builder.ts` and `apps/cf-bridge/Dockerfile`, sets the two
runtime packages in `packages/workspaces/package.json` to exact aliases
(`"@sealant/runtime-client": "npm:@sealant/runtime-client-next@<version>"`, the same for
`runtime-protocol`; plain exact versions for a release), and runs `pnpm install`. Core's release
refuses a sealantd image without its digest. Core trusts the recovery boot of
`ghcr.io/sealant-sh/sealantd-next:X.Y.Z-next.N` as it does a release's.

## Release

One order, for one Mend release with one release of each repository. Each step says what enforces
it; the rest is this checklist.

1. **sealantd: merge its Version Packages pull request.** sealantd main is frozen from here until
   its tag: no other merge. `next.yml` publishes `X.Y.Z-next.N` from that commit.
2. **Core: pin that sealantd build** with `node tooling/scripts/pin-sealantd.mjs X.Y.Z-next.N` (the
   image as `sealantd-next:X.Y.Z-next.N@sha256:…` and both runtime packages as exact aliases) and
   merge. Optionally pin the resulting Core build in Mend, cut a Mend next build and run it on the
   box.
3. **Tag sealantd `vX.Y.Z` on its Version Packages commit,** the one Core pinned. _Enforced:_ the
   release refuses a prerelease tag, and refuses while any next build of `X.Y.Z` came from a commit
   the tag does not contain, which is what a merge during the freeze produces. sealantd unfreezes.
4. **Core: pin sealantd `vX.Y.Z`** (`node tooling/scripts/pin-sealantd.mjs X.Y.Z`, which writes
   `sealantd:X.Y.Z@sha256:…`), **merge, then merge Core's Version Packages pull request.** Core main
   is frozen from here until its tag. `next.yml` publishes the Version Packages commit's build.
5. **Mend: pin that Core build, cut a Mend next build, run it on the box** (recommended: it proves
   Core's release code before the tag).
6. **Tag Core `vX'.Y'.Z'` on its Version Packages commit.** _Enforced:_ the release refuses a
   prerelease tag, a sealantd pin that is not a release with its digest (a prerelease, a tag without
   its digest, a bare digest, `latest`), a prerelease runtime package, and any next build of the
   version the tag does not contain (the freeze). Core unfreezes.
7. **Mend: pin Core `vX'.Y'.Z'`** (`node scripts/sealant-pins.mjs pin X'.Y'.Z'`), merge, **cut a
   Mend next build of the release's version, and run it on the box.** This is the proof that counts:
   the whole stable stack, exactly as it will ship.
8. **Mend: merge its Version Packages pull request and tag `vA.B.C` on it.** _Enforced by the pins
   job:_ the commit is on main; no prerelease is pinned; the CLI package carries the version; no
   next tag of `A.B.C` sits on a commit the release leaves out; the newest next build of `A.B.C` it
   contains reached npm; and since that build only `.changeset/`, `CHANGELOG.md` files, the CLI
   package's `version` line, the chart's `version`/`appVersion` lines (`appVersion` must be the
   release), `docs/`, `apps/docs/`, `apps/marketing/` and top-level Markdown changed, never a
   `package.json` (a move counts as a deletion and an addition). In effect Mend main is frozen from
   step 7 to the tag too.

If anything fails after a tag, the fix is a patch release through the same order.

## Withdraw a bad prerelease

With an npm login that has 2FA (the workflows cannot do this):

```sh
npm dist-tag add @sealant/mend@0.36.0-next.N1 next
npm deprecate @sealant/mend@0.36.0-next.N2 "Withdrawn: <reason>. Use 0.36.0-next.N3."
```

The `dist-tag add` is what moves `next` back; deprecating alone does not. The same for
`@sealant/sdk-next` and `@sealant/api-contracts-next` (Core) or the two runtime `-next` packages
(sealantd). Never unpublish. Leave the images; nothing floats, so nothing pulls them unasked. Edit a
withdrawn Mend prerelease's notes on GitHub to say which version replaces it; do not delete it. A
server already on the bad version moves forward only, to a fixed next build. A bad Core prerelease
pinned in Mend: revert the pin pull request. After moving `next` back by hand, the next merge
publishes as usual: it computes a version above the withdrawn one, which is above the version `next`
points at now.

## Once, before the first publish

npm lets a trusted publisher be added only to a package that exists, so each `-next` package is
created once, by hand, with your npm login and 2FA, from an empty directory:

```sh
cd "$(mktemp -d)"
for name in sdk api-contracts runtime-protocol runtime-client; do
  rm -f package.json
  npm init -y --scope=@sealant >/dev/null
  npm pkg set name="@sealant/$name-next" version=0.0.0-next.0 \
    description="Prereleases of @sealant/$name from main, for exact pins and @next only. Install @sealant/$name instead." \
    license=Apache-2.0
  npm publish --access public --tag next
done
```

npm sends only the `next` dist-tag (checked against a stub registry); whether the registry also
points `latest` at a package's first version was not tested, since that needs a real publish. Treat
`latest` on a `-next` package as meaningless: it may name the empty placeholder. Install a `-next`
package only by `@next` or by an exact version, as Mend's catalog alias does; never
`npm install @sealant/sdk-next` bare.

Then, on npmjs.com, for each of the four `-next` packages, **and only those**:

- `@sealant/sdk-next` and `@sealant/api-contracts-next`: trusted publisher, repository
  `sealant-sh/sealant`, workflow `next.yml`, environment `next`;
- `@sealant/runtime-protocol-next` and `@sealant/runtime-client-next`: repository
  `sealant-sh/sealantd`, workflow `next.yml`, environment `next`;
- **Require two-factor authentication and disallow tokens** on each.

Never add `next.yml` as a trusted publisher of a stable package (`@sealant/sdk`,
`@sealant/api-contracts`, `@sealant/runtime-*`, `@sealant/mend`). That boundary is what keeps a
compromised next job away from them.

In sealant-sh/sealant and sealant-sh/sealantd:

- Create the environment `next` before merging, with its deployment branch policy set to `main` only
  (a new environment allows every branch until you set it, and a job that names a missing
  environment creates it with no policy), and no required reviewer.
- On `main`: require a pull request with review from code owners. CODEOWNERS covers `.github/`, the
  release scripts, the Dockerfiles, the published packages' `package.json` files, the changesets
  config, the root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`,
  `.pnpmfile.mjs` (pnpm 11 loads it first), `.npmrc`, and in sealantd `Cargo.toml`/`Cargo.lock`.
- After the first next run pushes them, make the new image packages public, once:
  `sealant-api-next`, `sealant-worker-next`, `sealant-ssh-gateway-next` and `sealantd-next`
  (Settings → Danger Zone → Change visibility, at
  `https://github.com/orgs/sealant-sh/packages/container/<name>/settings`). **This cannot be
  undone:** GitHub does not let a public package become private again. Mend's pin check reads them
  anonymously, and Mend's image build pulls them.
- Mend's image build logs in to GHCR with Mend's own token before it pulls Core's images, and a
  logged-in token can be refused on a package not linked to its repository. Open the stable
  `sealant-api` package's settings: if **Manage Actions access** lists `sealant-sh/mend`, add
  `sealant-sh/mend` with the **Read** role to the three Core `-next` image packages too (and
  `sealant-sh/sealant` to `sealantd-next` if `sealantd` lists it). This could not be checked from
  here: reading package settings needs a token with `read:packages`.

In sealant-sh/mend, Mend's next builds use `release-cli.yml` and its `release` environment, already
registered as `@sealant/mend`'s trusted publisher. One setting is missing:

- Give the `release` environment a **deployment tag policy of `v*.*.*`**, as Core's and sealantd's
  `release` environments have. Today the approval is the only thing between a branch workflow that
  names `release` and an npm publish of `@sealant/mend`; with the policy, only a `v*.*.*` tag (which
  only admins can create) can deploy to it at all. Settings → Environments → `release` → Deployment
  branches and tags → Selected branches and tags → add a tag rule `v*.*.*`. It had no such policy
  when this was written (read from the environments API on 2026-10-05; Core's has the tag rule).

What that buys, exactly:

- **npm, with or without code-owner review:** the `next` publisher can publish only the four `-next`
  packages. Nothing in a next job, compromised or not, can publish a stable package or move its
  `latest`.
- **Images, with or without code-owner review:** any of a repository's writers can push a branch
  whose own workflow asks for `packages: write` and push any image the repository can write, stable
  ones included; review on `main` never sees it. Mend's bundle image pins the Core images by digest
  and Core pins sealantd by `tag@sha256:…`, which keeps out a tag moved after the pin. Whatever
  pulls by tag is not covered: `deploy/aws`, a self-hoster on Core's `latest`, and every Mend server
  (`ghcr.io/sealant-sh/mend:<version>`).
- **Inside the `-next` boundary, without code-owner review:** anyone who can merge to Core main can
  change `next.yml` and publish anything under the `-next` packages. Prereleases are only ever
  consumed pinned (Mend's catalog alias with lockfile integrity, Core's exact alias), so a bad one
  reaches nothing until someone pins it by hand.
- **With code-owner review:** those merges, and merges that change what configures installs, builds
  and packing, need a code owner's review. The republish keeps a compromised `pack` from changing
  the name, version, dist-tag, commit or sibling dependencies a prerelease publishes under. Every
  action in a job holding a write token is pinned to a commit, and no such job restores a cache
  other jobs write.
- **To close the image gap fully** (not done here): push stable images with a separate credential
  held in the `release` environment, and remove the repositories' Actions write access on the stable
  packages. For Mend servers, put the image digests in the CLI package, so the approval-gated npm
  publish fixes which image a server pulls (ADR 0015, Known gaps).
