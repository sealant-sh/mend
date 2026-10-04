# A `next` channel: prereleases from main, and a stable release as their promotion

Status: proposed 2026-10-04, revised the same day after review. Covers `sealant-sh/mend`,
`sealant-sh/sealant` (Core) and `sealant-sh/sealantd`. Amends ROADMAP "How releases work". Read
against Mend `6d2b48e01`, Core `3599f9d` (SDK 0.38.1) and sealantd `05ce137` (0.19.0).

## Decisions for the owner

Each has a recommendation. The pull requests implement the recommendation; the ones marked
**action** need a setting only an organization owner can change, before the publish jobs run.

1. **One version scheme in all three repositories:** `B-next.N`. B is what the next Version Packages
   pull request would release from the commit: the highest stable tag bumped by the largest pending
   changeset (patches only: `X.Y.(Z+1)`; any minor: `X.(Y+1).0`), or the package's own version once
   that pull request has merged and the tag has not. N counts the commits since the last stable tag.
   Recommended. Today that makes Mend `0.36.0-next.51`, Core `0.39.0-next.6`, sealantd
   `0.20.0-next.7`.
2. **Core and sealantd publish on every merge to main; Mend publishes on demand,** when an admin
   pushes a `vX.Y.Z-next.N` tag on a main commit. Recommended. Mend's release pipeline takes 30 to
   45 minutes on eight runners and waits for your approval, and a Mend `next` build is something we
   hand to people, so each one should be chosen. The alternatives: a dispatch button (the
   release-tag ruleset would need to exclude `v*-next.*` so the workflow's token can create the
   tag), or every merge.
3. **Action: lock down who can publish from Core and sealantd main.** Three settings, all needed:
   - (a) a `next` environment in sealant-sh/sealant and sealant-sh/sealantd whose deployment branch
     policy is **`main` only**, set explicitly (a new environment allows every branch), with no
     required reviewer;
   - (b) a second npm trusted publisher (workflow `next.yml`, environment `next`) on `@sealant/sdk`,
     `@sealant/api-contracts`, `@sealant/runtime-protocol` and `@sealant/runtime-client` (npm allows
     up to ten per package);
   - (c) on `main` in both repositories, **require a pull request with review from code owners**.
     The PRs add `CODEOWNERS` covering `.github/`, the release scripts, the Dockerfiles and the
     changesets config.

   Recommended, all three. Why (c) matters: npm's trusted publisher grants (repository, `next.yml`,
   `next`) the right to publish any version under any dist-tag, `latest` included. The `-next` check
   and `--tag next` live in the workflow file. Core main today requires Lint and Typecheck but no
   review, and has a maintain-role collaborator, so anyone who can merge could merge an edit to
   `next.yml` and publish `@sealant/sdk` as `latest` without you. The PRs close the other path: the
   job that holds the npm credential runs no repository code, so a build dependency can no longer
   reach it. Without (c), that narrows the hole but does not close it. sealantd has only admin
   writers today, so there (c) guards the future.

4. **Mend's `next` builds reuse `release-cli.yml` and its `release` environment,** so each one still
   waits for your approval and needs no new trusted publisher. Recommended.
5. **A stable Mend release must be a promotion,** enforced. The release refuses a `vX.Y.Z` tag
   unless the newest next build of `X.Y.Z` it contains reached npm and, since that build, only the
   Version Packages pull request, release notes and docs changed. It also refuses while any next tag
   of `X.Y.Z` sits on a commit the release leaves out. Recommended. Core and sealantd refuse a
   release that leaves out one of their own next builds and, for Core, a prerelease sealantd pin;
   their stable releases are proven by the final Mend `next` that pins them.
6. **Preview builds stay** as the tool for trying unmerged branches of the three repositories on the
   box, separate from `next`. Their version becomes `B-next.N.preview.R` (B and N of the branch's
   merge base with main, R the run), so previews and `next` builds sort in main's order.
   Recommended.
7. **The box moves onto the channel with a supported CLI path, once.** It runs `0.36.0-preview.K`,
   which sorts above every `0.36.0-next.*` (`preview` comes after `next`).
   `mend server upgrade --version 0.36.0-next.N --from-preview` moves it: before anything stops, it
   reads the migrations both databases applied and refuses, naming them, if the target image does
   not carry one; a failure before the target starts recovers the preview's own image. No hand
   edits. Recommended over the alternatives: editing `server.json` breaks the `server.env` check and
   leaves a failed upgrade rolling back to an image that does not exist; and no naming of the next
   channel sorts above `preview` while still saying `next`.
