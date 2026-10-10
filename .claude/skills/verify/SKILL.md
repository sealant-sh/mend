---
name: verify
description:
  "Drive Mend the way a user does and keep evidence: a full stack (sealantd, Sealant Core, Mend)
  built from source inside one Mend session, its web tunnelled to this machine, its CLI run in the
  session. Use to prove a change to Mend's web or CLI works, to verify a PR that spans Mend, Core
  and sealantd at once, or when a playbook asks for the project's verify skill."
---

# Verify Mend

A verification run builds the **stack** (sealantd, Core and Mend, each at a ref) in one outer Mend
session's Docker, drives a feature through the inner web and CLI, and keeps the **evidence** on this
machine. The stack is `scripts/verify-stack/stack.mjs`; `docs/operations/verify-stack.md` explains
how it builds. The recipes, one per feature, are the **feature map**: `features/` beside this file,
`features/README.md` its index (Drive says where to read it until it lands here).

Every proof line is an **observation**: what was run, what was seen, where it is kept ("inner
session bb2cdbf7 · completed · observed"). "Works", "passes", "safe" and "ready to merge" are
verdicts. They never appear in a report.

## What you need

- A `mend` CLI signed in to the **outer** server where the stack will run (the box, or a local one),
  with `mend run --detach --json`, `mend service run --wait`, `mend wait` and `mend logs`: Mend main
  since 430b2fd (mend#609 to #611). The guard (Launch) runs this checkout's own `apps/cli` from
  source (`node apps/cli/src/main.ts`, after `pnpm install`), or the CLI `MEND_VERIFY_REAL_MEND`
  names; it never takes a `mend` from `PATH`.

  Run the steps in a script (`bash`): an interactive shell's `mend` alias outranks `PATH`.

- The outer server has the `mend` project adopted (shared), and its sessions can start a Docker
  service (the default). With no shared outer server free for a run (the box busy, or none),
  `local-outer.sh` makes one on this machine (Linux, Docker): a real Mend in Docker-in-Docker, named
  `st-verify-outer`, serving the tree under test as project `mend`:

  ```sh
  .claude/skills/verify/scripts/local-outer.sh up   # Mend 0.36.0-next.658 on 127.0.0.1:23105
  .claude/skills/verify/scripts/local-outer.sh serve HEAD   # prints the served commit, for --expect-mend
  export MEND_VERIFY_MACHINE_XDG=${XDG_CONFIG_HOME:-}      # this machine's own, before it changes
  export XDG_CONFIG_HOME=~/.cache/mend-verify/outer-cli   # the mend CLI now talks to it
  export MEND_VERIFY_OUTER_URL=http://127.0.0.1:23105      # and the guard (Launch) lets it through
  .claude/skills/verify/scripts/local-outer.sh down   # after Cleanup: the container and its volumes
  ```

  Its defaults make one outer per machine. A second verifier on the same machine sets its own
  `MEND_VERIFY_OUTER_NAME`, `MEND_VERIFY_OUTER_PORT`, `MEND_VERIFY_OUTER_CONFIG` and
  `MEND_VERIFY_OUTER_WORK` for every `local-outer.sh` call (and its `XDG_CONFIG_HOME` and
  `MEND_VERIFY_OUTER_URL` to match): with the defaults, its `up` meets the first one's container and
  its `serve` writes into the first one's served repository.

  It always serves a complete repository (one parentless commit of the tree, then each serve on
  top), never a shallow clone: Mend refuses to adopt a shallow repository (mend#654), and a worktree
  whose history it cannot walk never finishes its Stop (`final seal · refused · unrestorable`). The
  outer session checks out the Mend branch under test, which must carry `scripts/verify-stack/` and
  this skill's `scripts/` (main does once #616, #617 and #642 land).

- `jq`, `curl`, `od`, `timeout`, `ps` and Node 26 on this machine.
- Playwright, kept outside every checkout, installed once. The subshell keeps your directory:

  ```sh
  (mkdir -p ~/.cache/mend-verify/playwright && cd ~/.cache/mend-verify/playwright \
    && npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core \
    && node node_modules/playwright-core/cli.js install chromium-headless-shell)
  ```

## Isolation and capacity

- **One stack per verifier session.** The stack takes the product's own names (Compose project
  `mend`, volumes `mend-store`, `mend-control`, `mend-garage`), so its Docker daemon holds one, and
  `stack.mjs` refuses a daemon that already runs one. Each outer session has a Docker service of its
  own, so each verifier starts its own session, in a worktree of its own: the run's name carries a
  random suffix, and `mend run --name` joins a worktree that already has the name.
- **Everything the run makes is named `st-verify-<run>`:** the outer worktree, the stack's Service,
  the evidence directory, and every project a recipe adopts (`st-verify-<run>-<n>`). The stack's own
  inner names (`verify-fixture`, `verifier@verify-stack.invalid`) are the stack's.
- **Drive only what this run started:** the stack whose doctor matched, the tunnel `tunnel.mjs`
  recorded, the sessions whose ids you recorded. Never the owner's Mend (the guard, under Launch,
  refuses any `mend` not aimed at the declared outer server), and never another verifier's
  `st-verify-` session.
- **How many at once: at most 4 stacks live and 2 building, across the machine.** That is the limit
  the verify stack's author recommends from the box's numbers (12 CPUs and 39 GB, shared with the
  server and everyone's sessions). Per stack on the box, in #616's runs: 1.7 to 2.0 GiB idle (every
  process of its Docker daemon), 6.3 GiB at the build peak, plus about 0.6 GiB for the outer
  session's workspace. **Cold builds are the limit**: one keeps all 12 CPUs busy for 3 to 4 minutes,
  and two at once share them. `stack.mjs` cannot enforce this, since each session has its own Docker
  daemon, so Launch counts (`slots.mjs`, steps 1 and 4). The owner's decision on the roadmap ("how
  many stacks the box runs at once") may change the numbers: pass them as `--max` and
  `--max-building`.
- **The box.** Start no stack while an `st-bench-` session is starting or running
  (`mend sessions --all`), or during a server upgrade.

## Launch

Pick the run's names once, from the root of a Mend checkout; everything below uses them.

```sh
run=$(date -u +%m%d-%H%M)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')   # one run: 1010-0305-9f3a
wt=st-verify-$run                             # its outer worktree, and its stack's Service
port=3345                                     # free on this machine; the stack's browser origin (not 3305: mend.toml's own stack tunnel)
web=http://localhost:$port
E=${XDG_STATE_HOME:-$HOME/.local/state}/mend-verify/$wt   # evidence: kept
P=$(mktemp -d)                                # private: the run's secret registry, browser state
export MEND_VERIFY_PRIVATE=$P                 # every helper redacts the registry's values by value
mkdir -p "$(dirname "$E")" && mkdir "$E" && mkdir "$E/launch"   # refuses a run that exists
skill=$PWD/.claude/skills/verify              # absolute, so a later cd cannot lose it
export PATH=$skill/scripts/guard:$PATH         # every mend below, the helpers' too, passes the guard
[ -n "${MEND_VERIFY_MACHINE_XDG+set}" ] || export MEND_VERIFY_MACHINE_XDG=${XDG_CONFIG_HOME:-}   # this machine's own, before the run's
# The guard runs this checkout's apps/cli; to run another build: export MEND_VERIFY_REAL_MEND=<absolute path>
export MEND_VERIFY_OUTER_URL=<the outer server's URL, as its CLI config names it>   # local-outer.sh: http://127.0.0.1:23105
[ "$(command -v mend)" = "$skill/scripts/guard/mend" ] || { echo "mend does not resolve to the guard: unalias mend, or run this in a bash script" >&2; exit 1; }
```

**A verifier never talks to the owner's server; the guard refuses it.** `scripts/guard/mend` stands
in front of the CLI, and `scripts/guard/policy.mjs` decides for it and for every driver. A run may
reach two servers: the outer one it declared (`MEND_VERIFY_OUTER_URL`), and its own stack through
its own tunnel (`http://localhost:<port>` or `http://127.0.0.1:<port>`, while `$P/tunnel.json` says
`tunnel.mjs` saw its own child bind that port and the recorded pid is still that child, and nothing
listens on `[::1]:<port>`). A loopback URL alone is not enough: the owner's own server, or the
owner's own `mend service connect stack --port 3305`, may listen on this machine, so
`tunnel.mjs start` refuses a port anything already holds. The guard refuses (exit 97, before any
request) when:

- `MEND_VERIFY_OUTER_URL` is not declared, `MEND_TOKEN` is set, or `MEND_URL` is (except
  `http://127.0.0.1:9`, loopback's discard port, where the map drives the unreachable-server lines);
- `XDG_CONFIG_HOME` is unset, relative or missing, `$XDG_CONFIG_HOME/mend/cli.json` is missing (the
  CLI then reads a legacy `~/.mend`; only `mend login --url <one of the two>` may make it, into an
  existing `$XDG_CONFIG_HOME/mend`), or the config is this machine's own (under `~/.config/mend` or
  `~/.mend`, for `$HOME` and for the account's home in the password database, symlinks resolved, so
  setting `HOME` elsewhere changes nothing, and under `$MEND_VERIFY_MACHINE_XDG`, recorded at
  Launch), the same file (a hard link), or a copy holding the same token or device id (read to
  compare, never printed): a run's CLI config is its own;
- that config, or a `--url` or `--server` argument (`mend login --url …` included), names any other
  server. Only the words after a runner's `--` (`mend run`, `mend service`,
  `mend claude|codex|opencode|pi`) are left alone: they run in the workspace;
- the command acts on this machine's own Mend installation (`mend server …`, `mend uninstall`),
  except its help page: those recipes run on a disposable host;
- `MEND_VERIFY_REAL_MEND` names a Mend session's in-workspace helper (`/run/mend/bin/mend`, which
  every workspace links to `/usr/local/bin/mend`), or a script that starts it: the helper ignores
  the config and acts on the session it runs in, not on the run's stack.

