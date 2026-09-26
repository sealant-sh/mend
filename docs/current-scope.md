# Current scope

Written 2026-09-20, ticked 2026-09-26. A working list across `sealant-sh/mend`, `sealant-sh/sealant`
(Core) and `sealant-sh/sealantd`. Update it as items land; delete it when it is empty.

## Shipped since 2026-09-21

Merged to `main` and released (Mend 0.30.0 to 0.33.0). "Alpha-unproven" means no record of it
running on alpha.mend.run exists yet.

- Slack (#324 to #335, ADR 0006), released in 0.30.0. Two faults found against a real Slack install
  were fixed in #376 and #378. Alpha-unproven.
- Landing (#341 to #349, ADR 0007), released in 0.30.0; adopting pull requests opened outside Mend
  (#372) in 0.31.0. Alpha-unproven.
- Dotfiles 1 to 7 (#351 to #357), released in 0.30.0. Alpha-unproven.
- Desktop revival (#359 to #363). No published desktop release. Alpha-unproven.
- Fixes from Anna's feedback (#368 to #372): Services that keep a stopped agent's workspace up, the
  Git author setting, pasted images and skills in captured workspaces, review pass dedup and
  concurrency, adopting outside pull requests. Released in 0.31.0. Alpha-unproven.
- `mend doctor --bundle` (#374), released in 0.32.0. Alpha-unproven.
- Organization defaults and the default zsh profile (#378 to #380, Sealant 0.37.2), released in
  0.33.0. Alpha-unproven.

## What we are fixing now

Done 2026-09-20: Core 0.36.0 builds each project's image on MicroVM, and Mend pins it (#314). The
text below is the problem as it stood.

Image customisation on MicroVM, in Core. A project's OS family, custom base image and packages do
nothing on MicroVM today, and the build that is ignored still runs on the control plane's Docker.
This is the one thing between the alpha instance and running sessions.

The design is merged: `sealant` `docs/workspace-image-builders-design.md` (sealant#266). Two rules:

1. A project's image customisation (OS family or custom base image, packages, default shell) works
   on every runtime, including every adapter added later. Setup commands are Mend's: it runs them
   inside the live workspace, which already works on MicroVM.
2. It never runs where it can read the control plane's credentials or harm it.

Measured on the AWS account on 2026-09-20 (all experiment resources deleted):

- A MicroVM image can use any distro's base. Fedora 41 with Fedora packages built and booted in 144
  s. Builds took 144 to 184 s.
- A recipe step in AWS's managed build is root with Internet access. It cannot reach the VPC or the
  database. It can get the build role's credentials through IMDSv2, and nothing else.
- The managed builder works with a role that has only `GetObject` on one prefix. From inside that
  build every write was denied, and so was another organization's object.

## What we do first

Core step one. No behaviour change.

Open as sealant#267.

- [x] A runtime is registered with the worker as an adapter plus the builder of its image. Required,
      no opt-out. (Not a member of the adapter class: adapters are constructed in about ninety
      places.)
- [x] Builders declare `host` or `isolated`.
- [x] A conformance test over every adapter id. MicroVM was an expected failure until step two;
      sealant#270 removes the exception.
- [x] Correct the design record: the instance never mounts the Docker socket; MicroVM image cleanup
      and an image cap are in scope; the per-build zip is deleted after the build; the same recipe
      builds once, with a test.

## Alpha is up (2026-09-20 evening)

https://alpha.mend.run runs Mend 0.29.0 on Sealant 0.36.0 on one instance, `multi` and `public`, the
EKS cluster taken down (`cluster_enabled = false`). What the first day found:

- [x] Arch, Mend's default family, cannot be built on the MicroVM runtime with Sealant 0.36.0:
      Docker Hub's `archlinux` is x86_64 only. sealant#276 builds Arch from Arch Linux ARM's signed
      rootfs, links glibc's loader on the nix image (no native harness binary ran there), and lets
      opencode's postinstall run. Until Core 0.36.1 and a Mend pin bump, alpha projects must pick
      Fedora or Ubuntu. Done: Sealant 0.36.1 is pinned (#318).
- [ ] Mend defaults every project to Docker on, and to Arch, without asking the deployment what it
      serves. Sealant's health answers the runtime's support; the setup page should default the OS
      family and the Docker toggle from it and say why an option is off.
- [x] Workspace-scoped Docker on every family, proven live on 2026-09-20 (sealant#276).
      `SEALANT_MICROVM_DOCKER_ENABLED=true` is set on alpha.
- [ ] A real capture session through Mend on alpha, with its flush at stop, has still not run.
- [ ] Services on alpha. The stack merged as #336, #337 and #338 and shipped in Mend 0.30.0; the
      live proof below has not been recorded. The check: in a capture-mode session,
      `mend service run web` finds the worktree's `mend.toml` recipe (read from the live executor),
      the agent's own `mend service run --http …` gets an Open URL, `mend attach` on a laptop prints
      `web → http://localhost:<port>` and the page loads through it (HMR included), stopping the
      Service closes the tunnel, and the web's Services card shows `mend service connect web`
      instead of a dead Open link. Only alpha can prove the executor-side read and the tunnel
      through the MicroVM forward.
- [ ] The `reassessment` exposure item is open until someone records a reassessment of 0.29.0.
- [ ] Remove the setup SSH key from the instance once the next pin bump has landed there.
- [ ] Tailnet: remove the cluster's Tailscale operator device and OAuth client. Orphan captures from
      the cluster's sessions sit in the capture bucket.

## To get alpha running (done 2026-09-20; ticked 2026-09-26)

- [x] Core step two: merged as one stack of five (sealant#267, #268, #270, #271, #273).
  - #268: the MicroVM builder. One plan is one image, named `sealant-ws-<plan hash>`. The per-build
    zip is deleted after the build. An image cap.
  - #270: the MicroVM adapter boots the built image. The four one-image settings are retired and
    refused at start. `SEALANT_MICROVM_BUILD_ROLE_ARN` enables the adapter. Docker on a MicroVM is
    `SEALANT_MICROVM_DOCKER_ENABLED`, off by default. `build-image.sh` is removed.
  - #271: image retention deletes unused MicroVM images, and the ones no build job names.
  - #273: sealantd 0.18.1, whose image ships `sealantctl` (sealantd#94). The agent's suspend and
    terminate hooks run `sealantctl capture flush`.
  - `ListMicrovmImages` returns no tags, so images are told by name. Two control planes in one AWS
    account set different `SEALANT_MICROVM_IMAGE_NAME_PREFIX` values.
- [x] The build context needs no binaries: the recipe takes `sealantd` and `sealantctl` with
      `COPY --from` the released image. No Docker on the control plane for a MicroVM build.
- [x] Live proof on AWS, 2026-09-20. A Fedora blueprint with `ripgrep` built in 203 s. The same plan
      again took under a second. The adapter booted it in 7 s, and the OS, the package, `sealantd`,
      a working `sealantctl` and the repository were inside. A fenced stop took 3 s. Not covered: a
      capture-source flush at terminate (needs Mend), and the Docker variant.
- [x] sealant#275, merged and released in Core 0.36.0. The proof found two faults: image lookups
      need an ARN, and the create request's token must be one per attempt. Until it merges, `main`
      builds no MicroVM image. Hold the Core Version PR (sealant#274) until then.
- [ ] One proof image, `proof-ws-2f90f800473b7775fd29c642`, is stuck in `CREATING` in the AWS
      account and cannot be deleted in that state. Try `delete-microvm-image` again later.
- [ ] Core step three: one read-only build role and one prefix per organization.
- [x] Core release, then the Mend pin bump (template: mend#307). Core 0.36.0, pinned in #314.
- [ ] Mend: a multi mode gate item that refuses `MEND_TENANCY=multi` while recipes run on the
      control plane's host.
- [ ] Mend OpenTofu: per-organization build roles and prefixes.
- [x] The worker's new permissions (the four `lambda:*MicrovmImage` actions, `iam:PassRole` on the
      build role, `s3:PutObject` and `s3:DeleteObject` on the prefix) and the new settings in
      `compose.aws.yaml` (#314, #320; `deploy/aws/tofu/application.tf`).
- [x] Apply `deploy/aws/tofu` with `instance_enabled = true`.
- [x] `alpha.mend.run` A record, DNS-only, at the instance's Elastic IP.
- [x] Fresh `mend` and `sealant_control_plane` databases on PlanetScale. No data carried over.
- [x] First boot in two steps: `single` and `private`, create the first account over an SSM
      port-forward, then `multi` and `public`. The order as it ran is in `deploy/aws/README.md`
      (#316).
- [ ] From outside the VPC: `mend doctor` against the origin, a sign-up without an invitation, and
      connection attempts to the database and Sealant.
- [x] Tear down EKS (`deploy/aws/TEARDOWN.md`), with `cluster_enabled = false` (#315).

## A dead worker looks healthy

Found 2026-09-20 while booting the image without a Docker socket. Sealant's worker retries its own
start every two seconds forever. A missing setting never heals, so the process stays alive, the
bundle supervisor reports ready, Mend's health says ok, and no session can start.

- [ ] Core: a configuration error stops the worker. Errors that can heal keep the retry, with a
      growing delay.
- [ ] Core: the API reports whether a worker is alive.
- [ ] Mend: health and `mend doctor` report it as an observation.

## Test stages agreed

The packaged acceptance run takes about three minutes, and the whole workflow about seven.

- [ ] A real upgrade: install the published previous release, create data, upgrade to the candidate,
      and check the old data still works. The most important one.
- [ ] A second account, run with `multi` and the edge: the invitation flow, private and shared
      projects, per-account keys and credentials, shared control.
- [ ] Services: `mend service run` inside a live session, reached from outside.
- [ ] Real GitHub.com. Needs a private repository in `sealant-sh` and a fine-grained token on a
      protected environment.
- [ ] References and folders present inside a live workspace.
- [ ] Linked projects in capture mode. Suspected broken from the code: the engine applies no mounts
      in capture mode and nothing sends linked projects on the plan. Never confirmed live.
- [ ] Run the packaged acceptance on pull requests that touch sessions, the store, the API, the CLI,
      the Dockerfile or `deploy/`.
- [ ] Stop the skipped "Release acceptance" entries on pull requests without the label.
- [x] Confirm `version.yml` dispatches the acceptance on the next Version PR. It does: the
      `release-acceptance.yml` runs on `changeset-release/main` are `workflow_dispatch` runs.

## Smaller loose ends

- [x] Tag Mend 0.29.0. The acceptance run on `main` at `fef117c` passed on both architectures. Tags
      now run to v0.33.0.
- [ ] The capture warning `git section failed verification at register … not a git repository` on a
      suspend capture. Never investigated.
- [ ] `install.sh` is still served by the marketing site and attached to every release. Only the
      references were removed (#311).
- [x] The docs install page still says "two product containers". It is three. Fixed in the
      2026-09-26 docs pass.
- [x] What `mend` prints when the TUI is opened on Node.js 22. It says the dashboard needs Node 26
      and that every other command still works (`apps/cli/src/main.ts`).
- [ ] `mend server setup`, `start` and `upgrade` do not know the edge overlay or `compose.aws.yaml`.
      Alpha upgrades are by hand until they do.
- [ ] Core's `format:check` fails on two generated changelogs on `main`.
- [ ] Local leftovers: the worktrees `Sealantd-plan-remotes`, `Core-sealantd-0.18` and
      `Core-skip-build`, and the `ghcr.io/sealant-sh/mend:0.0.0-acceptance.4` image.

## Done on 2026-09-19 and 2026-09-20

- Released sealantd 0.18.0 (plan remotes, sealantd#91; the shutdown reply race, sealantd#93) and
  Sealant 0.35.1 (sealant#263).
- Three bugs on in-session git, all found by the new acceptance push check: no git transport in a
  captured workspace (#302), no `origin` in the repository sealantd builds (sealantd#91, #303,
  #307), and the origin binding refusing `git@host` (#309).
- The packaged acceptance gained a git access stage over SSH and runs before a tag (#304, #305). Two
  stale assertions in it were fixed.
- README cleanup, npm as the one install path, Node.js 26 for the TUI (#311).
- The single-instance AWS deployment, defined and not applied (#312). Booted locally with no Docker
  socket: Mend and Sealant's API, worker and SSH gateway stay up.
- The workspace image builders design (sealant#266), with the AWS measurements above.
- Closed: sealant#265, which skipped the image build for MicroVM and made customisation a no-op.
