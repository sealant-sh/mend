# Doppler

A person connects their own Doppler token to Mend, and maps a Mend project to a Doppler project and
config. Mend keeps the token encrypted and writes `~/.doppler/.doppler.yaml` into every workspace
home the person owns, so `doppler run` works there with no login. Launch never calls Doppler. The
token never comes back out: every surface shows connected or not, and the set date.

## Sub-features

- `doppler-connect-cli` uploads the token of a local `doppler login` with `mend doppler connect`, on
  the laptop or inside a session, and imports its directory scopes as mappings by Git remote.
- `doppler-use` maps a Mend project to a Doppler project and config with `mend doppler use`. Inside
  a session the Mend project defaults to the session's, and the home file changes at once.
- `doppler-status` reads the stored connection and mappings locally, with no Doppler call.
- `doppler-delivery` writes the home file into each workspace home the person owns, outside the
  captured worktree, mode `0600` in a `0700` directory.
- `doppler-settings` connects a pasted token, picks a project and config, and disconnects on
  Settings, beside Secret files.
- `doppler-disconnect` removes the token and the mappings, and the home file Mend wrote.

## How to get to it (user POV)

- CLI: `mend doppler connect`, `mend doppler use <doppler-project> <config> [--project <name>]`,
  `mend doppler status`, `mend doppler disconnect`.
- Web: `Settings` in the primary navigation opens `/settings`; the Doppler panel sits beside
  `Secret files`.
- TUI, desktop, mobile, VS Code, Slack: no Doppler surface.

## Driving it with verify

This recipe needs a real Doppler account. Use a disposable Doppler project with `dev` and `stg`
configs, and a secret `MEND_DOPPLER_CHECK=connected` in it. The automated tests use fake tokens
only, so this is the only check against Doppler itself. A workspace image without the Doppler CLI
still receives the home file, and `mend doppler status` reports the missing CLI.

Preconditions:

- Mend is healthy at `<web>`, the CLI and the browser are signed in, and `<project>` is adopted from
  a Git remote.
- `<checkout>` is a local checkout of that remote, and `doppler` is installed on the laptop.

Set the values once:

```sh
export MEND_DOPPLER_CHECKOUT=<checkout>
export MEND_DOPPLER_MEND_PROJECT=<project>
export MEND_DOPPLER_PROJECT=<disposable-doppler-project>
```

- **Connect from the laptop.** Run:

  ```sh
  cd "$MEND_DOPPLER_CHECKOUT"
  doppler login
  doppler setup --project "$MEND_DOPPLER_PROJECT" --config dev --no-interactive
  mend doppler connect
  mend doppler status
  ```

  Status reads connected, with a mapping from `<project>` to the Doppler project's `dev` config,
  imported by Git remote. No token is printed. Another local directory of the same remote still
  matches. A scope with no matching adopted project is skipped.

- **Launch a session.** Run:

  ```sh
  mend doppler use "$MEND_DOPPLER_PROJECT" dev --project "$MEND_DOPPLER_MEND_PROJECT"
  mend run --project "$MEND_DOPPLER_MEND_PROJECT" --name doppler-check --detach --json -- sleep infinity
  ```

  Copy the `sessionId` from the JSON into `MEND_DOPPLER_SESSION`, then run
  `mend shell "$MEND_DOPPLER_SESSION"`.

- **Delivery.** In the session's shell, from the worktree, run `id`, `pwd`, `mend doppler status`,
  `doppler --version`, then this check, which reads the file without printing its token:

  ```sh
  node <<'JS'
  const fs = require('node:fs');
  const path = require('node:path');
  const assert = require('node:assert/strict');
  const home = require('node:os').homedir();
  const dir = path.join(home, '.doppler');
  const file = path.join(dir, '.doppler.yaml');
  const stat = fs.statSync(file);
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stat.uid, process.getuid());
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.ok(!fs.realpathSync(file).startsWith('/workspace/'));
  assert.equal(typeof config.scoped['/'].token, 'string');
  assert.ok(config.scoped['/'].token.length > 0);
  assert.ok(config.scoped[process.cwd()]['enclave.project']);
  assert.equal(config.scoped[process.cwd()]['enclave.config'], 'dev');
  console.log('Own home, private config, root token, worktree mapping: passed');
  JS
  doppler configure get project config --plain
  doppler secrets --only-names
  doppler run -- sh -c 'test "$MEND_DOPPLER_CHECK" = connected && printf "Doppler run: passed\n"'
  ```

  Expect the check's `passed` line, the intended project and `dev`, secret names only, and
  `Doppler run: passed`. The process runs as the session's Linux user, and the home file is outside
  the captured worktree.

- **Mapping update.** In the same shell, set `MEND_DOPPLER_PROJECT` again, run
  `mend doppler use "$MEND_DOPPLER_PROJECT" stg` and `doppler configure get project config --plain`.
  It reads `stg` at once, with no restart. Run `mend doppler use "$MEND_DOPPLER_PROJECT" dev` to put
  it back.
- **Connect from inside.** In the shell, run `doppler login`, `mend doppler connect`,
  `mend doppler status` and `doppler secrets --only-names`. The workspace's own login uploads and
  its worktree mapping imports. No token appears in the terminal or the session record.
- **Doppler failing.** In the shell, run
  `doppler secrets --only-names --api-host http://127.0.0.1:1 --attempts 1 --timeout 1s --no-check-version`,
  which fails, then `mend doppler status`, which still reads the stored connection. Exit the shell
  and repeat the laptop's `mend run` with `--name doppler-outage-check`. It launches and writes the
  file. This fails the local CLI only; it does not simulate an outage seen by the Mend server.
- **Settings.** On `<web>/settings`, connect by pasting a disposable service token or personal CLI
  token. The panel reads connected with the set date, and no token comes back. Choose a project and
  config for `<project>`, save and reload: the mapping persists. The picker lists what the token may
  see; when listing fails, typed project and config names still save. Remove a mapping and save
  another.
- **Another person.** A second account connects its own token and a different mapping for the same
  shared project, then steers a turn. From that person's session shell, repeat the delivery check
  and `doppler configure get project config --plain`. Expect their Linux home, token and mapping. A
  preview that person starts uses the same identity. Inspect names or the sentinel only.
- **Disconnect.** In a session shell, after `mend doppler use` has written Mend's file, run:

  ```sh
  mend doppler disconnect
  mend doppler status
  test ! -e "$HOME/.doppler/.doppler.yaml" && printf 'Mend-delivered config removed\n'
  ```

  Status reads disconnected with no mappings, and the file is gone. Settings also reads
  disconnected; try its Connect and Disconnect buttons once.

- **Clean up.** On the laptop, `mend stop "$MEND_DOPPLER_SESSION"` and `mend stop` the outage
  check's session. Delete the disposable Doppler project, or remove the sentinel from its configs.

## Gotchas

- A `doppler login` the person runs after Mend's delivery is theirs: disconnect keeps it. Do not
  read it as Mend's unchanged file.
- Other running homes get the disconnect at their next file delivery, not at once.
- Never print a secret value in a recipe: the terminal is recorded. Check names or the sentinel.
