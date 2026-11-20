# Preview builds

A preview build puts unmerged branches of Mend, sealant and sealantd on one self-hosted box, through
the same `mend server setup` and `mend server upgrade` an operator uses for a release. The workflow
is `.github/workflows/preview.yml`; the box side is `scripts/preview-deploy.sh`.

What is already on main does not need a preview: sealant and sealantd publish a prerelease on every
merge, and a Mend `next` build is one tag away. Read [The next channel](next-channel.md). A preview
is for the branches that have not merged yet, and it reaches only the box: nothing goes to npm.

## Build

Dispatch the workflow on the Mend branch you want. The two other refs are optional; leave one out
and the build keeps what this Mend commit already pins.

Without `sealant_ref`, the plan runs the release pin checker before any image builds. It checks the
bundle's sealant version label, package catalog, setup assets and all three sealant image digests
against GHCR. A mismatch or registry failure refuses the preview. With an explicit sealant ref, the
build replaces all three images and labels the bundle `preview-<sha12>` for that resolved commit.

```sh
gh workflow run preview.yml --repo sealant-sh/mend --ref <mend-branch> \
  -f sealant_ref=<sealant-branch> -f sealantd_ref=<sealantd-branch>
```

`-f platforms=linux/arm64` or `-f platforms=linux/amd64,linux/arm64` builds other platforms; the
default is `linux/amd64`. Each platform builds on its own native runner.

