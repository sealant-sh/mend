---
name: box-main-run
description:
  One run of the daily check of Mend's main: starts and reports a full CI run, deploys a preview of
  main to check VM copies of the run's own data on this machine, uses them as a signed-in person
  through the flow list in up to three lanes at once, files a ticket per failure, and saves the
  run's data as the next master. Use when a scheduled task names this skill, or to run it by hand.
---

# Main on check VMs

A T3 scheduled task runs this once a day in the Mend project. One run starts a full CI run of `main`
and a preview build of it, boots up to three check VM copies of the run's own data on this machine
(`pnpm verify vm up`, `docs/operations/preview-builds.md`, "Check VMs"), deploys the preview to each
and uses Mend there as a person: the CLI and browser of the checker account, through the flows in
[flows.md](flows.md), split across the copies in lanes. Every author's own run is re-seen here, by
an agent that wrote none of it. You report and file tickets; you fix nothing.

The run owns its data. The master disk every copy boots from holds it: the checker account, the
second account, their agent logins and the fixtures, as the last run left them. Lane A's copy is the
run's own: at its end, `pnpm verify vm save` makes its data the data of the next master, keeping the
one before, and `pnpm verify vm build` builds that master. Lanes B and C are thrown away. Until 20
Nov 2026 the run held VM 131, which also serves the owner's instance and waited for other checks;
nothing here touches VM 131 now.

flows.md lists every feature of the map. Which of its flows a run does is the line `Runs:` at its
top; report any flow outside it as `not run · not in this run's set`. A flow marked
`- **Box:** after cut-over` drives the new web app (`apps/web`). This run builds its preview of
`main` with `web_app=web`, so the copies serve the new app, as the owner's server does, and
`pnpm verify box plan`'s `flows` line says every flow runs, those included. A preview built without
it serves today's app: there, report such a flow as `not run · after cut-over`, apart from the seen
and failed flows.

## Who does what

The run is an Opus 5.5 thread that hands most flows to GPT-6.1 Sol subagents (the owner's choice on
SLNT-1050, 17 Nov). You are the Opus thread. You keep what needs judgement or happens once: steps 1
to 4 (the skip, the dispatches, the copies and their holds, the deploys and identity), the flows
`server.upgrade`, `server.data-intact`, `handoff.held`, `capture-and-save.live-stop`, and the four
that run commands on a copy over ssh, which subagents never do (`server.status-logs`,
`land-change.web-push`, `land-change.cli-again` and `land-change.refused`), reading every subagent's
evidence, step 6's wind-down and save, and step 7's report and tickets. The subagents drive the
other flows (step 5). Linear is reached through the Executor MCP server's `execute` tool, with the
`linear_app.org.localLinearMcp` connection; when your harness has no such tool, write the report to
`$E/report.md` and the tickets to `$E/tickets.md`, and say so in your last line.

You are the only writer of what this skill keeps. Work in the task's worktree of Mend, detached at
`origin/main`:

```sh
git fetch --quiet origin main && git checkout --quiet --detach origin/main && pnpm install --frozen-lockfile
```

## Names

```sh
BOAT_COPIES=2                                             # copies that may have Boat (see Lanes)
VMS=~/.local/share/mend-check-vms                         # the master and the run's saved data (box/)
KIT=~/.local/share/mend-boat-check                        # its checker account: cli/, password
KIT2=~/.local/share/mend-boat-check-2                     # the second account (fixtures.sh)
STATE=~/.local/state/mend-main-run                        # state.json, lock/, lanes/, runs/<tag>/
SHA=$(git rev-parse HEAD); TAG=main-${SHA:0:12}; E=$STATE/runs/$TAG
```

- `BOAT_COPIES` is how many of the run's copies may have Boat at once: 2, so lanes A and C both boot
  with Boat (Lanes; SLNT-1223). This machine has four Boat slots (`pnpm verify vm list`, SLNT-1218),
  shared with other checks. At 1, only lane A has Boat and carries every Boat flow, as on 20 Nov.
