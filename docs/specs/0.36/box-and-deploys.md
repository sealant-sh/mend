# The box and its deploys

- **Release:** 0.36
- **Status:** on main for everything in the repository: mend#463, #497, #499, #500, #522, plus #481,
  the packaged edge this feature runs on. The box-side pieces are set up by hand and are not in any
  repository: the VM, the NAT rules, the `deploy` user and its forced command, the sudoers rule,
  `tailscale serve`, and the firewall. They are described here from the owner's notes and marked
  **box-side**. On 2026-10-05 `https://alpha.mend.run/api/health` reported
  `version 0.36.0-next.601`, `tenancy multi`, `exposure.declared public` with 3 items open.
- **PRs:**
  - mend#463 (preview builds of Mend, Core and sealantd branches for one box);
  - mend#497 (the box deploys itself: `deploy` / `even_if_live` inputs, `deploy-box.yml`, the
    live-session guard, previous logs kept);
  - mend#499 (deploy over SSH from a hosted runner, not a self-hosted one);
  - mend#500 (the deploy waits for the versioned image tag);
  - mend#522 (next channel, preview numbering, `mend server upgrade --from-preview`);
  - context: mend#481 (`mend server setup --edge`, `--exposure`, `--tenancy`), mend#507 (startup
    never waits on an executor; what makes a deploy over live sessions safe to boot).
- **Decision records:** docs/adr/0004-access-without-a-private-network.md (edge, exposure, decisions
  15, 16, 19), docs/adr/0015-next-channel.md, docs/adr/0003-organizations-and-tenancy.md (tenancy,
  operator). Runbooks: docs/operations/preview-builds.md, docs/operations/next-channel.md.
