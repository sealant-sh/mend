# Preview builds

A preview build puts unmerged branches of Mend, Sealant Core and sealantd on one self-hosted box,
through the same `mend server setup` and `mend server upgrade` an operator uses for a release. The
workflow is `.github/workflows/preview.yml`; the box side is `scripts/preview-deploy.sh`.

What is already on main does not need a preview: Core and sealantd publish a prerelease on every
merge, and a Mend `next` build is one tag away. Read [The next channel](next-channel.md). A preview
is for the branches that have not merged yet, and it reaches only the box: nothing goes to npm.

## Build

Dispatch the workflow on the Mend branch you want. The two other refs are optional; leave one out
and the build keeps what this Mend commit already pins.

```sh
gh workflow run preview.yml --repo sealant-sh/mend --ref <mend-branch> \
  -f sealant_ref=<sealant-branch> -f sealantd_ref=<sealantd-branch>
```

`-f platforms=linux/arm64` or `-f platforms=linux/amd64,linux/arm64` builds other platforms; the
default is `linux/amd64`. Each platform builds on its own native runner.

| Input          | Builds                                                                                          | Reaches the box as                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sealantd_ref` | `ghcr.io/sealant-sh/mend-preview-sealantd:<sha12>` from sealantd's `docker/Dockerfile`          | `MEND_PREVIEW_SEALANTD_IMAGE` in the Mend image, by digest. The bundled worker bakes it into every workspace image it builds. |
| `sealant_ref`  | `ghcr.io/sealant-sh/mend-preview-sealant-{api,worker,ssh-gateway}:<sha12>` from Core's `apps/*` | The `SEALANT_*_IMAGE` build arguments of Mend's root `Dockerfile`, by digest, in place of the pinned release digests.         |
| the Mend ref   | `ghcr.io/sealant-sh/mend:<version>` from the root `Dockerfile`                                  | The image `mend server setup` and `mend server upgrade` pin.                                                                  |

A sealantd branch needs no Core rebuild. `scripts/bundle-supervisor.mjs` gives the Sealant worker
`SEALANT_SEALANTD_IMAGE=<the preview image>` and adds it to `SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES`,
because Core trusts the recovery boot only of released `ghcr.io/sealant-sh/sealantd:X.Y.Z` images
and of the images listed there. The reference is a digest, so each sealantd build gets its own
workspace images instead of reusing the last preview's.

The version is the `next` version of the branch's merge base with main, plus the run number
(`scripts/next-version.mjs --package apps/cli --preview`): a branch cut from main's
`0.36.0-next.56`, built by run 17, is `0.36.0-next.56.preview.17`. It sorts after `0.36.0-next.56`
and before `0.36.0-next.57`, so the box moves between next builds and previews in main's order, and
the release that follows (`0.36.0`) is higher than both. A branch cut from an older main sorts
lower, and a box already past it refuses it: rebase the branch. Re-running a run keeps its number,
and the box already pinned to that version does nothing: dispatch a new run instead.

The run's summary lists the three refs and their commits, every image it pushed, the version, and
the deploy command. The workflow runs no packaged acceptance, so a preview takes one image build per
component, not a release's half hour.

## Make the sealantd image public, once

GitHub creates a package private the first time a workflow pushes it. The box's Docker pulls
`mend-preview-sealantd` without credentials when it builds a workspace image, so after the first run
with `sealantd_ref` set, an organization owner changes that package to public: open
<https://github.com/orgs/sealant-sh/packages/container/mend-preview-sealantd/settings>, then
**Danger Zone**, **Change visibility**, **Public**. GitHub's REST API reads a package's visibility
but cannot change it. To check it:

```sh
gh api /orgs/sealant-sh/packages/container/mend-preview-sealantd --jq .visibility
```

(This needs a token with `read:packages`: `gh auth refresh -s read:packages`.)

The three `mend-preview-sealant-*` Core images are read only by the workflow's own Mend build, which
is signed in, so they can stay private. `ghcr.io/sealant-sh/mend` is already public.

## Deploy

On the box, as root, with the `mend` CLI installed, run the command from the run's summary:

```sh
curl -fsSL https://raw.githubusercontent.com/sealant-sh/mend/<sha>/scripts/preview-deploy.sh \
  | bash -s -- <version> <sha>
```

or `scripts/preview-deploy.sh <version> <sha>` from a checkout. The script takes
`deploy/docker/compose.v2.yaml` and `deploy/docker/postgres-init.sh` from that Mend commit, pulls
`ghcr.io/sealant-sh/mend:<version>`, and refuses the image unless its
`org.opencontainers.image.version` label is that version, its `org.opencontainers.image.revision`
label is that commit, and its platform is the box's. With no Mend server on the box it runs
`mend server setup --version <version> --assets-dir <dir>`, passing on any options after the commit
(`--url`, `--bind`, `--port`, `--edge`, `--exposure` and the rest); with one, it runs
`mend server upgrade --version <version> --assets-dir <dir>` and the installed configuration stays,
the edge and the declared exposure and tenancy included (the CLI carries the edge overlay and writes
it into every generation). It ends with `mend server status`.

Before an upgrade it counts the sessions that have not settled, in the bundled Postgres. It refuses
when any is live, and also when it cannot read the count; `PREVIEW_DEPLOY_EVEN_IF_LIVE=1` upgrades
anyway.

### From the workflow

`-f deploy=true` (or `deploy-box.yml` for a version already built) runs the same script on the box
over SSH, through the `deploy` user's forced command, as root. So the workflows deploy only code on
main:

- the deploy key is in the `box-deploy` environment, which only `main` and tags may use;
- the deploy job runs only when dispatched from `main` or a tag, and checks that the Mend commit is
  on main, and so are the `sealant_ref` and `sealantd_ref` commits when they are set;
- `deploy=true` needs `linux/amd64` in `platforms`: the box is amd64.

A preview of a branch is built by the workflow and deployed by hand, with the command above.

## Limits

- `mend server upgrade` refuses an equal or lower version, so a preview of a branch cut before the
  box's version cannot be installed over it. Neither can a release older than the preview: a box on
  `0.36.0-next.56.preview.17` takes `0.36.0-next.57`, `0.36.0` or later.
- Previews before ADR 0015 were numbered `0.36.0-preview.R`. `preview` sorts after `next`, so a box
  on one of those refuses every `0.36.0-next.*`, new-style previews included. Move it once with
  `mend server upgrade --version <version> --from-preview` (steps in
  [The next channel](next-channel.md)); after that this deploy script works as usual.
- A preview applies its Mend and Sealant migrations to the box's databases, and they are not
  reversed. Use a box you can rebuild.
- Mend imports `@sealant/sdk` and `@sealant/api-contracts` from npm, and Core imports the
  `@sealant/runtime-*` packages from npm. A Core branch that changes the SDK or the API contract
  Mend uses, or a sealantd branch that changes those runtime packages, does not reach the preview:
  merge it, and pin the prerelease main publishes.
- The deploy script covers a box installed with `mend server setup`. The workflows deploy only to
  the amd64 box; an arm64 box is deployed by hand, from the images a `linux/arm64` run pushed.
- A release build passes none of these arguments: the root `Dockerfile` defaults are the pinned Core
  digests (`scripts/bundle-packaging.test.mjs` asserts them), and an empty
  `MEND_PREVIEW_SEALANTD_IMAGE` changes nothing.
