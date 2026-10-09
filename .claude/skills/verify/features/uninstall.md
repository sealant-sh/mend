# Uninstall

`mend uninstall` is the one command that deletes. It removes the local server, this machine's Mend
files, or both. Without a scope it asks which, then prints exactly what will go before touching
anything. Removing the server takes its containers, every volume it owns (repositories, worktrees,
session captures, the database), its release image and its private configuration with generations
and backups, and needs the typed word `delete`. Removing this machine's files revokes this
terminal's device token on the server first, then removes `cli.json`, the workspace SSH key and the
managed block in `~/.ssh/config`. Anything else is listed and left in place, and workspace
containers are named with the command that removes them, never removed.

## Sub-features

- `uninstall-ask-scope` asks `what should go?` with three numbered choices when no scope is given.
- `uninstall-plan` prints one line per thing that goes before asking.
- `uninstall-confirm` asks for the word `delete` when the server is in scope, `y` otherwise.
- `uninstall-server` removes the Compose installation, its owned volumes, its image and its private
  configuration.
- `uninstall-home` revokes the device token and removes the sign-in, the SSH key and the managed
  `~/.ssh/config` block.
- `uninstall-all` does both, server first.
- `uninstall-leftovers` lists what stays and why: unowned volumes, workspace containers, other
  files in the configuration directory.
- `uninstall-yes` skips the question with `--yes`, which a run without a terminal requires.

## How to get to it (user POV)

- CLI: `mend uninstall [--all | --server | --home] [--yes]`.
- CLI: `mend help uninstall`; the install and VPS docs end with it.
- Web, TUI, desktop, mobile, VS Code and Slack: not a surface for this feature. A revoked device
  shows as gone under the web Settings `Devices` panel, which is the
  [pairing-devices](./pairing-devices.md) feature.

## Driving it with verify

Preconditions:

- The server steps run only on the disposable host from [the local server](./server.md), with a
  server that recipe installed, and with the same `XDG_CONFIG_HOME=<scratch>/config` and
  `HOME=<scratch>/home`. Never on the owner's machine or Launch's stack: this deletes repositories
  and the database.
- The home steps run with `XDG_CONFIG_HOME=<scratch>/config` and `HOME=<scratch>/home` too, and the
  CLI there is signed in to an instance this run started (`mend login --url <web>`), so the device
  token it revokes is a disposable one. Keep the saved token as `<token>` for the second view.
- `<scratch>/home/.ssh/config` exists; it may hold a managed block from `mend ssh setup`.

- **Help page.** Run `mend help uninstall`. Stdout starts
  `mend uninstall · remove the server, this machine's Mend files, or both` and lists `--all`,
  `--server`, `--home` and `--yes`. Exit code `0`.
- **Usage errors.** Run `mend uninstall --server --home`. Stderr reads
  `mend: usage: mend uninstall [--all | --server | --home] [--yes] · pick one scope`, exit `1`. Run
  `mend uninstall --everything`. Stderr reads
  `mend: usage: mend uninstall [--all | --server | --home] [--yes] · "--everything" is not an option`,
  exit `1`.
- **No terminal, no scope.** Run `mend uninstall < /dev/null | cat`. Stderr reads
  `mend: usage: mend uninstall [--all | --server | --home] [--yes] · no terminal to ask on`, exit
  `1`.
- **Plan only, server.** Run `mend uninstall --server < /dev/null`. Stdout reads
  `mend uninstall · server`, then `  server   Mend <v> at <url> · docker context <ctx>`,
  `           containers mend, postgres, garage · volumes mend-store, mend-control, mend-garage, mend-config, mend-ssh, mend-postgres · image ghcr.io/sealant-sh/mend:<v>`,
  `           <scratch>/config/mend: identity.env, active, <n> generation(s), <m> backup(s)`, and
  `repositories, worktrees, the database and its backups are deleted with the server`. Stderr reads
  `mend: non-interactive — pass --yes to remove`, exit `1`. `mend server status` still reads
  `Pinned Mend <v>`: nothing was removed.
- **Ask and decline.** In a PTY, run
  `tmux new-session -d -s verify-uninstall -x 200 -y 50 'mend uninstall; echo "exit $?"; sleep 600'`.
  The screen shows `what should go?`, then
  `  1. everything · the server on this machine and this machine's Mend files`,
  `  2. the server only · containers, volumes, configuration, backups`,
  `  3. this machine's files only · sign-in, workspace ssh key, ~/.ssh/config block` and the prompt
  `  1, 2 or 3: `. Send `tmux send-keys -t verify-uninstall 2 Enter`. The server plan prints, then
  `type delete to remove: `. Send `tmux send-keys -t verify-uninstall no Enter`. The screen shows
  `nothing removed` and `exit 0`.
