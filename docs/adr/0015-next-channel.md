# A `next` channel: prereleases from main, and a stable release as their promotion

Status: proposed 2026-10-04, revised the same day after four reviews. Covers `sealant-sh/mend`,
`sealant-sh/sealant` (Core) and `sealant-sh/sealantd`. Amends ROADMAP "How releases work". Read
against Mend `6d2b48e01`, Core `3599f9d` (SDK 0.38.1) and sealantd `05ce137` (0.19.0).

## Decisions for the owner

Each has a recommendation. The pull requests implement the recommendation; the ones marked
**action** need a setting only an organization owner can change, before the publish jobs run.

1. **One version scheme in all three repositories, monotonic by construction:** `B-next.N`. N is the
   commit's whole history (`git rev-list --count`), so it never restarts. B is the larger of what
   the pending changesets would release (patches only: `X.Y.(Z+1)`; any minor: `X.(Y+1).0`; or the
   package's own version once the Version Packages pull request has merged and the tag has not) and
   the base of the highest next build already published or tagged above the last stable tag, so it
   never falls. Recommended. Today that makes Mend `0.36.0-next.584`, Core `0.39.0-next.679`,
   sealantd `0.20.0-next.139`.
2. **Core and sealantd publish on every merge to main; Mend publishes on demand,** when an admin
   pushes a `vX.Y.Z-next.N` tag on a main commit. Recommended. Mend's release pipeline takes 30 to
   45 minutes on eight runners and waits for your approval, and a Mend `next` build is something we
   hand to people, so each one should be chosen. The alternatives: a dispatch button (the
   release-tag ruleset would need to exclude `v*-next.*` so the workflow's token can create the
   tag), or every merge.
3. **Prereleases of Core and sealantd are separate packages and images.** The next builds publish as
   `@sealant/sdk-next`, `@sealant/api-contracts-next`, `@sealant/runtime-protocol-next` and
   `@sealant/runtime-client-next`, and push `sealant-api-next`, `sealant-worker-next`,
   `sealant-ssh-gateway-next` and `sealantd-next`. The `next` trusted publisher is registered
   **only** on the four `-next` packages, never on a stable one. So even a fully compromised next
   job cannot publish `@sealant/sdk`, move its `latest`, or write a stable image tag; the worst it
   can do is a bad prerelease of a package nothing installs unpinned. Consumers use exact aliases
   (`"@sealant/sdk": npm:@sealant/sdk-next@<version>` in Mend's catalog; checked locally that pnpm
   10 installs, typechecks and bundles through a catalog alias), and the prerelease packages depend
   on each other the same way. Recommended. It replaces four rounds of hardening the job that held
   the stable packages' publishing right: each round found a new way to steer it.
4. **Action, once, before merging #319 and #137:**
   - (a) create the four `-next` npm packages with a `0.0.0-next.0` placeholder from your machine
     with 2FA (the runbook has the commands: npm adds a trusted publisher only to a package that
     exists), then register the `next.yml` / `next` trusted publisher on each of them **and on
     nothing else**, and turn on **Require two-factor authentication and disallow tokens**;
   - (b) a `next` environment in sealant-sh/sealant and sealant-sh/sealantd whose deployment branch
     policy is **`main` only**, set explicitly, created before merging (a job that names a missing
     environment creates it with no policy), with no required reviewer;
   - (c) on `main` in both repositories, **require a pull request with review from code owners**.
     The PRs add `CODEOWNERS` for `.github/`, the release scripts, the Dockerfiles, the changesets
     config, the published packages' `package.json` files, the root `package.json`,
     `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.pnpmfile.cjs`, `.pnpmfile.mjs` (pnpm 11 loads it
     first), `.npmrc`, and in sealantd `Cargo.toml` and `Cargo.lock`;
   - (d) after the first next run, make the four `-next` GHCR packages public (Mend's pin check
     reads them anonymously and Mend's image build pulls them).

   Recommended, all four. What each guarantees is under "What the design guarantees".

5. **Mend's own next builds stay `@sealant/mend` on the `next` dist-tag,** on `release-cli.yml` and
   its `release` environment, not a `@sealant/mend-next` package. People install
   `npm install --global @sealant/mend@next`, and `mend server setup` runs the CLI's own version, so
   the name is the product's; and the boundary the `-next` packages buy is already there: each Mend
   next build is tagged by an admin and approved by you before its npm job runs, so the stable
   package's credential is never in an unattended job. The npm job is split like Core's: a
   credential-free `npm-pack` job builds; the `npm` job checks nothing out and publishes the tarball
   rebuilt from npm's reading. Recommended.
6. **A stable Mend release must be a promotion,** enforced. The release refuses a `vX.Y.Z` tag
   unless the newest next build of `X.Y.Z` it contains reached npm and, since that build, only the
   Version Packages pull request, release notes and docs changed. It also refuses while any next tag
   of `X.Y.Z` sits on a commit the release leaves out. Recommended. Core and sealantd refuse a
   release that leaves out one of their own next builds and, for Core, a prerelease sealantd pin;
   their stable releases are proven by the final Mend `next` that pins them.
7. **Preview builds stay** as the tool for trying unmerged branches of the three repositories on the
   box, separate from `next`. Their version becomes `B-next.N.preview.R` (B and N of the branch's
   merge base with main, R the run), so previews and `next` builds sort in main's order.
   Recommended.
8. **The box moves onto the channel with a supported CLI path, once.** It runs `0.36.0-preview.K`,
   which sorts above every `0.36.0-next.*` and every new-style preview (`preview` comes after
   `next`). `mend server upgrade --version <next build or new-style preview> --from-preview` moves
   it. Before anything stops, it reads the migrations both databases applied and refuses, naming
   them, if the target lacks one (Mend's by id and name, as Effect stores them), would skip one (a
   target Mend migration at or below the highest applied id that the box never ran), or changed one
   (Sealant's, by drizzle's hash, which the image now lists). A failure before the target starts
   recovers the preview's own image. It cannot detect a Mend migration whose code changed under the
   same id and name. The exact steps are under "The box, once" below. Recommended over the
   alternatives: editing `server.json` breaks the `server.env` check and leaves a failed upgrade
   rolling back to an image that does not exist; and no naming of the next channel sorts above
   `preview` while still saying `next`.
9. **Core's lockfile becomes binding.** Core's AGENTS.md said never to touch `pnpm-lock.yaml` and to
   add dependencies with `--lockfile=false`. It now says what Mend's says: the lockfile is generated
   and committed with the change that caused it, and CI fails without it. Recommended; the drift fix
   depends on it.
10. **Published internal dependencies become exact.** `@sealant/sdk` depends on
    `@sealant/api-contracts` and `@sealant/runtime-client` on `@sealant/runtime-protocol` with
    `workspace:^`, which publishes `^0.39.0-next.12`: any later `0.39.0-next.*` satisfies it. Both
    move to `workspace:*` (exact) for releases, and a prerelease depends on its sibling's `-next`
    package through an exact alias
    (`"@sealant/api-contracts": "npm:@sealant/api-contracts-next@<same version>"`). The pairs are
    versioned together already. Recommended.
11. **Core's `minimumReleaseAgeExclude` names the runtime packages and their `-next` packages**
    instead of listing their versions. pnpm 11 holds back anything published in the last day, the
    lockfile included, so a sealantd prerelease Core pins would otherwise wait a day or need a new
    line per version. With frozen installs and exact pins, the exclusion lets nothing in the
    lockfile does not name; a fresh `pnpm add` or a regenerated lockfile would take a just-published
    version at once. Recommended.
12. **Core's prerelease images are `sealant-api-next`, `sealant-worker-next` and
    `sealant-ssh-gateway-next`**, built natively per architecture. `sealant-web` stays release-only:
    Mend does not use it. Recommended.

## Context

### How each repository releases today

|                    | sealantd                                                                                | Core                                                                               | Mend                                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Versioning         | changesets, `fixed` pair `runtime-protocol` + `runtime-client`                          | changesets, `fixed` pair `api-contracts` + `sdk`; private packages never versioned | changesets on `@sealant/mend`; `version-packages` also syncs the Helm chart                                |
| Version PR         | `version.yml` on push to main                                                           | `version.yml` on push to main                                                      | `version.yml` on push to main; dispatches `release-acceptance.yml` on it                                   |
| Release trigger    | `v*.*.*` tag (admins only, ruleset)                                                     | `v*.*.*` tag (admins only)                                                         | `v*.*.*` tag (admins only)                                                                                 |
| Images             | `ghcr.io/sealant-sh/sealantd` `X.Y.Z`, `X.Y`, `latest`; QEMU arm64                      | `sealant-{api,worker,ssh-gateway,web}` `X.Y.Z`, `X.Y`, `latest`; QEMU arm64        | `mend`, `mend-api`, `mend-web` by digest per native arch, packaged acceptance, `latest` promoted after npm |
| npm                | OIDC trusted publishing, `--provenance`, environment `release` (your review, tags only) | same                                                                               | same; environment `release` (your review, any ref)                                                         |
| Binaries           | none published; only the image                                                          | —                                                                                  | —                                                                                                          |
| Prerelease support | none                                                                                    | none                                                                               | already there: a tag with `-` becomes a GitHub prerelease and npm `next`, and `latest` is not promoted     |
| Main protection    | required checks `rust`, `node`; no review                                               | required checks `Lint`, `Typecheck`; no review                                     | no deletion, no force push; no checks, no review                                                           |

How the pins chain together:

- **Core pins sealantd** as an image tag, `ghcr.io/sealant-sh/sealantd:0.19.0`, in
  `packages/workspaces/src/buildkit/buildkit-builder.ts` (overridable with `SEALANT_SEALANTD_IMAGE`)
  and `apps/cf-bridge/Dockerfile`, and its npm packages `@sealant/runtime-*` through
  `packages/workspaces/package.json` and the lockfile. Core trusts sealantd's recovery boot only for
  `ghcr.io/sealant-sh/sealantd:X.Y.Z` from 0.19.0 on, or an image named in
  `SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES` (`packages/workspaces/src/runtime/daemon-recovery.ts`).
- **Mend pins Core** in three places that must agree: the catalog (`@sealant/sdk`,
  `@sealant/api-contracts` 0.38.1), the root `Dockerfile` (`sealant-api`, `sealant-worker`,
  `sealant-ssh-gateway` by digest, plus the `dev.sealant.mend.sealant-version` label), and the
  version named in `scripts/bundle-supervisor.mjs`, the setup assets and their test fixtures.
  `scripts/bundle-packaging.test.mjs` asserts the digests.
- **Mend never pins sealantd.** The bundled worker bakes the sealantd its Core version pins. Only a
  preview build passes `MEND_PREVIEW_SEALANTD_IMAGE`; a release leaves it empty.
- **`mend server setup` runs the CLI's own version** unless `--version` says otherwise. It downloads
  `compose.v2.yaml` and `postgres-init.sh` from the GitHub release `v<version>` and runs
  `ghcr.io/sealant-sh/mend:<version>`, refusing an image whose version label differs.
  `--version latest` reads GitHub's `releases/latest`, which never returns a prerelease.
  `mend server upgrade` refuses an equal or lower version, because migrations do not run backwards.

### The pain

Mend compiles against `@sealant/sdk` from npm. A Mend change that needs a new Core API waits for a
Core release, which waits for a sealantd release, and the roadmap allows one of each per Mend
release. Three Mend changes wait like this now: faster status polling (sealant#314, merged), the
`available` field on a run's changes (sealant#313), and the steering login switch (sealant#315,
sealant#316, `workspace.setCredentials`). People cannot try Mend before a release either: preview
builds reach only the box.

### The drift that has to go first

Core's CI, its release and version workflows and all four image builds installed with
`pnpm install --lockfile=false`, so every run re-resolved every range against npm at that minute. On
2026-09-13 an Effect `rc` drifted into the `sealant-api` image that way. Once prereleases of our own
packages publish from main, the same path would let a newer prerelease into any image whose range
admits it: `workspace:^` publishes the SDK's dependency on the API contract as `^0.39.0-next.9`,
which `0.39.0-next.10` satisfies. Core main's lockfile is current: `pnpm install --frozen-lockfile`
succeeds on `3599f9d`, and the four images build with it.

## Decision

### Versions

A commit on main has one `next` version, computed from git and the builds already handed out, never
committed:

```
B-next.N             N = git rev-list --count <commit>: the commit's whole history
                     B = the larger of
                         - what the pending changesets would release: the highest stable tag vX.Y.Z
                           the commit contains, bumped by the largest pending changeset of the
                           released package or its fixed group (patches only or none: X.Y.(Z+1);
                           any minor: X.(Y+1).0; any major: (X+1).0.0), or the package's own version
                           when it is higher (the Version Packages pull request merged, not tagged)
                         - the base of the highest next build already handed out above vX.Y.Z
                           (Mend: its vX.Y.Z-next.N tags; Core and sealantd: the package's published
                           next versions on npm)
B-next.N.preview.R   a preview: B and N of the branch's merge base with main, R the run number
```

**Monotonic by construction.** N grows by at least one with every commit on main and never restarts:
a tag does not touch it. B never falls below a base already handed out since the last stable tag,
whatever the changesets do (a reverted minor, a reverted Version Packages merge, a minor landing
between a patch's Version Packages merge and its tag). After a tag `vX.Y.Z`, B is above `X.Y.Z`, so
above every earlier next build. A property test generates histories of patches, minors, reverted
minors, Version Packages merges and reverts and tags placed behind HEAD, publishes a build after
every commit, and checks each is strictly higher than the one before.

An older commit can compute a version only below a newer commit's (its N is smaller and its B is at
most the newest). So a re-run of an older commit after a newer one published fails `plan` loudly,
before any build; a version already published from the same commit is skipped; one published from a
different commit (`gitHead`) is refused.

**Patches.** While only patch changesets are pending, next builds are `0.36.1-next.N`: the box
proves the patch as the version it ships as, and a server on it can upgrade to `0.36.1`. Once a
minor changeset lands, builds are `0.37.0-next.N`, and stay there even if the minor is reverted; a
server on one of those cannot take `0.36.1` (a downgrade) and waits for `0.37.0`. The docs say so.
And once a `0.37.0-next.*` build is handed out, no next build of `0.36.1` can follow it, so the
promotion rule cannot release `0.36.1`: after a reverted minor changeset, the next release is
`0.37.0`. sealantd's and Core's Version Packages commit then publishes `0.37.0-next.N`, and that is
the build release step 1 pins.

A next tag counts as handed out the moment it exists. A mistyped or refused Mend next tag raises B
for later builds, and one off main blocks its version's release, so the runbook says to delete it
(`git push origin --delete v<version>`) unless its release already published.

The three copies of `next-version.mjs` (Mend and sealantd `scripts/`, Core `tooling/scripts/`) are
identical and tested, and refuse a shallow clone, where N would come out too small.

**Changesets snapshot or pre mode: neither, though it is a snapshot in spirit.** Nothing about a
prerelease is committed; the workflow writes the version into `package.json` at publish time, as the
stable release already does from its tag. The pending changesets decide B, as changesets itself
would.

- `changeset pre enter next` commits `.changeset/pre.json`, after which every Version Packages pull
  request produces `-next.N` versions until someone merges `changeset pre exit`. With main
  publishing continuously, main would sit in pre mode permanently. Each stable release would need an
  exit pull request before the Version Packages pull request and an enter pull request after it, and
  the CHANGELOGs would grow an entry per prerelease.
- `changeset version --snapshot next` versions only packages with a pending changeset. A Core merge
  that touches only the worker publishes images but no SDK, so it would get no version at all. Its
  templates offer a timestamp or a commit, not a counter, so the versions would not sort in main's
  order.

### Which merges publish

**sealantd: every commit on main whose CI passed.** New `next.yml`, triggered by `workflow_run` of
`ci` on main, `conclusion == success`, from a push to this repository:

- `ghcr.io/sealant-sh/sealantd-next:<version>`, multi-arch, built natively on the amd64 and arm64
  runners (`cargo build --locked`), merged by digest, labelled with the commit.
- `@sealant/runtime-protocol-next` and `@sealant/runtime-client-next` `<version>` under `next`, with
  provenance.
- No binaries: sealantd publishes none today; the image carries `sealantd`, `sealantctl` and
  `socat`.

**Core: every merge to main.** New `next.yml`, on push to main:

- `sealant-api-next`, `sealant-worker-next` and `sealant-ssh-gateway-next` `<version>`, native per
  architecture, tagged only after the unit and integration tests (against Postgres, as CI runs them
  on a pull request) and the workspace runtime e2e against the pinned sealantd pass.
- `@sealant/sdk-next` and `@sealant/api-contracts-next` `<version>` under `next`, after the images,
  so every SDK prerelease has its images.

**The images' boundary is weaker than npm's, and Mend does not rely on it.** The image jobs hold
`packages: write` and run repository code (the Docker builds), and GHCR cannot scope a token to one
image. What keeps a stable tag safe is that the next workflows push only `-next` names, so their
flow never writes a stable tag; and Mend pins every Core image by digest, so a moved `-next` tag
cannot reach a Mend build either.

**Mend: on demand.** An admin pushes `vX.Y.Z-next.N` on a main commit; `release-cli.yml` does the
rest, as it already does for any prerelease tag: images, packaged acceptance on both architectures,
a GitHub prerelease with the setup assets, then npm `next` after your approval. `latest` and the
`latest` image tags are not touched. The version comes from
`node scripts/next-version.mjs --package apps/cli origin/main`.

### Who holds the npm credential

The boundary is decision 3: Core's and sealantd's `next` publisher can publish only the four `-next`
packages. Inside it, the publish job is kept small and unsteerable:

- `plan` (Core, sealantd) decides first: done if this commit already published; failed if npm's
  `next` is not older. Every registry read retries and fails closed: an error or a 404 never reads
  as "nothing published".
- `pack` (no `id-token`) installs (restoring no pnpm store cache, which jobs running unowned code
  write), writes the version and the commit (`gitHead`) into each `package.json`, builds, renames
  the packages to their `-next` names (Core, sealantd), runs `pnpm pack`, and checks each tarball
  (`check-tarball.mjs`): every file its `exports`, `main` and `types` name is in it, nothing sits
  outside `package/`, and there is one `package.json` however its path is spelled.
- `publish` (`id-token: write`, its environment, a GitHub-hosted runner) checks out nothing,
  installs nothing and runs no repository code. It:
  1. refuses an artifact holding anything but the expected tarballs: a `.npmrc` beside them would
     otherwise configure every npm command, a proxy that captures the OIDC exchange included;
  2. runs every npm command from a fresh empty directory, so no project `.npmrc` applies;
  3. extracts each tarball with npm's own bundled pacote (nothing is installed, so nothing unpinned
     loads beside the credential);
  4. rewrites `package.json` from an allowlist (name, version, description, license, repository,
     homepage, bugs, keywords, type, main, module, types, typings, exports, files, bin, man,
     directories, engines, the four dependency maps, gitHead, and `publishConfig.access`), dropping
     any `tag`, other `publishConfig` keys and all scripts, and refuses a root `binding.gyp`, which
     npm would turn into an install script;
  5. checks the name (a `-next` name in Core and sealantd), the `-next.N` version (or, for a Mend
     stable release, `X.Y.Z`) and the commit on that rewritten manifest;
  6. reads `next` from the uncached `/-/package/<name>/dist-tags` right before publishing and
     refuses a version that is not newer, so re-running an old failed job cannot move it back;
  7. repacks with `npm pack --ignore-scripts` and publishes that with `--ignore-scripts`.

  A test runs that block, as written in each workflow, against a stub registry: every tarball the
  reviews crafted (a second manifest, a doubled `package/package.json`, `package/./` and `package//`
  paths, a `tag` field, `publishConfig` redirects, a stable version, a forged commit, an older
  version, a `binding.gyp`), an artifact with a `.npmrc` or extra files, and a `.npmrc` planted
  beside the tarball.

The allowlist and repack stay because they are cheap and already tested: with the `-next` boundary
they no longer guard `latest`, but they still keep a compromised `pack` from publishing under
another name, version or commit, or shipping a `tag`, scripts or a `binding.gyp` to whoever pins the
prerelease. The post-publish `latest` move-back is gone: a `-next` package's `latest` means nothing.

### What the design guarantees

- **With decisions 3 and 4(a), whatever else happens:** nothing in a next workflow, compromised or
  not, can publish `@sealant/sdk`, `@sealant/api-contracts`, `@sealant/runtime-*` or
  `@sealant/mend`, or move their `latest`: the `next` publisher exists only on the `-next` packages.
  The next workflows never write a stable image tag, and Mend pins every image by digest.
- **Without 4(c) (code-owner review):** anyone who can merge to Core main can edit `next.yml` and
  publish anything under the two `-next` packages and `-next` images. Prereleases are consumed only
  pinned (Mend's exact catalog alias with lockfile integrity; Core's exact alias), so a bad one
  reaches nothing until someone pins it.
- **With 4(c):** that edit, and edits to what configures installs, builds and packing, need your
  review. A compromised `pack` (through an unowned path) still cannot steer the publish job: it
  cannot change the name, version, dist-tag or commit a prerelease publishes under; it can change
  the code inside the prerelease, as any merge can.
- **Mend:** its npm job is approval-gated, checks nothing out and republishes the same way. Mend
  main has no required review and no CODEOWNERS, so code merged there reaches a Mend build, as it
  always has; it cannot steer the npm job itself.

### Dist-tags

- Core's and sealantd's prereleases publish under the `-next` package names, with `--tag next` from
  a rewritten manifest that has no `tag` field, refused unless the version is `-next.N`, and only
  when newer than the current `next`, read uncached right before publishing: the tag only moves
  forward. In Mend the pins job refuses a next tag below an existing higher one, and the npm step
  checks `next` again after the approval, so two approvals in the wrong order cannot move `next`
  back.
- `latest` moves only from a `v*.*.*` tag, exactly as today. Core's and sealantd's releases now
  refuse a prerelease tag, which `v*.*.*` matched and which would have published to `latest`.
- No floating image tags: nothing tags `next` or `edge`. Every reference names an exact version or a
  digest. Mend's `image.yml` can no longer overwrite a version: an existing
  `ghcr.io/sealant-sh/mend:<version>` is refused (a commit's own dev or acceptance build excepted),
  and a dispatch of `image.yml` itself (told apart from a call by `github.workflow_ref`, so the
  Version Packages pull request's acceptance still runs) must come from main and name a version that
  has its git tag, or a dev or acceptance build.

### Pins

- **Mend main pins exact Core prereleases.** `node scripts/sealant-pins.mjs pin 0.39.0-next.12`
  reads the three image digests from GHCR (`sealant-*-next`), rewrites every file that names the
  Core version or a digest, turns the catalog into exact aliases
  (`"@sealant/sdk": npm:@sealant/sdk-next@0.39.0-next.12`), and runs `pnpm install`. The published
  `@sealant/mend` CLI bundles what it imports from `@sealant/*`, so `npm i -g @sealant/mend@next`
  never resolves the SDK. The Mend change that needs the new API stacks on that pull request, and
  waits only for Core main's `next.yml`.
- **Core main pins exact sealantd prereleases:** `ghcr.io/sealant-sh/sealantd-next:<version>` in
  `buildkit-builder.ts` and `apps/cf-bridge/Dockerfile`, and the two runtime packages as exact
  aliases in `packages/workspaces/package.json`. Core's recovery check treats
  `ghcr.io/sealant-sh/sealantd-next:0.20.0-next.N` like a release: a prerelease of a version after
  0.19.0 has the recovery boot. A prerelease of 0.19.0 itself does not count.

### Promotion

A stable release is a promotion of commits already proven on the box, one release of each repository
per Mend release, in one order. Each step says what enforces it; the rest is a checklist
(`docs/operations/next-channel.md`).

1. **sealantd** merges its Version Packages pull request. sealantd main is frozen from here until
   its tag. `next.yml` publishes that commit's `X.Y.Z-next.N`.
2. **Core** pins exactly that sealantd build and merges (optionally proven on the box through a Mend
   next build).
3. **sealantd** tags `vX.Y.Z` on its Version Packages commit, the one Core pinned. _Enforced:_ the
   release refuses a prerelease tag and any next build of `X.Y.Z` from a commit the tag leaves out,
   which is what a merge during the freeze produces. sealantd unfreezes.
4. **Core** pins sealantd `vX.Y.Z`, merges, then merges its Version Packages pull request. Core main
   is frozen until its tag.
5. **Mend** pins that Core build, cuts a next build and runs it on the box (recommended).
6. **Core** tags its Version Packages commit. _Enforced:_ a prerelease tag, a sealantd pin that is
   not a release, a prerelease runtime package, and a next build of the version the tag leaves out
   are refused. Core unfreezes.
7. **Mend** pins Core's release, cuts a next build of the release's version and runs it on the box:
   the proof that counts, the whole stable stack as it will ship.
8. **Mend** merges its Version Packages pull request and an admin tags it. _Enforced:_ the promotion
   rules under Guards; in effect Mend main is frozen from step 7 to the tag.

Core's and sealantd's stable images are rebuilt from their tags rather than retagged from a `next`.
Their sources differ from the proven commit only by version files and their installs are bound to
the lockfile, but not everything is pinned (see Known gaps), and step 7 runs those exact stable
images on the box before Mend releases.

### The box, once

1. Merge the next-channel pull requests, cut the first Mend next build, approve it, and wait for
   `@sealant/mend@<version>` on npm.
2. On the box, as root: `npm install --global @sealant/mend@<version>` (the CLI with
   `--from-preview`).
3. Check each preview the box ran (the one case the CLI cannot see is a Mend migration changed under
   the same id and name). Every preview image carries its commit in
   `org.opencontainers.image.revision`; the runbook gives the exact loop: for each local
   `ghcr.io/sealant-sh/mend:*-preview.*` image, it diffs the preview branch's change to
   `packages/db/src/migrations.ts` against its merge base and runs `git apply --check --reverse` on
   main, which succeeds only when main carries that change exactly. Then run
   `mend server upgrade --version <version> --from-preview` (online: the setup assets come from that
   version's GitHub prerelease).
4. If it refuses, the named migrations came from a branch main lacks or has in another form: merge
   it and cut a next build that contains it, then repeat step 3; or, for a changed or skipped
   migration, restore the box from a backup taken before that preview.
5. After the move, `deploy-box.yml` and `scripts/preview-deploy.sh` work as usual.

### Guards

**Mend, `release-cli.yml`, job `pins`,** before any image builds (`scripts/check-release-pins.mjs`):

- Every release: the commit is on `origin/main`; the catalog and the Dockerfile label name one exact
  Core version; each Core image is pinned by digest, and each digest is what GHCR serves,
  anonymously, for that version's tag; the setup assets (`compose.v2.yaml`, `setup-contract.v2.json`
  and their fixtures) and `bundle-supervisor.mjs` name that version; `MEND_PREVIEW_SEALANTD_IMAGE`
  is empty.
- A next tag must be `vX.Y.Z-next.N`, equal to the version its commit computes, and not below an
  existing next tag.
- A stable tag:
  - no prerelease pinned anywhere (the catalog, the label, the digests, which must be the stable
    tags' digests), and `apps/cli/package.json` carries the version;
  - no next tag of `X.Y.Z` on a commit the release does not contain: a server on that build would
    "upgrade" to `X.Y.Z` and lose its work;
  - the newest next tag of `X.Y.Z` the commit contains exists and reached npm (the last step of its
    release, so its pipeline finished);
  - since that tag (`git diff --no-renames`, so a move counts as a deletion and an addition), only
    `.changeset/`, `CHANGELOG.md` files, the CLI package's `version` line, the chart's `version` and
    `appVersion` lines (`appVersion` must be the release), `docs/`, `apps/docs/`, `apps/marketing/`
    and top-level Markdown changed, never a `package.json` among them (`apps/docs` and
    `apps/marketing` are workspace members: a lifecycle script there runs in the image build).
- The sealantd pin is covered transitively: Mend refuses a prerelease Core, and Core refuses a
  prerelease sealantd.

**Core, `release.yml`, job `pins`,** before any image builds or publishes: a stable tag; every
sealantd image reference is `sealantd:X.Y.Z[@sha256:…]` (a prerelease tag, a bare digest or `latest`
is refused); no prerelease in the `@sealant/runtime-*` ranges or the versions the lockfile resolves;
and no npm prerelease of `X.Y.Z` built from a commit the tag leaves out. Core's recovery check
accepts only sealantd's own `-next.N` prereleases.

**sealantd, `release.yml`, job `stable-tag`:** a stable tag, and no npm prerelease of `X.Y.Z` built
from a commit the tag leaves out.

### The lockfile fix, first

Core's first pull request, before any publish job exists: every `pnpm install` in CI, the release,
the version workflow and the four Dockerfiles is `--frozen-lockfile`; the npm job drops
`PNPM_CONFIG_LOCKFILE=false`; the ssh-gateway runtime installs `ssh2@1.17.0` (the version the
lockfile resolves) instead of `^1.17.0`; and CI fails if a lockfile-free install comes back. Mend's
version workflow, its only remaining lockfile-free install, gets the same change, and Mend's CI gets
the same check.

### What a person trying a preview gets

```sh
npm install --global @sealant/mend@next
mend server setup
```

- The CLI is `0.36.0-next.N`. Setup installs the server at the same version: the setup assets from
  the GitHub prerelease `v0.36.0-next.N`, the image `ghcr.io/sealant-sh/mend:0.36.0-next.N`, which
  carries whichever Core that commit pinned (possibly a Core prerelease), and Core's sealantd.
- A later preview:
  `npm install --global @sealant/mend@next && mend server upgrade --version "$(npm view @sealant/mend@next version)"`.
- The stable release:
  `npm install --global @sealant/mend@latest && mend server upgrade --version latest`. `0.36.0` is
  higher than every `0.36.0-next.*`.
- There is no way back to an earlier release or preview: upgrade refuses a lower version, because
  migrations do not run backwards. A server on `0.37.0-next.*` cannot take a `0.36.1` patch. The
  docs page says so before the first command.

### Rolling back a bad prerelease

- **npm:** move the dist-tag back, then deprecate the bad version:
  `npm dist-tag add @sealant/mend@0.36.0-next.60 next` and
  `npm deprecate @sealant/mend@0.36.0-next.61 "Withdrawn: <reason>. Use 0.36.0-next.62."`.
  Deprecating alone does not move `next`. Same for the `-next` Core and sealantd packages. Never
  unpublish: lockfiles name the version, and npm forbids reusing it. Both commands need an owner's
  npm login with 2FA.
- **Images:** leave them. Nothing floats, so nothing pulls a bad image that was not named exactly.
- **Mend's GitHub prerelease:** edit its notes to say it is withdrawn and which version replaces it.
  Do not delete it: servers pinned to that version read its assets on a fresh setup.
- **Servers already on it** move forward only: publish a fixed `next` and upgrade.
- **A bad Core prerelease pinned by Mend:** revert Mend's pin pull request. The pin is one commit.

### Provenance and security

- Every npm publish uses OIDC trusted publishing from a GitHub-hosted runner with `--provenance`. No
  npm token exists in any repository. Recommended once this works: **Require two-factor
  authentication and disallow tokens** on all five packages, and consider pnpm's
  `trustPolicy: no-downgrade` in Core so a runtime package published without provenance is refused.
- Who can publish a prerelease: in Core and sealantd, only to the `-next` packages, by whoever can
  merge to main, with exactly the name, version, dist-tag and commit the workflow computes, unless
  they edit the workflow itself, which decision 4(c) puts behind your review; in Mend, only an
  admin, who alone can create `v*` tags (ruleset `protect-release-tags`), and only after your
  approval in `release`.
- Neither `next.yml` runs for a fork: `push` to main and `workflow_run` on a push to main only.
- Images push with the workflow's `GITHUB_TOKEN` (`packages: write`) into the `-next` image
  packages, which you make public once. A prerelease version tag is never rewritten: a run whose
  version already exists keeps the image.

### Known gaps

Left as they are here, and why a rebuilt stable release is not byte-for-byte the proven next:

- `ssh2@1.17.0` in Core's ssh-gateway runtime is exact, but its own dependencies (`asn1 ^0.2.6`,
  `bcrypt-pbkdf ^1.0.2`) resolve at build time.
- Base images float: `node:24-bookworm-slim`, `node:26-bookworm-slim`, `rust:slim`, `alpine:3.22`.
- Mend's Dockerfile installs `corepack` unpinned.
- The published `@sealant/mend` has caret dependencies (`@opentui/*`) that resolve on the user's
  machine.
- Core's `ssh-gateway` and `telemetry` still range `@sealant/runtime-*` as `^0.6.0` and `^0.4.0`; a
  non-frozen resolve would take a fresh one at once (decision 10).
- Workspace images install agent CLIs at `@latest`, by design.
- `--from-preview` cannot see a Mend migration changed under the same id and name: Mend stores no
  hash of its migrations.
- An ordinary upgrade from a new-style preview to a next build checks no migrations, as before this
  change; a preview of an unmerged branch can still leave the box ahead of main.
- A next image job holds `packages: write` while running repository code, and GHCR cannot scope that
  token per image. The next workflows push only `-next` names and Mend pins digests; a stable image
  tag is written only by the release workflows.
- Mend has no CODEOWNERS and no required review on main.

## Considered

- **One publisher for the stable and the prerelease versions of each package, hardened.** Four
  review rounds each found a new way to steer the job that held it (a crafted tarball, the
  manifest's `tag`, path spellings, unpinned loaded code, a `.npmrc` beside the artifact). Separate
  `-next` packages make the worst case a bad prerelease nobody installs unpinned, and the hardening
  that remains is defence in depth.
- **A `@sealant/mend-next` package for Mend's own builds.** People install `@sealant/mend@next`, and
  Mend's next builds already wait for an admin's tag and your approval; a second package would add a
  name for users to learn and no boundary Mend lacks.
- **One `release.yml` per repository with both triggers.** It would reuse the existing trusted
  publisher, but Core's and sealantd's `release` environments deploy only `v*.*.*` tags and require
  a review, and the tag path's QEMU builds, smoke test and GitHub release do not belong on every
  merge.
- **Mend on every merge.** Thirty to forty-five minutes on eight runners and an approval per merge,
  for builds nobody chose to hand out.
- **Always the next minor (`X.(Y+1).0-next.N`).** Simpler, but a patch release would sort below the
  next builds that proved it, so neither the box nor anyone on `@next` could upgrade to it.
- **Retagging Core's proven `next` images as the stable release.** Promotes the exact bytes, but the
  stable tag's commit is the Version Packages merge, not the proven commit, and Mend's final `next`
  (step 3) proves the rebuilt stable images anyway.
- **Folding preview builds into `next`.** A preview combines unmerged branches of three
  repositories; publishing that to npm would hand people code no one merged.
- **Hand-editing the box's `server.json` to leave the old previews.** Fails the `server.env` check,
  and a failed upgrade would roll back to an image that does not exist.
- **Keeping `--lockfile=false` and pinning only our own packages exactly.** It fixes drift of our
  prereleases but leaves third-party drift, which is the incident that already happened.

## Consequences

- A Mend pull request that needs a new Core API waits for Core main's `next.yml` (tests, images,
  e2e, npm), not for a Core release.
- People can install a preview with one npm command and upgrade to the stable release without
  reinstalling.
- Core and sealantd spend runner time on every merge: for Core three images times two architectures,
  the test suite and the workspace e2e; for sealantd one image times two.
- A dependency change in Core without its lockfile fails CI.
- sealantd's and Core's main each freeze from their Version Packages merge to their tag; a merge in
  between publishes a next build the release then refuses to leave out.
- The first stable release under these rules, 0.36.0, needs a next build of 0.36.0 first; the guard
  refuses it otherwise.
- The box's deploy command (outside this repository) must accept `0.36.0-next.N` and
  `0.36.0-next.N.preview.R`. `scripts/preview-deploy.sh` does; the one-time `--from-preview` move is
  run by hand.

## Delivery

| Repository | Pull request                                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------------------------------- |
| Core       | 1. Every install reads the committed lockfile                                                                     |
| sealantd   | 2. `next.yml` with a credential-free pack job; exact `runtime-protocol`; release guards; `--locked`; CODEOWNERS   |
| Core       | 3. `next.yml` with a credential-free pack job; release guards; recovery check; exact deps; CODEOWNERS             |
| Mend       | 4. This ADR                                                                                                       |
| Mend       | 5. The `next` channel: release guard, promotion check, pin script, `image.yml`, `--from-preview`, preview numbers |
| Mend       | 6. Docs: try a preview (merges after the first Mend next build publishes)                                         |
| Mend       | 7. ROADMAP "How releases work"                                                                                    |

Then, once you have done decision 4: the first Core and sealantd prereleases publish on their next
merge. Core pins a sealantd prerelease when it needs one; Mend pins Core `0.39.0-next.N` to unblock
sealant#313, #315 and #316.

## Decision log

- 2026-10-04: one version scheme, from what the pending changesets would release; N since the last
  stable tag.
- 2026-10-04: nothing about a prerelease is committed; no changesets pre mode, no snapshot command.
- 2026-10-04: Core and sealantd publish per merge from a `next` environment; Mend per `next` tag
  through its existing release workflow.
- 2026-10-04: the npm credential sits in a job that runs no repository code; code-owner review on
  main is an owner action, without which the hole narrows but stays open.
- 2026-10-04: a stable Mend release is refused unless it promotes a published next build of its own
  version and leaves none out.
- 2026-10-04: lockfile-bound installs in Core before any publish job exists.
- 2026-10-04: preview builds stay, renumbered into main's order; the box leaves the old numbering
  with `mend server upgrade --from-preview`.
- 2026-10-04 (fourth review): prereleases of Core and sealantd are separate `-next` packages and
  images, and the `next` publisher exists only on those; the publish job installs nothing, takes
  only the expected tarballs and runs npm from an empty directory; the `latest` move-back is gone.
- 2026-10-04 (third review): the publish job publishes a tarball it rebuilt from npm's own reading
  with an allowlisted manifest, in all three repositories; registry reads fail closed; CODEOWNERS
  covers what configures installs and builds; what the design guarantees with and without code-owner
  review, said exactly.
- 2026-10-04 (second review): N is the whole history's commit count and B never falls below a base
  already handed out, so versions only go up by construction; `pack` builds and checks its tarballs;
  `publish` reads what npm would publish; one release order with a freeze from each Version Packages
  merge to its tag.
