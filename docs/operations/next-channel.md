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
node scripts/next-version.mjs --package packages/runtime-client --npm @sealant/runtime-client origin/main  # sealantd
node tooling/scripts/next-version.mjs --package packages/sdk --npm @sealant/sdk origin/main      # Core
```

The builds already handed out are the repository's `vX.Y.Z-next.N` tags (Mend) and the package's
published next versions (`--npm`, Core and sealantd). The script refuses a shallow clone.

A preview build is `B-next.N.preview.R`: B and N of its branch's merge base with main, R the
workflow run. It sorts after that commit's `next` build and before the next commit's.

A patch release has its own next builds while only patch changesets are pending: after `v0.36.0`, a
fix is `0.36.1-next.N`, and a server on it can upgrade to `0.36.1`. Once a minor changeset lands,
later builds are `0.37.0-next.N` (and stay there, even if the minor is reverted); a server on one of
those cannot take `0.36.1` (a downgrade) and waits for `0.37.0`.

## What publishes when

| Repository | Trigger                                   | Publishes                                                                                                               |
| ---------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| sealantd   | `ci` passes on a main commit (`next.yml`) | `ghcr.io/sealant-sh/sealantd:<version>`; `@sealant/runtime-protocol`, `@sealant/runtime-client` on npm `next`           |
| Core       | every merge to main (`next.yml`)          | `sealant-api`, `sealant-worker`, `sealant-ssh-gateway` `:<version>`; `@sealant/sdk`, `@sealant/api-contracts` on `next` |
| Mend       | a `vX.Y.Z-next.N` tag (`release-cli.yml`) | `mend`, `mend-api`, `mend-web` `:<version>`; a GitHub prerelease with the setup assets; `@sealant/mend` on `next`       |

`latest`, on npm and on GHCR, moves only from a stable `vX.Y.Z` tag. In Core and sealantd:

- `plan` decides first, before any build: a version already published from this commit is done; a
  version not newer than npm's current `next` fails the run (a newer commit already published).
- `pack` builds, packs, and checks that every path the package's `exports`, `main` and `types` name
  is in its tarball.
- `publish` holds the npm credential and runs no repository code. It refuses a tarball with any
  entry outside `package/` or a second `package.json`, reads the name and version from
  `npm publish --dry-run --json` (what npm would really publish), requires both to match, and
  publishes with `--tag next`.

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
   of it. Before running this, check that every branch the box's previews carried migrations from
   was merged unchanged.

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

It reads the three image digests from GHCR, rewrites every file that names the Core version or a
digest (the root `Dockerfile`, the catalog, `scripts/bundle-supervisor.mjs`, the setup assets and
their fixtures, `scripts/bundle-packaging.test.mjs`) and runs `pnpm install` for the lockfile. Open
that as its own pull request; the change that needs the new API stacks on it.

## Pin a sealantd prerelease in Core

By hand, in one pull request: the image tag in
`packages/workspaces/src/buildkit/buildkit-builder.ts` and `apps/cf-bridge/Dockerfile`, the exact
`@sealant/runtime-*` versions in `packages/workspaces/package.json`, then `pnpm install`. Core
trusts the recovery boot of `ghcr.io/sealant-sh/sealantd:X.Y.Z-next.N` (only `-next.N`) as it does a
release's.

## Release

One order, for one Mend release with one release of each repository. Each step says what enforces
it; the rest is this checklist.

1. **sealantd: merge its Version Packages pull request.** sealantd main is frozen from here until
   its tag: no other merge. `next.yml` publishes `X.Y.Z-next.N` from that commit.
2. **Core: pin that sealantd build** (the image tag and both runtime packages, exactly) and merge.
   Optionally pin the resulting Core build in Mend, cut a Mend next build and run it on the box.
3. **Tag sealantd `vX.Y.Z` on its Version Packages commit,** the one Core pinned. _Enforced:_ the
   release refuses a prerelease tag, and refuses while any next build of `X.Y.Z` came from a commit
   the tag does not contain, which is what a merge during the freeze produces. sealantd unfreezes.
4. **Core: pin sealantd `vX.Y.Z`, merge, then merge Core's Version Packages pull request.** Core
   main is frozen from here until its tag. `next.yml` publishes the Version Packages commit's build.
5. **Mend: pin that Core build, cut a Mend next build, run it on the box** (recommended: it proves
   Core's release code before the tag).
6. **Tag Core `vX'.Y'.Z'` on its Version Packages commit.** _Enforced:_ the release refuses a
   prerelease tag, a sealantd pin that is not a release (prerelease tag, bare digest, `latest`), a
   prerelease runtime package, and any next build of the version the tag does not contain (the
   freeze). Core unfreezes.
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
`@sealant/sdk` and `@sealant/api-contracts` (Core) or the two runtime packages (sealantd). Never
unpublish. Leave the images; nothing floats, so nothing pulls them unasked. Edit a withdrawn Mend
prerelease's notes on GitHub to say which version replaces it; do not delete it. A server already on
the bad version moves forward only, to a fixed next build. A bad Core prerelease pinned in Mend:
revert the pin pull request. After moving `next` back by hand, the next automatic publish in Core or
sealantd fails `plan` until a commit computes a version above the withdrawn one; that is the
forward-only rule doing its job, and the next merge clears it.

## Once, before the first publish

- In sealant-sh/sealant and sealant-sh/sealantd: create the environment `next` **first**, with its
  deployment branch policy set to `main` only (a new environment allows every branch until you set
  it, and a job that names a missing environment creates it with no policy), and no required
  reviewer.
- Then, on npmjs.com, for `@sealant/sdk` and `@sealant/api-contracts` (repository
  sealant-sh/sealant) and `@sealant/runtime-protocol` and `@sealant/runtime-client`
  (sealant-sh/sealantd): a second trusted publisher, workflow `next.yml`, environment `next`.
- On `main` in both repositories: require a pull request with review from code owners. CODEOWNERS
  covers `.github/`, the release scripts, the Dockerfiles, the published packages' `package.json`
  files and the changesets config. Without the rule, anyone who can merge could change `next.yml` or
  a package's lifecycle scripts and publish under any version or dist-tag.
- Nothing for Mend: its next builds use `release-cli.yml` and `release`, already registered.