- `$VMS/box` holds the run's saved data: `world.sql`, `world.store.tgz` (the store directories that
  data names), `mend-git.tgz` (the git service's repositories) and `mend-garage.tgz` (the blob
  store, where sessions' captures live), each with the copy before it as `world.prev.sql`,
  `world.prev.store.tgz`, `mend-git.prev.tgz` and `mend-garage.prev.tgz`. Beside them sit VM 131's
  install identity and Boat key, which the data is sealed with. Never print, copy out or commit
  anything from `$VMS`. Never restore a `.prev` copy unless the newest is lost: its agent logins
  have been spent by the newer one, so expect `reconnect needed`.
- VM 130 (`alpha.mend.run`) is the owner's live server and VM 131 (`mend.yiannisp.dev`) the owner's
  preview server: nothing here reaches either. The preview workflow's `deploy` input targets VM 130;
  leave that input unset. Push no tag. Never ssh to `acer-laptop`.
- `WEB`, a copy's address, is not a name you set: step 4's `names.sh` reads it from the copy
  (`http://127.0.1.<n>:3105`) into `$STATE/lanes/<lane>/web`.
- The checker account (`boat-check@example.test`, owner of Default in the run's data) is signed in
  already in `$KIT/cli`. The wrappers of step 4 set `MEND_URL` to the lane's address, so that saved
  login works on every copy. Use that config as it is: never `mend login` or `mend logout`, and
  never read a token from it. The login is a device token in the run's data, so it comes back with
  that data each night. The password file is read only into the private account file of step 4.
- Run the shell steps in `bash`. zsh does not split an unquoted `$MEND_VERIFY_BOX_SSH` into
  arguments, and it may alias `mend` to another checkout's CLI.

## Lanes

A lane is one check VM copy and the groups of flows.md's "Run order" that run on it. Each copy boots
with the same data, and nothing one copy does reaches another, so lanes run side by side. Within a
lane, groups run in the order below.

- **Lane A**, Boat when `BOAT_COPIES` is 1 or more; the refresher, and its data is saved: groups 1,
  3, 4, 6 and 7.
- **Lane B**, never Boat: groups 2, 5 and 8.
- **Lane C**, Boat when `BOAT_COPIES` is 2 or more: group 9 in its order, its Boat flows
  (`repositories-in-session.add-second`, `references-folders.select-link`,
  `shared-control.two-people`, `per-person-homes.two-people`) among the others (the three
  `land-change` flows, `organization.visibility-who-sees`, `organization.roles-roundtrip`,
  `organization.join-refused`, `operator.owner-grant-restore`).
- **Lane C without Boat** (`BOAT_COPIES` below 2, or every Boat slot held by other checks when it
  booted: its `copy.json` reads `"boat": false`): it runs group 9's other flows, and group 9's Boat
  flows run on lane A after A's own groups, in group 9's order.

- **Lane A is the run's own.** The flows whose effects the next run reads run there: group 1's
  `server.data-intact`, the turn session the ledger keeps, the worktrees wind-down removes. Its copy
  alone may refresh the agent logins (State, "The logins"), and its data is saved (step 6).
- **B and C are thrown away** when their flows end. Whatever their flows change goes with them, so a
  restore a B or C flow misses changes nothing for later runs; it is still reported.
- **Fewer copies.** The run takes at most 3 copies, and this machine runs at most 5 counting other
  checks' (`copies.sh`). A lane with no room is left out and its groups run on lane A after A's own,
  in run order: B's, then C's. `start-session.docker-run` needs a copy without Boat: with lane B
  left out it runs on lane C when C has no Boat, and is `not run · no copy without Boat` otherwise.
- **Boat on lane C changes nothing else.** Lane C's copy never lifts the logins' claim, never
  refreshes a login and is never saved, Boat or not: what its Boat sessions change goes with the
  copy. Two Boat copies run under the same Boat deployment (preview-builds.md, "Check VMs"), and
  sealant on each acts only on its own copy's runs.

## State

`$STATE/state.json` is the run's memory. It lives on this machine, beside the scheduler, because a
skip must be decided before anything is touched, and the cleanup ledger must be exact: Linear can be
down, and a ticket comment is text a person may edit. Each report on SLNT-1050 names its commit, so
a lost file is rebuilt from the latest report.

```json
{
  "lastCommit": "<sha of the last run that reached the report>",
  "runs": [
    {
      "tag": "main-<sha12>",
      "commit": "<sha>",
      "at": "<UTC>",
      "version": "<preview version>",
      "copies": [{ "lane": "a", "slot": 2, "startedAt": "<UTC>" }],
      "saved": "<UTC of vm save, or null>",
      "master": "<the version vm build built, or null>",
      "worktrees": ["boat-check-ubuntu/main-run-<sha8>", "main-run-land/main-run-land-<sha8>", "…"],
      "session": "<the start-session.boat-turn session id>"
    }
  ]
}
```

`lastCommit` is the commit of `main` the run checked. A run's `commit` is the one it deployed, which
is the same except when a run checked `main` with an unmerged branch merged in (16 Nov: `main`
c416f754 with the SLNT-895 stack, deployed as 92eca0b8); then the two differ, by design.

`runs` is newest first, and lists only what this skill made and has not removed. Write each field as
soon as the step that made it succeeds, so a run that dies still leaves its ledger. `copies` are the
copies this run booted: a copy is this run's only while `pnpm verify vm list` shows that slot
running and `$STATE/lanes/<lane>/copy.json` names the same `startedAt`; slots are reused by other
checks. `worktrees` and `session` live in lane A's data, which is saved, so the next run's copies
hold them.

Beside it, `$STATE/listing/` holds the listing of step 6.2, taken on lane A just before its data was
saved: `projects.json` and `sessions.json`, with the tag in `tag`. It is flow `server.data-intact`'s
`before`, because tonight's lane A boots from exactly the data that listing read.

**The logins.** Every copy of the run's data holds the same Codex and Claude logins, and only
sealant's keep-fresh sweeper on a server refreshes them. A refresh spends the refresh token every
other copy holds: the first copy to refresh keeps the login and every other is signed out at its own
next refresh. So `vm save` holds each login against refresh in the saved data (a refresh claim of
2999 the sweepers never take), and `refresher.sh lift` takes that claim off on lane A's copy alone.
A copy another check boots in the day never refreshes; it runs on the access token the last save
left, which for Codex lives 240 hours (measured 20 Nov) and is refreshed once it is within 24 hours
of expiry, on the sweeper's hourly tick, the first 60 minutes after Mend starts. A Claude access
token lives about 8 hours, so a copy booted more than 8 hours after a save holds an expired Claude
token it cannot refresh (SLNT-1219). `node .agents/skills/box-main-run/logins.mjs` prints when each
saved login expires, with times only.

## Limits

- **One run at a time.** `mkdir $STATE/lock` is the lock; write `{ "tag", "at" }` into
  `$STATE/lock/run.json`. A lock older than **24 hours** is a dead run: remove it, say so in the
  report, and go on. A dead run's copies (its ledger's `copies`, checked as State says) are deleted
  with `pnpm verify vm down <slot>` before this run boots its own; when its `saved` is null and it
  had lifted the logins' claim, run `vm save <slot>` on its lane A copy first, as long as it still
  runs: it may hold the only login that can still refresh.
- **The wait.** A run waits for room on this machine (`copies.sh`) for at most **20 hours** from
  taking the lock, so it never meets the next day's run, then gives up with one skip line (step 3).
- **Load.** No copy boots while the 1-minute load average in `/proc/loadavg` is over **24**:
  `copies.sh` waits it out.
- **Processes.** At most one subagent per lane at once, so at most three.
- **Time.** Each step has the cap below. A step past its cap is hung: stop the command it started,
  mark it failed with `hung after <n> min`, and go on to what can still run. At **4 hours** from
  lane A's boot, start nothing new: wind down (step 6) and report what did not run as
  `not run · run cap`.

| Step                                | Cap    |
| ----------------------------------- | ------ |
| room for the copies (`copies.sh`)   | 20 h   |
| the preview build                   | 45 min |
| the full CI run, after the flows    | 2 h    |
| `preview-deploy.sh`, per copy       | 25 min |
| each flow                           | 10 min |
| the agent turn (`mend wait --turn`) | 8 min  |
| `vm save`                           | 15 min |
| `vm build`                          | 30 min |
| any other single command over ssh   | 5 min  |

Each `gh` call spends a quota a dozen agents share: no polling loops of your own.

## 1. Skip or start

In order; the first that holds ends the run with one line in your final message, and nothing
started:

1. `mkdir $STATE/lock` fails and the lock is under 24 hours old: `skipped · a run is in progress`.
2. No product commit since `lastCommit`: run `pnpm verify plan --base <lastCommit> --json` and read
   `.verify/latest/plan.json`. No obligation with id `judge` means no product source changed. Then
   read `node .agents/skills/box-main-run/logins.mjs`. When its Codex line expires in more than 30
   hours, end with `skipped · main has no product commit since <lastCommit:12>`. When it expires
   sooner, the run does only the refresh, so the login does not expire before a run refreshes it:
   step 3 with `BOAT_COPIES=0` and lane A alone (`copies.sh <deadline> 0`, then
   `pnpm verify vm down` on any other lane it booted), `refresher.sh lift` on it, a background
   `sleep 3900`, then `refresher.sh state` must read the Codex line `synced` within the last 70
   minutes; then step 6, items 4 to 6, and end with
   `skipped · main has no product commit since <lastCommit:12> · logins refreshed and saved`. With
   no `lastCommit`, go on.

A skip removes the lock it took and leaves `lastCommit` as it was, so the next run tries again. Plan
`--base` against a `lastCommit` that is no longer on `main` fails: treat it as no `lastCommit`.

**Done when** the run stopped with a skip line, or you hold the lock and `main` has product commits.

## 2. Full CI and the preview build

Start both now; nothing waits for a server any more. A dispatch of `ci.yml` on `main` with
`formal=full` runs the same set as its nightly schedule: every package (a run that is not a pull
request selects all), cold (GitHub's runners hold no Turbo cache to read, which is what the
schedule's `--force` ensures on the box), and the formal models at full bounds. GitHub starts the
schedule hours late, so the run starts its own.

```sh
gh workflow run ci.yml --repo sealant-sh/mend --ref main -f formal=full
gh workflow run preview.yml --repo sealant-sh/mend --ref main -f web_app=web
gh run list --repo sealant-sh/mend --workflow ci.yml --branch main --event workflow_dispatch \
  --limit 1 --json databaseId,headSha,createdAt,url
gh run list --repo sealant-sh/mend --workflow preview.yml --branch main --event workflow_dispatch \
  --limit 1 --json databaseId,number,headSha,createdAt
```

Take the runs whose `createdAt` is after your dispatches and note their ids in
`$STATE/lock/run.json`. The preview run's `headSha` is the commit you test: when `main` moved since
your checkout, `git checkout --detach <headSha>` and `pnpm install --frozen-lockfile`, and set
`SHA`, `TAG` and `E` from it. The version is
`node scripts/next-version.mjs --package apps/cli --preview <number> --main origin/main $SHA`. Wait
for the build as background work while step 3 runs:
`timeout 45m gh run watch <id> --repo sealant-sh/mend --interval 60 --exit-status`.

A failed build is a failure of `main`: no flow runs. File it (step 7) naming the failed job, delete
any copy step 3 booted (`pnpm verify vm down <slot>`, no save: nothing ran on it), and finish (step
8).

**Done when** both runs are started and noted, and you have `$SHA`, `$TAG` and the version.

## 3. The copies

Boot the lanes' copies with no model calls. Start from no lanes
(`rm -rf ~/.local/state/mend-main-run/lanes`, one plain command): an earlier run's lane files name
copies that are gone. Then run the script as a background command when your harness has them, and
read its last line when it ends; it stops itself after 110 minutes in any case:

```sh
deadline=$(( $(date -d "<the lock's at>" +%s) + 20 * 3600 ))
.agents/skills/box-main-run/copies.sh $deadline $BOAT_COPIES   # in the background; read its last line
```

Its last line says what happened:

- `copies a=<slot> [b=<slot>] [c=<slot>]`: those lanes' copies are up. Each lane's copy is in
  `$STATE/lanes/<lane>/copy.json` (`slot`, `url`, `ssh`, `startedAt`, `boat`); record each in the
  ledger's `copies` at once. A lane it left out runs on lane A (Lanes). A lane A with no Boat (its
  line reads `no Boat`, after 60 minutes of another check holding it) makes every Boat flow lane A
  would run `not run · no Boat copy`. Lane C does not wait for Boat: when every slot is held as it
  boots, it prints `lane c · no Boat slot free · …` and boots without Boat, and group 9's Boat flows
  run on lane A (Lanes, "Lane C without Boat").
- `failed <lane> <what failed>`: `vm up` failed for a reason other than room. Run it once more; a
  second failure is a Fix Now ticket (step 7), and the run ends after step 8 without moving
  `lastCommit`.
- `again <what blocked>`: a background command's 2-hour limit came first. Start it again with the
  same deadline; lanes already up are kept.
- `deadline <what blocked>`: 20 hours passed without room. End the run with
  `skipped · no room for a copy in 20 h: <what blocked>`, remove the lock, and leave `lastCommit`.
  The CI run still goes on the ticket: comment its link and conclusion on SLNT-1050.

Count the wait: from the lock's `at` to lane A's `startedAt`, for the report. Then, for each lane,
name its copy and hold it as this run (one plain command each; the copy's data is already the run's,
so there is nothing to load):

```sh
export MEND_VERIFY_BOX_SSH="$(jq -r .ssh $STATE/lanes/<lane>/copy.json)" MEND_VERIFY_OUTER_URL="$(jq -r .url $STATE/lanes/<lane>/copy.json)"
pnpm verify box prepare --tag $TAG --yes
```

On lane A, and only there, lift the logins' claim, and read their state for the report:

```sh
MEND_VERIFY_BOX_SSH="$(jq -r .ssh $STATE/lanes/a/copy.json)" .agents/skills/box-main-run/refresher.sh lift
MEND_VERIFY_BOX_SSH="$(jq -r .ssh $STATE/lanes/a/copy.json)" .agents/skills/box-main-run/refresher.sh state
```

`lift` must print `lifted=<n>` with n at least 1. `lifted=0` means the saved data held no claim (a
master built before SLNT-1216, as on 20 Nov), so lanes B and C could refresh too and spend the login
under lane A. Hold theirs at once, before their sweepers' first tick 15 minutes after their Mend
started, and say so in the report:

```sh
MEND_VERIFY_BOX_SSH="$(jq -r .ssh $STATE/lanes/<b or c>/copy.json)" .agents/skills/box-main-run/refresher.sh hold
```

**Done when** lane A's copy is up and held, every other lane's copy is up and held or named as left
out, and lane A's logins read `claim free`.

## 4. Deploy

Wait for the preview build (step 2) if it has not ended. Then, lane by lane, with that lane's
`MEND_VERIFY_BOX_SSH` and `MEND_VERIFY_OUTER_URL` exported as in step 3:

```sh
pnpm verify box cli --tag $TAG --yes         # this commit's CLI, under /root/box-$TAG-cli on the copy
mkdir -p $E
.agents/skills/box-main-run/names.sh <lane> .verify/box/cli-${SHA:0:12}/*.tgz
```

`names.sh` reads the copy's address into `$STATE/lanes/<lane>/web`, installs this commit's CLI once
for all lanes and writes, at fixed paths, the names every later command uses:

| Name          | Path                                                | What it is                                                                           |
| ------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `M`           | `~/.local/state/mend-main-run/lanes/<lane>/bin/M`   | mend, signed in as the checker account, at the lane's copy                           |
| `M2`          | `~/.local/state/mend-main-run/lanes/<lane>/bin/M2`  | mend, signed in as the second account, at the lane's copy                            |
| `box`         | `~/.local/state/mend-main-run/lanes/<lane>/bin/box` | `box '<command>'` runs it on the lane's copy over ssh                                |
| `web`, `web2` | `~/.local/state/mend-main-run/lanes/<lane>/bin/web` | `web <out dir> <recipe> [flags]`: the web driver against the copy, as either account |
| `$P`          | `~/.local/state/mend-main-run/private`              | mode 700, the two accounts' web sign-in and each lane's browser state                |

`$P` holds credentials and nothing else: the evidence scan (step 7) treats every value in it as a
secret, and `--delete-hits` deletes the evidence that contains one.

**Run every command as one plain command, by these full paths.** A shell function or variable does
not outlive one tool call, so write `~/.local/state/mend-main-run/lanes/a/bin/M stop <id8>`, not
`M stop` inside `bash -c '…'` or after `source`. This matters most for a removal (`… worktrees rm`,
`… secrets rm`, `… folder rm`, `rm -rf …`): Claude Code's removal check reads a plain command and
refuses one hidden in `bash -c` or a sourced file, and on 17 Nov that left a worktree, a secret and
a folder on the box. Give each removal its own command. Where these files write `M`, `M2`, `box` or
`web`, they mean those paths for the flow's lane.

Copy the listing the last run left, `$STATE/listing/`, into `$E/server.data-intact/before/`: it is
that flow's `before`. With no listing there, its listing half is `not run · no listing saved`. Read
`df -B1 --output=avail /` on lane A's copy. Then deploy, on each lane's copy, with the CLI `box cli`
installed. The lanes' deploys may run side by side as background commands, one per lane, each
writing its own log; lane A's is flow `server.upgrade`'s:

```sh
ssh $MEND_VERIFY_BOX_SSH "export PATH=/root/box-$TAG-cli/node_modules/.bin:\$PATH; \
  curl -fsSL https://raw.githubusercontent.com/sealant-sh/mend/$SHA/scripts/preview-deploy.sh \
  | timeout 25m bash -s -- <version> $SHA" 2>&1 | tee $E/deploy-<lane>.log
pnpm verify box identity --tag $TAG
pnpm verify health --url "$(cat $STATE/lanes/<lane>/web)"
```

The deploy upgrades from the master's build over the run's data. Then the lane's `M doctor` must
name its `web` as its server before any other `M` command: a different server means that lane does
not run, and its flows are `not run · <lane> not started`.

Record `version` in the ledger once lane A's deploy pulled the image. `identity` must read
`the box runs this head` on each lane; on a lane where it does not, the flows would test another
build: report that lane's flows `not run · identity`, file it, and delete the copy. A deploy that
exits non-zero while `identity` passes and `health` answers is still a deploy: record the exit and
its last lines in flow `server.upgrade` (lane A) or in the report (B, C).

Then make sure the fixtures are there on each lane:

```sh
LANE=<lane> .agents/skills/box-main-run/fixtures.sh $TAG
```

It prints one line per fixture (`present`, `made`, or `manual: <step>`) and keeps them in the
report. Every fixture is in the saved data, so on a copy they read `present`; one it makes on lane A
is saved with A's data, one it makes on B or C goes with the copy. A fixture it could not make turns
the flows that need it on that lane into `not run · fixture <name> missing`; it never stops the run.

**Done when** `identity` passed and the fixtures were checked on every lane, or each lane that did
not is named with the reason.

## 5. The flows

Run each lane's groups (Lanes) in flows.md's "Run order": later flows in a lane reuse what earlier
ones made. Lanes run side by side. Do the flows Opus keeps (see "Who does what") yourself, in their
place in their lane's order. Hand each other group to one subagent, one group after another within a
lane; across lanes, up to one subagent each at once. Two groups of one lane run side by side only
when both are plainly independent reads (no session made or stopped).

Start a subagent with T3's `delegate_task`: `target`
`{ providerInstanceId: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "high" } }`,
`isolation: "shared"` (it works in this worktree), and as `task` the text of
[sol-task.md](sol-task.md) with every `<…>` filled: the group's flow ids, the lane, this worktree's
path, the lane's `web`, the commit's first 8 characters, `$E`, and the session ids earlier flows of
that lane made (from their `result.txt` or your own notes). Wait for its completion, then read its
evidence. Lanes' subagents share `$E` and its `timeline.txt`: each flow has its own directory.

**Check, do not trust.** A flow counts as `seen` only when its `result.txt`, `cli.log`, the web
driver's `steps.log` and its screenshots show every part of the flow's See line. Read each
`restored · … · read back:` line too: a `not restored` line, or a restore the Do line names with no
read-back, is yours to put right before the next flow of that lane that touches the same thing, and
goes in the report. Read them for every flow; open screenshots where the See line names a screen. A
flow the subagent marked `failed`, or whose evidence falls short, you see again yourself, on the
same lane, before reporting it as failed or filing a ticket. Re-see only those flows, however many
there are in the group: a flow whose own evidence shows every part of its See line stays `seen` by
Sol, even beside a failed neighbour, a slip elsewhere in the group, or a damaged `timeline.txt`
(sol-task.md says what that costs). A slip that changed shared state (an extra invitation, a role or
visibility not put back) is a restore to put right and report, not a reason to re-see other flows. A
flow you re-do that makes a worktree needs a new name (`main-run-extras2-<sha8>`): the subagent's
removed worktree leaves its branch, and Mend refuses the name. Note per flow its lane, who drove it
(Sol, or Opus) and whether you re-did it.

How a flow is driven, by you or a subagent:

- A `scripted` flow runs its recipe with the verify skill's web driver. The lane's copy is the
  declared outer server (`MEND_VERIFY_OUTER_URL`, step 4), which is how the guard lets a driver
  reach it (`.agents/skills/verify/references/guard.md`): the owner asked for this run on SLNT-1050.

  ```sh
  MAIN_RUN_SESSION=<id> ~/.local/state/mend-main-run/lanes/<lane>/bin/web $E/<flow> \
    .agents/skills/box-main-run/recipes/<recipe>.mjs
  ```

- A scripted CLI flow runs
  `E=$E SHA8=<sha8> LANE=<lane> .agents/skills/box-main-run/recipes/cli-reads.sh <flow id>` (it uses
  step 4's CLI and the checker account by default). It checks every part of the See line and writes
  `cli.log` and `result.txt`; exit 0 is `seen`.

- An `agent` flow is driven by hand, as its feature file's "Driving it with verify" says, through
  `M` and a recipe module of your own run with `web` (it keeps the redaction and the screenshots'
  checks). Judge only the flow's See line.

A scripted flow that fails is not yet a failure: drive it again the agent way, and report it failed
only when that sees the same.

Keep every CLI command's stdout, stderr and exit code in `$E/<flow>/cli.log`. Each flow ends as
`seen`, `failed` or `not run · <reason>`, against the flow's own See line, never a looser one. A
flow that needs an earlier flow's session and lacks it is `not run · <flow> failed`.

When lane B's or C's flows are all judged, delete its copy at once (`pnpm verify vm down <slot>`,
one plain command): it frees room for other checks, and nothing on it is kept.

**Done when** every flow in this run's set has one of the three outcomes, checked by you, and lanes
B and C are deleted.

## 6. Wind down and save

Everything here runs against lane A's copy, by lane A's names.

1. Stop every session this run started on lane A that is still live (`M stop <id8>`), and confirm
   `M sessions --project <project> --json` lists none of them.
2. Keep `runs[0]` (this run) and `runs[1]`: the next run reads their sessions. For every older
   entry, remove each of its worktrees with `M worktrees rm <name> --force --project <project>`, one
   plain command each, after checking each name has the shape `<project>/main-run-<word>-<8 hex>` or
   `<project>/main-run-<8 hex>`, `<project>` one of `boat-check-ubuntu`, `main-run-land`,
   `main-run-second`. A name of any other shape is not this skill's: leave it and say so. A refusal
   (a live session) keeps that worktree and its entry: say so. Drop an entry once its worktrees are
   gone. An entry from before 21 Nov 2026 also names a `dump`, `cliDir` and `image` on VM 131: leave
   them there, since this skill no longer reaches VM 131, and name them once in the report. Then
   write the listing for the next run: `M projects --json` and
   `M sessions --all --project boat-check-ubuntu --json` into `$STATE/listing/projects.json` and
   `sessions.json`, and `$TAG` into `$STATE/listing/tag`, replacing what was there.
3. Read `df -B1 --output=avail /` on lane A's copy, and its logins:
   `MEND_VERIFY_BOX_SSH="$(cat $STATE/lanes/a/ssh)" .agents/skills/box-main-run/refresher.sh state`.
   A login due for refresh (`logins.mjs` before the run read it within 24 hours of expiry, for
   Codex) whose line does not read `synced` within this run means the sweeper has not ticked yet:
   when lane A's copy has been up for less than 65 minutes, wait (a background `sleep`) until it
   has, and read again. A line reading `invalid`, or `refused` in its outcome, is the login signed
   out: report it and file Fix Now (step 7); the owner reconnects it.
4. Save lane A's data as the next master's:

   ```sh
   pnpm verify vm save <lane A's slot>
   ```

   It refuses data carrying a migration `origin/main` lacks, then, with Mend stopped, holds the
   logins against refresh, dumps the databases and store, archives the git service and the blob
   store, and moves the four into `$VMS/box` once all four are whole, keeping the copies before as
   `*.prev.*`. A failed save leaves `$VMS/box` as it was: run it once more, and when it fails again
   keep lane A's copy running, file Fix Now and say so in the report. Do not delete that copy: it
   holds the newest logins. Record `saved` in the ledger. Then
   `node .agents/skills/box-main-run/logins.mjs` reads the saved logins: every line `held`.

5. `pnpm verify vm down <lane A's slot>`. Check `pnpm verify vm list` shows none of the ledger's
   copies, and drop them from it.
6. Build the next master from the saved data, with this run's preview, once no copy runs on this
   machine: `vm build` replaces the master every copy is backed by, so it refuses while any runs. As
   background work, wait for `pnpm verify vm list --json` to list no copy, re-reading it every 2
   minutes for up to 6 hours, then:

   ```sh
   pnpm verify vm build --version <version> --sha $SHA --cli "$(npm view @sealant/mend dist-tags.next)"
   ```

   (no `--from-box`: it builds from `$VMS/box`). Record `master` in the ledger from `vm list`. A
   build that fails leaves no master: run it once more; a second failure is Fix Now, filed with the
   build's step that failed. Six hours without a moment free of copies: say so in the report, and
   the next run's start builds it first. Day copies keep running on the master before, whose Codex
   access token stays valid until its own expiry.

`rm -rf ~/.local/state/mend-main-run/private` once the evidence scan (step 7) has passed, as one
plain command.

**Done when** no session of this run is live on lane A, its data is saved with every login held, no
copy of this run runs, and the next master is built (or the report says why not).

## 7. Report and tickets

First read the full CI run step 2 started. If it has not ended, wait for it as background work
(`timeout 2h gh run watch <id> --repo sealant-sh/mend --interval 120 --exit-status`); past that,
report it as `running` with its link. Then:

```sh
gh run view <id> --repo sealant-sh/mend --json jobs \
  --jq '.jobs[] | [.databaseId, .name, .conclusion] | @tsv'
gh api repos/sealant-sh/mend/actions/runs/<id>/artifacts --jq '.artifacts[].name' | grep -- '-retried$'
gh run download <id> --repo sealant-sh/mend -n <each -retried artifact> -D <scratch>   # retried-*.json
gh run view <id> --repo sealant-sh/mend --log --job <each formal job id> \
  | cut -f3- | sed -E 's/^\S+Z //' | grep -E '^\S+\s+\S+: '
gh run view <id> --repo sealant-sh/mend --log-failed | grep -E 'FAIL |not ok ' | head -40
```

A lane that retried a test uploads its report as `test-report-<job>-retried`; its `retried-*.json`
name each test. Each formal job prints one line per model with its status. Failed tests are the
`FAIL` and `not ok` lines of the failed jobs' logs. The home repo's `bin/ci failures` reads only
pushes to `main` and scheduled runs, so it does not see this dispatched run. Read the latest
scheduled `build-input-probe.yml` run's conclusion too.

A red full run is reported and ticketed like a failed flow, after looking in Linear's "Flaky tests"
project for the ticket the failed-tests watch (the home repo's `watch-ci-failures`) may already have
made for the same test: link that one. It never stopped the flows.

What else runs only on a schedule, and whether this check covers it:

| Scheduled work                                         | Covered here                                           |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `ci.yml`'s nightly: every package cold, models full    | yes: step 2's dispatch runs the same set               |
| `build-input-probe.yml` (daily)                        | yes: its latest conclusion                             |
| the Undo crash property's full sweep (`docker-suites`) | yes: a job of every push to `main` and of the full run |
| `nightly-watch.yml` (every 6 h, on CI completion)      | no: it files the `nightly-failure` GitHub issue itself |
| `t3code-drift.yml` (daily)                             | no: it opens its own drift issue                       |
| `nix-server.yml` (Mondays)                             | no: weekly; its result is in GitHub                    |

Then, as [report.md](report.md) says: scan the evidence, comment the report on SLNT-1050, and file
one ticket per failure.

**Done when** the report is on SLNT-1050, leading with the full CI run, and every `failed` flow or
CI job has its ticket or a comment on an open one.

## 8. Finish

Set `lastCommit` to `$SHA` once the report is posted (a run whose build failed counts: its ticket is
filed), remove `$STATE/lock`, and end with one line per flow and the report's link.