8. **Core's lockfile becomes binding.** Core's AGENTS.md said never to touch `pnpm-lock.yaml` and to
   add dependencies with `--lockfile=false`. It now says what Mend's says: the lockfile is generated
   and committed with the change that caused it, and CI fails without it. Recommended; the drift fix
   depends on it.
9. **Published internal dependencies become exact.** `@sealant/sdk` depends on
   `@sealant/api-contracts` and `@sealant/runtime-client` on `@sealant/runtime-protocol` with
   `workspace:^`, which publishes `^0.39.0-next.12`: any later `0.39.0-next.*` satisfies it. Both
   move to `workspace:*` (exact). The pairs are versioned together already. Recommended.
10. **Core's `minimumReleaseAgeExclude` names the two runtime packages** instead of listing their
    versions. pnpm 11 holds back anything published in the last day, the lockfile included, so a
    sealantd prerelease Core pins would otherwise wait a day or need a new line per version. With
    frozen installs and exact pins, the exclusion lets nothing in the lockfile does not name; a
    fresh `pnpm add` or a regenerated lockfile would take a just-published version at once.
    Recommended.
11. **Core's prerelease images are `sealant-api`, `sealant-worker` and `sealant-ssh-gateway`**,
    built natively per architecture. `sealant-web` stays release-only: Mend does not use it.
    Recommended.

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

A commit on main has one `next` version, computed from git, never committed:

```
B-next.N             B = what the next Version Packages pull request would release:
                         the highest stable tag vX.Y.Z the commit contains, bumped by the largest
                         pending changeset of the released package or its fixed group
                         (patches only or none: X.Y.(Z+1); any minor: X.(Y+1).0; any major: (X+1).0.0),
                         or the package's own version when it is higher (the Version Packages
                         pull request merged, the tag not yet pushed)
                     N = git rev-list --count vX.Y.Z..<commit>
B-next.N.preview.R   a preview: B and N of the branch's merge base with main, R the run number
```

**Every later commit on main gets a higher version.** Between two stable tags, pending changesets
only accumulate (nothing deletes them but the Version Packages pull request), so the bump, and B,
only grow; that pull request replaces them with the version they produce, which becomes the
package's version, so B holds. N grows with every commit. A new tag `vX.Y.Z` is the B before it, and
everything after it starts above `X.Y.Z`. A test runs this history: a patch after `v0.36.0` gives
`0.36.1-next.2`; a minor changeset then gives `0.37.0-next.3`; the Version Packages merge gives
`0.37.0-next.4`; after the tag, `0.37.1-next.1`.

**Patches have their own next builds.** A fix after `v0.36.0` with a patch changeset is
`0.36.1-next.N`: the box proves the patch as the version it will be released as, and a server on it
can upgrade to `0.36.1`. Once a minor changeset lands, later builds are `0.37.0-next.M`; a server on
one of those cannot take `0.36.1` (a downgrade) and waits for `0.37.0`. The docs say so.

**A version belongs to a commit and the tags on its ancestors.** A re-run of a failed job publishes
the same version, and a version already on npm from the same commit is skipped. One case moves it: a
stable tag pushed later on an ancestor (the Version Packages merge) makes an older commit compute a
new base. That re-run is caught twice: npm's `next` only moves forward, so an older commit re-run
after a newer one published publishes nothing, and a version already published from a different
commit (`gitHead`) is refused.

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

- `ghcr.io/sealant-sh/sealantd:<version>`, multi-arch, built natively on the amd64 and arm64 runners
  (`cargo build --locked`), merged by digest, labelled with the commit.
- `@sealant/runtime-protocol` and `@sealant/runtime-client` `<version>` under `next`, with
  provenance.
- No binaries: sealantd publishes none today; the image carries `sealantd`, `sealantctl` and
  `socat`.

**Core: every merge to main.** New `next.yml`, on push to main:

- `sealant-api`, `sealant-worker` and `sealant-ssh-gateway` `<version>`, native per architecture,
  tagged only after the unit and integration tests (against Postgres, as CI runs them on a pull
  request) and the workspace runtime e2e against the pinned sealantd pass.
- `@sealant/sdk` and `@sealant/api-contracts` `<version>` under `next`, after the images, so every
  SDK prerelease has its images.

**Mend: on demand.** An admin pushes `vX.Y.Z-next.N` on a main commit; `release-cli.yml` does the
rest, as it already does for any prerelease tag: images, packaged acceptance on both architectures,
a GitHub prerelease with the setup assets, then npm `next` after your approval. `latest` and the
`latest` image tags are not touched. The version comes from
`node scripts/next-version.mjs --package apps/cli origin/main`.

