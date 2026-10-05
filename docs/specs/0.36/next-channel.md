# The `next` prerelease channel across sealantd, Core and Mend

- **Release:** 0.36
- **Status:**
  - **On main:** mend#521 and mend#522 (2026-10-04); sealant#318 and sealant#319 (2026-10-04);
    sealantd#137 and sealantd#138 (2026-10-04); sealant#321 (2026-10-05); mend#531 and mend#532
    (2026-10-05).
  - **In review:**
    - mend#523 (docs: try a preview);
    - mend#524 (ROADMAP "How releases work");
    - the "Argument list too long" fix: mend#533, sealant#322, sealantd#140, all open.
  - **Published:**
    - Core `0.39.0-next.682` and `0.39.0-next.683`;
    - sealantd `0.20.0-next.142`.
  - **Not yet on npm:** Mend's first next build, `v0.36.0-next.601`. Its npm step failed (see Edge
    cases).
- **PRs:** mend#521, mend#522, mend#523, mend#524, mend#531, mend#532; sealant#318, sealant#319,
  sealant#321; sealantd#137, sealantd#138. The fix in flight: mend#533, sealant#322, sealantd#140.
- **Decision records:** docs/adr/0015-next-channel.md (Mend). Runbook:
  docs/operations/next-channel.md (Mend). Also Core `DEVELOPMENT.md` and sealantd
  `docs/runtime/integration.md`.
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`.

## Why it exists

Mend compiles against `@sealant/sdk` from npm and bundles Core's images, and Core bakes in sealantd.
Before this, a Mend change that needed a new Core API waited for a Core release, and that waited for
a sealantd release. The roadmap allowed one of each per Mend release. In October 2026 three Mend
changes were blocked this way: faster status polling (sealant#314), `available` on a run's changes
(sealant#313), and the steering login switch (sealant#315, sealant#316).

Nobody outside the box could try Mend before a release: preview builds reached only the box.

There was also a live supply-chain gap. Core installed with `pnpm install --lockfile=false` in CI,
release and image builds, and on 2026-09-13 an Effect `rc` drifted into the `sealant-api` image that
way. With prereleases of Sealant's own packages on npm, `workspace:^` ranges would let a newer
prerelease drift into any image (ADR 0015, "The drift that has to go first").

The owner's 0.36 goal is a release shared with people and bulletproof. That needs a channel people
can install with one command, and a stable release that is provably the build that ran on the box.

## What it does

**Versions.** One scheme in all three repositories: `B-next.N`.

- **N** is `git rev-list --count <commit>`, the commit's whole history. It never restarts at a tag.
- **B** is the larger of two bases:
  - what the pending changesets would release: the highest stable tag the commit contains, bumped by
    the largest pending changeset of the released package or its `fixed` group (patches only or
    none: `X.Y.(Z+1)`; any minor: `X.(Y+1).0`; any major: `(X+1).0.0`), or the package's own version
    when it is higher (Version Packages merged, not yet tagged);
  - the base of the highest next build already handed out above that tag. For Mend that is its
    `vX.Y.Z-next.N` tags. For Core and sealantd it is also the package's published next versions on
    npm.
- A preview build of an unmerged branch is `B-next.N.preview.R`: B and N of the branch's merge base
  with `origin/main`, and R the preview workflow's run number.

Observed on 2026-10-04/05:

| Repository | Commit      | Count | Version           |
| ---------- | ----------- | ----- | ----------------- |
| Core       | `ef9e537`   | 682   | `0.39.0-next.682` |
| Core       | `bc9ec42`   | 683   | `0.39.0-next.683` |
| sealantd   | `07ada50`   | 142   | `0.20.0-next.142` |
| Mend       | `c9b645b0b` | 601   | `0.36.0-next.601` |

**What publishes, and when.**

- **sealantd:** every commit on main whose `ci` run succeeded, from a push to this repository
  (`next.yml`, `workflow_run`).
  - Image: `ghcr.io/sealant-sh/sealantd-next:<version>`, amd64 and arm64, built natively and merged
    by digest.
  - npm, under `next`: `@sealant/runtime-protocol-next` and `@sealant/runtime-client-next`
    `<version>`, with provenance.
- **Core:** every push to main (`next.yml`).
  - The unit and integration tests (against Postgres) and the workspace runtime e2e against the
    pinned sealantd must pass first.
  - Images: `ghcr.io/sealant-sh/sealant-{api,worker,ssh-gateway}-next:<version>`, amd64 and arm64,
    built natively.
  - npm, after the images: `@sealant/api-contracts-next` and `@sealant/sdk-next` `<version>` under
    `next`, with provenance. `sealant-web` is release-only.
- **Mend:** on demand. An admin pushes `vX.Y.Z-next.N` on a main commit. `release-cli.yml` then
  runs:
  1. the pins guard;
  2. images, the same `mend`, `mend-api` and `mend-web` names as releases;
  3. packaged acceptance on both architectures;
  4. a GitHub prerelease with the setup assets;
  5. after the owner's approval in `release`, `@sealant/mend@<version>` under npm `next`.

  `latest` npm and image tags are not touched.

**Separate packages and images.**

- Prereleases of Core and sealantd never publish under the stable names.
- The `next` trusted publisher (workflow `next.yml`, environment `next`) is registered only on the
  four `-next` packages.
- Consumers pin prereleases by exact alias:
  - Mend's catalog: `"@sealant/sdk": npm:@sealant/sdk-next@0.39.0-next.683`;
  - Core's `packages/workspaces/package.json`:
    `"@sealant/runtime-client": "npm:@sealant/runtime-client-next@0.20.0-next.142"`.
- A `-next` package depends on its sibling only as `npm:@sealant/<sibling>-next@<same version>`.
- Mend's own next builds stay `@sealant/mend` on the `next` dist-tag, because people install
  `npm install --global @sealant/mend@next`.

**What a person trying a next build does** (mend#523, in review):

```sh
npm install --global @sealant/mend@next
mend server setup
# later
npm install --global @sealant/mend@next && mend server upgrade --version "$(npm view @sealant/mend@next version)"
# the release
npm install --global @sealant/mend@latest && mend server upgrade --version latest
```

A server moves forward only. `mend server upgrade` refuses a lower version:
`Refusing downgrade from <from> to <to>. Database migrations may not be reversible.`

**Promotion to stable.** A stable release is a promotion, in one order per Mend release (ADR 0015,
"Promotion"; runbook "Release"):

1. sealantd merges its Version Packages PR, which freezes its main. That commit publishes
   `X.Y.Z-next.N`.
2. Core pins that build (`pin-sealantd.mjs`).
3. sealantd tags `vX.Y.Z` on that commit.
4. Core pins sealantd `vX.Y.Z` and merges its Version Packages PR, which freezes its main.
5. Mend pins that Core build, cuts a next build and runs it on the box.
6. Core tags its release.
7. Mend pins Core's release and cuts a next build of its own release version: the proof.
8. Mend merges its Version Packages PR and tags it.

Guards refuse the steps that can be checked. The rest is the runbook checklist.

**The box, once.** It ran `0.36.0-preview.K`, which sorts above every `0.36.0-next.*`.
`mend server upgrade --version <next or new-style preview> --from-preview` moves it once, after
checking migrations. The CLI help reads:
`once, from a preview numbered X.Y.Z-preview.K to a next build X.Y.Z-next.N; refused unless the target carries every migration the server applied`.

**In scope.**

- `next-version.mjs`: the same file in all three repositories.
- Core and sealantd `next.yml`: plan, image, image-tag, Core's `test` and `workspace-e2e`, pack,
  publish.
- The republish block: the same in all three.
- `check-tarball.mjs` (Core, sealantd).
- The release guards:
  - Mend `check-release-pins.mjs`;
  - Core `check-release-pins.mjs` and `--stray`;
  - sealantd's `stable-tag` job.
- The pin tools: Mend `sealant-pins.mjs`, Core `pin-sealantd.mjs`.
- The image rules: Mend `image.yml` (a version is pushed once; a dispatch must come from main and
  name a tagged or dev version).
- The preview renumbering in Mend `preview.yml`.
- `--from-preview` and `/app/migrations.txt` in Mend's image.
- Core's recovery check accepting `sealantd-next`.
- Lockfile-bound installs (Core #318, Mend `version.yml`) and the CI check that refuses a
  lockfile-free install.
- Exact internal dependencies (`workspace:*`).
- CODEOWNERS (Core, sealantd).
- Action and BuildKit/binfmt pins in every write-token job.
- The socat checksum (sealantd#138).
- Mend main pinning Core `0.39.0-next.683` and sealantd `0.20.0-next.142` (mend#531, mend#532;
  sealant#321).

**Out of scope.**

- **No credential boundary for images.** A job holding `packages: write` can push any image of its
  repository, stable ones included. Making it otherwise needs a separate credential for stable
  images (ADR 0015, "Known gaps").
- **Mend servers pull `ghcr.io/sealant-sh/mend:<version>` by tag.** Image digests are not in the CLI
  package (recommended follow-up, not built).
- **Byte-identical stable releases.** Core's and sealantd's stable images are rebuilt from the tag.
  Base images float, `corepack` is unpinned in Mend's Dockerfile, `ssh2`'s own deps resolve at build
  time, and `@opentui/*` are carets in the published CLI.
- **Mend has no CODEOWNERS and no required review on main.**
- **Changesets pre mode or `--snapshot`.** Nothing about a prerelease is committed.
- **Floating image tags.** `next` and `edge` never exist.
- **A Mend migration changed under the same id and name.** `--from-preview` cannot detect it: Mend
  stores no migration hash.
- **An ordinary preview-to-next upgrade** checks no migrations.

## How it works

**1. Computing a version** (`scripts/next-version.mjs`; Core `tooling/scripts/next-version.mjs`;
byte-identical, sha256 `1f005e25…`).

- `planAt` (`:181-197`) reads, at the commit:
  - the package's `package.json`;
  - `.changeset/config.json`, for its `fixed` group;
  - every `.changeset/*.md` except README;
  - `git tag --merged <commit> --list v*`.
- `planNext` (`:87-105`) takes the highest of three candidates:
  - the anchor tag bumped by the top changeset level;
  - the package version, if above the anchor;
  - the core of every handed-out `X.Y.Z-next.N` above the anchor.
- `refuseShallow` (`:131-135`) throws on a shallow clone.
- `registryRecord` (`:142-163`) fetches `<registry>/<package>` with 4 attempts at 1.5 s × attempt.
  Any non-OK answer, a 404 included, ends in a throw, never in "nothing published".
- CLI modes (`:239-294`):

  | Mode                                     | What it does                                                                                                                |
  | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
  | `--package <dir> [--npm <pkg>] [commit]` | the version                                                                                                                 |
  | `--preview <run> --main <ref>`           | the preview version of the merge base                                                                                       |
  | `--stray vX.Y.Z [--npm]`                 | exit 1 if a next build of X.Y.Z comes from a commit that is not an ancestor; an npm build without `gitHead` counts as stray |
  | `--newer <a> <b>`                        | exit 0 only if a > b; garbage on either side is not newer                                                                   |
  | `--published <pkg> <version>`            | prints the `gitHead`, `unknown`, or nothing                                                                                 |
  | `--dist-tag <pkg> <tag>`                 | prints the tag's version                                                                                                    |

**2. sealantd `next.yml`** (sealantd `.github/workflows/next.yml`).

- **Trigger.** `workflow_run` of `ci` on main, `completed`. `plan` runs only if:
  - the repository is `sealant-sh/sealantd`;
  - the CI run's conclusion is `success`;
  - its event is `push`;
  - its head repository is this one (`:43-46`).

  Concurrency group `next`, `cancel-in-progress: false`.

- **`plan`** (`:42-103`):
  1. Check out `head_sha` with full history.
  2. `next-version.mjs --package packages/runtime-client --npm @sealant/runtime-client-next HEAD`.
     The answer must match `^\d+\.\d+\.\d+-next\.\d+$`.
  3. `--published`:
     - published from this sha: `publish=false`;
     - published from another sha: fail.
  4. `--dist-tag … next`, then `--newer`: fail if `next` is already as new.
- **`image`.** Per architecture, native runners, BuildKit `v0.33.1@sha256:cec9f139…`. Push by digest
  to `ghcr.io/sealant-sh/sealantd-next`, with labels for source, revision and version.
- **`image-tag`.** `imagetools create --tag <version>` only if that tag does not exist yet: a
  version is tagged once. It outputs the digest.
- **`pack`** (no `id-token`):
  1. `pnpm install --frozen-lockfile --ignore-scripts`.
  2. `npm version <v>` and `gitHead=<sha>` in both packages.
  3. `pnpm -r build`.
  4. Rename to the `-next` names, with runtime-client depending on
     `npm:@sealant/runtime-protocol-next@<v>`.
  5. `pnpm pack`.
  6. `check-tarball.mjs`: every file `exports`, `main` and `types` name is present, nothing sits
     outside `package/`, and there is exactly one `package.json`.
  7. Upload `next-tarballs`.
- **`publish`.**
  - Runs on `ubuntu-latest`, environment `next`, `id-token: write`.
  - Node 24 with `package-manager-cache: false`. It downloads the artifact and runs the republish
    block (step 4 below) for runtime-protocol-next, then runtime-client-next.
- **The `next` environment** in sealantd deploys only from branch `main` (environments API,
  2026-10-05).

**3. Core `next.yml`** (Core `.github/workflows/next.yml`).

- **Trigger.** `push` to main, `if: github.repository == 'sealant-sh/sealant'`. Concurrency `next`,
  no cancel.
- **`plan`** (`:42-98`): as sealantd's, with `--package packages/sdk --npm @sealant/sdk-next`.
- **`image`** (`:100-163`): per image × arch, pushed by digest to `sealant-<image>-next`,
  `provenance: false`.
- **`test`** (`:167-211`): Postgres 17, `pnpm install --frozen-lockfile`, `pnpm db:migrate`,
  `pnpm exec turbo test --force`. It restores `cache: pnpm`, but holds no write token.
- **`workspace-e2e`** (`:215-251`): builds the baked workspace image (pulls the pinned sealantd) and
  runs the sealantd e2e suite with `SEALANT_E2E_REQUIRE_IMAGE=1`, plus the containerized launcher
  test.
- **`image-tag`** (`:255-295`): needs `image`, `test` and `workspace-e2e`. Tags once, as sealantd's.
- **`pack`** (`:299-361`):
  1. Frozen install, `--ignore-scripts`, no store cache.
  2. Version and `gitHead`.
  3. Build `@sealant/api-contracts` and `@sealant/sdk`.
  4. Rename to `-next`, with `@sealant/sdk-next` depending on `npm:@sealant/api-contracts-next@<v>`.
  5. Pack, then `check-tarball.mjs`.
- **`publish`** (`:365-579`): environment `next`. Republishes `api-contracts-next`, then `sdk-next`.
- **The `next` environment** in Core deploys only from branch `main`.

**4. The republish block.** It is the same text in Mend `release-cli.yml:122-293`, Core
`next.yml:392-563` and sealantd `next.yml`. `republish.test.mjs` (identical in all three) extracts
it from the workflow and runs it against a stub registry.

1. `check_artifacts`: the artifact directory holds exactly the expected tarball names, as regular
   files and not symlinks, and nothing else.
2. `cd "$(mktemp -d)"`: every npm command runs from an empty directory, so no `.npmrc` beside the
   artifact applies.
3. `publish_rebuilt`:
   1. `published_from <name> <version>` reads the full registry document. If the version exists from
      the same commit, the step is done; from another commit, it fails.
   2. Under `next`, `dist_tag <name> next` reads the uncached `/-/package/<name>/dist-tags`. `newer`
      must hold.
   3. `rebuild_tarball`:
      - extracts with npm's bundled pacote (`$(npm root -g)/npm/node_modules/pacote`);
      - rewrites `package.json` from `KEEP_FIELDS` plus `publishConfig.access` only, which drops
        `tag`, scripts and other `publishConfig` keys;
      - checks the rewritten manifest:
        - the name (a `-next` name, except `@sealant/mend`);
        - the version shape (`X.Y.Z-next.N` under next, `X.Y.Z` under latest);
        - `gitHead` = the commit;
        - every `@sealant/*` dependency of a `-next` package is exactly
          `npm:@sealant/<dep>-next@<version>`;
        - no `npm:` alias anywhere else;
        - no root `binding.gyp`;
      - deletes any `.npmrc` in the tree;
      - runs `npm pack --ignore-scripts --json`.
   4. `npm publish <rebuilt> --tag <channel> --access public --ignore-scripts --provenance`.

**5. Mend's release** (`.github/workflows/release-cli.yml`, trigger `push` tags `v*.*.*`).

- **`pins`** (`:20-33`): full history, then `node scripts/check-release-pins.mjs "$GITHUB_REF_NAME"`
  (see 6).
- **`images`** (`:35-42`): calls `image.yml` with `packages: write`. The merge job refuses an
  existing `ghcr.io/sealant-sh/mend:<version>` with
  `<repo>:<version> already exists; a version is pushed once.` (dev and acceptance builds excepted;
  `image.yml:180-187`). Packaged acceptance runs on both architectures.
- **`npm-pack`** (`:46-88`):
  - no `id-token`;
  - frozen install with `--ignore-scripts`;
  - `npm version <tag version>` and `gitHead=$GITHUB_SHA` in `apps/cli`;
  - build, `pnpm pack`;
  - upload `mend-tarball`.

  There is no `check-tarball` step.

- **`github-release`** (`:307-391`, `contents: write`):
  - For a version with `-`, the notes are the fixed next text and the release is created with
    `--prerelease`. `--latest=false` always.
  - It uploads `compose.v2.yaml`, `postgres-init.sh`, `setup-contract.v2.json` and `install.sh`, and
    verifies anonymous downloads match.
- **`npm`** (`:95-304`):
  - `needs: [images, github-release, npm-pack]`;
  - environment `release`, which requires the owner's review and deploys only from tags `v*.*.*`;
  - `ubuntu-latest`, Node 24, `id-token: write`;
  - no checkout;
  - channel `next` if the version contains `-`, else `latest`;
  - runs the republish block with `--provenance`.
- **`promote-images`** (`:393-417`): exits at once for a prerelease. For a stable release it retags
  `mend`, `mend-api` and `mend-web` `latest` and marks the GitHub release latest.

**6. Mend's pins guard** (`scripts/check-release-pins.mjs:139-212`).

- **Every tag.**
  - The tag matches SEMVER.
  - `pinProblems` (`sealant-pins.mjs:94-129`):
    - the Dockerfile label `dev.sealant.mend.sealant-version` is an exact version;
    - the catalog's `@sealant/sdk` and `@sealant/api-contracts` equal `catalogSpec(version)`: plain
      for a release, `npm:<name>-next@<v>` for a prerelease;
    - each `ARG SEALANT_{API,WORKER,SSH_GATEWAY}_IMAGE` is
      `ghcr.io/sealant-sh/sealant-<x>[-next]@sha256:<64 hex>`;
    - `MEND_PREVIEW_SEALANTD_IMAGE` is `""`.
  - `assetProblems` (`:219-253`): both `setup-contract.v2.json` copies, both `compose.v2.yaml`
    copies and `bundle-supervisor.mjs` name the version.
  - `digestProblems` (`:195-213`): each pinned digest equals the `docker-content-digest` GHCR serves
    anonymously for `<repo>:<version>`.
  - The commit is an ancestor of `origin/main`.
- **A next tag** (`:151-169`):
  - It must be `X.Y.Z-next.N`.
  - It must equal `nextVersionOf("HEAD", "apps/cli", <every other next tag>)`; otherwise
    `This commit's next version is <expected>, not <version>.`
  - No higher next tag may exist; otherwise
    `<tag> already exists; npm's next only moves forward. Tag a newer commit.`
- **A stable tag** (`:170-211`):
  - `lockfilePrereleases`: no `@sealant/*-next@…` in `pnpm-lock.yaml`.
  - `apps/cli/package.json` carries the version.
  - `strayBuildsOf(version, HEAD)`: no next tag of X.Y.Z off HEAD's ancestry.
  - The newest next tag of X.Y.Z merged into HEAD exists, and npm has it (`published`, `:120-126`, a
    single GET with no retry).
  - `promotionProblems` (`:65-100`): since that tag, `git diff --no-renames --name-only` touches
    only `.changeset/`, `*/CHANGELOG.md`, `docs/`, `apps/docs/`, `apps/marketing/` and top-level
    `*.md`, never a `package.json`. Two exceptions:
    - `apps/cli/package.json`, whose only changed line may be `"version"`;
    - `deploy/helm/mend/Chart.yaml`, whose only changed lines may be `version` and `appVersion`,
      with `appVersion` equal to the release.

**7. Core's and sealantd's stable guards.**

- **Core `release.yml` `pins`:**
  - `check-release-pins.mjs` (Core):
    - the tag is stable;
    - every sealantd reference in `buildkit-builder.ts` and `apps/cf-bridge/Dockerfile` matches
      `^ghcr\.io/sealant-sh/sealantd:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$` (`:31`);
    - no prerelease in the `@sealant/runtime-*` ranges of ssh-gateway, telemetry or workspaces, nor
      in the lockfile;
    - no `npm:` alias in `packages/{sdk,api-contracts}/package.json`.
  - `next-version.mjs --stray "$GITHUB_REF_NAME" --npm @sealant/sdk-next HEAD`.
- **sealantd `release.yml` `stable-tag`:**
  - the tag matches `^v\d+\.\d+\.\d+$`;
  - no `npm:` alias in `runtime-{protocol,client}`;
  - `--stray … --npm @sealant/runtime-client-next HEAD`.
- **Release environments.** Both repositories' `release` environments require reviewers and deploy
  only from tags `v*.*.*`.

**8. Pins.**

- **Mend:** `node scripts/sealant-pins.mjs pin <core-version>` (`:271-297`).
  1. Reads the three digests from GHCR: `-next` repositories for a prerelease.
  2. Rewrites every `PIN_FILES` entry (`:30-39`): `Dockerfile`, `pnpm-workspace.yaml`,
     `scripts/bundle-supervisor.mjs`, `scripts/bundle-packaging.test.mjs`, both `compose.v2.yaml`
     copies and both `setup-contract.v2.json` copies. Image references and the version are replaced
     as whole tokens, and the catalog becomes an alias or plain version.
  3. Checks `pinProblems`.
  4. Runs `pnpm install`.
- **Core:** `node tooling/scripts/pin-sealantd.mjs <version>`.
  1. Reads the digest from `sealant-sh/sealantd[-next]`.
  2. Writes `ghcr.io/sealant-sh/sealantd[-next]:<version>@sha256:<digest>` into both image files.
  3. Sets both runtime packages in `packages/workspaces/package.json` exact: aliases for a
     prerelease.
  4. Runs `pnpm install`.
- **Recovery boot.** Core's recovery check (`packages/workspaces/src/runtime/daemon-recovery.ts:41`)
  accepts `ghcr.io/sealant-sh/sealantd:X.Y.Z` or `ghcr.io/sealant-sh/sealantd-next:X.Y.Z-next.N`
  from 0.19.0 on, with an optional digest.
- **Current pins.**
  - Core main: `ghcr.io/sealant-sh/sealantd-next:0.20.0-next.142@sha256:5983d0b8…` and
    `npm:@sealant/runtime-*-next@0.20.0-next.142` (sealant#321).
  - Mend main pins Core `0.39.0-next.683`:
    - catalog: aliases;
    - images: `sealant-*-next@sha256:1114bdcf…`, `a0873bea…` and `27f38ffa…`;
    - label: `0.39.0-next.683`.

    (mend#532.)

**9. Previews and the box.**

- `preview.yml` computes
  `next-version.mjs --package apps/cli --preview "$RUN_NUMBER" --main origin/main HEAD`.
- `deploy-box.yml` and `scripts/preview-deploy.sh` accept `0.36.0-next.N` and
  `0.36.0-next.N.preview.R`.
- **Migrations manifest.** Mend's image writes `/app/migrations.txt` (`Dockerfile:28,73-81`):
  - `mend <id>_<name>` from `scripts/mend-migrations.mjs`;
  - `sealant <folder> <sha256 of migration.sql>` for each drizzle folder.

  The build fails if either kind is missing.

- **`--from-preview`** (`apps/cli/src/server-setup.ts:1965-2212`):
  - `isPreviewToNext` requires the server to be on `X.Y.Z-preview.K` and the target to be
    `X.Y.Z-next.N[.preview.R]` of the same X.Y.Z. Any other use of the flag is refused.
  - `checkPreviewMigrations` reads the target's `/app/migrations.txt` with
    `docker run --rm --entrypoint cat`. It also reads `mend_migrations` and
    `drizzle.__drizzle_migrations` from the running Postgres. `migrationProblems` (`:2012-2081`)
    refuses when:
    - a Mend migration the server applied is missing in the target by id and name;
    - a target Mend migration at or below the highest applied id was never applied;
    - a Sealant migration the server applied is missing, matched by folder (or by folder time for
      old rows);
    - a Sealant migration's hash changed.
  - The refusal names each problem and ends `Nothing was changed.` The check runs before the new
    generation is prepared, so the previous generation stays the preview.
  - Ordinary downgrades are still refused. With a preview-to-next pair, the refusal suggests
    `--from-preview`.

**10. Lockfile and supply chain.**

- Core: every `pnpm install` in CI, `release.yml`, `version.yml` and the four Dockerfiles is
  `--frozen-lockfile`. `ssh2@1.17.0` is exact.
- Core's and Mend's `ci.yml` fail on `lockfile=false`, `PNPM_CONFIG_LOCKFILE` or
  `no-frozen-lockfile` in workflows, Dockerfiles or scripts.
- `@sealant/sdk` → `@sealant/api-contracts` and `runtime-client` → `runtime-protocol` are
  `workspace:*` (exact on publish).
- Core's `minimumReleaseAgeExclude` names the two runtime packages and their `-next` packages
  (`pnpm-workspace.yaml:69-73`).
- sealantd builds with `cargo build --locked`.
- sealantd's socat comes over HTTPS and is checked against a pinned sha256 (sealantd#138).
- Every action in a write-token job is pinned to a commit. BuildKit `v0.33.1@sha256:cec9f139…` and
  binfmt `qemu-v10.2.3-68@sha256:400a4873…` are pinned. No write-token job restores a cache.

**Ordering and concurrency.**

- Core and sealantd `next` runs share one concurrency group per repository, and do not cancel a
  running one.
- The forward-only check runs twice: in `plan`, before any build, and right before `npm publish`.
- Mend checks tag order in `pins` and checks `next` again in the `npm` job, after approval.
- On a re-run:
  - an image tag that exists is kept;
  - a package already published from the same commit is skipped;
  - one from another commit is refused.

## Happy path

Yiannis (owner, admin) merges sealant#319 on 2026-10-04.

1. Core's `next.yml` run 37243345550 (on `ef9e537`):
   - computes `0.39.0-next.682` (count 682; B = `0.39.0` from a pending minor over `v0.38.1`);
   - finds nothing published from another commit;
   - builds six images, runs the tests and the e2e, and tags
     `sealant-{api,worker,ssh-gateway}-next:0.39.0-next.682`;
   - packs, and publishes `@sealant/api-contracts-next` and `@sealant/sdk-next` `0.39.0-next.682`
     under `next` at 23:24:59Z.

   The run summary says: `Pin it in Mend: node scripts/sealant-pins.mjs pin 0.39.0-next.682`.

2. sealantd#136 merges as `07ada50`. `ci` succeeds. `next.yml` run 37243952334 publishes
   `ghcr.io/sealant-sh/sealantd-next:0.20.0-next.142` and the two runtime `-next` packages at
   23:34:52Z.
3. On 2026-10-05 Yiannis runs `node tooling/scripts/pin-sealantd.mjs 0.20.0-next.142` in Core and
   merges sealant#321 (`bc9ec42`). Core publishes `0.39.0-next.683` at 15:25:07Z (run 37331747877).
4. In Mend he runs `node scripts/sealant-pins.mjs pin 0.39.0-next.683`, then `pnpm format:fix`,
   opens mend#532 and merges it (`c9b645b0b`).
5. He cuts the Mend next build:

   ```sh
   git fetch origin main --tags
   version=$(node scripts/next-version.mjs --package apps/cli origin/main)   # 0.36.0-next.601
   git tag "v$version" origin/main && git push origin "v$version"
   ```

6. `release-cli.yml` run 37342721738 (16:41Z):
   - `pins` passes, the images build, packaged acceptance passes on amd64 and arm64;
   - the GitHub prerelease `v0.36.0-next.601` is created with its four assets;
   - Yiannis approves `release`.

   **Intended:** `@sealant/mend@0.36.0-next.601` publishes under `next`, and
   `npm install --global @sealant/mend@next` installs it. **Observed:** the npm step failed (see
   Edge cases), so Anna, trying it, would find `npm view @sealant/mend dist-tags` shows only
   `latest: 0.35.1`.

7. **Intended, once a next build is on npm:**
   - On the box: `npm install --global @sealant/mend@0.36.0-next.<M>`, then the box loop from the
     runbook, then `mend server upgrade --version 0.36.0-next.<M> --from-preview`.
   - It prints
     `ghcr.io/sealant-sh/mend:0.36.0-next.<M> carries all <k> migrations this server applied.` and
     upgrades.
   - From then on `deploy-box.yml` deploys next builds and new-style previews.
8. **At release:** sealantd tags `v0.20.0`; Core pins it and tags `v0.39.0`; Mend pins `0.39.0`,
   cuts `v0.36.0-next.<P>`, proves it on the box, merges Version Packages and tags `v0.36.0`. `pins`
   finds no prerelease pinned or locked, the promotion diff clean, and `v0.36.0-next.<P>` on npm.
   `@sealant/mend@0.36.0` publishes as `latest`, and the images are retagged `latest`.

## Invariants

1. **Versions only go up.** In each repository, each next build published is strictly higher than
   every next build published or tagged before it, and every stable `X.Y.Z` is higher than every
   `X.Y.Z-next.*`. N never decreases, and B never falls below a base handed out since the last
   stable tag.
2. **An older commit never publishes after a newer one.** It computes a lower version, and `plan`
   (Core, sealantd) or `pins` (Mend) refuses it before any build.
3. **npm's `next` dist-tag never moves back through a workflow.** Every publish re-reads `next`
   uncached right before `npm publish` and refuses a version that is not newer.
4. **A version is published from exactly one commit.** A re-run on the same commit skips what is
   already there. A different commit with the same version is refused (the `gitHead` check).
5. **A next workflow cannot touch the stable packages.**
   - No next workflow can publish `@sealant/sdk`, `@sealant/api-contracts`,
     `@sealant/runtime-protocol` or `@sealant/runtime-client`, or move their `latest`. The `next`
     trusted publisher exists only on the four `-next` packages, the rebuilt manifest must carry a
     `-next` name, and `--tag next` is explicit.
   - `@sealant/mend` publishes only from `release-cli.yml` in environment `release`: the owner's
     approval, deployable only from a `v*.*.*` tag.
6. **The job that holds an npm credential checks out nothing, installs nothing and runs no
   repository code.**
   - It publishes only a tarball it rebuilt with npm's own pacote and an allowlisted manifest. That
     manifest has no scripts and no `tag`; `publishConfig` is reduced to `access`, and a root
     `binding.gyp` is refused.
   - It runs npm from an empty directory and refuses an artifact holding anything but the expected
     tarballs.
7. **No npm token in any repository.** Every publish is OIDC trusted publishing from a GitHub-hosted
   runner, with `--provenance`. (Not verified read-only; see Divergences.)
8. **Image tags are never overwritten.**
   - A `-next` image version tag is created once and never moved by a workflow.
   - `ghcr.io/sealant-sh/mend:<version>` is pushed once, dev and acceptance builds aside.
   - No floating `next` or `edge` image tag exists.
9. **A stable Mend release ships no prerelease anywhere and promotes a proven build.**
   - Its catalog, label, digests and lockfile name no prerelease.
   - Its commit is on main.
   - It promotes the newest next build of its version that its commit contains, and that build
     reached npm.
   - Since that build, it changes only notes, docs and version lines.
10. **No release leaves out one of its own next builds.** No stable release of X.Y.Z, in any
    repository, is cut from a commit that leaves out a next build of X.Y.Z: a server on that build
    would lose work by "upgrading".
11. **A stable Core release pins no sealantd prerelease.**
    - Every sealantd image reference is a release, pinned `tag@sha256`.
    - No `@sealant/runtime-*` range or locked version is a prerelease.
    - No published manifest of Core or sealantd depends on an `npm:` alias.
12. **Mend's pinned Core digests match GHCR.** Each digest Mend pins equals what GHCR serves
    anonymously for that Core version's tag when the release runs.
13. **Every dependency install is bound to the lockfile.** That covers every install in a workflow
    or Dockerfile of Core and Mend, and every cargo build of sealantd (`--locked`).
14. **No server upgrade drops data.**
    - A server never moves to a lower version.
    - `--from-preview` refuses a target that lacks a migration the server applied, would skip one,
      or carries a changed Sealant migration. Nothing changes on the server before that check
      passes.
15. **The wording reports evidence, not verdicts.** Release notes for a next build say what was
    observed (`It passed the packaged acceptance; it is not a release.`). No workflow, guard or doc
    calls a build "safe" or "ready".

## Edge cases and failure behaviour

**Real events (2026-10-04/05)**

- **The placeholders.** On 2026-10-04 at 22:56–22:57Z the owner created the four `-next` packages
  with a `0.0.0-next.0` placeholder, which is `latest` on each.
  - `@sealant/sdk-next` also carries `0.0.0-stage`, described "Temporary package placeholder for
    staged publishing" (22:56:21Z).
  - `next-version.mjs` ignores both: `0.0.0-stage` is not a next version, and `0.0.0-next.0` is not
    above the anchor.
- **First Core publish.** `0.39.0-next.682` from `ef9e537`, at 23:24:59Z.
- **First sealantd publish.** `0.20.0-next.142` from `07ada50`, at 23:34:52Z. The merges of
  sealantd#138 (`42d69da`, count 140) and sealantd#137 (`231691f`, count 141) never published: their
  main `ci` runs were cancelled by the next push (`ci.yml` `cancel-in-progress: true`), and
  `next.yml` skipped them.
- **Second Core publish.** `0.39.0-next.683` from `bc9ec42` (sealant#321, pinning sealantd
  `0.20.0-next.142`), on 2026-10-05 at 15:25:07Z.
- **Mend's first release failed.** `v0.36.0-next.601` on `c9b645b0b`, run 37342721738.
  - `pins`, `npm-pack`, the images (eight builds, four merges), packaged acceptance on both
    architectures, and `Publish and verify setup assets` all succeeded.
  - `Publish @sealant/mend` failed at 16:59:39Z:
    `line 67: /opt/hostedtoolcache/node/24.21.0/x64/bin/node: Argument list too long`, exit 126.
  - **Cause.** `published_from` passed the whole registry document of `@sealant/mend` (about 206 KB)
    to `node -e` as one argument. Linux refuses one argument over 128 KB (`MAX_ARG_STRLEN`).
  - **Effect.** Nothing reached npm: the failure came before the publish, and `inherit_errexit`
    stopped the job. `@sealant/mend` dist-tags are `{ latest: "0.35.1" }`. The GitHub prerelease
    `v0.36.0-next.601` exists with its assets, and the `mend*:0.36.0-next.601` images exist.
  - **Fix.** mend#533, sealant#322 and sealantd#140 pass the JSON on stdin (`<<<"$var"`,
    `readFileSync(0)`) in `published_from`, `dist_tag` and the `npm pack --json` read. They add a
    test with a document over 256 KB. All three are open.
  - **Still exposed.** Core's and sealantd's publish jobs carry the same block. Their `-next`
    documents are 4–8 KB today and grow about 2 KB per publish, so each would hit the limit after
    roughly 60 more publishes without the fix.

**Repairing a failed Mend next build**

- **"Re-run failed jobs"** runs the workflow as it was at the tag's commit, so the same bug fails
  again.
- **A full re-run** fails at `image.yml` merge:
  `ghcr.io/sealant-sh/mend:0.36.0-next.601 already exists; a version is pushed once.`
- **The way out** is a new next tag on a main commit that contains mend#533 (N ≥ 602).
- **`v0.36.0-next.601` stays as a handed-out tag.**
  - It is on main, so it is never stray.
  - It cannot be the newest next build of 0.36.0 a stable release promotes, because `pins` requires
    that one on npm.
  - Its prerelease notes say `npm install --global @sealant/mend@next`, which fails (no `next`
    dist-tag on `@sealant/mend`). Once a later build publishes, the same command installs that build
    instead.
  - The notes link `https://docs.mend.run/getting-started/try-a-preview/`, which answers 404 until
    mend#523 merges.
  - `mend server setup --version 0.36.0-next.601` from another CLI would still work: the assets and
    images exist.