Then it becomes the real CLI (`$MEND_VERIFY_REAL_MEND`, else this checkout's `apps/cli` from source;
never a `mend` from `PATH`, which inside a session is that helper), with no `MEND_SESSION_*`
variable, and with `XDG_CONFIG_HOME` pinned to the absolute, resolved directory it checked, so no
change of directory or of `HOME` downstream makes the CLI read another config. The CLI gets a home
of the run's own (`~/.cache/mend-verify/home/<digest>`, with `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and
`GH_CONFIG_DIR` in it) and none of this machine's session, SSH agent, GitHub or provider variables
(`GH_TOKEN`, `ANTHROPIC_*`, `OPENAI_*`, `CLAUDE_*`, …): `mend connect github`, `--use-my-login`,
`memory import`, `dotfiles sync`, `skills push` and `ssh setup` see an empty home, never the owner's
logins or files. A recipe that needs a login supplies a test one, through the secret registry and
`--from-stdin`. The drivers hold to the same policy: `drive-tui.sh` puts the guard first on its
terminal's `PATH` and its bundled CLI behind it, and `drive-tui.sh`, `drive-desktop.sh`,
`drive-web.mjs` and `drive-mobile.mjs` refuse a `<web>` that is not the run's tunnel. The box is an
outer server only when its operator says so: then declare its URL. An alias or a shell function
named `mend` outranks `PATH` and skips the guard (an interactive zsh often has one), so the check
above must print nothing: run the steps in a `bash` script, where aliases do not apply, or
`unalias mend` first. The helpers start `mend` through `PATH`, so they always meet the guard.

