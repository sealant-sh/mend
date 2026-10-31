# Doppler account check

Use the Mend build from this stack. It pins Core `0.40.0-next.775`, containing Core #428 and its
Doppler CLI catalog package. An older workspace image without Doppler should still receive the home
file, and `mend doppler status` should report the missing CLI. These are manual checks for Yiannis's
account. The implementation tests use fake tokens only.

## On the laptop

Use a disposable Doppler project with `dev` and `stg` configs and a Mend project adopted from a Git
remote. Replace the three values below. Use the Mend build from this stack, signed in to the
instance under test.

```sh
export MEND_DOPPLER_CHECKOUT=/absolute/path/to/the/local/checkout
export MEND_DOPPLER_MEND_PROJECT=your-mend-project
export MEND_DOPPLER_PROJECT=your-disposable-doppler-project
cd "$MEND_DOPPLER_CHECKOUT"
doppler login
doppler setup --project "$MEND_DOPPLER_PROJECT" --config dev --no-interactive
doppler secrets set MEND_DOPPLER_CHECK=connected
mend doppler connect
mend doppler status
```

Expect a connected status and a mapping from the Mend project to the Doppler project's `dev` config,
imported by Git remote. No token should be printed. A different local directory for the same remote
should still match. A scope with no matching adopted project should be skipped.

```sh
mend doppler use "$MEND_DOPPLER_PROJECT" dev --project "$MEND_DOPPLER_MEND_PROJECT"
mend run --project "$MEND_DOPPLER_MEND_PROJECT" --name doppler-check --detach --json -- sleep infinity
```

Copy the `sessionId` from the JSON, then open its shell:

```sh
export MEND_DOPPLER_SESSION=the-session-id
mend shell "$MEND_DOPPLER_SESSION"
```

## Inside that session

Run these from the worktree. The following check reads the file without printing its token.

```sh
id
pwd
mend doppler status
doppler --version
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

Expect the intended project and `dev`, secret names only, and `Doppler run: passed`. The process
must run as the session's Linux user. The home file must be outside the captured worktree.

Now test an immediate mapping update. Set the disposable project name again inside the session.

```sh
export MEND_DOPPLER_PROJECT=your-disposable-doppler-project
mend doppler use "$MEND_DOPPLER_PROJECT" stg
doppler configure get project config --plain
mend doppler use "$MEND_DOPPLER_PROJECT" dev
```

Expect `stg` immediately, without restarting the session, then `dev` after the second command. The
Mend project defaults to this session's project.

Test a login performed inside the workspace:

```sh
doppler login
mend doppler connect
mend doppler status
doppler secrets --only-names
```

Expect the workspace's own login to upload successfully and its worktree mapping to import. No token
should appear in the terminal or session record.

To exercise a Doppler request failure without changing the box's network:

```sh
doppler secrets --only-names --api-host http://127.0.0.1:1 --attempts 1 --timeout 1s --no-check-version
mend doppler status
```

The first command should fail. Mend's status still reads locally stored connection metadata. Exit
this shell and repeat the laptop's `mend run` command with `--name doppler-outage-check`. It must
launch and write the file. Mend does not call Doppler during launch; the automated launch tests also
run with no Doppler API dependency. This local CLI failure does not simulate a network outage in the
Mend server process.

## Settings and another person

Open Settings, beside Secret files. Connect by pasting a disposable service token or personal CLI
token. Expect a connected state and set date, with no token returned. Choose a Doppler project and
config for the Mend project, save, reload, and check that the mapping persists. The picker should
list choices permitted by that token. If listing fails, entering project/config names by hand should
still work. Remove a mapping and save another.

For shared control, have a second Mend account connect its own Doppler token and a different mapping
for the same shared project. Let that person steer a turn. From that person's session shell, repeat
the ownership and `doppler configure get project config --plain` checks. Expect their Linux home,
token and mapping. A preview started by that person uses the same identity; inspect names or the
disposable sentinel, never print secret values.

## Disconnect and clean up

In the session, after `mend doppler use` has written Mend's config:

```sh
mend doppler disconnect
mend doppler status
test ! -e "$HOME/.doppler/.doppler.yaml" && printf 'Mend-delivered config removed\n'
```

Expect disconnected status and no saved mappings. A subsequent `doppler login` belongs to the person
and is preserved by disconnect; it should not be mistaken for Mend's unchanged delivery. Other
running homes receive the disconnect on their next file delivery. Verify Settings also shows
disconnected, then test its Connect and Disconnect buttons once.

On the laptop, stop the disposable sessions using the IDs printed at launch:

```sh
mend stop "$MEND_DOPPLER_SESSION"
mend stop the-doppler-outage-check-session-id
```

Delete the disposable Doppler project when finished, or remove the test sentinel from its configs.
Reconnect the normal account with `mend doppler connect` from the laptop if desired.