- **The box move** ("The box, once", step 2) needs a Mend next build on npm, and is blocked until
  one publishes.

**Concurrency**

- **Two merges in quick succession** (Core or sealantd). The second run waits for the first. A
  third, arriving while one runs and one is pending, cancels the pending one (GitHub keeps one
  pending run per group), so not every merge publishes. Versions stay monotonic.
- **A run of an older commit started after a newer commit published** fails in `plan` with
  `npm's next is already <v>; <older> from this commit is not newer. A newer commit published first.`
- **Two Mend next tags pushed close together.**
  - Each `pins` sees the tags as they were at its start.
  - If the newer build's npm publishes first, the older build's npm step fails after approval with
    `@sealant/mend's next is already <newer>, not older than <older>. Nothing was published.` Its
    GitHub prerelease and images remain.
  - Two approvals in the wrong order cannot move `next` back.
- **A merge to sealantd or Core during the freeze** (between its Version Packages merge and its tag)
  publishes `X.Y.Z-next.M` from a commit the tag on the Version Packages commit leaves out. The
  stable release then refuses: `<version> was built from <sha>, which vX.Y.Z would not contain…`.
- **Image job ran, publish failed.** A re-run keeps the existing image tag (Mend may already have
  pinned its digest) and publishes npm only.

**Restarts and partial failures**