1. **Take a slot.** Count the live verify stacks on the outer Mend before starting one:

   ```sh
   node $skill/scripts/slots.mjs --max 4 --max-building 2 --wait 900 --out "$E/launch"
   ```

   It reads `mend service list` (every live Service in every project this account can see), keeps
   the Services labelled `st-verify-<run>` or `stack` (`mend service stack`), and reads each one's
   own output (`mend service logs`): a stack that printed `verify stack · ready in …` has finished
   building; any other is building, and one whose output could not be read is counted as building.
   Exit 0: a slot is free. Exit 1: no slot after 15 minutes of looking every 15 s, and `slots.txt`
   names the stacks holding them; report that and start nothing. It sees only projects this account
   can see, so run stacks in the shared `mend` project. Two verifiers can both find the last slot;
   step 4 settles that.

2. **Start the outer session** in a new worktree. It holds the workspace while the stack runs. Add
   `--base <branch>` to build Mend at a branch other than the project's default.

   ```sh
   mend run --project mend --name "$wt" --detach --json -- sleep 86400 > "$E/launch/session.json"
   id=$(jq -r .sessionId "$E/launch/session.json")
   ```

   Done when the JSON reads `"status": "running"`. This took 20 to 43 s.

3. **Start the stack** as a Service of that session, named for this run, so `logs`, `connect` and
   `stop` can never pick another verifier's:

   ```sh
   mend service run "$id" --port $port --http --name "$wt" --wait --no-connect -- \
     node scripts/verify-stack/stack.mjs serve --port $port \
     || mend service list | grep "^$wt " > /dev/null \
     || { echo "the Service did not start: the message above says why"; exit 1; }
   ```

   For refs from open PRs, add sources after `serve`: `--sealant '#345' --sealantd '#152'`, or
   `--mend '#610'`. Each source is a path, `#<pr>`, a branch, tag or commit; Core and sealantd also
   take `pinned`. Without one, Mend builds from the session's checkout, and Core and sealantd build
   from `main`, or from `/workspace/repos/<name>` after `mend repo add`. From inside a Mend session
   of `mend`, the same stack is `mend service stack`: the `mend.toml` recipe, port 3305.

   Since mend#651, `--wait` waits through the build: it exits 0 once the port answers (a cold stack
   took 123 s here), 2 if the stack's process ended first, 3 if the session's workspace did, and 124
   if the port still had not answered at `--timeout` (default 10 min; the Service keeps building). A
   CLI from before #651 gives up after about 62 s with
   `nothing answered on :<port> · the Service keeps running`. Either way a Service that
   `mend service list` shows as `$wt` is building, and the run goes on; one that is not listed did
   not start (a refused sign-in, a bad flag): stop and read the message. The `grep` reads the whole
   list: a `grep -q` closes the pipe at its first match, and `mend service list` then dies of
   `EPIPE`.

4. **Keep the slot, or give it back.** Now that this run's stack is listed, count again:

   ```sh
   node $skill/scripts/slots.mjs --max 4 --max-building 2 --mine "$wt" --out "$E/launch/admitted"
   ```

   Every verifier ranks the live stacks the same way, by when their Service was registered (the
   server lists Services newest first), so a stack registered later never outranks one registered
   earlier. Built stacks are admitted first, then building ones, each in that order while the limits
   leave room: a built stack past `--max` is over the limit too. Exit 0: `<wt> holds a slot`. Exit
   1: it is over the limit. Stop its Service and wait for its teardown (the retry under Cleanup),
   then go back to step 1 and on from step 3. A stack whose output could not be read counts as
   building, so a later one may back off when it need not; none stays over the limit.

5. **Wait until the stack says it is ready.** `stack.mjs serve` prints
   `verify stack · health answers` once it is up and its check (an inner `mend run -- true`) has
   completed. A failure prints `verify stack: <reason>`, removes what the start made, and ends the
   Service. Give up after 15 minutes; the log you keep says why.

   ```sh
   deadline=$((SECONDS + 900))
   until timeout 8 mend service logs "$wt" 2>&1 | tr -d '\r' \
     | grep -qE '^verify stack( · health answers|: )' || [ $SECONDS -ge $deadline ]; do sleep 2; done
   timeout 8 mend service logs "$wt" 2>&1 | tr -d '\r' > "$E/launch/stack.log"
   grep -q '^verify stack · health answers' "$E/launch/stack.log"   # 0: ready
   ```

   Measured on the box (12 CPUs) in #616's runs: **cold 3 min 16 s to 4 min 13 s** to `ready`, then
   the check, 35 to 37 s; **warm 20 to 25 s**, when every image is reused (the same session, after
   the retry under Cleanup). sealantd's cargo build is the longest cold step, about 3 minutes.
   `mend service logs` follows until it is killed, so always run it under `timeout`.

   Exit 1: the stack failed or never got ready, and `stack.log` says which (in a proof run, an inner
   check whose session stopped `before its agent ran` while its first workspace image built). A
   failed start removes what it made; take the retry under Cleanup (same session, images kept), and
   report the failure with the retry.

6. **Bring the web here.** `tunnel.mjs` holds `mend service connect` in the background and records
   which process it is (its pid and start time), so Cleanup stops that process and no other:

   ```sh
   node $skill/scripts/tunnel.mjs start --service "$wt" --port $port --dir "$P" --log "$E/launch/connect.log"
   ```

   Exit 0 once `$web/api/health` answers, within 60 s. A tunnel that exited has its reason in
   `connect.log` (a port taken here: pick another for both the stack and the tunnel). The local port
   must equal the stack's `--port`: the inner server trusts only its own origins
   (`http://localhost:<port>`, `http://127.0.0.1:<port>`, and the one the session's Docker host
   publishes) and refuses a sign-in from any other.