### Who holds the npm credential

In Core and sealantd the work is split so the OIDC credential never meets repository code:

- `pack` (no `id-token`) installs, writes the version and the commit (`gitHead`) into each
  `package.json`, builds and runs `pnpm pack`. The tarballs carry the exact sibling version.
- `publish` (`id-token: write`, environment `next`, GitHub-hosted runner) checks out nothing. It
  downloads the tarballs; checks each one's name, that its version is this run's and matches
  `-next.\d+$`, and that its `gitHead` is this commit; checks npm's current `next` is older; and
  runs `npm publish ./<tarball> --tag next --provenance --ignore-scripts`, the contract or protocol
  first.

That closes the path where a build dependency in the lockfile asks for the token. It does not stop a
merged edit to `next.yml` itself; decision 3(c) does.

### Dist-tags

- Prereleases publish with `--tag next` only, refused unless the version is `-next.N`, and only when
  newer than the current `next`: the tag only moves forward. In Mend the release refuses a next tag
  below an existing higher one, so two approvals in the wrong order cannot move `next` back.
- `latest` moves only from a `v*.*.*` tag, exactly as today. Core's and sealantd's releases now
  refuse a prerelease tag, which `v*.*.*` matched and which would have published to `latest`.
- No floating image tags: nothing tags `next` or `edge`. Every reference names an exact version or a
  digest. Mend's `image.yml` can no longer overwrite a version: a dispatch comes from main only, and
  an existing `ghcr.io/sealant-sh/mend:<version>` is refused (a commit's own dev or acceptance build
  excepted).

### Pins

- **Mend main pins exact Core prereleases.** `node scripts/sealant-pins.mjs pin 0.39.0-next.12`
  reads the three image digests from GHCR, rewrites every file that names the Core version or a
  digest, and runs `pnpm install`. The Mend change that needs the new API stacks on that pull
  request, and waits only for Core main's `next.yml`.
- **Core main pins exact sealantd prereleases:** the image tag in `buildkit-builder.ts` and
  `apps/cf-bridge/Dockerfile`, and the two runtime packages, exact, in
  `packages/workspaces/package.json`. Core's recovery check treats
  `ghcr.io/sealant-sh/sealantd:0.20.0-next.N` like a release: a prerelease of a version after 0.19.0
  has the recovery boot. A prerelease of 0.19.0 itself does not count.

### Promotion

A stable release is a promotion of commits already proven on the box, in this order:

1. **sealantd** tags `vX.Y.Z` on a commit Core's main already pinned as `next` and the box ran,
   right after its Version Packages merge.
2. **Core** pins that stable sealantd (its `next` publishes), merges its Version Packages pull
   request and tags right after it.
3. **Mend** pins that stable Core and an admin pushes one more `next` tag of `X.Y.Z` on the result.
   That build runs on the box: it is the first time this exact stack runs anywhere, and it is the
   proof.
4. **Mend** merges its Version Packages pull request and an admin tags `vX.Y.Z`.

Core's and sealantd's stable images are rebuilt from their tags rather than retagged from a `next`.
Their sources differ from the proven commit only by version files and their installs are bound to
the lockfile, but not everything is pinned (see Known gaps), and step 3 runs those exact stable
images on the box before Mend releases.

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
and no npm prerelease of `X.Y.Z` built from a commit the tag leaves out.

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
  Deprecating alone does not move `next`. Same for the Core and sealantd packages. Never unpublish:
  lockfiles name the version, and npm forbids reusing it. Both commands need an owner's npm login
  with 2FA; a trusted publisher can move a dist-tag only with **Allow npm dist-tag** and npm 11.21
  or later, which we do not need yet.
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
- Who can publish a prerelease: in Core and sealantd, whoever can merge to main, until decision 3(c)
  makes `.github/` changes need your review; in Mend, only an admin, who alone can create `v*` tags
  (ruleset `protect-release-tags`), and only after your approval in `release`.
- Neither `next.yml` runs for a fork: `push` to main and `workflow_run` on a push to main only.
- Images push with the workflow's `GITHUB_TOKEN` (`packages: write`) into the existing public
  packages. A prerelease version tag is never rewritten: a run whose version already exists keeps
  the image.

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

## Considered

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
- Tag Core and sealantd right after their Version Packages merge; a merge in between publishes a
  next build the release then refuses to leave out.
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

Then, once you have done decision 3: the first Core and sealantd prereleases publish on their next
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