- **Remove the server.** Run `mend uninstall --server --yes`. Stdout shows the plan, then
  `removed containers mend, postgres, garage and the Compose-owned volumes`,
  `removed volumes mend-store, mend-control, mend-garage`,
  `removed image ghcr.io/sealant-sh/mend:<v>`,
  `removed <scratch>/config/mend/{identity.env, active, generations, backups}`, any
  `  kept · …` lines, and `✓ the server is gone from this machine`. Exit code `0`.
- **Server gone, second view.** Run `mend server status`. Stderr reads
  `mend: No Mend server is configured. Run mend server setup explicitly to install one.`, exit `1`.
  Run `docker --context <ctx> volume ls --format '{{.Name}}'`. No `mend-store`, `mend-control` or
  `mend-garage` is listed. When a session had run, a `  kept · <n> workspace container(s) left on docker context <ctx> (…): docker --context <ctx> rm -f …`
  line named them, and `docker --context <ctx> ps -a` still lists them.
- **Plan only, home.** Run `mend uninstall --home < /dev/null`. Stdout reads
  `mend uninstall · home`, then `  home     <scratch>/config/mend/cli.json (signed in to <web>)`,
  plus `<scratch>/config/mend/ssh` and `<n> managed block(s) in ~/.ssh/config` lines when present.
  No `delete` line is printed. Stderr reads `mend: non-interactive — pass --yes to remove`, exit
  `1`.
- **Remove the home files.** Run `mend uninstall --home --yes`. Stdout shows
  `revoked this terminal's device on <web>`, `removed <scratch>/config/mend/cli.json`, the SSH key
  and managed-block removals when they existed, `removed <scratch>/config/mend` (or a
  `  kept · <scratch>/config/mend kept: …` line naming what else lives there), and
  `✓ this machine no longer holds Mend files`. Exit code `0`.
- **Revoked, second view.** Run `MEND_URL=<web> MEND_TOKEN=<token> mend doctor`. The second line
  reads `✗ signed in   token rejected → mend login`. Run `MEND_URL=<web> mend doctor` with no token
  in the environment. It reads `✗ signed in   no token saved → mend login`. (Without `MEND_URL` the
  CLI falls back to `http://localhost:3105`, since `cli.json` is gone.)
- **Nothing left.** Run `mend uninstall --all --yes` again. Stdout reads `mend uninstall · everything`,
  `  server   none installed under <scratch>/config/mend`, `  home     nothing of Mend's here` and
  `nothing to remove`. Exit code `0`.
- **Proof.** Keep every transcript with stdout, stderr and exit code, the `tmux capture-pane -p`
  snapshots of the asked scope and the declined confirmation, and the second views (`mend server
  status`, `docker volume ls`, the two `mend doctor` runs). Record what the run removed in the
  report; that is the point of this feature.

## Gotchas

- `HOME` matters as much as `XDG_CONFIG_HOME`: the home scope edits `~/.ssh/config` under the real
  `HOME`. A run with the owner's `HOME` strips the owner's managed block.
- The home scope revokes the device on whatever server `cli.json` names, before deleting anything.
  Run it only when that server is one this run started. Signed in through `MEND_TOKEN` with no saved
  device id, it keeps a line instead:
  `kept · device token on <url>: no device id saved (end it under Settings → Devices)`.
- `--yes` is required without a terminal, and the confirmation reads stdin, not the scope flags. A
  plan-only check is `< /dev/null` without `--yes`: it prints the plan, removes nothing and exits
  `1`.
- `-y` is accepted as `--yes` (`apps/cli/src/uninstall.ts:49`), but `mend help uninstall` documents
  only `--yes`. A gap between the parser and the catalog.
- The plan line always names the `garage` container and `mend-garage` volume, even for an install
  from before the capture store; the removal then names only the volumes that install owns.
- Data volumes go only when their ownership label matches this installation's identity. Otherwise a
  `kept · volumes …: ownership could not be confirmed for this installation, so they stay` line
  names them. That is the designed outcome on a daemon that already had Mend data, not a failure.
- Workspace containers (`sealant-…`) carry no label tying them to this install; uninstall names them
  with the `docker rm -f` command and leaves them. Remove them by that command in cleanup.
- A `mend doctor --bundle` archive saved under the default `<config>/mend/bundles/` keeps the
  configuration directory: the home scope reports it as kept and does not remove it.
- With `--all` the device is revoked first, then the server goes, then the home files. If the server
  removal fails, the command exits `1` with the reason after removing the home files; read every
  `kept ·` line before retrying.
