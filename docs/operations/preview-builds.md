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
loads `<dump>` in place of the box's data and leaves Mend stopped for the deploy. When
`<name>.store.tgz` sits beside it, it extracts that into the store volume. Then it checks that every
repository the loaded data names is in the store. Its hold records the generation
`/root/.config/mend/active` points at, that build's version, and any lapsed hold it replaced. With
`--load`, the box's own schema does not hold the check up, since the check never deploys over that
data; the loaded data's schema is checked once it is in. `release --save <dump>` then stops Mend and
dumps the data the check ran on to `<dump>`, with the store directories it names (its projects' and
organizations') in `<name>.store.tgz`. It replaces the old pair together and keeps it as
`<name>.prev.*`. It refuses, leaving the pair as it was, when that data carries a Mend migration
`origin/main` lacks: a later check of `main` could not load it. After that it restores the hold's
dump, points `active` back at the recorded generation and starts it (`mend server start --offline`),
checks that version runs, tidies, and writes the lapsed hold back. Generations are immutable
snapshots, so this restarts exactly the build the box ran, which `mend server upgrade` would refuse
as a downgrade. A put-back that fails keeps the hold. Both paths must be `.sql` files under `/root`;
keep them outside `/root/backups`, which a tidy prunes.

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

Once deployed, it tidies the box, by the choice `pnpm verify box release` makes
(`tooling/verify/box-tidy.mjs`, run with the box's `node`: from the checkout beside the script, or
fetched from `<sha>` when the script is piped in). It removes Mend preview images older than the
newest three, untagged images that nothing uses or pins, build cache unused for two days and dumps
in `/root/backups` beyond the newest ten. It keeps the image it just deployed, any image a container
uses (running or stopped, so every live session's), the images a kept Mend image pins and every
workspace image, which sealant's worker reaps itself. It removes nothing while a check holds the box
(`box prepare`), whose release tidies instead, and re-checks the hold just before removing. It ends
with one `preview-deploy: tidy: …` line naming what went and free space before and after. A tidy
that cannot run or fails leaves the deploy as it stood; `PREVIEW_DEPLOY_TIDY=0` skips it. Until 21
Nov 2026 only a release tidied, so a box that took deploys and no checks (VM 131 since checks moved
to check VMs) filled its disk with old previews (SLNT-1251).

### The web app

A preview image serves `apps/web`, as every release does since the cut-over (ADR 0027).

A change that is only `apps/web` and `packages/ui` can be checked on the box from its author's
checkout instead, and nothing on the box changes for it. `pnpm verify drive web --box` runs
`vite dev` on this machine behind a local proxy. The proxy sends `/api` to the box's `APP_URL` with
the box's own `Origin`, so the box's allowed origins stay as they are. The app signs in on its own
`/login` as the box's checker account, and the session cookie the box sets is for `localhost`. Such
a change needs no preview of its head: `verify box identity` passes on that drive, against a box
whose server is the head's base or later. The commands are in the verify skill, section 9.

### From the workflow

`-f deploy=true` (or `deploy-box.yml` for a version already built) runs the same script on the box
over SSH, through the `deploy` user's forced command, as root. So the workflows deploy only code on
main:

- the deploy key is in the `box-deploy` environment, which only `main` and tags may use;
- the deploy job runs only when dispatched from `main` or a tag, and checks that the Mend commit is
  on main, and so are the `sealant_ref` and `sealantd_ref` commits when they are set;
- `deploy=true` needs `linux/amd64` in `platforms`: the box is amd64.

A preview of a branch is built by the workflow and deployed by hand, with the command above.

## Check VMs

A check whose judge answers `box` runs on a check VM on the dev machine (SLNT-1214): a throwaway
copy of a box, one per check, so no check waits for another. A check that needs Boat takes one of
four Boat slots (below); VM 131 is used only for what a check VM cannot do.

```sh
pnpm verify vm build --version <preview> --sha <commit> [--from-box '<ssh args>']
pnpm verify vm up            # a fresh copy: prints MEND_VERIFY_BOX_SSH and MEND_VERIFY_OUTER_URL
pnpm verify vm list          # the master and each copy
pnpm verify vm down <n>      # or --all: stops the copy and deletes its disk
pnpm verify vm slot add      # a Boat slot joins the tailnet (an auth key from the owner); remove <n>
pnpm verify vm save <n>      # the copy's data becomes the next master's (the daily run's own copy)
```

**The master disk** is a stock Ubuntu 24.04 cloud image under QEMU/KVM with Docker, Node and the
`mend` CLI of the preview it installs (`vm build` packs `@sealant/mend` from `--sha` in a scratch
worktree, stamped `--version`, and never reads npm's `next` tag; the same build is the checker's CLI
in `~/.local/share/mend-check-vms/cli` once the master is sealed), and Mend installed by
`scripts/preview-deploy.sh` (so by `mend server setup`, with
`--session-runtime docker --session-runtimes docker --allow-userns`) over VM 131's own
`identity.env`. Setup reuses an identity it finds, so the box run's data loads as it is: `world.sql`
and its store archive, the git service's repositories in `/srv/mend-git` on the same bridge gateway,
and the machine keys the data is sealed with (`mend/keys` in the `mend_mend-config` volume:
`secrets.key` and each user's git key; without it the API exits at start with
`ExecutorIdentityFailure`) and the workspace SSH gateway's host key. The checker account, the second
account, their CLI logins and the agent logins all work on it unchanged. The build then starts one
session in `boat-check-ubuntu` and one in `boat-check-arch` as the checker, so the two workspace
images are built once, and loads the data again. Measured on 20 Nov 2026: about 10 minutes, 32 GiB
on disk, of which the warm-up is 6.5 minutes.

**The run's data** lives in `~/.local/share/mend-check-vms/box`, and the master is built from it:
`world.sql`, `world.store.tgz`, `mend-git.tgz`, `mend-garage.tgz` (the blob store, where sessions'
captures live) and `mend-boat-state.tgz` (the build journals of the Boat images the data names),
with VM 131's identity, keys and Boat key beside them. Since SLNT-1216 the daily run of `main` keeps
it (`.agents/skills/box-main-run/`): each night its own copy (lane A) runs the flows that change it,
and `vm save <n>` makes that copy's data the next master's. With Mend stopped in the copy, it holds
every agent login against refresh (below), dumps the databases and the store directories they name,
as `box release --save` does, and archives the git service, the blob store and Boat's state volume
(`mend_mend-boat-state`; a copy without Boat keeps the journals its master was built with). It
copies the five out beside the old ones, checks each (a dump with no `pg_dumpall` trailer, or an
archive that does not read to its end, is refused), and only then moves the old ones to `*.prev.*`
and the new ones into place. Until SLNT-1252 (21 Nov 2026) the journals were not saved: the image
lane A built that night kept its row as `ready` while its journal went with the copy, and sealant
quarantined it (`native-local-io-failed`) on every copy's first launch. The first master (20 Nov)
had no blob store: VM 131's Garage volume holds the owner's data beside the run's, so it was not
copied, and a change made on VM 131 shows `its capture manifest could not be read` on a copy.
Changes made on copies since keep theirs. A save that fails anywhere leaves the directory as it was.
It refuses data carrying a Mend migration `origin/main` lacks. The run then builds the master with
`vm build` and no `--from-box`, from those files and its own preview, while other checks' copies run
(SLNT-1249). The build boots its own disk in `master-build/` and, once it is sealed, renames it over
`master/disk.qcow2`. A copy already running keeps the disk it opened at start (its QEMU holds the
file; nothing reopens it by path) until `vm down`, and `vm list` marks it `on the master before`; a
copy started after the rename boots the new master. Every master boots with one host key,
`key/host_ed25519`, which cloud-init writes, so `known_hosts` reaches a copy of either. A build that
fails leaves the master before in place, and only one build runs at a time. `--from-box` copies the
data from VM 131 (`identity.env`, `/root/main-run/world.{sql,store.tgz}`, `/srv/mend-git`, the two
volumes) instead. Do not use it after 20 Nov 2026: VM 131's copy of the run's data stopped there,
and its agent logins have been spent since (below).

**A copy** is a qcow2 overlay of the master with QEMU's user-mode network, 6 vCPU and 8 GB as VM 131
has, on a loopback address of its own, `127.0.1.<n>`: web on `3105`, ssh on `2022` as root with the
VMs' own key. Mend binds loopback in the VM, as setup requires of a loopback `--url`, and a
`systemd-socket-proxyd` socket in the VM carries QEMU's forward and the copy's own address to it.
`vm up` sets the copy's `APP_URL` with `mend server setup --offline --url http://127.0.1.<n>:3105`
and waits for health. Every copy is reached through one ssh config, so the box verbs take it as is:

```sh
export MEND_VERIFY_BOX_SSH='-F ~/.local/share/mend-check-vms/ssh_config mend-check-<n>'
export MEND_VERIFY_OUTER_URL=http://127.0.1.<n>:3105
```

(`vm up` prints both, with the home directory spelled out.) `box plan`, `prepare`, `cli`, `identity`
and `release`, `health`, `drive web --box` and a deploy with `preview-deploy.sh` run there
unchanged. No other check holds a copy, so a hold is always free, and `release` matters only for its
evidence scan: `vm down` deletes the copy. The checker's CLI follows the copy through `MEND_URL`, as
on the box.

**A copy outlives what started it** (SLNT-1326). `vm up` starts the copy's QEMU as a transient
service in the user's systemd manager, `mend-check-vm-<hash of the copies directory>-<n>.service`,
so it runs in a cgroup of its own. Until then QEMU stayed in the cgroup of whatever ran `vm up`. On
24 Nov 2026 the daily run lost all three copies when T3 stopped the scope of the thread that started
them, as it does when a thread ends a turn with no background command. The unit goes away when QEMU
exits (`--collect`), so `vm down` and a failed start leave none. A `vm up` stopped by a signal
before its copy is healthy (its scope stopped, Ctrl-C) stops the VM and removes the copy. `vm list`
names each copy's unit. On a host with no user manager reachable, `vm up` starts QEMU as before,
says so, and `vm list` marks the copy `dies with the process that started it`. Run over ssh, that
needs lingering for the user (`loginctl enable-linger <user>`), so the manager outlives the ssh
session. `vm build` and `vm slot` keep their VM in their own process: it is no use without the
command driving it, and a build stopped partway leaves the master as it was.

Everything private (the master, the copies, what was copied from VM 131, the VMs' key) lives in
`~/.local/share/mend-check-vms`, mode 0700, outside any checkout; `MEND_CHECK_VMS` moves it.

Measured on 20 Nov 2026, on the Ryzen 9 9950X3D (32 threads, 62 GB):

- `vm up` to a healthy Mend: 20 s alone, 26 s with three starting at once, 29 s with five.
- PR 1909's box check replayed on a copy, from `vm up` to `vm down`: plan, prepare, cli, the preview
  deploy, `box identity`, a bare Codex session that Mend named on the real login 9 to 12 s after its
  first message, the `new-web-instant-start` drive, and release. Alone: 3 to 5 minutes, most of the
  spread being the deploy's pull of the 2.75 GB Mend image (42 to 173 s). Three at once: about 3
  minutes each. Five at once: 3.5 minutes each, with 6 GB of the host's memory left, so five is the
  most at once and four leaves room for the rest of the machine.
- On VM 131 the same check held the box for 10.7 minutes (prepare 13:32, release 13:42), after
  waiting for the box, which recent checks held for one to two hours.

Limits of a check VM:

- **Boat on a slot** (SLNT-1215, SLNT-1218). `pnpm verify vm up --boat` claims a free Boat slot: a
  tailnet identity of its own, `mend-check-boat-<n>.<tailnet>.ts.net`, kept on a 256 MB disk in
  `boat-slots/<n>` in the private directory, outside the copy's throwaway overlay. That disk holds
  tailscaled's state: its node key, its name and its HTTPS certificate. The copy mounts it, starts
  the pinned Tailscale build (`vm-boat.mjs`, in userspace networking, so the copy's routes and
  Docker stay as they are), and serves its own Funnel on 8443 (session traffic) and 10000 (saved
  work) to Mend on its loopback. `mend server setup` then turns Boat on with VM 131's own Boat key
  (`--boat-api-key-stdin`), new sessions on Boat and no resource gateway, and `vm up` waits until
  the copy's Funnel answers, first from inside the copy, then from outside the tailnet as a Boat VM
  reaches it (SLNT-1228): the name's public A records from public resolvers (Tailscale's Funnel
  relays), and both ports asked through a relay address with the name as SNI. This machine's own
  resolver answers with the tailnet address, which never goes through Funnel. Any HTTP status is an
  answer; with none in 90 s `vm up` fails, naming each port's last result, and a new copy
  (`vm down`, then `vm up --boat`) is the remedy. Nothing touches this machine's own Funnel or Serve
  config. Four slots have joined, so four Boat copies can run at once; `vm list` shows each slot,
  who holds it and when its node key expires. Measured on 20 Nov: `vm up --boat` 60 s to a healthy
  Mend with Boat; two Boat copies each ran a real Codex turn at once; the stop took 13 s and the
  resume, on a new Boat VM, 2 s to running; `vm down`, which stops the copy's Boat sessions and
  waits for their VMs to go, took 85 s.
- **One copy per slot.** A claim file names the copy that holds a slot, written aside and linked
  into place so that two copies starting at once take different slots, and never removed unless it
  is still the stale one read (its copy gone, five minutes after the claim). QEMU's own write lock
  on the slot's disk refuses a second VM outright and goes with the process, so a crashed copy's
  slot is free again. A VM holding a slot flushes and unmounts it before QEMU is stopped (`vm down`,
  a failed start, `vm slot`): otherwise a certificate tailscaled had just written never reached the
  disk, and the next start asked Let's Encrypt for another one (its weekly limit is five per name).
- **Adding a slot** needs a new auth key from the owner (reusable or one-off, not ephemeral, so the
  node outlives its copy). Put it in `~/.local/share/mend-check-vms/tailscale-authkey` (mode 0600),
  run `pnpm verify vm slot add` once per slot, and delete the file. Each add boots a bare copy with
  a new slot disk, logs in with the key read from a file inside the VM (never a command line),
  checks the node may use Funnel and HTTPS, asks for its certificate once and powers off; about 46
  s. A node without the `funnel` node attribute (a tagged key whose tag the tailnet policy's
  `nodeAttrs` does not name), or a tailnet with HTTPS certificates off, is reported, not worked
  around.
- **Node keys expire.** The slots joined with an untagged key, so they are the owner's own devices,
  like this machine, and their node keys expire 180 days after joining (the four of 20 Nov 2026 on
  19 May 2027; `vm list` says so). Then each slot needs joining again with a new key, unless key
  expiry is turned off for the four devices in the admin console (Machines, the device's menu,
  Disable key expiry).
- **Removing a slot.** `pnpm verify vm slot remove <n>` boots a bare copy with the slot's disk, logs
  its node out and deletes the slot. A logout only expires the node's key: the device stays in the
  tailnet as expired until someone deletes it in the admin console (Machines, Remove). It refuses a
  slot a running copy holds.
- **The copy shares VM 131's Boat deployment.** It runs under the deployment name the loaded data's
  sealant keeps, with the build journals of the Boat images its data names (`mend_mend-boat-state`),
  so it reuses those images and builds none. The master carries the journals saved with its data
  (`vm build` copies `mend-boat-state.tgz` in), and `vm up --boat` puts them into the copy's volume
  once setup turns Boat on; a master built before 21 Nov carries none, and its copy gets the saved
  ones. sealant reads an image's journal before every launch on it: an image whose row is `ready`
  but whose journal is missing is quarantined for good, and only an image built again (a new row)
  starts. With a name of its own, the copy's first image build failed at once
  (`native-local-io-failed`) and sealant quarantined the image, so sessions never started. Sharing
  is safe because sealant acts only on runs in its own database: every Boat run the loaded data
  holds under that name is settled, VM 131 never sees a copy's runs, and `vm down` stops the copy's
  Boat sessions so no VM it launched is left. The resource gateway stays off on a copy (a Boat
  session in a project with `@db` is refused there): its host id derives from the identity the copy
  shares with VM 131, so a copy's gateway would take the box's place. A worktree the loaded data
  made on Boat under that name starts on a Boat copy; on a Docker-only copy it cannot.
- **One set of agent logins, refreshed in one place.** Every copy holds the Codex and Claude logins
  of the run's data. Only sealant's keep-fresh sweeper on a server refreshes them (every other
  holder gets a copy with no usable refresh token), and a refresh spends the refresh token every
  other copy holds: whichever refreshes first keeps the login, and every other is signed out at its
  own next refresh. Codex: a 240-hour access token (measured 20 Nov), refreshed within 24 hours of
  expiry on an hourly tick whose first comes 60 minutes after Mend starts. Claude: an 8-hour access
  token, refreshed within an hour of expiry every 15 minutes. These are constants, not settings. So
  the saved data holds each login against refresh: `vm save` sets its `refresh_claimed_until` to
  2999, and a sweeper takes a login only when that is null or past (`claimRefresh`), so a copy
  answers `skipped-claimed` and never refreshes. The daily run lifts the claim on its own copy alone
  (`.agents/skills/box-main-run/refresher.sh lift`), lets it refresh what is due, and saves. A copy
  started in the day runs on the access tokens of the last save: Codex's stays valid for days, and a
  refresh due in the day waits for that night's run. Claude's expires about 8 hours after the save,
  and a copy cannot refresh it (SLNT-1219). `node .agents/skills/box-main-run/logins.mjs` prints
  when each saved login expires and whether it is held, with times only. A master built before
  SLNT-1216 (on 20 Nov) holds no claim: hold it on a copy with `refresher.sh hold`. VM 131's own
  copy of the run's data, `/root/main-run/world.sql`, is no longer loaded or saved after 20 Nov: its
  logins went stale at the run's first refresh on a copy, and loading it there signs nothing in.
- **Memory.** A copy takes about 9 GB of the host's memory once its sessions run.

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
  - every preview deploy leaves a 4 GB `all.sql` in a new `/root/preview-backup.*` directory, which
    nothing removes: prune them when the disk fills (the deploy's tidy removes old preview images,
    not these);
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
  - until 20 Nov 2026 the daily run of `main` brought its own data (`/root/main-run/world.sql`) with
    `prepare --load` and `release --save`, as described under [Deploy](#deploy). It runs on check
    VMs now (SLNT-1216), so that file is left as the run's 20 Nov data, with agent logins the run
    has since refreshed elsewhere: stale, and not to be loaded;
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