- **npm unreachable or 5xx in `plan` or the guards.** Four attempts, then fail. A 404 never reads as
  "nothing published".
- **Exception: Mend's stable `published()` check** is one GET. A 5xx throws and fails `pins`; re-run
  it.
- **Core publishes `api-contracts-next`, then fails on `sdk-next`.** A re-run: `plan` sees
  `sdk-next` unpublished, `publish_rebuilt` finds `api-contracts-next` already published from this
  commit and skips it, then publishes `sdk-next`.
- **A GHCR digest that differs from the pin at Mend release time** (a tag moved after the pin) fails
  `pins`: `ARG <arg> pins <digest>, but ghcr.io/<repo>:<version> is <other>.`
- **GHCR `-next` packages not public.** `pins` and `pin` fail with `GHCR refused a pull token…` or
  `… is not published (HTTP 401)`. They are public as of 2026-10-05 (the 601 `pins` job read them
  anonymously).
- **`--from-preview` with a target image that has no `/app/migrations.txt`** (any image built before
  mend#522):
  `ghcr.io/sealant-sh/mend:<v> does not list its migrations (/app/migrations.txt), so --from-preview cannot check them. Nothing was changed.`
- **`--from-preview` failing after the target started.** The usual upgrade rollback to the previous
  generation, which is still the preview's image.

**Missing or odd input**

- **A Mend tag that is not SEMVER, or is a prerelease other than `-next.N`** (for example
  `v0.36.0-rc.1`): refused in `pins`.
- **A Core or sealantd tag with `-`:** refused
  (`… is a prerelease. Prereleases publish from main (next.yml), never from a tag.`).
- **A mistyped Mend next tag** (wrong N): refused in `pins`, but it counts as handed out from the
  moment it exists. Raised B for later builds, or a tag off main blocking its version's release; the
  runbook says to delete it with `git push origin --delete "v$version"`.
- **A shallow clone:** `This is a shallow clone: N would be wrong. Fetch the full history first.`
- **No reachable stable tag:** `No stable vX.Y.Z tag is reachable from this commit.`
- **Changesets.**
  - With pending patches only, builds are `X.Y.(Z+1)-next.N`.
  - Once any minor lands, `X.(Y+1).0-next.N`. B stays there after the minor is reverted, so the
    following release must be that minor: the patch release is no longer possible.
  - A server on `0.37.0-next.*` cannot take `0.36.1`.
- **A crafted tarball** (second manifest, `package/./`, a `tag` field, `publishConfig` redirects, a
  stable version, a forged `gitHead`, `binding.gyp`, a planted `.npmrc`): refused. Each case is
  covered by `republish.test.mjs`.

**Older data**

- **The box on `0.36.0-preview.K`.** It can only leave with `--from-preview`, to the same X.Y.Z.
- **Servers on releases** upgrade to next builds normally: a higher version.
- **Old Sealant drizzle rows without a name** are matched by folder time.
- **A Mend migration changed under the same id and name** cannot be detected.

**Permissions**

- **Mend next and stable tags:** only admins (ruleset `protect-release-tags`), then the owner's
  approval in `release`.
- **Core and sealantd prereleases:** anyone who can merge to main. Code-owner review is not enforced
  (see Divergences). The `next` environment deploys only from `main`.
- **Image pushes:** anyone with write access can run a branch workflow that asks for
  `packages: write` and push any image, stable ones included. No review stops it (ADR 0015, Known
  gaps).
- **Operators of Mend servers:** they pull `mend:<version>` by tag, so they are exposed to a
  pushed-over image.

**Clients**

- **CLI:** `@sealant/mend@next` bundles what it imports from `@sealant/*`, so installing it never
  resolves the SDK.
- **Server images** carry the Core pinned by that commit, possibly a Core prerelease, and Core's
  pinned sealantd.
- **Web, desktop, mobile, VS Code, Slack and the t3 gateway** run against whatever server version is
  installed. The `versions differ — the server's API wins` line in `mend version` shows a mismatch.

## Known limits

From ADR 0015, "Known gaps":

- **Images:**
  - no credential boundary for images;
  - digest pins trust what a tag pointed at when pinned;
  - `deploy/aws` pulls `sealant-api:0.33.0` and `sealant-worker:0.33.0` by tag;
  - every Mend server pulls `mend:<version>` by tag (follow-up: image digests in the CLI package).
- **Rebuilt stable releases are not byte-identical:**
  - floating base images;
  - unpinned `corepack` in Mend's Dockerfile;
  - `ssh2`'s transitive ranges;
  - `@opentui/*` carets in the published CLI;
  - Core's ssh-gateway and telemetry still on `^0.6.0` / `^0.4.0` of `@sealant/runtime-*`;
  - workspace images install agent CLIs at `@latest`, by design.
- **Migrations:** `--from-preview` cannot see a Mend migration changed under the same id and name.
  An ordinary preview-to-next upgrade checks no migrations.
- **Mend main:** no CODEOWNERS, no required review.
- **Core's and sealantd's stable npm jobs** still check out, install (frozen, `--ignore-scripts`)
  and build in the job that holds `id-token`. The republish hardening applies to next builds and to
  Mend's npm job only. The stable jobs rely on the tag-only, review-gated `release` environment.
- **The main freezes:** sealantd main and Core main each freeze from their Version Packages merge to
  their tag. Mend main is in effect frozen from the proving next build to its tag.
- **Mend next builds** take 30–45 minutes on eight runners and an approval each, so they are cut on
  demand, not per merge.
- **Withdrawing a prerelease** needs an owner's npm login with 2FA. Nothing in the workflows can
  move `next` back.

## How to verify

**Tests:**

- **Mend** (`ci.yml` runs them with `node --test`):
  - `scripts/next-version.test.mjs`: property test over generated histories; shallow refusal;
    strays; `--newer`.
  - `scripts/sealant-pins.test.mjs`: rewrite and pin problems.
  - `scripts/check-release-pins.test.mjs`: promotion diff, lockfile prereleases, newest tag.
  - `scripts/republish.test.mjs`: the republish block against a stub registry. mend#533 adds the
    over-256 KB case.
  - `scripts/release-publication.test.mjs`: the job boundaries in `release-cli.yml`.
  - `scripts/mend-migrations.test.mjs`.
  - `scripts/bundle-packaging.test.mjs`: digests.
  - `apps/cli/src/server-lifecycle.test.ts` and `apps/cli/src/server-migrations.test.ts`:
    `--from-preview`.
- **Core:**
  `tooling/scripts/{next-version,check-release-pins,check-tarball,republish,pin-sealantd}.test.mjs`
  (CI) and `packages/workspaces/src/runtime/daemon-recovery.test.ts`.
- **sealantd:** `scripts/{next-version,check-tarball,republish}.test.mjs` (CI).
- **Not covered by tests:**
  - the workflows end to end (Core's and sealantd's `next.yml` run only on main);
  - the size of real registry documents, which is what broke 601;
  - GitHub concurrency behaviour;
  - Mend's stable path end to end (no stable release has run under these rules);
  - `--from-preview` against the real box.

**By hand** (read-only checks):

```sh
npm view @sealant/mend dist-tags
npm view @sealant/sdk-next dist-tags versions
npm view @sealant/runtime-client-next dist-tags versions
curl -s https://registry.npmjs.org/@sealant%2fsdk-next | wc -c      # document size vs the 128 KB argv limit
gh run list -R sealant-sh/sealant --workflow next.yml --limit 5
gh run list -R sealant-sh/sealantd --workflow next.yml --limit 5
gh run view 37342721738 -R sealant-sh/mend --log-failed | grep -i 'too long'
cd Mend && git fetch origin main --tags && node scripts/next-version.mjs --package apps/cli origin/main
node scripts/check-release-pins.mjs v0.36.0-next.<N>                 # on main's head, as the pins job runs
gh api repos/sealant-sh/sealant/branches/main/protection -q .required_pull_request_reviews.require_code_owner_reviews
gh api repos/sealant-sh/mend/environments/release/deployment-branch-policies -q '.branch_policies[] | "\(.type):\(.name)"'
```

On the box, after a next build reaches npm:

```sh
npm install --global @sealant/mend@0.36.0-next.<M>
mend server upgrade --version 0.36.0-next.<M> --from-preview
```

Run the runbook's box loop for each local `ghcr.io/sealant-sh/mend:*-preview.*` image first.

**Signals to watch:**

- Run summaries:
  - Core: `## Sealant <v>` with `Pin it in Mend: …`;
  - sealantd: `## sealantd <v>` with the digest.
- Errors:
  - `::error::` lines from `pins`, `plan` and `publish_rebuilt`;
  - `Argument list too long` or exit 126 in a publish job.
- GitHub prerelease notes.
- npm `next` dist-tags.
- The CLI line `… carries all <k> migrations this server applied.`

## Divergences found while writing

1. **Registry JSON passed as an argument** (`.github/workflows/release-cli.yml:184-191` in Mend, and
   the same block at Core `.github/workflows/next.yml:454-461` and sealantd `next.yml`).
   - `published_from` passes the registry document to `node -e` as an argument. That killed Mend's
     first next publish (`v0.36.0-next.601`, run 37342721738, `Argument list too long`, exit 126).
   - `dist_tag` (`release-cli.yml:177-181`) and `rebuild_tarball`'s `npm pack --json` read (`:264`)
     have the same shape.
   - The fix is in review (mend#533, sealant#322, sealantd#140). Core and sealantd will hit it as
     their `-next` documents grow.
2. **ADR 0015 decision 4(c) is not done.** Code-owner review is listed as an owner action "before
   merging #319 and #137". `require_code_owner_reviews` is `false` on Core and sealantd main (branch
   protection API, 2026-10-05), with 0 required approvals. The CODEOWNERS files exist but bind
   nothing, so anyone who can merge to main can edit `next.yml` and publish under the `-next` names.
3. **"Every merge to main" does not publish** (ADR 0015 decision 2; the `next.yml` headers).
   - sealantd's `ci` cancels in progress per ref (`.github/workflows/ci.yml:18-20`), so a main
     commit superseded by the next push has no successful CI and is never published. `231691f`
     (sealantd#137's own merge) and `42d69da` were skipped.
   - In both repositories, `concurrency: next` keeps only one pending run, so a third quick merge
     cancels the pending second.
4. **The ADR and the code differ on the sealantd digest** (ADR 0015 "Guards", Core).
   - The ADR writes `sealantd:X.Y.Z[@sha256:…]`, which reads as the digest being optional.
   - Core `tooling/scripts/check-release-pins.mjs:31` requires the digest and refuses a tag alone.
     The runbook matches the code.
5. **Mend's `npm-pack` job has no `check-tarball` step**
   (`.github/workflows/release-cli.yml:75-81`).
   - Core's and sealantd's `pack` jobs have one, and ADR 0015 ("Who holds the npm credential")
     describes `pack` as checking each tarball.
   - A Mend tarball missing `dist/main.js` (its `bin`) would publish. Packaged acceptance tests the
     images, not the npm tarball.
6. **A GitHub prerelease can exist without its npm build** (`.github/workflows/release-cli.yml:97`,
   `:320-327`).
   - The prerelease is published before npm. Its notes promise
     `npm install --global @sealant/mend@next` and link a docs page that is not merged (mend#523).
     When npm fails, as for 601, the prerelease stays live, naming an npm version that does not
     exist.
   - The runbook covers editing a withdrawn prerelease's notes, but not a next build whose npm step
     failed.
7. **The runbook has no path for a next tag whose release failed after `pins`**
   (docs/operations/next-channel.md, "Cut a Mend next build").
   - It covers tags `pins` refused, mistaken tags, and published ones.
   - It does not say that a "Re-run failed jobs" repeats the tag's workflow, nor that a full re-run
     cannot rebuild the images ("a version is pushed once"), nor that the fix is a new tag.
8. **ADR 0015's status and decision log are stale.**
   - The header says "Status: proposed" though all of it is merged and running.
   - The first decision-log entry says "N since the last stable tag", superseded by "whole history".
9. **Owner actions not verifiable read-only, and an extra version** (ADR 0015 decision 4(a),
   "Provenance and security").
   - "Require two-factor authentication and disallow tokens", trusted publishers on the `-next`
     packages only, and "No npm token exists in any repository" cannot be verified read-only.
   - `@sealant/sdk-next` carries an extra version, `0.0.0-stage`, that the runbook does not mention.
   - `latest` on all four `-next` packages is the placeholder `0.0.0-next.0`.
10. **One word, two meanings** (mend#523, `apps/docs/.../try-a-preview.md`, in review). The user
    docs call a `next` build "a preview", while ADR 0015 decision 7, `preview.yml` and
    `deploy-box.yml` use "preview" for `B-next.N.preview.R` builds of unmerged branches. Which one
    the product means is unclear.
11. **The changesets name prerelease versions** (`.changeset/sealant-0-39-next.md`,
    `.changeset/sealantd-0-20-next.md`). Unless they are rewritten when Core is re-pinned to a
    release (promotion step 7), the stable 0.36.0 CHANGELOG will name prerelease versions. Intent
    unclear.
12. **Mend's stable `published()` check is not retried** (`scripts/check-release-pins.mjs:120-126`).
    - It is one GET, unlike `next-version.mjs`'s 4-attempt `registryRecord`. It fails closed, but a
      transient npm error fails the stable `pins` job.
    - Its 404 means "not published", where the ADR's rule elsewhere is that a 404 never reads as
      "nothing published". Here that is the intended meaning, but it is the one place the rule is
      inverted.