| Input          | Builds                                                                                             | Reaches the box as                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sealantd_ref` | `ghcr.io/sealant-sh/mend-preview-sealantd:<sha12>` from sealantd's `docker/Dockerfile`             | `MEND_PREVIEW_SEALANTD_IMAGE` in the Mend image, by digest. The bundled worker bakes it into every workspace image it builds. |
| `sealant_ref`  | `ghcr.io/sealant-sh/mend-preview-sealant-{api,worker,ssh-gateway}:<sha12>` from sealant's `apps/*` | The `SEALANT_*_IMAGE` build arguments of Mend's root `Dockerfile`, by digest, in place of the pinned release digests.         |
| the Mend ref   | `ghcr.io/sealant-sh/mend:<version>` from the root `Dockerfile`                                     | The image `mend server setup` and `mend server upgrade` pin.                                                                  |

A sealantd branch needs no sealant rebuild. `scripts/bundle-supervisor.mjs` gives the Sealant worker
`SEALANT_SEALANTD_IMAGE=<the preview image>` and adds it to `SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES`,
because sealant trusts the recovery boot only of released `ghcr.io/sealant-sh/sealantd:X.Y.Z` images
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

The three `mend-preview-sealant-*` sealant images are read only by the workflow's own Mend build,
which is signed in, so they can stay private. `ghcr.io/sealant-sh/mend` is already public.

## Deploy

Before a deploy that checks a PR on the box, `pnpm verify box prepare --yes` takes the database dump
and holds the box, and `pnpm verify box identity` proves afterwards that the running build contains
the PR (AGENTS.md, The Box). A change is checked on the box only when its judge says a local stack
can't show it, or when the owner asks.

`plan` and `prepare` refuse a box with less free space than one deploy needs: the box's newest Mend
preview image, its newest dump and its newest workspace image (a deploy that changes the workspace
plan builds one at its first session); on 16 Nov 2026 a deploy took 10.8 GB. `prepare --yes` on a
box no other check holds takes the hold and tidies first, and refuses only if that did not make
room. `release --yes` tidies before it lifts the hold. A tidy removes Mend preview images older than
the newest three; untagged images no container uses and no Mend image left on the box names in a
label (the network guard and Boat's gateway are pinned that way); build cache unused for two days
(`docker buildx prune --all --filter until=48h`, which removes build cache only; without `--all`
BuildKit keeps all but dangling records); and dumps in `/root/backups` beyond the newest ten. It
never removes an image a container uses, the image the hold's own deploy pulled, the hold's own
dump, or a workspace image: sealant's worker reaps those itself, keeping the newest ten plans and
any built in the last seven days. Most of the build cache backs those workspace images, so pruning
it frees only the part no image shares; `plan` prints both beside free space, with the workspace
images' total.

Before it tidies, `release --yes` puts the box's data back when the check's deploy applied a Mend
migration `origin/main` lacks: a preview of an unmerged migration would otherwise refuse every
preview of `main` until that branch merges (on 16 Nov 2026, for about ten hours). It stops the app
container, drops every database (Mend's and `sealant_control_plane` alike) and replays the hold's
`prepare` dump, then checks that no migration main lacks is left. Mend stays stopped: the image the
check deployed would apply its migrations again on start, and `mend server upgrade` refuses a
downgrade, so the next deploy starts it. A restore that fails keeps the hold and says what to put
right. `--no-restore` leaves the data, for a check whose branch is about to merge.

A check that brings its own data (the daily run of `main`, on a box that also serves someone's own
instance) uses two more flags. `prepare --load <dump>` takes the dump and the hold as above, then
loads `<dump>` in place of the box's data and leaves Mend stopped for the deploy. Its hold records
the generation `/root/.config/mend/active` points at, that build's version, and any lapsed hold it
replaced. With `--load`, the box's own schema does not hold the check up, since the check never
deploys over that data; the loaded data's schema is checked once it is in. `release --save <dump>`
then stops Mend and dumps the data the check ran on to `<dump>`, keeping the previous copy as
`<name>.prev.sql`. After that it restores the hold's dump, points `active` back at the recorded
generation and starts it (`mend server start --offline`), checks that version runs, tidies, and
writes the lapsed hold back. Generations are immutable snapshots, so this restarts exactly the build
the box ran, which `mend server upgrade` would refuse as a downgrade. A put-back that fails keeps
the hold. Both paths must be `.sql` files under `/root`; keep them outside `/root/backups`, which a
tidy prunes.

A restore puts back the databases only. What the check made outside them stays, with no row that
names it: worktrees and repositories in the `mend-store` volume, captured objects in the
`mend-garage` bucket, Boat's own state (`mend_mend-boat-state`), and the T3 gateway's and SSH
volumes. None stops a later deploy or check. They take disk until removed by hand, and a Boat VM a
check left running stays running: stop a check's sessions before releasing it.

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

### The new web app

A preview image serves the old web app (`apps/web-old`) until cut-over (ADR 0027), and so does every
release, unless its dispatch asks for the new one with `-f web_app=web`. That preview's image builds
`apps/web`, its `dev.sealant.mend.web-app` label reads `web`, and the bundle supervisor starts the
new app's front on 3105 in place of the old one's. Nothing else about it changes.

A route of the new app (`apps/web`) is checked on the box from its author's checkout instead, and
nothing on the box changes for it. `pnpm verify drive new-web --box` runs `vite dev` on this machine
behind a local proxy. The proxy sends `/api` to the box's `APP_URL` with the box's own `Origin`, so
the box's allowed origins stay as they are. The new app signs in on its own `/login` as the box's
checker account, and the session cookie the box sets is for `localhost`. A change that is only
`apps/web` and `packages/ui` needs no preview of its head: `verify box identity` passes on that
drive, against a box whose server is the head's base or later. The commands are in the verify skill,
section 9. The box check of the whole new app before cut-over runs a preview built with
`web_app=web`.

### From the workflow

`-f deploy=true` (or `deploy-box.yml` for a version already built) runs the same script on the box
over SSH, through the `deploy` user's forced command, as root. So the workflows deploy only code on
main:

- the deploy key is in the `box-deploy` environment, which only `main` and tags may use;
- the deploy job runs only when dispatched from `main` or a tag, and checks that the Mend commit is
  on main, and so are the `sealant_ref` and `sealantd_ref` commits when they are set;
- `deploy=true` needs `linux/amd64` in `platforms`: the box is amd64.

A preview of a branch is built by the workflow and deployed by hand, with the command above.

## The box

Two Mend servers run as VMs on one Proxmox host. A check on the box uses VM 131, the preview server
with Boat set up; either server is acceptable. Name the server with `MEND_VERIFY_BOX_SSH`, as below.

Both are set up by hand. None of this is in a repository, so check it on the server before you rely
on it.

- **The Proxmox host** (`49.12.133.97`):
  - DNAT on `eno1`: 80/tcp, 443/tcp and 443/udp to `10.0.0.40`, and 2223/tcp to `10.0.0.40:22`;
  - hairpin DNAT for `tailscale0` and for `OUTPUT` to `49.12.133.97`;
  - `ethtool -K eno1 tso off gso off`, against the e1000e hang;
  - the Hetzner Robot firewall allows 22, 80, 443 (any protocol), 2223 and 41641/udp, among others.
- **VM 130, `mend`** (`10.0.0.40`), the server at `alpha.mend.run`:
  - Ubuntu 24.04, 12 vCPU, 400 GB disk, `onboot 1`; 32 GB RAM from its next stop and start (40 GB
    until then);
  - every preview deploy leaves a 4 GB `all.sql` in a new `/root/preview-backup.*` directory and its
    image in Docker, and nothing removes either: prune them when the disk fills;
  - Docker with `"shutdown-timeout": 3600` in `daemon.json`;
  - Node in `/opt/node`;
  - cloud-init `ssh_deletekeys: false`, so a hard reset keeps the pinned host key.
- **The `deploy` user:**
  - its key is in `authorized_keys` with `restrict,command=/usr/local/bin/mend-ci-deploy`;
  - sshd has `Match User deploy` with `ForceCommand`, no TTY and no forwarding;
  - `mend-ci-deploy` accepts exactly `deploy <version> <40-hex sha> [even-if-live]` and runs
    `/usr/local/bin/mend-ci-deploy-root` through `sudo` (`/etc/sudoers.d/mend-ci-deploy`);
  - that script fetches `scripts/preview-deploy.sh` and runs it as root, with
    `PREVIEW_DEPLOY_EVEN_IF_LIVE=1` for `even-if-live`. The private key exists only as the
    `box-deploy` environment's secret.
- **Ways in:**
  - `https://alpha.mend.run`: the Caddy edge on `0.0.0.0:80/443`;
  - `https://mend-box.tailc79e49.ts.net:8443`, which `tailscale serve` forwards to `127.0.0.1:3105`;
  - SSH: `ssh -J root@100.94.101.28 root@10.0.0.40`.
- **The install:**

  ```sh
  mend server setup --edge alpha.mend.run --url https://alpha.mend.run --bind 127.0.0.1 \
    --origin https://mend-box.tailc79e49.ts.net:8443
  mend server setup --exposure public --tenancy multi
  ```

  The `mend` CLI on the box is whatever `npm install --global @sealant/mend@<version>` put there
  last. No deploy updates it.

- **VM 131, `mend-boat-preview`** (`10.0.0.41`), the preview server made on 5 Nov 2026 for the Boat
  work, where checks on the box run:
  - 6 vCPU, 8 GB RAM, 116 GB disk, `onboot 1`;
  - sessions run on Boat by default and may run in Docker (`MEND_SESSION_RUNTIMES=docker,boat`,
    `MEND_SESSION_RUNTIME=boat`);
  - since 19 Nov 2026 it also serves the owner's own instance, `https://mend.yiannisp.dev`, behind a
    Caddy edge (`mend-edge-1`), with Mend bound to loopback. He tests builds of the new web app
    there by hand, and it may be wiped at any time: read what it runs before relying on it. Its
    `APP_URL` is that address; its session endpoint is still
    `https://mend-boat-preview.tailc79e49.ts.net:8443`;
  - its old `APP_URL`, `https://yiannis-k8s-arc.tailc79e49.ts.net` (the Proxmox host's tailnet name,
    which `tailscale serve` proxies to `10.0.0.41:3105`), answers 502 now that Mend binds loopback.
    The hosts line that let the box resolve that name,
    `100.94.101.28 yiannis-k8s-arc.tailc79e49.ts.net`, is still in `/etc/hosts` and
    `/etc/cloud/templates/hosts.debian.tmpl` (backups `*.before-slnt-892-20261115`);
  - the daily run of `main` brings its own data (`/root/main-run/world.sql`) with `prepare --load`
    and `release --save`, as described under [Deploy](#deploy), so the owner's data and build are
    back when it ends;
  - Docker workspaces on it cannot resolve the `APP_URL` either, which does not matter: a workspace
    reaches the server only through the session endpoint, and `pnpm verify health` says the app-URL
    probe from a workspace does not apply there;
  - deploys are by hand, with the command under [Deploy](#deploy);
  - SSH: `ssh -J root@100.94.101.28 root@10.0.0.41`. For a check on it,
    `MEND_VERIFY_BOX_SSH='-J root@100.94.101.28 root@10.0.0.41'`.

## Limits

- `mend server upgrade` refuses an equal or lower version, so a preview of a branch cut before the
  box's version cannot be installed over it. Neither can a release older than the preview: a box on
  `0.36.0-next.56.preview.17` takes `0.36.0-next.57`, `0.36.0` or later.
- A preview applies its Mend and Sealant migrations to the box's databases, and they are not
  reversed. Use a box you can rebuild.
- Mend imports `@sealant/sdk` and `@sealant/api-contracts` from npm, and sealant imports the
  `@sealant/runtime-*` packages from npm. A sealant branch that changes the SDK or the API contract
  Mend uses, or a sealantd branch that changes those runtime packages, does not reach the preview:
  merge it, and pin the prerelease main publishes.
- The deploy script covers a box installed with `mend server setup`. The workflows deploy only to
  the amd64 box; an arm64 box is deployed by hand, from the images a `linux/arm64` run pushed.
- A release build passes none of these arguments: the root `Dockerfile` defaults are the pinned
  sealant digests (`scripts/bundle-packaging.test.mjs` asserts them), and an empty
  `MEND_PREVIEW_SEALANTD_IMAGE` changes nothing.
