# Current scope

Written 2026-09-20. A working list across `sealant-sh/mend`, `sealant-sh/sealant` (Core) and
`sealant-sh/sealantd`. Update it as items land; delete it when it is empty.

## What we are fixing now

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

## To get alpha running

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
- [ ] sealant#275, open. The proof found two faults: image lookups need an ARN, and the create
      request's token must be one per attempt. Until it merges, `main` builds no MicroVM image. Hold
      the Core Version PR (sealant#274) until then.
- [ ] One proof image, `proof-ws-2f90f800473b7775fd29c642`, is stuck in `CREATING` in the AWS
      account and cannot be deleted in that state. Try `delete-microvm-image` again later.
- [ ] Core step three: one read-only build role and one prefix per organization.
- [ ] Core release, then the Mend pin bump (template: mend#307).
- [ ] Mend: a multi mode gate item that refuses `MEND_TENANCY=multi` while recipes run on the
      control plane's host.
- [ ] Mend OpenTofu: per-organization build roles and prefixes. Also the worker's new permissions
      (the four `lambda:*MicrovmImage` actions, `iam:PassRole` on the build role, `s3:PutObject` and
      `s3:DeleteObject` on the prefix) and the new settings in `compose.aws.yaml`.
- [ ] Apply `deploy/aws/tofu` with `instance_enabled = true`.
- [ ] `alpha.mend.run` A record, DNS-only, at the instance's Elastic IP.
- [ ] Fresh `mend` and `sealant_control_plane` databases on PlanetScale. No data carried over.
- [ ] First boot in two steps: `single` and `private`, create the first account over an SSM
      port-forward, then `multi` and `public`.
- [ ] From outside the VPC: `mend doctor` against the origin, a sign-up without an invitation, and
      connection attempts to the database and Sealant.
- [ ] Tear down EKS (`deploy/aws/TEARDOWN.md`).

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
- [ ] Confirm `version.yml` dispatches the acceptance on the next Version PR. Unproven.

## Smaller loose ends

- [ ] Tag Mend 0.29.0. The acceptance run on `main` at `fef117c` passed on both architectures.
- [ ] The capture warning `git section failed verification at register … not a git repository` on a
      suspend capture. Never investigated.
- [ ] `install.sh` is still served by the marketing site and attached to every release. Only the
      references were removed (#311).
- [ ] The docs install page still says "two product containers". It is three.
- [ ] What `mend` prints when the TUI is opened on Node.js 22.
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
