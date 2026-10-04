# A `next` channel: prereleases from main, and a stable release as their promotion

Status: proposed 2026-10-04. Covers `sealant-sh/mend`, `sealant-sh/sealant` (Core) and
`sealant-sh/sealantd`. Amends ROADMAP "How releases work". Read against Mend `6d2b48e01`, Core
`3599f9d` (SDK 0.38.1) and sealantd `05ce137` (0.19.0).

## Decisions for the owner

Each has a recommendation. The pull requests implement the recommendation; the ones marked
**action** need a setting only an organization owner can change before the publish jobs can run.

1. **One version scheme in all three repositories:** `X.(Y+1).0-next.N`, where `vX.Y.Z` is the
   highest stable tag and N counts the commits on main since that minor's first release (`vX.Y.0`).
   Recommended. Today that makes Mend `0.36.0-next.56`, Core `0.39.0-next.9`, sealantd
   `0.20.0-next.7`.
2. **Core and sealantd publish on every merge to main; Mend publishes on demand,** when you push a
   `vX.Y.Z-next.N` tag on a main commit. Recommended. Mend's release pipeline takes 30 to 45 minutes
   on eight runners and waits for your approval, and a Mend `next` build is something we hand to
   people, so each one should be chosen. The alternatives: a dispatch button (the release-tag
   ruleset would need to exclude `v*-next.*` so the workflow's token can create the tag), or every
   merge.
3. **Action: a `next` environment in sealant-sh/sealant and sealant-sh/sealantd,** deployable from
   `main` only, with no required reviewer, and a second npm trusted publisher (workflow `next.yml`,
   environment `next`) on `@sealant/sdk`, `@sealant/api-contracts`, `@sealant/runtime-protocol` and
   `@sealant/runtime-client`. Recommended without a reviewer: the merge is the review, and this path
   cannot move `latest`. The existing `release` environments only deploy `v*.*.*` tags, so the
   prereleases cannot reuse them. npm allows up to ten trusted publishers per package.
4. **Mend's `next` builds reuse `release-cli.yml` and its `release` environment,** so each one still
   waits for your approval and needs no new trusted publisher. Recommended.
5. **A stable Mend release must be a promotion,** enforced: the release workflow refuses a `vX.Y.Z`
   tag whose commit changed anything since the newest `next` tag it contains, beyond the Version
   Packages pull request, release notes and documentation. Recommended. Core and sealantd get the
   pin guard only (decision 11); their stable releases are proven by the final Mend `next` that pins
   them.
6. **Preview builds stay** as the tool for trying unmerged branches of the three repositories on the
   box, separate from `next`. Their version becomes `X.Y.0-next.N.preview.R` (N of the branch's
   merge base with main, R the run), so previews and `next` builds sort in main's order.
   Recommended.
7. **The box, once.** It runs `0.36.0-preview.K`. `preview` sorts after `next`, so
   `mend server upgrade` refuses every `0.36.0-next.*` and every new-style preview until 0.36.0.
   Choose one:
   - (a, recommended) check that every Mend and Sealant migration the box has applied is on main,
     then set `serverVersion` in the box's `server.json` to `0.36.0-next.0` and upgrade to the first
     `next` build. Not tested: nothing here touched the box.
   - (b) keep deploying old-style previews until 0.36.0 ships, and start `next` on the box after it.
     The box would then not prove 0.36.0's commits as `next` builds.
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
    sealantd prerelease Core pins would otherwise wait a day or need a new line per version. Our own
    packages, published with provenance by our own workflows, are the case the exclusion is for.
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

A commit on main has exactly one `next` version, computed from git, never committed:

```
X.(Y+1).0-next.N             vX.Y.Z = highest stable tag the commit contains
                             N      = git rev-list --count vX.Y.0..<commit>
X.(Y+1).0-next.N.preview.R   a preview: N of the branch's merge base with main, R the run number
```

- N counts from the minor's first release, not the latest patch, so a patch release never makes it
  smaller: every later commit on main gets a higher version.
- The version is reproducible from the commit. A re-run of a failed job publishes the same version,
  and a version already published is skipped, not published again.
- After `v0.39.0`, Core's next builds are `0.40.0-next.N` from 1. Every one is higher than every
  `0.39.0-next.*` and lower than `0.40.0`, so `mend server upgrade` moves forward through them and
  on to the stable release.
- `scripts/next-version.mjs` (Mend, sealantd) and `tooling/scripts/next-version.mjs` (Core) compute
  it. The three copies are identical and tested.

**Changesets snapshot or pre mode: neither, though it is a snapshot in spirit.** Nothing about a
prerelease is committed; the workflow writes the version into `package.json` at publish time, as the
stable release already does from its tag.

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
`ci` on main, `conclusion == success`:

- `ghcr.io/sealant-sh/sealantd:0.20.0-next.N`, multi-arch, built natively on the amd64 and arm64
  runners and merged by digest, labelled with the commit.
- `@sealant/runtime-protocol` and `@sealant/runtime-client` `0.20.0-next.N` under `next`, with
  provenance, from the `next` environment.
- No binaries: sealantd publishes none today; the image carries `sealantd`, `sealantctl` and
  `socat`.

**Core: every merge to main.** New `next.yml`, on push to main:

- `sealant-api`, `sealant-worker` and `sealant-ssh-gateway` `0.39.0-next.N`, native per
  architecture, merged by digest.
- The workspace runtime e2e against the pinned sealantd, as the release runs it, before npm.
- `@sealant/sdk` and `@sealant/api-contracts` `0.39.0-next.N` under `next`, after the images exist,
  so every SDK prerelease has its images.

**Mend: on demand.** You push `v0.36.0-next.N` on a main commit; `release-cli.yml` does the rest, as
it already does for any prerelease tag: images, packaged acceptance on both architectures, a GitHub
prerelease with the setup assets, then npm `next` after your approval. `latest` and the `latest`
image tags are not touched. The version comes from `node scripts/next-version.mjs origin/main`.

### Dist-tags

- Prereleases publish with `--tag next` only, and the publish step refuses a version without
  `-next.`. `latest` moves only from a `v*.*.*` tag, exactly as today.
- No floating image tags: nothing tags `next` or `edge`. Every reference names an exact version or a
  digest.

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

1. **sealantd** tags `vX.Y.Z` on a commit Core's main already pinned as `next` and the box ran.
2. **Core** pins that stable sealantd (its `next` publishes), merges its Version Packages pull
   request and tags. The release refuses to start while Core pins a prerelease sealantd.
3. **Mend** pins that stable Core and you push one more `next` tag on the result. That build runs on
   the box: it is the first time this exact stack runs anywhere, and it is the proof.
4. **Mend** merges its Version Packages pull request and you tag `vX.Y.Z`. The release refuses
   unless the commit is a promotion of the newest `next` tag it contains (decision 5).

Core's and sealantd's stable images are rebuilt from their tags rather than retagged from a `next`.
Their sources differ from the proven commit only by version files, their installs are bound to the
lockfile, and step 3 runs those exact stable images on the box before Mend releases.

### Guards

**Mend, `release-cli.yml`, job `pins`,** before any image builds (`scripts/check-release-pins.mjs`):

- Every release: the catalog, the Dockerfile label and the setup assets name one exact Core version;
  each Core image is pinned by digest, and each digest is what GHCR serves, anonymously, for that
  version's tag; `MEND_PREVIEW_SEALANTD_IMAGE` is empty.
- A prerelease tag must be `vX.Y.Z-next.N`, equal to the version its commit computes, and on main.
- A stable tag: no prerelease pinned anywhere (the catalog, the label, the digests, which must be
  the stable tags' digests); `apps/cli/package.json` carries the version; and the commit is a
  promotion. Allowed after the `next` tag: `.changeset/`, `CHANGELOG.md` files, the CLI package's
  `version` line, `deploy/helm/mend/Chart.yaml`, `docs/`, `apps/docs/`, `apps/marketing/` and
  top-level Markdown.
- The sealantd pin is covered transitively: Mend refuses a prerelease Core, and Core refuses a
  prerelease sealantd.

**Core, `release.yml`, job `pins`,** before any image builds or publishes: no prerelease in the
sealantd image references, in the `@sealant/runtime-*` dependency ranges, or in the versions the
lockfile resolves for them.

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
- There is no way back to 0.35.x or to an earlier preview: upgrade refuses a lower version, because
  migrations do not run backwards. The docs page says so before the first command.

### Rolling back a bad prerelease

- **npm:** move the dist-tag back and deprecate the bad version:
  `npm dist-tag add @sealant/mend@0.36.0-next.60 next` and
  `npm deprecate @sealant/mend@0.36.0-next.61 "Withdrawn: <reason>. Use 0.36.0-next.62."`. Same for
  the Core and sealantd packages. Never unpublish: lockfiles name the version, and npm forbids
  reusing it. Both commands need an owner's npm login with 2FA; a trusted publisher can do the
  dist-tag move only with **Allow npm dist-tag** and npm 11.21 or later, which we do not need yet.
- **Images:** leave them. Nothing floats, so nothing pulls a bad image that was not named exactly.
- **Mend's GitHub prerelease:** edit its notes to say it is withdrawn and which version replaces it.
  Do not delete it: servers pinned to that version read its assets on a fresh setup.
- **Servers already on it** move forward only: publish a fixed `next` and upgrade.
- **A bad Core prerelease pinned by Mend:** revert Mend's pin pull request. The pin is one commit.

### Provenance and security

- Every npm publish uses OIDC trusted publishing from a GitHub-hosted runner with `--provenance`. No
  npm token exists in any repository. Recommended once this works: **Require two-factor
  authentication and disallow tokens** on all five packages.
- Who can publish a prerelease: in Core and sealantd, whoever can merge to main (required checks
  `Lint`/`Typecheck` and `rust`/`node` hold); in Mend, only an admin, who alone can create `v*` tags
  (ruleset `protect-release-tags`), and only after your approval in `release`.
- Neither `next.yml` runs for a fork: `push` to main and `workflow_run` on main only. Neither can
  publish to `latest`.
- Images push with the workflow's `GITHUB_TOKEN` (`packages: write`) into the existing public
  packages. A prerelease version tag is never rewritten: a run whose version already exists skips.

## Considered

- **One `release.yml` per repository with both triggers.** It would reuse the existing trusted
  publisher, but Core's and sealantd's `release` environments deploy only `v*.*.*` tags and require
  a review, and the tag path's QEMU builds, smoke test and GitHub release do not belong on every
  merge.
- **Mend on every merge.** Thirty to forty-five minutes on eight runners and an approval per merge,
  for builds nobody chose to hand out.
- **Retagging Core's proven `next` images as the stable release.** Promotes the exact bytes, but the
  stable tag's commit is the Version Packages merge, not the proven commit, and Mend's final `next`
  (step 3) proves the rebuilt stable images anyway.
- **Folding preview builds into `next`.** A preview combines unmerged branches of three
  repositories; publishing that to npm would hand people code no one merged.
- **Keeping `--lockfile=false` and pinning only our own packages exactly.** It fixes drift of our
  prereleases but leaves third-party drift, which is the incident that already happened.

## Consequences

- A Mend pull request that needs a new Core API waits for Core main's `next.yml` (images, e2e, npm),
  not for a Core release.
- People can install a preview with one npm command and upgrade to the stable release without
  reinstalling.
- Core and sealantd spend runner time on every merge: three images times two architectures and the
  workspace e2e for Core, one image times two for sealantd.
- A dependency change in Core without its lockfile fails CI.
- The first stable release under these rules, 0.36.0, needs a `next` tag first; the guard refuses it
  otherwise.
- The box's deploy command (outside this repository) must accept `0.36.0-next.N` and
  `0.36.0-next.N.preview.R`. `scripts/preview-deploy.sh` does.

## Delivery

| Repository | Pull request                                                                                    |
| ---------- | ----------------------------------------------------------------------------------------------- |
| Core       | 1. Every install reads the committed lockfile                                                   |
| sealantd   | 2. `next.yml`: prerelease image and npm packages; exact `runtime-protocol` dependency           |
| Core       | 3. `next.yml`, the release's pin guard, the recovery check for prerelease sealantd, exact deps  |
| Mend       | 4. This ADR                                                                                     |
| Mend       | 5. The `next` channel: pin guard, promotion check, pin script, preview versions, frozen install |
| Mend       | 6. Docs: try a preview                                                                          |
| Mend       | 7. ROADMAP "How releases work"                                                                  |

Then, once you have done decision 3: the first Core and sealantd prereleases publish on their next
merge. Core pins a sealantd prerelease when it needs one; Mend pins Core `0.39.0-next.N` to unblock
sealant#313, #315 and #316.

## Decision log

- 2026-10-04: one version scheme, `X.(Y+1).0-next.N`, counted from the minor's first release.
- 2026-10-04: nothing about a prerelease is committed; no changesets pre mode, no snapshot command.
- 2026-10-04: Core and sealantd publish per merge from a `next` environment; Mend per `next` tag
  through its existing release workflow.
- 2026-10-04: a stable Mend release is refused unless it promotes a `next` build.
- 2026-10-04: lockfile-bound installs in Core before any publish job exists.
- 2026-10-04: preview builds stay, renumbered into main's order.