7. **Take over the stack's account.** The browser signs in as the stack's first account, the one the
   inner CLI uses, so both surfaces act as one owner. Its password and token never pass through a
   terminal as text: the session prints them sealed to a key that only this machine holds.

   ```sh
   key=$(node $skill/scripts/handover.mjs keygen --dir "$P")
   mend run --project mend --worktree "$wt" -- \
     node .claude/skills/verify/scripts/handover.mjs seal --to "$key" 2>/dev/null \
     | node $skill/scripts/handover.mjs open --dir "$P"
   ```

   `$P/account.json` (0600) then holds `verifier@verify-stack.invalid`'s password and CLI token. The
   outer session's record holds the public key and the ciphertext only.

## Doctor

Run it after Launch, before the first drive, and again after anything surprising.

```sh
node $skill/scripts/doctor.mjs --worktree "$wt" --web "$web" --out "$E/doctor" --tunnel "$P/tunnel.json" \
  [--expect-mend <sha>] [--expect-sealant <sha>] [--expect-sealantd <sha>]
```

It is one check, and it starts, stops and writes nothing of the stack: `stack.mjs report` prints
what it measures and writes nothing back. The only reader of the stack runs in the session, so the
doctor leaves two traces outside it: one sibling `mend run` in the worktree (a record on the outer
server), and the short-lived container `report` runs on the session's Docker to read memory. Exit 0
when every `ok`/`NOT` line holds:

- **This run's.** The tunnel is the process `tunnel.mjs` started (the same pid with the same start
  time), bound to this port, and the web's `version` is the one this session's stack stamped on its
  build (`<major.minor.patch>-verify.t<digest>`, which no release carries): the same build behind
  the tunnel.
- **At the expected refs.** Each `--expect-*` is a commit prefix, for example
  `gh pr view 345 -R sealant-sh/sealant --json headRefOid -q .headRefOid`. Without one, the source
  is printed. Beside them, `workspace sealantd · …`: the daemon the outer session's workspace image
  carries, as `sealantd --version`, the binary's sha256 and `sealantd capabilities --json` say (a
  `-next` build reports version `0.0.0`, so the hash is what tells two builds apart). The inner
  stack's own sealantd is the `sealantd` source line.
- **Healthy now.** `/api/health` reads `ok`, the stack has a `readyAt`, its check reads `completed`,
  and an inner `mend projects`, signed in as the stack's first account, exits 0.
- **Isolation**, when there is something to compare. `report` looks for the session's credential
  (from its environment, or `~/.mend/session-token` or `MEND_SESSION_TOKEN_FILE` in a per-person
  session) in every container's environment, command and labels. When it could read none, the doctor
  prints `isolation · not compared`: that line observes nothing and counts for nothing.

`doctor.txt`, `report.json` and `health.json` land in `--out`. On a `NOT` line, read
`$E/launch/stack.log`, then go to Cleanup and launch again. Run the doctor after `health answers`:
before it, the check reads `not run yet`.

## Drive

