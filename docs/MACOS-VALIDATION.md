# macOS packaging validation

The test target is the three-container Mend deployment (Mend, Postgres and Garage) that
`mend server setup` installs, first planned in [PACKAGING-PLAN.md](archive/PACKAGING-PLAN.md), not
the retired host-process installer.

Sealant 0.28.0 first supplied the volume-backed runtime capability; the bundle pins Sealant 0.37.2
today (`deploy/docker/setup-contract.v2.json`). Its containerized-launcher E2E passed on Linux. No
macOS-specific failure has been demonstrated in the proposed architecture. Actual Mac and installed
VS Code acceptance remain unverified.

## Optional prerequisite probe

With Docker Desktop or OrbStack running, execute:

```sh
sh scripts/check-docker-boundary.sh
```

The script respects the current context and `DOCKER_CONTEXT`; it does not change either. It rejects
remote TCP/SSH endpoints because its host-loopback test would otherwise target the wrong machine. It
downloads `node:24-alpine` if needed and creates a temporary named volume and containers. It mounts
no user files or Docker socket and uses no privileged containers. It removes its resources on exit;
the image remains cached. If Docker stops during cleanup, remove only the scratch resources reported
by the script after Docker returns.

The probe checks a published loopback port, HTTP over Unix sockets between Linux containers,
read-only subdirectory access, sibling-directory isolation, and persistence after container removal.
It does not exercise Mend, Sealant's adapter, peer credentials, or VS Code. A passing result proves
only these Docker operations.

Linux control command:

```sh
sh scripts/check-docker-boundary.sh --allow-linux
```

## Product acceptance

Use a disposable project/account, the exact release-candidate image, the packed CLI, and the
installed extension VSIX. Record macOS version, architecture, Docker provider and Engine version,
Mend image digest, and VS Code/extension versions. Apple Silicon, Intel, Docker Desktop, and
OrbStack need separate observations; one passing combination does not prove the others.

### Fresh setup and origin policy

1. Install the CLI from npm. Verify no server starts. Repeat the shell bootstrap independently.
2. Run `mend server setup`, selecting localhost. Do not set manual volume mappings, access the VM
   shell, or choose a Sealant version.
3. Confirm only the Mend application, Postgres and Garage containers run at idle, with only intended
   ports published. Workspace containers are additional only when workspaces exist.
4. Open the printed URL, create an account, and run `mend login`. Connect a provider normally.
5. Repeat setup. Confirm accounts, secrets, selected context/ports, volumes, and SSH host keys
   remain.
6. Adopt a Git URL. Local paths, `file://` sources, and folder selection must be rejected or absent;
   there is no local-repository import requirement. Existing-project/worktree selection still works.
7. Start a session, edit a file, run Git commands and the workspace helper, then inspect its change
   in Mend. Confirm linked Git metadata, dotfiles, harness state, and the session channel work
   without the Mac opening a container socket or host-sharing the store.
8. Configure private-network access through setup. Sign in through the primary and each explicitly
   allowed alternate origin. An unlisted hostname, scheme, or port must not gain credentialed
   access.

### Installed VS Code extension

1. Install Mend and Microsoft Remote-SSH locally. Launch VS Code from Finder/Dock, not just a shell
   that lends it environment variables.
2. Use the connection saved by `mend login`, choose the project/worktree/session, accept the normal
   SSH setup, and open its workspace. Do not repair SSH configuration manually to make the test
   pass.
3. Confirm the remote folder is `/workspace/repo`, `uname -s` returns `Linux`, and `git status`
   succeeds. Edit through VS Code and confirm the same file appears in Mend's review.
4. Confirm Remote-SSH installs its server and transfers files. Start an HTTP service on workspace
   loopback, forward it through VS Code's Ports view, and open it on the Mac. A shell alone does not
   prove Remote-SSH forwarding.
5. Run a connected agent from the terminal; confirm Mend observes it and preserves its conversation.
   Close and reopen VS Code, then test the extension's offered resume path for a settled session.
6. Test local key-file and ssh-agent identities, paths with spaces, a changed gateway port, and two
   Mend servers. Per-server aliases must remain distinct; hand-written SSH configuration survives.
7. An unreachable or unauthorized server must produce an actionable failure, never a local-folder
   fallback or a request to SSH into Docker's VM.

### MacBook client and Mac Mini server

1. Install the server on the Mini with an explicitly configured LAN or other private-network URL.
   Exposure stays at its default, `private`.
2. On the MacBook, run `mend login` against that URL and open VS Code normally.
3. Open a workspace through the extension. Its managed SSH hostname must address the Mini, not the
   MacBook's localhost. Verify browser login, terminal, file editing, and port forwarding.
4. Change the server's published SSH port and repeat setup/reconnection. The managed entry updates
   without changing another server's alias or requiring a manual SSH edit.
5. Test an explicit separate SSH hostname if supported. It must not change Better Auth's origin
   policy or trust arbitrary forwarded headers.

### Restart and upgrade

1. Restart only the application container during disposable active work. Confirm helper/Git
   transport, review, agent state, and VS Code reconnect; SSH host identity remains unchanged.
2. Restart Docker Desktop/OrbStack. Data and records survive. Report processes that died as ended;
   verify native resume rather than claiming uninterrupted execution.
3. Upgrade between supported Mend versions. Confirm both databases migrate, secrets/keys persist,
   and failure leaves recoverable state with a clear diagnosis. Binary downgrade is not a database
   rollback.
4. Stop/start the installation. Volumes remain. Upgrade only the CLI and confirm the server version
   does not change.

## Evidence ledger

| Check                                                  | Observation                                                      |
| ------------------------------------------------------ | ---------------------------------------------------------------- |
| Generic volume/socket/port probe on Linux amd64        | Passed, Docker Engine 29.7.2                                     |
| Sealant 0.28.0 containerized-launcher E2E on Linux     | Passed, including controller replacement and strict subpaths     |
| Same prerequisite probe on macOS                       | Not yet run                                                      |
| Packaged Mend session on macOS                         | Not yet run                                                      |
| Installed VS Code and MacBook-to-Mini flow             | Not yet run                                                      |
| Packaged CLI, session, record, and native SSH on Linux | Passed; private client config and container-pinned gateway trust |
| Packaged rerun/restart/stop-start/upgrade on Linux     | Passed; same-source two-image upgrade and retained data          |
| Packaged Mend rerun/restart/upgrade on macOS           | Not yet run                                                      |

The Linux installed-product run on 2026-09-06 used a packed CLI from this stack (the unreleased
source manifest still read `0.22.0`), not a historical npm release:

```sh
MEND_TEST_IMAGE=ghcr.io/sealant-sh/mend:0.0.0-acceptance.local.20260906 \
MEND_TEST_VERSION=0.0.0-acceptance.local.20260906 \
MEND_TEST_UPGRADE_IMAGE=ghcr.io/sealant-sh/mend:0.23.0-packaging.20260906.1 \
MEND_TEST_UPGRADE_VERSION=0.23.0-packaging.20260906.1 \
MEND_TEST_OFFLINE=1 node scripts/check-packaged-server.mjs
```

The locally built images have genuine, distinct version stamps but the same server source. This
proves upgrade mechanics and retention, not historical migration compatibility, restore, or
target-startup failure recovery. Native SSH read the committed workspace file; no installed editor
or port-forwarding claim follows.

Record new evidence with exact versions and commands. Do not include private keys, provider tokens,
Docker credential files, or environment dumps in reports.
