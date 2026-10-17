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

Mend's npm job holds the same credential, after the owner's approval in `release`, for
`@sealant/mend`, with the same refusals and the same check of `next`, but it repacks nothing. It
publishes the tarball its own run's acceptance installed, byte for byte: image.yml's `mend-cli`
artifact, refused unless its sha512 is the one the run's release manifest records and unless it is
already normalized for its channel (the check of `scripts/normalize-npm-tarball.mjs --check`,
written out in the job, which runs no repository file). After `npm publish <file>`, the integrity
npm serves (`npm view @sealant/mend@<version> dist.integrity`) must be the manifest's. It runs only
after the run's `acceptance` job, which passes only when image.yml reports that packaged acceptance
against ghcr passed. `@sealant/mend` keeps its `next` dist-tag on its own name rather than a
`@sealant/mend-next` package: people install `npm install --global @sealant/mend@next`,
`mend server setup` runs the CLI's own version, and each Mend next build is tagged by an admin and
approved by the owner, so the stable package's credential is never in an unattended job.

### What acceptance accepts

image.yml writes `release-manifest.json` (kept 90 days) for each run: the version, the baseline
version and the commit; for each image (`mend`, `mend-before`, `mend-api`, `mend-web`), its index
digest and its amd64 and arm64 platform digests; and the CLI tarball by file name, sha512 and npm
integrity. A platform digest is what that arch's build job pushed: an attested single-platform index
(build-push-action's default provenance), whose one runnable manifest is the build. The index digest
is the one `imagetools create` reported for what it pushed, never a later read of the tag, which
another run can move. It is recorded only once that index, read by its digest, maps `linux/amd64` to
the amd64 build and `linux/arm64` to the arm64 build, each once and in a variant that build has
(none for amd64, none or `v8` for arm64), and holds only those builds and their attestations
(`scripts/release-manifest.mjs check-index`). The arch of each build comes from its build job's
artifact name. A swapped label, a duplicated or missing platform, another variant, another build
under either platform, a digest listed twice, and an attestation annotation on a runnable platform
are each refused: only an annotated `unknown/unknown` descriptor is an attestation, since containerd
ignores the annotation and pulls the first descriptor whose platform matches. Its `cli` job packs
`@sealant/mend` once and normalizes it with `scripts/normalize-npm-tarball.mjs`, the manifest
rewrite the publisher makes. Packaged acceptance reads the manifest from its own run, never another
run's. For its own arch, it resolves each image through the index the manifest records, read by that
digest, as a consumer of `:<version>` resolves it, and refuses before any pull unless that is the
build the manifest records for the arch (`scripts/release-manifest.mjs resolve`). It pulls that
digest, tags only the pulled image ID with the name `mend server setup` expects, and fails unless
the running server is that ID, after setup and after the upgrade. It installs the tarball named in
the manifest after checking its sha512, the file the npm job then publishes. A stable release's
`promote-images` reads the manifest too: each `:<version>` tag must still resolve to the manifest's
index digest, and `latest` is created from that digest, never from the tag.

`target: archive` (an image.yml or release-acceptance.yml dispatch input; `ghcr` is the default)
builds the same images without a push or a ghcr login. Each image is exported to a one-day run
artifact, assembled into its multi-arch index in a registry inside the merge job, and accepted
offline from the archive once its platform manifest digest matches the manifest. The archives expire
after one day, as run artifacts; nothing deletes them sooner, since that would need `actions: write`
in every caller of image.yml, a release's included.

### The upgrade window

Packaged acceptance also upgrades from the releases a server may really be on: image.yml's
`previous-upgrade` (ghcr) and `archive-previous-upgrade` (archive) jobs, one per release in the
window and per arch, beside the same-source acceptance (`scripts/check-previous-upgrade.mjs`).
release-cli.yml's `acceptance` gate requires them: image.yml reports a target accepted only when the
same-source acceptance, the upgrade and the split-tier smoke (below) all passed.

The window (`scripts/upgrade-window.mjs`, the `upgrade-window` job):

- **A stable candidate** `X.Y.Z` upgrades from the highest stable release below it.
- **A next candidate** `X.Y.Z-next.N` upgrades from the newest next build below it, and from the
  highest stable release below it. A next build older than that stable release is left out: a server
  on it moves to the stable release first.
- **A dry run**, `X.Y.Z-next.N.dryrun.<run>.<attempt>`, takes the window of `X.Y.Z-next.N`, with
  `X.Y.Z-next.N` itself when it is published, since the stamp sorts above it. It runs the whole
  scenario, the upgrade included.
- **A dev or acceptance build** (`0.0.0-dev.*`, `0.0.0-acceptance.*`, and dry runs from before the
  current stamp) takes the window of the next build main would release now,
  `node scripts/next-version.mjs --package apps/cli origin/main`. It is stamped `0.0.0-*`, which
  orders below every release, and the CLI refuses that as a downgrade: such a run installs and seeds
  each release and reports the upgrade itself as NOT TESTED.

The releases come from npm's list for `@sealant/mend` and must agree with the live markers, read as
the stable guards read them: npm's `latest` and `next`, GitHub's latest release, and the version
label of ghcr's `mend`, `mend-api` and `mend-web` `:latest`. Only a real absence is absent (a 404, a
dist-tag npm does not have, buildx's not-found); a marker in the wrong shape fails the run, as does
npm's `next` inside the window when npm's list lacks it.

**Stable pins are committed.** `release/upgrade-from.json` holds, for each stable release, its npm
integrity and publish time, its `mend` index digest, the sha256 of its four setup assets, and the
digests of the images its setup starts beside Mend (Postgres and Garage for 0.35.1). Those
support-image digests are the ones their tags named on 2026-10-16, when the file was written, not
necessarily the ones the release first ran with. `mend-api` and `mend-web` are not pinned: the
scenario runs the bundle image only. `release/upgrade-from/<version>/` holds a `package.json` and a
lockfile for that release's CLI, installed with `npm ci`: the CLI ships no lockfile and depends on
version ranges, so without one its dependencies would drift. **Each stable release's pull request
adds the stable release before it**: read every value anonymously from npm, the GitHub release and
ghcr, write the lockfile once with
`npm install --package-lock-only --ignore-scripts --before=<that release's npm publish time + 1 s>`,
and check the entry against the artifacts with
`MEND_UPGRADE_FROM=<version> node scripts/check-previous-upgrade.mjs --prepare-only`.

**A next build's pins are read live**, never committed, and none needs a pull request: the integrity
and publish time npm records for it; the index digest ghcr serves for `mend:<version>`, whose
version label must be the version; and the sha256 GitHub records for each release asset on upload
(the `digest` field of the release API; releases carry no checksum file), each asset then downloaded
and checked against it. Its CLI is installed as npm resolved it when it was published,
`npm install --before=<publish time + 1 s>`, and the resulting lock must bind npm's integrity. Its
setup pulls the images it starts beside Mend as it would for a user; their digests are not pinned.
Every resolved pin is written to the run summary. The limits of those sources: a release asset can
be replaced by anyone who can write the repository, unless immutable releases are on, and the API's
digest then follows the replacement; and a ghcr `:<version>` tag written before staging and
`finalize-images` (#1025) was never protected against an overwrite.

**Failures, and what the job leaves.** The scenario says whose a failure is: HARNESS FAILURE when
the script or an artifact it fetched went wrong, PRODUCT FAILURE when Mend's own setup, upgrade or
data did. On a failure the job keeps the server's logs and `mend server status` as an artifact,
`previous-upgrade-<target>-<from>--<arch>`. The scenario cleans up nothing, on success or failure:
it runs on a fresh hosted runner, and is not safe to run on a workstation's Docker daemon.

**Waivers.** When a release cannot be installed or upgraded from (a deleted asset, a release from
before the pins could exist), the run fails with the reason; it never skips. Yiannis may approve a
waiver instead: an entry in `release/upgrade-waivers.json`, `{version, from, reason, approvedBy}`,
merged in a pull request he approves. `version` must equal the candidate exactly, so a waiver never
carries forward to the next release. The transition is then reported as waived, with the reason, in
the run summary; it is never counted as passed. A stable release's waived upgrade from a stable
release is written into its GitHub release notes too, by the `github-release` job from the same
file. release-acceptance.yml reads the file at the commit under test, as image.yml does.

**The GitHub release is never patched.** `github-release` lists the repository's releases first. A
published release for the tag with all four assets is a retry and changes nothing; one missing an
asset fails ("published release is missing an asset; cut a new version"), since an upload to a
published release is refused once immutable releases are on. A broken published release is fixed by
cutting a new version, never by editing it. A draft for the tag, left by a runner killed mid-upload
(`gh release create` uploads to a draft, then publishes it), is deleted and the release created
afresh; a draft's assets may be partial or from another attempt, so it is never reused.

### The split tiers

`mend-api` and `mend-web`, the images the Helm chart runs, are smoked as the chart runs them:
image.yml's `split-tier-smoke` (ghcr, pulled by the manifest's platform digests) and
`archive-split-tier-smoke` (loaded from the run's archives after their digests match the manifest),
on amd64 and arm64. `scripts/split-tier/compose.yaml` starts Postgres (the chart's
`postgres:17-alpine`, pinned by the digest it named on 2026-10-16), the API on 3101 and the web tier
on 3105, with the environment the chart renders: `MEND_DEPLOYMENT_MODE=kubernetes`, the capture
store and its network session channel (`MEND_SESSION_ENDPOINT_URL` is the chart's
`sessionChannel.advertisedUrl`, set to the Compose service), the API as uid 1000 and the web tier as
`node`. `scripts/check-split-tier.test.mjs` compares the file with `helm template`; what Compose
cannot copy is named there: generated secrets, Compose service names for the cluster's, and no
bucket, so the API keeps captures in a directory beside its store.

`scripts/check-split-tier.mjs` then goes through the web tier's port only: health reports ok and the
exact version; `/api/instance` has no users; the first sign-up gets a bearer token; `/api/projects`
answers 200 with it and 401 without it; an upgrade ticket opens `/api/keys/bridge/ws` through the
web tier, and an ssh-agent request from inside the API and its answer each cross it; after both
tiers restart, health, the version and the same account's sign-in work again. The running containers
must be the images the job pulled or loaded. A failure is named a HARNESS or a PRODUCT FAILURE, and
the job keeps every container's logs as `split-tier-<target>--<arch>`. It cleans up nothing, so it
runs on fresh hosted runners only.

What it does not test:

- **Sessions on split tiers.** They would need Sealant Core in the Compose file, and the bundle's
  acceptance covers sessions through the same API code.
- **Ingress, NetworkPolicy and the Kubernetes workspace backend.** Nothing here runs a cluster.

### Where publishing runs

Every job in a workflow that publishes, or holds a token that writes to a repository, its packages
or a registry, runs on a GitHub-hosted runner: a fresh VM per job. The box's runner VMs keep state
between jobs (Docker images, the setup-node tool cache, the pnpm store), so code from an earlier
pull request could change what a job there builds, accepts or pushes. A test in each repository
refuses any other runner in those workflows. This holds for runs created from the workflow files
since that change, in all three repositories: Mend (this change), Core and sealantd (their own pull
requests).

**Never re-run a publishing run created before that change.** A re-run uses the workflow files of
the run's own commit, so it runs on the box again. A new run is only safe if it targets a commit
whose workflow files contain the change: a tag on an older commit, or a dispatch on an older branch,
runs that commit's files. Mend's `release-cli.yml` before the change still has the `v*` trigger and
its box `pins` job, so a release tag on such a commit runs on the box.

Before merging that change in each repository:

1. List the repository's unfinished runs of every publishing workflow: queued, waiting, requested,
   pending and in progress.
2. Cancel every one that has not started. Let an in-progress run finish, and watch what it
   publishes.
3. Record the run IDs, or that there were none, in the pull request.

## Dry-run a release

A dry run builds, accepts and checks a release from any branch and publishes nothing:

```sh
gh workflow run release-cli.yml --ref <branch> -f dry_run=true
```

A dispatch without `dry_run` fails in its first job: only a `vX.Y.Z` tag push publishes. The run's
version is always derived, never an input: `<next>.dryrun.<run id>.<attempt>`, where `<next>` is the
`X.Y.Z-next.N` that `scripts/next-version.mjs` gives the dispatched commit, for example
`0.36.0-next.988.dryrun.38931186422.1`. If the allocator cannot give the commit a version (a missing
package, no stable tag in its history, a shallow clone), the first job fails and says so.

The stamp sorts as a release would: above `X.Y.Z-next.N` (it has more prerelease fields with the
same start), below `X.Y.Z-next.(N+1)` (`N` is compared first, as a number), and below `X.Y.Z` itself
(any prerelease is). Dispatched from current main, or a branch on top of it, `X.Y.Z-next.N` is at
least the newest published next build, so the stamp sorts above every published release, its window
is the newest next build and the stable release before it, and nothing it builds could replace
either. Dispatched from an older commit, it is stamped with that commit's `N` and can sort below a
published next build: commit 2, with `next.3` already tagged, is
`0.36.0-next.2.dryrun.<run>.<attempt>`, below `next.3`, and upgrades from `next.2`'s window. So
dispatch a dry run from current main. It never equals a version the allocator hands out, which are
only `X.Y.Z-next.N`, `X.Y.Z-next.N.preview.R` and `X.Y.Z`. A tag carrying `dryrun` is refused by the
release job, a dry-run version builds to `target: archive` only (image.yml refuses it for ghcr,
whether it comes from the version input or from the tag a run is dispatched on), and the publisher
refuses it on either npm channel. Runs before this stamp used `0.0.0-dryrun.<run id>.<attempt>`;
`scripts/check-release-pins.mjs` reads both forms as a dry run. The pins job checks the Core pins,
their digests on GHCR and the setup assets (not the release-only checks: main, the next order, the
promotion). image.yml runs with `target: archive`, its `cli` job packs and normalizes the CLI
tarball, and packaged acceptance runs offline from the archives, gated by the same `acceptance` job
a release waits for. `finalize-images`, `npm`, `github-release` and `promote-images` run on a tag
push only, so a dry run asks for no `release` environment and mints no id-token, and none of its
jobs holds `contents: write` or `packages: write`.

Dry run 2, run 38923041738 on `475d88ca9`, passed end to end and published nothing.

Dry run 3, run 38931186422 on `79e6edd0e` (staging and finalize), passed end to end and published
nothing: `finalize-images`, `npm`, `github-release` and `promote-images` were skipped, and every
job's token was read-only.

Dry run 4, run 38965446723 on `a5809999e` (plan (d)), passed end to end and published nothing in
11.0 min, stamped `0.36.0-next.993.dryrun.38965446723.1`. On both architectures it upgraded from
0.35.1 and from 0.36.0-next.792 to the archived candidate and ran the split-tier smoke, all through
the release gate; the new jobs ran in parallel inside packaged acceptance's time and added no wall
time.

Unproven until the watched `-next` tag below: the ghcr-mode `previous-upgrade` and
`split-tier-smoke` jobs; the ghcr login and push from GitHub's hosted runners; the multi-arch index
on ghcr; `finalize-images` itself; online setup pulling from ghcr; npm's OIDC and the `release`
environment; the GitHub release and its assets; and what offline acceptance skips (the dotfiles
scenario, git access, fetching through the mirrors). A tag push is the only run that proves them.

The stable `latest` promotion stays unproven until the first stable release: on a `-next` tag,
`promote-images` returns before it reads anything, so the watched `-next` tag proves nothing about
it. The stable floor guards
([A stable release never moves backwards](#a-stable-release-never-moves-backwards)) are tested only
against stub registries and APIs until then.

Proven once, and stale when GitHub's runner images change: a ghcr login with `packages: write`, a
push by digest, and the multi-arch index on ghcr, on 14 October 2026 in run 38607378387, before the
pause. That run built amd64 on the box, not on a hosted runner: the first proof on GitHub's hosted
runners is still pending. **The first real release after the dry run is a `-next` tag, watched
live**, job by job.

### When npm serves other bytes

If the npm job fails with `INCIDENT`, the version on npm is not the tarball the run accepted.

What has moved: `npm publish` already pointed the channel's npm dist-tag at the incident version,
`latest` for a stable release, `next` for a next build. Installs pick it up until you move it back.
The GitHub release and its assets are up. What has not moved: GHCR's `:latest` and GitHub's latest
release, because `promote-images` runs after the npm job and did not run.

With an npm login that has 2FA, from an empty directory:

1. Check that the dist-tag still names the incident version, so you do not move it off a newer good
   release published since:

   ```sh
   npm view @sealant/mend dist-tags --json
   ```

   If `latest` (stable) or `next` (next build) names another version, leave it and go to step 3.

2. Point it back at the last release whose integrity checked:

   ```sh
   npm dist-tag add @sealant/mend@<verified prior version> <latest or next>
   ```

3. Deprecate the incident version, and cut a new one:

   ```sh
   npm deprecate @sealant/mend@<version> "Withdrawn: published bytes differ from the accepted tarball. Use <new version>."
   ```

Never republish over the incident version, and never unpublish it. Edit its GitHub release notes to
name the version that replaces it.

## Staging, then the version

A release's images reach `:<version>` only after its own acceptance passed. image.yml's `merge`
creates each multi-arch index under `staging-<run id>-<run attempt>` and records its digest in the
release manifest. Packaged acceptance pulls by digest, never by tag. Then release-cli.yml's
`finalize-images`, before it reads or writes any tag, reads each image's index by the digest the
manifest records and binds its platforms again, as `merge` and acceptance did: each arch's platform
must map to the build the manifest records for that arch. The manifest outlives the one-day digest
artifacts, so a re-run can still check. Any mismatch fails with nothing written. Then it reads each
image's `:<version>` and:

- absent (the registry answered not found): creates it from the manifest's index digest;
- already this run's digest: done;
- another digest: refuses. The version is spent; cut a new one;
- unreadable for any other reason: fails without writing.

Every tag is read before any is written. After each create, the tag is read again, and that read
decides: this run's digest is a success even when the create reported an error, another digest is
refused, and an unreadable or absent tag fails. `npm` and `promote-images` need `finalize-images`,
and the three share the `mend-release-channel` queue. Each of those jobs is serialized on its own:
two runs' `finalize-images` never overlap, nor their `npm`, nor their `promote-images`. The queue is
not held across a whole release, so two releases' jobs can interleave. An older stable run that
reaches `npm` or `promote-images` after a newer one is refused there by the stable floor, read again
inside each job's lock
([A stable release never moves backwards](#a-stable-release-never-moves-backwards)).

### A stable release never moves backwards

A stable release's floor is the highest of three markers, compared as numbers `X.Y.Z`: npm's
`latest` for `@sealant/mend` (the uncached dist-tags endpoint), the tag of GitHub's latest release,
and the `org.opencontainers.image.version` label every platform of `mend`, `mend-api` and
`mend-web`'s ghcr `:latest` carries. A marker that does not exist (no `latest` dist-tag, no latest
release, a `:latest` the registry does not have) adds nothing. One that cannot be read, or is
present but not a plain `X.Y.Z`, fails the job: it is never read as no floor. Each value is checked
whole: npm's dist-tags must be a JSON object whose `latest`, when there is one, is a string `X.Y.Z`;
GitHub's latest release tag must be exactly `vX.Y.Z`; every platform's label must be the same string
`X.Y.Z`, with nothing after it. Each part of `X.Y.Z` has at most 9 digits, so the comparison never
overflows; a longer part fails as not plain.

The `npm` and `promote-images` jobs each read the floor inside the `mend-release-channel` lock,
before any write, and compare the release with it:

- **Above the floor:** publish and promote as usual.
- **At the floor:** a retry of the same version. `npm` publishes nothing and moves no dist-tag; it
  checks that npm holds this version from this commit with the accepted tarball's integrity, and
  fails if npm does not hold it at all (a marker was moved by hand). `promote-images` retags only
  the `:latest` that is not already this run's index, then marks the GitHub release latest.
- **Below the floor:** refused, naming the marker and its version. Nothing is published and nothing
  moves: not npm's `latest`, not ghcr's `:latest`, not GitHub's latest release.

**A backport is refused on purpose**, for example `0.35.2` after `0.36.0`: it would move every
`latest` back. Publishing backports under a dist-tag of their own is a decision not yet made. The
`release` job also refuses, before anything builds, a stable tag below the highest stable `vX.Y.Z`
tag in the repository. That is an early exit only; the checks inside the lock are the guard.

The guards see only what the release workflows write. A hand-run `npm dist-tag add`, an image pushed
to `:latest` by hand, or a release marked latest in GitHub's UI moves a marker outside the lock, and
the next release's floor follows wherever it was moved.

#### Restore the three markers to one version

If the markers disagree after a manual write or an incident, put all three back on the last stable
version that was released whole (`<version>`, its commit's run and manifest known), from an empty
directory. You need three logins, and should check all three **before** you start, or the image
write can fail after npm and GitHub were already moved: an npm login that has 2FA; a `gh` login that
may edit releases; and Docker's own login to GHCR, which `gh auth` does not give buildx:
`docker login ghcr.io` with a token that has `write:packages`. Read a `:latest` with
`docker buildx imagetools inspect` to check that login reaches GHCR.

1. Check each marker, so you do not move one off a newer good release:

   ```sh
   npm view @sealant/mend dist-tags --json
   gh api repos/sealant-sh/Mend/releases/latest --jq .tag_name
   for image in mend mend-api mend-web; do
     docker buildx imagetools inspect "ghcr.io/sealant-sh/$image:latest" --format '{{json .Image}}' |
       jq -r '[.[].config.Labels["org.opencontainers.image.version"]] | unique | join(",")'
   done
   ```

2. Point each at `<version>`. Take the index digests from that release run's
   `release-manifest.json`, never from a tag:

   ```sh
   npm dist-tag add "@sealant/mend@<version>" latest
   gh release edit "v<version>" --repo sealant-sh/Mend --latest
   docker buildx imagetools create --tag ghcr.io/sealant-sh/<image>:latest \
     "ghcr.io/sealant-sh/<image>@<index digest from the manifest>"
   ```

3. Read all three again and check they name `<version>`. Deprecate any version that should not be
   installed, and never republish one.

So a version is spent once its tag exists. **Re-run failed jobs** of a release run: the images keep
their digests, `finalize-images` finds them and is done. **Re-run all jobs**: the images are built
again, under new digests, and `finalize-images` refuses the version; cut a new one. A dev
(`0.0.0-dev.*`) or acceptance (`0.0.0-acceptance.*`) build keeps its own mutable tag at `merge`:
release acceptance, previews and the baseline image of every acceptance run name it. An image.yml
dispatch of a real version stages only; nothing finalizes it outside a release.

### Clean up staging tags

A staging tag no release finalized stays on GHCR. `ghcr-staging-cleanup.yml` deletes package
versions whose every tag is a staging tag and whose `updated_at` is 14 days old or more. It never
deletes an untagged version (a platform manifest an index points at) or one with any other tag: a
final version, a dev or acceptance build, `latest`. Its first run lists only:

```sh
gh workflow run ghcr-staging-cleanup.yml
```

The cleanup queues on the same `mend-release-channel` group as `finalize-images`, so a release's
finalize never tags a staging index between the cleanup's listing and its deletes. That lock covers
this repository's workflows only: a manual push or any registry writer outside them is not
serialized with it. Right before each delete the cleanup reads the version again and reclassifies
it, keeping it if it gained another tag; that narrows the window against those outside writers, but
does not close it.

The log names each candidate and each version it keeps, with why. A 403 means the workflow token
cannot administer the packages (each package's Manage Actions access). After that run has been read,
`-f dry_run=false` deletes the candidates, and a reviewed follow-up turns its weekly schedule on.

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

Deploy it on the box with `deploy-box.yml` (`version` and the commit), dispatched from main, or by
hand with `scripts/preview-deploy.sh <version> <commit>`. The script refuses an image whose
`org.opencontainers.image.revision` is not that commit; next builds made before image.yml stamped
that label (`0.36.0-next.601` and earlier) are deployed by hand with `mend server upgrade`.

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
8. **Mend: run required CI and packaged acceptance on the Version Packages pull request's head**
   (`gh workflow run ci.yml --ref changeset-release/main` and
   `gh workflow run release-acceptance.yml --ref changeset-release/main`), wait for `checks` and
   acceptance to pass on that head, then **merge that pull request and tag `vA.B.C` on it.** Nothing
   dispatches either automatically, and GitHub's own runs for the bot-authored pull request stop at
   the contributor approval policy, so without the first command the pull request has no `checks`.
   _Enforced by the pins job:_ the commit is on main; no prerelease is pinned; the CLI package
   carries the version; no next tag of `A.B.C` sits on a commit the release leaves out; the newest
   next build of `A.B.C` it contains reached npm; and since that build only `.changeset/`,
   `CHANGELOG.md` files, the CLI package's `version` line, the chart's `version`/`appVersion` lines
   (`appVersion` must be the release), `docs/`, `apps/docs/`, `apps/marketing/` and top-level
   Markdown changed, never a `package.json` (a move counts as a deletion and an addition). In effect
   Mend main is frozen from step 7 to the tag too.

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