**The map first.** It lands as `features/` beside this file with mend#614; the feature groups
stacked on it (#625 to #631) add their files the same way. Until then, read it from #614's branch,
and record which map the run used:

```sh
map=$skill/features
if [ ! -f "$map/README.md" ]; then
  git fetch -q origin feat/verify-feature-map && map=$(mktemp -d) \
    && git archive origin/feat/verify-feature-map .claude/skills/verify/features | tar -x -C "$map" \
    && map=$map/.claude/skills/verify/features
fi
[ -f "$map/README.md" ] && echo "map $(git rev-parse --short origin/feat/verify-feature-map 2>/dev/null || git rev-parse --short HEAD) · $map" > "$E/map.txt"
```

With no `README.md` there, Drive does not run: report every feature
`not run · the feature map is not available (mend#614)`.

Pick the feature's file in the map and follow its `Driving it with verify` section. Map its
placeholders to this stack:

| Map          | Here                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `<web>`      | `$web`                                                                                                                    |
| `<repo-url>` | `http://verify-stack-fixture:9080/repo.git`: the stack's one-commit fixture, served on its network, cloned with `ambient` |
| `<project>`  | `$wt-1`, `$wt-2` …: no project has the name yet. `verify-fixture` is taken, adopted by Launch                             |
| `mend …`     | the inner CLI, below                                                                                                      |

**One account on both surfaces.** The browser (step 7's handover) and the inner CLI are both the
stack's first account, so the map's precondition holds: a session the CLI started is the browser's
own, and steps that need its owner (a Service started from the browser, sending review back,
landing) run. Report `both surfaces as verifier@verify-stack.invalid`.

**Web.** Playwright through ARIA roles and accessible names, against `$web`. The map's calls are
`page.…` lines. Put them in a recipe module, and `drive-web.mjs` runs it:

```sh
node $skill/scripts/drive-web.mjs --web "$web" --out "$E/<feature>/web" --private "$P" \
  --recipe <recipe.mjs> --account "$P/account.json" --state "$P/browser.json"
```

```js
// <recipe.mjs>: the map's steps, then capture()
export default async ({ page, web, capture, note }) => {
  await page.goto(`${web}/projects`);
  await page.getByRole("main").getByRole("heading", { name: "Projects", exact: true }).waitFor();
  await capture("projects");
};
```

`--account` signs in at `/login`; `--state` keeps the browser signed in for the next drive. Both are
credentials, so both stay in `$P`.

**Credentials in a recipe.** Type every credential with `typeSecret(locator, name, value)`, never
`fill`: the value goes into the run's **secret registry** (`$P`, `secrets.mjs`) first, then into the
field by script, so no Playwright log can carry it, and the page's screenshot is withheld while the
field holds it. Register what a page mints (a device token, a pairing code) with
`registerSecret(name, value)` as soon as the recipe reads it. Every snapshot, log line and error is
redacted against the registry by value, and against `redact.mjs`'s shapes: a value the registry
lacks is protected only by its shape, so register it. The registry is append-only: a second value
under a name joins the first, and the values of a rewritten `account.json` or `browser.json` stay. A
value under 6 characters is refused, and the recipe fails: it cannot be redacted by value without
redacting ordinary text, so keep such a value off every captured page.

**CLI.** The inner `mend` runs in the session, signed in as the stack's first account:

```sh
$skill/scripts/capture.sh "$E/<feature>/cli" <step> -- \
  mend run --project mend --worktree "$wt" -- node scripts/verify-stack/stack.mjs mend <args…>
```

Each call is a sibling session in the same worktree, so it reaches the same workspace and Docker
daemon. It returns in 6 to 7 s, plus 1 to 2 s at its end. Its stdout is the command's terminal: CRLF
line ends, ANSI colour, the inner stderr folded in. Mend's own lines go to stderr. Compare text
after `tr -d '\r' | sed 's/\x1b\[[0-9;]*m//g'`.

`stack.mjs mend` holds the stack's lock (shared) while it runs, and records the inner sessions the
command starts (their `sealant-…` containers and networks, from a snapshot of the daemon before and
after), so the stack's teardown removes them. Anything else a step makes on the session's daemon is
not recorded, and stays until the outer session stops.

- **A command that holds the terminal** (`mend attach`, `mend continue`, `mend service connect`,
  `mend service logs`, a harness): put its `timeout` inside the sibling,
  `mend run … -- timeout 30 node scripts/verify-stack/stack.mjs mend attach <id>`. A `timeout`
  around `mend run` ends only this machine's CLI: the sibling session keeps running the inner
  command, and while it holds the lock the stack's teardown waits for it (Cleanup stops such
  siblings first).
- **What a web drive starts is not recorded.** A session started from the inner web (the Now
  composer, a worktree's `New session` menu) runs outside any `stack.mjs mend` or `check`, so the
  teardown leaves its containers and networks and lists them (see Cleanup). Start an inner session
  through `stack.mjs mend` when the step allows either surface, and note in the feature's
  `steps.log` each one a recipe started from the web.

**A project a recipe adopts** gets the default workspace image, whose Docker service cannot start
inside the stack (it would be Docker in the session's Docker), so its sessions never launch
(`Workspace Docker service … did not become ready`). Right after adopting, give it the fixture's
image, `node:26-bookworm` with no Docker service:

```sh
mend run --project mend --worktree "$wt" -- node scripts/verify-stack/stack.mjs project-image "$wt-1"
```

Recipes that are about the workspace image itself (the map's `workspace-images` and `hot-sessions`)
skip this and set the image the way their steps say.

**Terminal (the dashboard).** `drive-tui.sh` runs this machine's `mend`, built from a Mend checkout
at the commit under test, signed in to the stack through the tunnel as the stack's first account
(the token stays in `$P`), in a detached tmux session on a tmux server of its own:

```sh
$skill/scripts/drive-tui.sh build <a Mend checkout at the commit under test>   # once per run
$skill/scripts/drive-tui.sh start ui-1 "$web" -- mend ui
$skill/scripts/drive-tui.sh wait ui-1 'projects' 30 && $skill/scripts/drive-tui.sh keys ui-1 j Enter
$skill/scripts/drive-tui.sh capture ui-1 "$E/<feature>/tui" 01-selected
$skill/scripts/drive-tui.sh stop ui-1
```

`build` is needed because the dashboard cannot run from the CLI's TypeScript source; it bundles with
the checkout's own esbuild, so the checkout needs its dependencies installed (`pnpm install`).
`capture` keeps only the redacted screen, and a code the screen shows (`mend login`'s authorization
code and its `/authorize?code=` link, a pairing code) joins the registry by value first, so it is
redacted wherever it turns up next. Every `mend` typed in the terminal passes the guard: the bundled
CLI is reached only as the guard's real CLI. Lines a program prints before a full-screen redraw
(`mend attach`'s `✓ attaching to …`) are not on the screen or in its scrollback; take them from a
CLI capture of the same command instead.

**Desktop.** `drive-desktop.sh` starts the Electron app (a checkout's `apps/desktop`, built with
`pnpm --filter @mend/desktop build`) on an Xvfb display of its own, signed in through the same
config, with a remote debugging port; `drive-web.mjs --cdp` drives its window with the web's rules:

```sh
$skill/scripts/drive-desktop.sh start <checkout>/apps/desktop "$web" 9335 :95
node $skill/scripts/drive-web.mjs --web "$web" --cdp http://127.0.0.1:9335 --out "$E/<feature>/desktop" \
  --private "$P" --recipe <recipe.mjs>
$skill/scripts/drive-desktop.sh stop
```

The desktop's terminal draws on a canvas (its text is not in the page), so every screenshot masks
it: read a terminal's output from the session (`drive-tui.sh` on `mend attach`, or the record), not
from a screenshot.

**Mobile web.** `drive-mobile.mjs` serves the Expo app's web build and the stack's API on one local
origin (the stack trusts only its own origins), and `drive-web.mjs --viewport 390x844` drives it.
Pair the app with that origin the way the map's pairing recipe says. At Mend main of 2026-10-10 the
web build does not bundle (Metro: `Importing react-native internals is not supported on web`, from
`ratex-react-native` through `react-native-nitro-markdown`): the page answers 500, and every mobile
step is `verified-unreachable` on that product gap until it is fixed.

```sh
node $skill/scripts/drive-mobile.mjs --app <checkout>/apps/mobile --web "$web" --port 18305 \
  --expo-port 8085 --log "$P.mobile.log" &   # a log beside $P, never in it
node $skill/scripts/drive-web.mjs --web http://127.0.0.1:18305 --viewport 390x844 \
  --out "$E/<feature>/mobile" --private "$P" --recipe <recipe.mjs>
```

Keep every log and profile **beside** `$P`, never inside it: every file under `$P` joins the secret
registry, a non-JSON one whole, and its text would then be redacted out of the evidence.

**Steps this skill does not run,** each reported `not run` with its reason:

- **A CLI step that prints a credential** (`mend pair`, a token minted by hand, a provider sign-in
  such as `mend connect`): a sibling `mend run` is a recorded terminal, and its record outlives the
  run. `not run · prints a credential into a recorded terminal`. Drive the web entry instead, where
  captures are redacted.
- **A local check of an inner tunnel.** The inner CLI's `mend service connect` binds the session
  Docker daemon's loopback, not this machine's, so the map's `curl http://127.0.0.1:<port>/` here
  finds nothing. `not run · the inner tunnel binds the session's Docker daemon`. The tunnel's own
  line (`● <name> → 127.0.0.1:<port>`) is still an observation of the CLI.
- **VS Code and Slack.** The map's VS Code and Slack entry points have no driver here:
  `not drivable yet · no VS Code (Slack) driver in the verify skill`. Slack's pages on the web
  (Settings → Slack, `/slack/link/<code>`) are web steps and run.
- **A step that needs what the stack lacks:** a provider login (Claude, Codex, GitHub), a GitHub
  origin or one that accepts pushes (the fixture serves fetch only and refuses a push with 403), a
  Kubernetes server, an SSH git host, a restart of the inner server with other environment, or a
  repository with package files (the fixture holds one `README.md`). Report it
  `verified-unreachable · <that prerequisite>`, and still drive the steps around it.

The driving conventions, repeated from the map:

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Use roles and names (`page.getByRole(role, { name })`). A name matches as a case-blind substring:
  pass `exact: true`, or an anchored regular expression, whenever it could sit inside another
  (`Worktrees` matches `No worktrees yet`). At 1024 px and wider the sidebar repeats the navigation
  and every project as links: scope page content to `page.getByRole("main")`. A control with no
  stable accessible name is a product finding: record it, and do not invent a selector.
- Wait for the role, name or text the step names, never for `networkidle`: every workbench page
  holds an SSE stream open, so the network never goes idle.
- Treat commands as literal; angle-bracketed words are values you fill in.
- Settings pages always hold a credential field, so their screenshots are withheld and the ARIA
  snapshot is the proof.
- Run commands that hold the terminal in their own PTY or under `timeout`: `mend codex`,
  `mend claude`, `mend attach`, `mend continue`, `mend service connect`, `mend service logs`. For
  the inner CLI the `timeout` goes inside the sibling (see **CLI** above).
- Restore seeded state after a mutation. Keep the evidence.

What differs from a `mend` on your own machine:

- **No working directory, no stdin.** The inner CLI runs in a container with no checkout and no
  files of this machine, and its stdin never closes: a command that reads stdin (`--from-stdin`)
  waits until its `timeout`. Put the input in a file the command reads, from a step inside the
  session.
- **One address on a local outer.** Every verifier on this machine reaches a `local-outer.sh` server
  from 127.0.0.1, and its budget is 1200 requests per minute per address: with four stacks driven at
  once, a sibling's watch can end `budget reached · 1200 requests per minute from one address` (the
  inner command keeps running), and the tunnel can drop a request. Read the inner record before
  calling such a step's result.
- **One exit code.** `stack.mjs mend` exits 1 for any inner failure, whatever code the inner CLI
  returned. Assert on 0 or not-0, and read the message from stdout.
- **The CLI's world is a container** on the session's Docker. A path names a file inside it, and
  there is no checkout for `mend adopt` without a URL to read an origin from.
- **The platform's argv rules.** At most 64 words. Since sealant#347 (Mend #653) only the program
  must be non-empty and trimmed; an outer server on an older Core refuses any word that is empty or
  starts or ends with whitespace, before it creates anything. Every script this skill passes as one
  word (`sh -c '…'`, the doctor's) starts and ends with a command, so either rule takes it; trim
  yours the same way.

## Evidence

Everything goes under `$E`, on this machine, outside any checkout and outside the stack's session.
Cleanup removes neither. Name each directory for the feature file and the entry point:
`$E/adopt-project/web`, `$E/adopt-project/cli`.

| What                     | How                                                                                                                                                                                                | Where                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| ARIA snapshot            | `capture(name)` in a recipe: `page.locator("body").ariaSnapshot()`, redacted                                                                                                                       | `<dir>/<name>.aria.yml`                                   |
| screenshot               | the same `capture(name)`, full page, heading in view, every canvas masked; withheld on a page that shows a credential                                                                              | `<dir>/<name>.png` and `.png.checked`, or `.png.withheld` |
| web steps                | `note(text)`, and every capture and failure                                                                                                                                                        | `<dir>/steps.log`                                         |
| CLI stdout, stderr, exit | `$skill/scripts/capture.sh <dir> <step> -- <command…>`, redacted                                                                                                                                   | `<dir>/<step>.{cmd,stdout,stderr,exit}`                   |
| the stack                | the doctor, and once more before Cleanup: `doctor.mjs … --out "$E/final"`                                                                                                                          | `report.json`, `doctor.txt`                               |
| the inner record         | before Cleanup: `stack.mjs mend sessions --all --json` through `capture.sh`, and the inner session page through `capture()`; `stack.mjs mend logs <id>` once the Mend under test has it (mend#610) | `$E/<feature>/cli`, `/web`                                |
| the outer record         | each `mend run` prints `session <id8>` on stderr; the outer server keeps those records after Cleanup: `mend logs <id8>`                                                                            | `<step>.stderr`                                           |
| a Stop that stays saving | `settle.mjs` (Cleanup): the session's last state, and the outer server's logs with its `capture seals` lines                                                                                       | `$E/cleanup/settle/`                                      |

The inner record lives in the stack and goes with it, so capture it before Cleanup. A proof follows
the map's proof rules:

- **The real user path.** Use the web through its controls and the CLI through its commands. Test
  endpoints and internal setters are not the user's path.
- **The action and its result.** Capture before and after, not only the last screen.
- **Side effects, seen a second time.** A reload, or a listing command (`mend projects`,
  `mend sessions --all --json`, `mend worktrees --json`) after a mutation.
- **The record of each artifact:** the feature file, the sub-feature ID, and the entry point (web or
  CLI).
- **Unreachable, said as such:** the step tried and the precondition missing ("provider not
  connected", "origin is not on GitHub"). An entry point proven through another is not proven.
- **Mocks only at a production boundary.** The stack's fixture git server stands in for a git host;
  Sealant, the database and the web are the real ones, built from source. A dry run is verified by
  observing what it skipped (files, git refs, network), not by its name.
- **No credential in the evidence, checked.** Every output path (snapshots, screenshots, steps, CLI
  transcripts, errors, server logs) is redacted twice: by value, against the run's secret registry
  (the handed-over account, the browser's cookies, the handover key, everything typed or minted,
  line by line and encoded), and by shape, against `redact.mjs` (invitation and reset links, device
  tokens, pairing codes and links, bearer tokens, signed URLs, private keys, provider keys,
  credential fields). A page that shows a credential (a field a secret was typed into, a QR code, a
  pairing code, a minted token), in its ARIA snapshot or anywhere in its text (`aria-hidden`
  included), keeps only its redacted snapshot, every credential field's subtree included:
  `<name>.png.withheld` says why. Pixels no text check can read are never kept: every canvas (a
  terminal's), video and embedded object is masked, and so is a frame that holds one; a kept
  screenshot gets `<name>.png.checked` with its digest. No trace, HAR or video is recorded.
  Cleanup's scan searches every file of `$E` for every registered value and every shape, and counts
  as a hit an archive and any image without a matching `.checked` (one a recipe saved itself, or
  changed since): a hit fails the run.

## Cleanup

Run it after the last drive, and after every failed attempt, with whatever of the run exists.

```sh
node $skill/scripts/tunnel.mjs stop --dir "$P"                     # the tunnel this run started
mend sessions --json | jq -r --arg wt "$wt" --arg id "$id" \
  '.sessions[] | select(.worktree == $wt and .id != $id) | .id' | while read -r s; do mend stop "$s"; done
mend stop --services "$id"                     # serve ends; its watchdog takes the stack down
$skill/scripts/capture.sh "$E/cleanup" teardown -- \
  mend run --project mend --worktree "$wt" -- sh -c 'for i in $(seq 180); do [ -z "$(docker ps -aq --filter name=^verify-stack-owner$)" ] && ! test -e ~/.cache/mend-verify-stack/stack.json && exec tail -n 100 ~/.cache/mend-verify-stack/logs/watchdog.log; sleep 1; done; exec node scripts/verify-stack/stack.mjs down --force'
mend stop "$id"                                                    # the outer session
mend wait "$id" --timeout 120 --json > "$E/cleanup/session-end.json"   # how its command ended
node $skill/scripts/settle.mjs --session "$id" --out "$E/cleanup/settle" --after 300 \
  [--logs-cmd '<prints the outer server's logs>']
find "$E" -type f | wc -l                                          # the evidence is still here
node $skill/scripts/scan-evidence.mjs --dir "$E" --secrets "$P" --delete-hits; scan=$?
rm -rf "$P"
[ "$scan" -eq 0 ] || { echo "verify: the evidence scan found a secret; those files are deleted ($E/scan.json): this run FAILED" >&2; exit 1; }
```

- `tunnel.mjs stop` signals the recorded pid only while it is still the process `start` made; a pid
  reused since is left alone, and said so.
- **Siblings first.** Every other live session in `$wt` is stopped before the Service: a sibling
  still running an inner `stack.mjs mend` (a `mend attach`, a `timeout` that ended only this
  machine's CLI) holds the stack's lock, and the watchdog's teardown waits for it without limit.
- **The stack goes down with its Service.** `serve` holds the daemon's lock for its whole life, and
  `stack.mjs down` is refused while `serve`, `up`, `check` or a `mend` holds it ("this daemon's
  stack is busy: a serve, up, mend or check holds it…"), so Cleanup stops the Service: `serve`'s
  watchdog then takes this start's stack down under the lock, the state file before the claim
  container `verify-stack-owner`. The `teardown` step waits up to 3 minutes until neither is left,
  and keeps the watchdog's report (its last 100 lines, ending `… the stack is down`). If the stack
  is still there by then, it runs `stack.mjs down --force`, which removes whatever stack the daemon
  holds once nothing holds the lock. Images stay. It reaches only the Docker daemon of this run's
  own session.
- **What the teardown removes, and what it leaves.** It removes what the stack recorded (its own
  containers, volumes and networks, and the inner sessions `up`, `check` and each `stack.mjs mend`
  started), one `verify stack · removed container|volume|network <name>` line each, then
  `verify stack · removed <n> container(s), <m> volume(s)`. The rest it leaves, grouped by reason:
  `left alone (made again after the stack recorded it): …`,
  `left alone (made while a recording was open, but shaped like nothing the stack makes): …` and
  `left alone (shaped like the stack's, but never recorded as made by it): …`, followed by the
  `docker rm --force …`, `docker volume rm …` and `docker network rm …` lines that would remove
  them. Report those lines as they are, beside the web-started inner sessions the recipes noted.
  They are on this session's Docker daemon only, and `mend stop "$id"` ends that daemon with the
  session.
- A run that dies before Cleanup leaves no stack behind once its Service ends, but its tunnel, outer
  session and private files stay until Cleanup runs.
- `mend wait` writes the command's end as last observed (`stopped` or `exited` in the proof runs)
  with `"exitCode": null`, and exits 1: a stopped command reports no exit code. It waits for the
  command, not for the workspace.
- **A Stop that stays saving.** `mend stop` returns while the outer workspace saves. `settle.mjs`
  reads `mend sessions --all --json` every 10 s. Exit 0: the session left `stopping`. Exit 1: it was
  still `stopping` after 5 minutes (`saving · no uploads pending`, then
  `not saved · final seal not confirmed · 0 B pending · workspace kept`). Its `session.json` is
  kept, and with `--logs-cmd` the outer server's logs, redacted, as `outer-server.log`.
  `capture-seals.txt` keeps the log entries about this session's seal:
  `capture seals: sealed, but … withheld until …` (the seal's code and until time),
  `final seal · refused` (its reason, such as `unrestorable`), `capture flush · final · incomplete`
  (`incompleteReason`), and `git section failed` (the capture's git section did not verify). The
  logs need the outer server's machine: on a local server,
  `--logs-cmd 'docker logs --since 1h mend-mend-1'`; on the box, ask its operator for those entries
  and the session id. Report the session id, its last line and those entries, beside the doctor's
  `workspace sealantd` line.
- **The scan comes last, before `$P` goes**: it needs the registry to search for. It reads every
  file in `$E` as text, as raw bytes, and a PNG's text chunks inflated; an archive (zip, trace, HAR)
  counts as a hit, since nothing here makes one. It writes `$E/scan.json` (files, how many values,
  hits by file and kind, never a value). A hit deletes the file it was in (`--delete-hits`), then
  `$P` goes, and the run ends with exit 1 and `this run FAILED`: report it as failed, with
  `scan.json`. The registry's values are in no file once `$P` is gone.
- **To retry in the same session** and keep the images, take the stack down and wait until its
  teardown has finished, take a slot again (step 1), then Launch from step 3:

  ```sh
  node $skill/scripts/tunnel.mjs stop --dir "$P"   # it tunnels to the old Service, and holds the port
  mv "$E/launch" "$E/launch-$(date -u +%H%M%S)" && mkdir "$E/launch" || exit 1   # keep it
  mend sessions --json | jq -r --arg wt "$wt" --arg id "$id" \
    '.sessions[] | select(.worktree == $wt and .id != $id) | .id' | while read -r s; do mend stop "$s"; done
  mend stop --services "$id"
  mend run --project mend --worktree "$wt" -- sh -c 'for i in $(seq 180); do [ -z "$(docker ps -aq --filter name=^verify-stack-owner$)" ] && ! test -e ~/.cache/mend-verify-stack/stack.json && exec tail -n 100 ~/.cache/mend-verify-stack/logs/watchdog.log; sleep 1; done; exec node scripts/verify-stack/stack.mjs down --force'
  ```

  The Service's stop wakes the stack's watchdog, which takes the stack down under the daemon's lock;
  the last command returns once the state file and the claim container `verify-stack-owner` are gone
  (4 to 6 s in the proof runs), and a new `serve` would otherwise refuse the old stack. What the
  teardown left alone is still on the daemon: if its report lists the inner sessions your recipes
  started from the web, run the `docker …` lines it printed before the new `serve`, through the same
  sibling command (`mend run --project mend --worktree "$wt" -- sh -c '<those lines>'`), and keep
  that transcript. Anything it lists that no recipe of yours started, leave and report. The retry
  brings up a **new inner server**: the earlier stack's projects and records are gone, and so is its
  first account. Capture the inner record before the retry, then take the new account over (step 7)
  and drop the old browser state.

- The worktree stays: it holds the outer record. When the run's evidence is no longer needed and the
  session has finished saving, remove it with `mend worktrees rm "$wt" --project mend --force`. That
  also removes its sessions' records.
- The stack's build logs are in the session's home, under `~/.cache/mend-verify-stack/logs/`, and go
  with the workspace. If a build failed, keep its tail before Cleanup:
  `$skill/scripts/capture.sh "$E/launch" build-log -- mend run --project mend --worktree "$wt" -- sh -c 'tail -n 80 ~/.cache/mend-verify-stack/logs/*/*.log'`.

## Report

One block per run, every line an observation:

- **Run:** `$wt`, the outer server and its version, and the evidence directory.
- **Refs and daemon:** the doctor's source lines (Mend, sealant, sealantd commits) and its
  `workspace sealantd · <version>`.
- **Launch:** slots (free, or the stacks that held them), cold or warm, the time to `ready`, the
  check's outcome.
- **Per feature and entry point:** observed, with its artifacts, or `not run · <reason>`. Both
  surfaces' account.
- **Cleanup:** what `down` removed, the session's state (and `capture seals` lines when it stayed
  saving), the scan's result, the evidence's file count.
