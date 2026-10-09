# Workspace SSH

An editor or a plain `ssh` client reaches a live session's workspace through the platform's
workspace SSH gateway, so VS Code Remote-SSH can open the worktree at `/workspace/repo`. On the
client machine, `mend ssh setup` registers a public key with the server and writes one managed,
server-specific `Host` block into `~/.ssh/config`; `mend ssh` reports what it observed about that
setup. Neither proves an SSH connection or verifies the gateway's host key: OpenSSH accepts a new
host key on first contact and refuses a changed one. The VS Code extension runs the same setup from
`Mend: Set up workspace SSH`, and `Mend: Open in VS Code` opens a session's worktree over it.

## Sub-features

- `ssh-status` reports the gateway, the client key and its registration, and the ssh config block
  (`mend ssh`, `mend ssh status`).
- `ssh-setup` picks or generates a client key, registers it, and writes the managed block
  (`mend ssh setup [--key <path>] [--host <hostname>]`).
- `no-gateway` says so when the deployment exposes no gateway.
- `vscode-setup` runs the same setup from VS Code, after asking.
- `vscode-open` opens a session's worktree over Remote-SSH, offering a shell resume for a settled
  session.

## How to get to it (user POV)

- CLI: `mend ssh [status]` and `mend ssh setup [--key <path>] [--host <hostname>]`.
- VS Code: the command palette's `Mend: Set up workspace SSH`; `Mend: Open in VS Code` from a
  session in the Mend tree or the quick pick. The setting `mend.workspaceSshHost` overrides the
  hostname. Not drivable yet: no VS Code harness exists for this map.
- `mend uninstall` with the `home` scope removes the managed block (see
  [Uninstall](./uninstall.md)).
- Web, TUI, desktop and mobile have no workspace SSH controls.

## Driving it with verify

Preconditions:

- Mend is healthy at `<web>` and its deployment exposes the workspace SSH gateway (the no-gateway
  step needs one that does not).
- Run every command with fresh disposable `HOME` and `XDG_CONFIG_HOME` directories so the run edits
  only its own SSH configuration and key: `export HOME=<tmp>/ssh-home` and
  `export XDG_CONFIG_HOME=<tmp>/ssh-config`. Create `$XDG_CONFIG_HOME/mend` and copy the run's
  signed-in `cli.json` there, to `$XDG_CONFIG_HOME/mend/cli.json`. Unset `SSH_AUTH_SOCK` so setup
  generates a dedicated key at `$XDG_CONFIG_HOME/mend/ssh/id_ed25519` instead of pinning an agent
  key. Both directories start empty apart from that copied credential file.

- **Status before setup.** Run `mend ssh`. Stdout shows
  `gateway         <host>:<port> · published for <web>`,
  `client key      none available · run: mend ssh setup`,
  `ssh config      missing or stale · run: mend ssh setup` and
  `host trust      not checked · status checks config and client-key registration, not an SSH connection`.
  Exit `0`.
- **Set up.** Run `mend ssh setup`. Stdout shows
  `key             ● <fingerprint> · generated dedicated key`,
  `ssh config      ● Host mend-ws-<label>-<hash> · <HOME>/.ssh/config`,
  `host trust      not checked · SSH verifies the gateway when you connect; setup does not replace known_hosts entries`,
  and
  `connect with    ssh <prefix>-<workspace-id>@mend-ws-<label>-<hash> · the VS Code extension uses this automatically`.
  Exit `0`.
- **Read the config.** Run `cat "$HOME/.ssh/config"`. It holds one block between
  `# >>> mend workspace ssh mend-ws-<label>-<hash> (managed) >>>` and
  `# <<< mend workspace ssh mend-ws-<label>-<hash> <<<`.
- **Status after setup.** Run `mend ssh`. Stdout shows
  `client key      ● <fingerprint> · registered` and
  `ssh config      ● Host mend-ws-<label>-<hash> · <HOME>/.ssh/config`, with the same fingerprint as
  setup printed.
- **Setup again.** Run `mend ssh setup`. The key line names the same fingerprint with
  `· existing selected key`, and the config still holds exactly one managed block for this server.
- **Unknown subcommand.** Run `mend ssh bogus`. Stdout reads
  `mend: Unknown ssh subcommand "bogus". Try: mend ssh · mend ssh setup [--key <path>] [--host <hostname>]`,
  exit `1`.
- **No gateway.** Against a deployment without one, `mend ssh` prints
  `workspace ssh   no gateway · this deployment exposes none` (exit `0`), and `mend ssh setup`
  prints `mend: This deployment exposes no workspace SSH gateway.` (exit `1`).
- **Connect from the CLI.** Not drivable through the CLI/web listings: neither provides the
  workspace id the `connect with` line needs (Gotchas). Record it unreachable with that reason. VS
  Code's `Copy code command` includes the id in its remote authority, but that path is not drivable
  yet because the verify stack has no VS Code driver.
- **VS Code (not drivable yet).** `Mend: Set up workspace SSH` asks `Set up workspace SSH?` with
  `Set up`; afterwards the status bar reads
  `Mend SSH config saved; client key registered. Host trust not checked.` `Mend: Open in VS Code`
  needs the Microsoft Remote SSH extension (otherwise
  `Opening a remote Mend worktree requires Microsoft Remote SSH.` with `Install Remote SSH` and
  `Copy code command`), and for a settled session asks `<session> has no live workspace.` with
  `Resume and open`. With Remote SSH absent, `Copy code command` copies
  `code --remote ssh-remote+<prefix>-<workspace-id>@<host> "/workspace/repo"`. Not drivable yet: no
  VS Code driver exists in the verify stack.
- **Proof.** Keep the `mend ssh`, `mend ssh setup` (twice) and `mend ssh bogus` transcripts with
  exit codes, and the disposable `~/.ssh/config` after each setup.

## Gotchas

- `mend ssh setup` writes the `~/.ssh/config` of whoever runs it and registers a key on the server.
  Without a disposable `HOME`, a run edits the operator's real SSH configuration.
- Changing `HOME` leaves an existing `XDG_CONFIG_HOME` authoritative for CLI credentials and the
  dedicated SSH key. Set both to fresh disposable directories. The resolved Mend config directory is
  `$XDG_CONFIG_HOME/mend`; copy `cli.json` there, or the commands answer `not signed in`.
- With `SSH_AUTH_SOCK` set, setup may pin a key from the agent
  (`from your ssh-agent (public identity saved locally)`) instead of generating one, which changes
  the printed lines.
- Local SSH command failures, including an unknown subcommand, no gateway during setup, or a
  config/key error, print `mend: …` on stdout and set exit `1`. API and authentication failures
  print `mend: …` on stderr and exit `1`. Capture both streams and the exit code.
- `mend ssh status` also reads `--host`; `help.ts` documents the flag only for `mend ssh setup`.
- `ssh-config` and `client key` lines describe this client's files and the server's key list.
  `host trust      not checked` is the honest state: Mend has no host-key fingerprint from the
  platform.
- The `connect with` line needs a workspace id, which neither `mend sessions --json` nor the web
  session page lists. That is a product gap for a CLI user trying the printed command. VS Code is an
  exception: when Microsoft Remote SSH is absent, `Copy code command` copies a remote authority
  containing the workspace id. `mend shell` is the CLI's way into a workspace (see
  [Session shell](./session-shell.md)).
- A settled session has no running workspace to reach; the editor flow resumes it as a shell first.