- **Written:** 2026-10-05, against mend main `c9b645b0b`, sealant main `bc9ec42`, sealantd main
  `07ada50`. Mend main has since moved to `a4bdb0e17` (#533, publish-job only).

## Why it exists

ROADMAP 0.36 is "Mend on our own box, every day". The owner wants to dogfood Mend full time on the
Hetzner box (`yiannis-k8s-arc`: i9-9900K, 62 GB, 2 × 1 TB NVMe) to find bugs while it is built.
`alpha.mend.run` moved there from AWS on 2026-10-03, and the AWS account was emptied.

Problems an operator had before:

- Branches of Mend, Core and sealantd could only be tried together after three releases, waiting on
  each other's CI.
- Deploying meant an SSH session as root and a hand-run script.
- An upgrade during a phone session lost that session's evidence (2026-10-03).
- Upgrades threw away the previous server's log with its container.
- A self-hosted runner on a public repository let a fork's workflow run as root on the box. It was
  removed within the hour (#499).
- A preview that never came up (preview 13, 2026-10-03 23:00–23:06 UTC) took `alpha.mend.run` down
  until the owner rolled back by hand.
- Previews were numbered `X.Y.Z-preview.K`, which sorts above every `X.Y.Z-next.N`, so a box on one
  could not take the next channel (#522).

This is operator-facing: the people who run the box (the owner, and agents acting for the owner).
Users of `alpha.mend.run` see its results: an origin that answers, upgrades that keep their
sessions, and versions they can read in `/api/health`.

## What it does

An operator can:

1. **Build a preview** of any Mend branch, optionally with a Core branch and a sealantd branch:

   ```sh
   gh workflow run preview.yml --repo sealant-sh/mend --ref <mend-branch> \
     -f sealant_ref=<core-ref> -f sealantd_ref=<sealantd-ref> [-f platforms=linux/amd64] \
     [-f deploy=true] [-f even_if_live=true]
   ```

   The image is `ghcr.io/sealant-sh/mend:<B-next.N.preview.R>`, for example
   `0.36.0-next.56.preview.17`. The run summary prints the refs, the commits, every image pushed,
   the version and the deploy command.

2. **Deploy a version already built** (a next build or a preview):

   ```sh
   gh workflow run deploy-box.yml --repo sealant-sh/mend -f version=<version> \
     -f commit=<40-char mend sha> [-f even_if_live=true]
   ```

3. **Deploy by hand**, on the VM as root:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/sealant-sh/mend/<sha>/scripts/preview-deploy.sh \
     | bash -s -- <version> <sha>
   ```

4. **Move a box off an old-style preview, once**:
   `mend server upgrade --version <X.Y.Z-next.N> --from-preview`.
5. **Roll back by generation**, by hand: point `~/.config/mend/active` at an earlier
   `generations/gen-<uuid>` and run `mend server restart`. No command does this (see Known limits).

What the operator sees:

- The deploy job's log ends with `mend server status`: version, health, edge host, edge container,
  certificate look, and the exposure and tenancy declared beside what the server observes.
- With live sessions and no override, the deploy fails with
  `preview-deploy: N session(s) are live on this box · nothing deployed · set PREVIEW_DEPLOY_EVEN_IF_LIVE=1 to upgrade anyway`.
- With the override, it prints `N session(s) live`, keeps the old container's log as
  `~/.config/mend/logs/mend-<UTC stamp>-<previous version>.log`, upgrades, and prints
  `Upgraded to <version>. Retained database backup: <dir>`.
- `--from-preview` prints `<image> carries all N migrations this server applied.`, or refuses naming
  each problem and saying `Nothing was changed.`

Defaults:

- `platforms=linux/amd64`, `deploy=false`, `even_if_live=false`.
- The edge listens on `0.0.0.0:80/443` (`MEND_EDGE_BIND_HOST`).
- Mend binds `127.0.0.1:3105` behind an edge.

**In scope.**

- `.github/workflows/preview.yml` (build and the optional `deploy` job).
- `.github/workflows/deploy-box.yml`.
- `scripts/preview-deploy.sh` (asset fetch, image label check, setup or upgrade, live-session guard,
  log keeping).
- `mend server setup --edge/--exposure/--tenancy`, `mend server upgrade` (generations, backup,
  recovery) and `--from-preview`.
- The Caddy edge (`deploy/docker/compose.edge.yaml`, `deploy/docker/Caddyfile`).
- Box-side: VM 130, NAT, firewall, the `deploy` user and its forced command, `tailscale serve`, DNS
  for `alpha.mend.run`.
- Rollback by generation as an operator procedure.

**Out of scope.**

- Releases and the npm `next` channel themselves (ADR 0015, `release-cli.yml`), except where the box
  consumes them.
- The Kubernetes (Helm) and AWS (`deploy/aws`) deployments. Their definitions stay in the repository
  as product (owner decision); the box does not use them.
- Isolated sessions per VM. Docker sessions run privileged, so a shared box is for trusted users
  (ROADMAP "Not scheduled").
- Automatic rollback. The CLI refuses to downgrade or restore a database on its own, by design.
- Preview builds for arm64 boxes being deployed by the workflow. That is by hand.

## How it works

### Build (`preview.yml`)

1. `plan` (Blacksmith, guarded `github.repository == 'sealant-sh/mend'`):
   - resolves `sealant_ref` and `sealantd_ref` to commits once, through
     `gh api repos/<r>/commits/<ref>`. A ref must match `^[A-Za-z0-9._/-]+$`;
   - computes the version with
     `node scripts/next-version.mjs --package apps/cli --preview <run_number> --main origin/main HEAD`:
     the next build of the branch's merge base with main, plus `.preview.<run>`;
   - chooses the platforms.
2. `sealantd` and `sealantd-image`, only with `sealantd_ref`: build
   `ghcr.io/sealant-sh/mend-preview-sealantd` by digest. The package must be public, once.
3. `core` and `core-images`, only with `sealant_ref`: build
   `mend-preview-sealant-{api,worker,ssh-gateway}` by digest.
4. `mend` (per platform, native runner) and `mend-image`:
   - build the root `Dockerfile` with `ARG SEALANT_{API,WORKER,SSH_GATEWAY}_IMAGE` (default: the
     pinned digests) and `MEND_PREVIEW_SEALANTD_IMAGE`;
   - tag `ghcr.io/sealant-sh/mend:<version>`;
   - BuildKit is pinned by digest.
5. `deploy` (preview.yml:467):
   - `needs: [plan, mend, mend-image]`,
     `if: !cancelled() && needs.mend-image.result == 'success' && inputs.deploy` (#500: it needs the
     versioned tag, not just the amd64 build);
   - runs on a Blacksmith hosted runner and writes the `MEND_BOX_DEPLOY_KEY` secret to a 0600 file;
   - pins the VM's host key (`[49.12.133.97]:2223 ssh-ed25519 AAAAC3…zqgl/`);
   - runs `ssh -p 2223 deploy@49.12.133.97 deploy "<version>" "<github.sha>" [even-if-live]`.
6. In the image, `scripts/bundle-supervisor.mjs` gives the bundled Sealant worker
   `SEALANT_SEALANTD_IMAGE=<preview image>` when `MEND_PREVIEW_SEALANTD_IMAGE` is non-empty, and
   appends it to `SEALANT_SEALANTD_RECOVERY_BOOT_IMAGES`. Release builds carry an empty value; the
   release pins job refuses a non-empty one (`scripts/check-release-pins.mjs`).

### Deploy-only (`deploy-box.yml`)

- `workflow_dispatch` with `version`, `commit` and `even_if_live`.
- Checks that `commit` is 40 lowercase hex, then makes the same SSH call as above with the given
  commit.
- `permissions: contents: read`, `timeout-minutes: 30`.

### Box-side (not in a repository; owner's notes, mend-box-vm memory)

- **PVE host** (`49.12.133.97`):
  - DNAT on `eno1`: 80/tcp, 443/tcp and 443/udp to `10.0.0.40`; 2223/tcp to `10.0.0.40:22`;
  - hairpin DNAT for `tailscale0` and `OUTPUT` to `49.12.133.97`;
  - `ethtool -K eno1 tso off gso off` (the e1000e hang);
  - Hetzner Robot firewall allows 22, 80, 443 (any protocol), 2223, 41641/udp and the Minecraft
    ports.
- **VM 130 `mend`** (`10.0.0.40`):
  - Ubuntu 24.04, 12 vCPU, 40 GB RAM, 400 GB, `onboot 1`;
  - Docker 29.8 with `daemon.json` `shutdown-timeout: 3600`;
  - Node 26.10 in `/opt/node`;
  - cloud-init `ssh_deletekeys: false`, so a hard reset keeps the pinned host key.
- **`deploy` user:**
  - its key is in `authorized_keys` with `restrict,command=/usr/local/bin/mend-ci-deploy`;
  - sshd has `Match User deploy` with `ForceCommand`, no TTY and no forwarding;
  - `mend-ci-deploy` accepts exactly `deploy <version> <40-hex sha> [even-if-live]` and `sudo`-execs
    `/usr/local/bin/mend-ci-deploy-root` (`/etc/sudoers.d/mend-ci-deploy`);
  - that script fetches `scripts/preview-deploy.sh` and runs it as root, with
    `PREVIEW_DEPLOY_EVEN_IF_LIVE=1` for `even-if-live`. The private key exists only as the repo
    secret.
- **Access paths:**
  - `https://alpha.mend.run`: Caddy on `0.0.0.0:80/443`, Let's Encrypt certificate obtained
    2026-10-03, expiring 2027-01-01;
  - `https://mend-box.tailc79e49.ts.net:8443` → `127.0.0.1:3105`, through `tailscale serve`;
  - SSH: `ssh -J root@100.94.101.28 root@10.0.0.40`.
- **The install:**
  - `mend server setup --edge alpha.mend.run --url https://alpha.mend.run --bind 127.0.0.1 --origin https://mend-box.tailc79e49.ts.net:8443`;
  - then `mend server setup --exposure public --tenancy multi`;
  - the CLI on the box is whatever was installed last
    (`npm install --global @sealant/mend@<version>`). No deploy updates it.

### `scripts/preview-deploy.sh` (as root on the VM)

1. Validates `<version>` (semver with an optional prerelease) and `<commit>` (40 hex), that it runs
   as root, and that `mend`, `docker` and `curl` are on PATH.
2. Fetches `deploy/docker/compose.v2.yaml` and `postgres-init.sh` from
   `raw.githubusercontent.com/sealant-sh/mend/<commit>/` into a temp dir.
3. `docker pull ghcr.io/sealant-sh/mend:<version>`, and refuses unless
   `org.opencontainers.image.version` equals `<version>`.
4. `mend server status`:
   - a nonzero exit with "No Mend server is configured" runs
     `mend server setup --version <v> --assets-dir <dir> <extra options>`;
   - otherwise extra options are ignored, with a line saying so.
5. **Live-session guard:**
   `docker exec mend-postgres-1 psql -U mend -d mend -At -c "select count(*) from agent_sessions where settled_at is null"`.
   - A number above 0 without `PREVIEW_DEPLOY_EVEN_IF_LIVE=1` dies with the "nothing deployed" line.
   - Anything that is not a number prints
     `could not count live sessions (no bundled Postgres answered) · going on` and continues.
6. **Previous log:**
   `docker logs mend-mend-1 > ${MEND_CONFIG_DIR:-/root/.config/mend}/logs/mend-<UTC>-<previous version>.log`.
   Only the newest 20 `mend-*.log` files are kept.
7. `mend server upgrade --version <v> --assets-dir <dir>`, then `mend server status`.

### `mend server upgrade` (apps/cli/src/server-setup.ts:2150ff)

1. Resolve the version.
   - Refuse a downgrade unless `--from-preview` applies.
   - Refuse `--from-preview` unless `isPreviewToNext(from, to)`: legacy `X.Y.Z-preview.K` to
     `X.Y.Z-next.N` or `X.Y.Z-next.N.preview.R`, same `X.Y.Z` (:1965–1972).
   - Equal versions: "already pinned … no upgrade was performed".
2. Render the target generation from the existing config (edge and posture carried), using the
   **CLI's own copy** of the edge files (`apps/cli/src/server-edge-files.ts`). Check images, local
   or pulled.
3. With `--from-preview` (`checkPreviewMigrations`, :2083), before anything stops:
   - read `/app/migrations.txt` from the target image;
   - start Postgres if needed;
   - read `mend_migrations` and `drizzle.__drizzle_migrations`;
   - refuse via `migrationProblems` (:2005) on any of these: an applied Mend migration missing by id
     and name; a target Mend id at or below the highest applied that never ran (Effect would skip
     it); an applied Sealant migration missing; a Sealant migration whose hash changed.
4. `store.prepare` a new `generations/gen-<uuid>`, and `createBackup` under
   `~/.config/mend/backups/upgrade-<uuid>` (0700).
5. `compose stop --timeout 30 mend`; start Postgres; `pg_dumpall` into the backup, within 15
   minutes.
6. Activate the target: an atomic rename of a temp symlink over `active`
   (apps/cli/src/server-store.ts:339–341).
7. On any failure before activation: re-activate the previous generation, restart the old app if it
   was running, and say "Target startup was not attempted".
8. After activation: `startInstallation` (:1919) removes a stray edge, runs `compose up -d --wait`,
   inits Garage, and probes exact-version health. On failure it says "migrations may have begun. The
   target pin remains active. Do NOT downgrade or restore the database automatically." and names the
   previous generation, the target generation and the backup.
9. The bundle supervisor inside the image waits up to 240 s for `http://127.0.0.1:3101/api/health`
   (scripts/bundle-supervisor.mjs:220) before restarting Mend's API.

### Mend boot over live sessions

Covered by mend#507 (`start-time.md`):

- the engine reconciles rows inline and forks every platform-reaching tail as the session's owner;
- PTY watchers are re-forked;
- protocol pipes are rehydrated after the sockets bind.

Executors keep running through the restart. Their capture channel is unreachable while Mend is down;
their calls retry.

### Rollback by generation (procedure, by hand)

Used on 2026-10-03 23:06 UTC to bring back preview 11 over preview 13. The schema stayed on the
newer migrations, which were additive.

```sh
cd /root/.config/mend
jq -r '.serverVersion' generations/*/server.json      # find the generation to go back to
ln -s generations/gen-<uuid> .active-tmp && mv -T .active-tmp active
mend server restart
```

`readActive` accepts only `generations/gen-<uuid>` targets (server-store.ts:274). The database is
not restored. This is safe only when every migration applied since that generation is additive. The
CLI says so in its refusal text, and nothing checks it.

## Happy path

The owner (Yiannis) and an agent he runs (Ana) operate the box. Ben uses `alpha.mend.run`.

1. Ana opens a PR on `fix/foo` with a Core branch `fix/bar`. She dispatches
   `gh workflow run preview.yml --ref fix/foo -f sealant_ref=fix/bar -f deploy=true`.
2. The run builds Core and Mend in about four minutes. The summary says
   `Mend 0.36.0-next.601.preview.40: sealant 1a2b3c…, sealantd pinned, linux/amd64` and lists
   `ghcr.io/sealant-sh/mend:0.36.0-next.601.preview.40`.
3. The `deploy` job connects to `deploy@49.12.133.97:2223`. Ben has a Claude session running, so the
   job fails:
   `1 session(s) are live on this box · nothing deployed · set PREVIEW_DEPLOY_EVEN_IF_LIVE=1 to upgrade anyway`.
   Nothing on the box changed.
4. Ben stops his session. Its save settles within 20 s.
5. Ana dispatches
   `deploy-box.yml -f version=0.36.0-next.601.preview.40 -f commit=<the 40-char sha>`. The log
   shows:
   - `fetching compose.v2.yaml …` and `pulling ghcr.io/sealant-sh/mend:0.36.0-next.601.preview.40`;
   - `0 session(s) live`;
   - `kept the previous server's log in /root/.config/mend/logs`;
   - `Upgrade recovery files: …`;
   - `Upgraded to 0.36.0-next.601.preview.40. Retained database backup: …`;
   - then `mend server status` with the edge `alpha.mend.run`, the edge container running, a
     certificate found, exposure declared public beside observed, and tenancy multi.
6. `curl https://alpha.mend.run/api/health` answers `"version":"0.36.0-next.601.preview.40"`. Ben
   resumes his session from the phone.
7. The preview turns out broken (`/api/health` never answers; Caddy 502). Yiannis runs the rollback
   procedure to the previous generation and `mend server restart`. `alpha.mend.run` answers 200 on
   the previous version within a minute.

## Invariants

1. A deploy never upgrades over unsettled sessions unless the operator asked (`even_if_live` /
   `PREVIEW_DEPLOY_EVEN_IF_LIVE=1`). Unsettled means `agent_sessions.settled_at is null`, which
   includes `stopping` sessions mid-save. No loss of work product.
2. A deploy never changes the box when the image's `org.opencontainers.image.version` differs from
   the requested version.
3. The deploy key exists only as a repository secret and never reaches a fork's workflow. On the box
   it can run only `deploy <version> <sha> [even-if-live]`: no shell, no TTY, no forwarding.
4. The VM's SSH host key is pinned. A changed key fails the deploy rather than prompting.
5. An upgrade never starts the target before a complete `pg_dumpall` of the server's databases
   exists. A failure before activation leaves the previous generation active and its app running if
   it was.
6. After activation, the CLI never selects an older generation or restores a database on its own.
   Rollback is an operator decision.
7. `--from-preview` changes nothing unless the target image lists every migration the server
   applied, unchanged (Sealant by hash), and none the server would skip.
8. Every generation keeps the edge and the declared posture across upgrades. Only `--no-edge`
   removes the edge, and only an edge container started from this installation's generations is
   removed.
9. Behind the edge, Mend's own port stays on loopback. Only the edge publishes beyond the host: 80,
   443 and 443/udp.
10. The edge's access log carries no `ticket`, `token` or `code` query value and no `Referer`. Caddy
    redacts `Authorization`, `Cookie` and `Set-Cookie`.
11. Status lines report what was declared and what was observed
    (`exposure declared public · 3 open`), never "safe to expose" or "gate passed".
12. The previous server's log is kept before its container goes, up to the newest 20.
13. One person's credentials are never spent by or exposed to another. The deploy path handles only
    the operator's deploy key. Upgrade backups (which contain every person's sealed secrets and the
    instance identity) live in a root-only 0700 directory and never leave the box.
14. A deploy reaches the box only through the forced command. No workflow job runs on the box
    itself.

## Edge cases and failure behaviour

- **The image tag is not pushed yet.** `preview.yml`'s deploy waits for `mend-image` (#500).
  `deploy-box.yml` with a version that does not exist:
  `could not pull … Check the version and that the workflow run finished.` Nothing changes.
- **Version and commit from different builds** (`deploy-box.yml` takes both by hand). The label
  check covers the version only. The compose assets come from `<commit>` and the image from
  `<version>`, which can disagree (see Divergences).
- **A preview built for `linux/arm64` only, with `deploy=true`.** The box is amd64. The deploy job
  does not check the platform (see Divergences).
- **Live sessions.** Refused without the override. With it, executors keep running, the capture
  channel is down for the upgrade, PTY and protocol sessions come back (#507), and a Stop mid-save
  loses its deferred user mark (ADR 0002 decision 50 "Known gap").
- **The live-session count cannot be read** (Postgres container renamed, stopped, or `psql`
  failing). The guard says so and **deploys anyway** (see Divergences).
- **The new version never answers health** (the preview 13 case). The bundle supervisor restarts the
  API every 240 s. `mend server upgrade` fails with the "target pin remains active" text, and the
  workflow job fails. The edge answers 502. Recovery is the rollback procedure, or a fixed preview.
- **The `pg_dumpall` fails or exceeds 15 min.** The previous generation is re-activated and the old
  app restarted. "Target startup was not attempted."
- **The CLI on the box is older than the target.** The generation is rendered with that CLI's edge
  files and asset contract. A deploy never updates the CLI.
- **A legacy preview box receives a next build through the workflow.** `mend server upgrade` refuses
  it as a downgrade and the refusal names `--from-preview`. The forced command cannot pass that
  flag, so the move is done by hand once.
- **A preview applied a migration main does not have.** `--from-preview` refuses and names it. A
  plain upgrade from a new-style preview to a next build does no such check (see Known limits).
- **A hard reset of the PVE host or VM.** The VM auto-starts and Mend comes back. The host key
  persists (cloud-init). The e1000e NIC hang is mitigated, not fixed.
- **The certificate.** Caddy renews on its own. A failed ACME challenge (DNS moved, port 80 blocked)
  keeps the old certificate until it expires. `mend server status` reports what Caddy's data holds.
- **Phone with Tailscale exit node through the box.** Reaches `alpha.mend.run` through the hairpin
  DNAT.
- **Concurrent deploys** (two dispatches at once). Both reach the VM. `mend server upgrade` takes
  the store lock ("Server is busy: … is locked"), so the second fails; nothing is half-applied.
- **Disk.** Every upgrade adds a `pg_dumpall` under `backups/` and a generation under
  `generations/`. Neither is pruned.
- **Permissions.**
  - Anyone with write access to `sealant-sh/mend` can dispatch `preview.yml` (on any branch) or
    `deploy-box.yml`, and so deploy that code as root on the box.
  - Fork PRs cannot: `workflow_dispatch` needs write access, and the secret is not given to forks.
  - Mend's `operator` role (instance administration) is separate. `mend operator exposure` and the
    status gate lines need the operator's sign-in on the machine.
- **Clients.** Web, phone, desktop, VS Code, CLI, Slack and the t3 gateway all reach the box through
  `https://alpha.mend.run`. The CLI on the owner's laptop may use the tailnet origin
  `https://mend-box.tailc79e49.ts.net:8443`. During an upgrade every client sees the edge's 502, or
  a dropped socket, for the restart's duration.

## Known limits

- Rollback has no command. It is the hand procedure above, and only safe over additive migrations.
- Upgrade backups and generations are never pruned.
- A preview's migrations are not reversed (preview-builds.md "Limits"): use a box you can rebuild.
- A Core branch that changes the SDK or API contract, or a sealantd branch that changes the runtime
  packages, does not reach a preview. Merge it and pin the prerelease.
- `mend server upgrade` cannot see a Mend migration whose code changed under the same id and name.
  The next-channel runbook gives a hand check.
- Docker sessions run privileged: the box is for trusted users (ROADMAP "Not scheduled").
- The owner's notes record the PVE thin pools as overcommitted (LVM warning).
- `/api/health` is unauthenticated and reports the version, the declared exposure and open-item
  counts by design (ADR 0004 decision 19).

## How to verify

**Tests.**

- `scripts/bundle-packaging.test.mjs`: pinned Core digests; `MEND_PREVIEW_SEALANTD_IMAGE` empty in
  releases and wired into the worker when set; the queue env.
- `apps/cli/src/server-lifecycle.test.ts`:
  - edge and posture through upgrade, start, restart and stop;
  - `--no-edge`;
  - stray edges;
  - `--from-preview`: the refusal hint, a move, a refusal naming a missing Mend and a missing
    Sealant migration, a target with no list, backup failure recovering the preview image, flag
    misuse.
- `apps/cli/src/server-migrations.test.ts`: `migrationProblems`.
- `apps/cli/src/server-edge.test.ts`, `server-setup.test.ts`, `server-runtime.test.ts` (real
  `docker compose config` of an edge plus public/multi generation).
- `scripts/check-release-pins.test.mjs`, `scripts/next-version.test.mjs` (preview numbering
  monotonic).
- Not covered by tests:
  - `preview-deploy.sh` (#463 ran it against stubs once; no test file);
  - the two workflows' deploy jobs;
  - the box-side forced command and sudoers;
  - the rollback procedure;
  - the live-session guard's fail-open path.

**By hand.**

```sh
# a deploy that must refuse: start a session on the box, then
gh workflow run deploy-box.yml --repo sealant-sh/mend -f version=<current> -f commit=<sha>
gh run watch --repo sealant-sh/mend   # expect "N session(s) are live on this box · nothing deployed"
# the forced command refuses anything else (from a machine holding the key, e.g. a test key):
ssh -p 2223 deploy@49.12.133.97 'id'        # expect a refusal, no shell
# after a deploy
curl -s https://alpha.mend.run/api/health | jq '{version, tenancy, exposure}'
ssh -J root@100.94.101.28 root@10.0.0.40 'mend server status; ls -1t /root/.config/mend/logs | head; \
  readlink /root/.config/mend/active; ls /root/.config/mend/generations | wc -l; du -sh /root/.config/mend/backups'
# certificate
echo | openssl s_client -connect alpha.mend.run:443 -servername alpha.mend.run 2>/dev/null | openssl x509 -noout -dates
```

**Signals.**

- Workflow logs:
  - `preview-deploy: pulling …`;
  - `… session(s) live`;
  - `kept the previous server's log`;
  - `Upgraded to …`;
  - the "target pin remains active" error.
- Mend log on boot: `mend api starting`, `session engine: re-attached`, then listening on 3101
  within seconds (preview 15: 0.5 s over 3 live sessions).
- Caddy (`docker logs mend-edge-1`): certificate obtained or renewed; 502s during a restart.
- `/api/health`: `version`, `tenancy`, `exposure.declared`, `exposure.open`.

## Divergences found while writing

1. scripts/preview-deploy.sh:83–95: the live-session guard fails open on purpose. Its comment says
   "a box without it is told and goes on". The count is read from a hard-coded container name,
   `mend-postgres-1`, as user `mend` on database `mend`. On the box, where Postgres is always
   bundled, any failure goes on and upgrades over live sessions without `even_if_live`: a Postgres
   that is restarting, a Compose project or namespace that names the container differently, or a
   changed role. That conflicts with "no loss of work product". `mend server upgrade` itself reaches
   Postgres through `compose exec postgres`, which does not depend on the name.
2. .github/workflows/preview.yml:467–472: the `deploy` job runs whatever `platforms` the dispatch
   chose. `-f platforms=linux/arm64 -f deploy=true` pushes an arm64-only image and deploys it to the
   amd64 VM. `preview-deploy.sh` checks the version label only, not the architecture. The upgrade
   then fails health after activation ("target pin remains active"), and the box needs the hand
   rollback.
3. .github/workflows/deploy-box.yml:40–56 and scripts/preview-deploy.sh:58–70: `version` and
   `commit` are independent inputs. The script takes `compose.v2.yaml` and `postgres-init.sh` from
   `<commit>` and the image from `<version>`, and never checks that the image's
   `org.opencontainers.image.revision` equals `<commit>`. A mistyped pair deploys assets and an
   image from different commits.
4. Box-side `mend-ci-deploy-root` (not in any repository): the owner's notes say it "curls
   preview-deploy.sh". If it fetches from the `<commit>` the workflow passes, then the root-run
   script is chosen by whoever dispatches. That includes any commit reachable by sha in the
   repository's object store, and GitHub serves commits from forks' PRs that way. The forced command
   then bounds the argument shape but not the code run as root. Neither workflow uses a GitHub
   `environment` with reviewers for `MEND_BOX_DEPLOY_KEY`, so any branch's workflow run by a writer
   can read the secret. Verify on the box which ref it fetches.
5. apps/cli/src/server-setup.ts:2209–2297 and apps/cli/src/server-store.ts:387–409: generations and
   `backups/upgrade-<uuid>` (a full `pg_dumpall` each) are never pruned. With the box deploying
   itself several times a day, `/root/.config/mend` grows without bound. preview-deploy.sh prunes
   only the logs it writes. Its glob `mend-*.log` also matches hand-saved logs such as
   `mend-preview13-failed-*.log` from the 2026-10-03 incident, which the 21st deploy deletes.
6. No document covers rollback by generation for a Docker install
   (docs/operations/preview-builds.md, next-channel.md, SELF-HOSTING.md). The only procedure is in
   the owner's memory notes. The CLI's own error text says not to downgrade.
7. deploy/docker/compose.edge.yaml:17–18 ("Not checked: a certificate issued and a browser session
   through it, end to end") and apps/docs/src/content/docs/reference/feature-status.md:59 ("no
   certificate has been issued through it end to end in testing") are stale. The box obtained a
   Let's Encrypt certificate through this overlay on 2026-10-03 and serves `alpha.mend.run` with it.
8. docs/operations/preview-builds.md, "Limits": "An arm64 deployment such as alpha (`deploy/aws`) is
   deployed by hand". Alpha is now the amd64 box, deployed by these workflows, and the AWS
   deployment was torn down (2026-10-03).
9. The `--from-preview` move cannot go through the workflows: the forced command accepts no extra
   flag, and `preview-deploy.sh` calls a plain `mend server upgrade`. That matches the runbook (a
   one-time hand step). A plain upgrade from a new-style preview to a next build runs no migration
   check at all, although a preview can apply a migration main never merges. Only the legacy move
   checks.
