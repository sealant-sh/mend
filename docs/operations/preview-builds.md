# Preview builds

A preview build puts unreleased branches of Mend, Sealant Core and sealantd on one self-hosted box,
through the same `mend server setup` and `mend server upgrade` an operator uses for a release. The
workflow is `.github/workflows/preview.yml`; the box side is `scripts/preview-deploy.sh`.

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

The version is the next minor of `apps/cli/package.json` plus the run number: on `0.35.1`, run 17 is
`0.36.0-preview.17`. A later run is always a higher version, and the release that follows (`0.36.0`)
is higher than every preview of it. Re-running a run keeps its number, and the box already pinned to
that version does nothing: dispatch a new run instead.

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
`ghcr.io/sealant-sh/mend:<version>`, and checks the image's version label. With no Mend server on
the box it runs `mend server setup --version <version> --assets-dir <dir>`, passing on any options
after the commit (`--url`, `--bind`, `--port`, `--edge`, `--exposure` and the rest); with one, it
runs `mend server upgrade --version <version> --assets-dir <dir>` and the installed configuration
stays, the edge and the declared exposure and tenancy included (the CLI carries the edge overlay and
writes it into every generation). It ends with `mend server status`.

## Limits

- `mend server upgrade` refuses an equal or lower version, so a preview from a Mend branch whose CLI
  version is behind the box's cannot be installed over it. Neither can a release older than the
  preview: a box on `0.36.0-preview.17` takes `0.36.0` or later.
- A preview applies its Mend and Sealant migrations to the box's databases, and they are not
  reversed. Use a box you can rebuild.
- Mend imports `@sealant/sdk` and `@sealant/api-contracts` from npm, and Core imports the
  `@sealant/runtime-*` packages from npm. A Core branch that changes the SDK or the API contract
  Mend uses, or a sealantd branch that changes those runtime packages, does not reach the preview:
  publish them first.
- The deploy script covers a box installed with `mend server setup`. An arm64 deployment such as
  alpha (`deploy/aws`) is deployed by hand for now, from the images a `linux/arm64` run pushed.
- A release build passes none of these arguments: the root `Dockerfile` defaults are the pinned Core
  digests (`scripts/bundle-packaging.test.mjs` asserts them), and an empty
  `MEND_PREVIEW_SEALANTD_IMAGE` changes nothing.
