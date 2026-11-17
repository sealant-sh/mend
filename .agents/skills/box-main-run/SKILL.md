---
name: box-main-run
description:
  One run of the daily check of Mend's main: starts and reports a full CI run, deploys a preview of
  main to the box (VM 131) and uses it as a signed-in person through the flow list, filing a ticket
  per failure. Use when a scheduled task names this skill, or to run it by hand.
---

# Main on the box

A T3 scheduled task runs this once a day in the Mend project. One run starts a full CI run of
`main`, waits for the box, builds a preview of `main`, deploys it to the box, and uses Mend there as
a person: the CLI and browser of the box's checker account, through the flows in
[flows.md](flows.md). Every author's own run is re-seen here, by an agent that wrote none of it. You
report and file tickets; you fix nothing.

flows.md lists every feature of the map. Which of its flows a run does is the line `Runs:` at its
top; report any flow outside it as `not run · not in this run's set`.

You are the only writer of what this skill keeps. Work in the task's worktree of Mend, detached at
`origin/main`:

```sh
git fetch --quiet origin main && git checkout --quiet --detach origin/main && pnpm install --frozen-lockfile
```

## Names

```sh
export MEND_VERIFY_BOX_SSH='-J mendbox root@10.0.0.41'   # VM 131, mend-boat-preview
WEB=https://yiannis-k8s-arc.tailc79e49.ts.net             # the box's APP_URL
KIT=~/.local/share/mend-boat-check                        # its checker account: cli/, password
STATE=~/.local/state/mend-main-run                        # state.json, lock/, runs/<tag>/
SHA=$(git rev-parse HEAD); TAG=main-${SHA:0:12}; E=$STATE/runs/$TAG
```

- VM 130 (`alpha.mend.run`) is the owner's live server: nothing here reaches it. The preview
  workflow's `deploy` input targets it; leave that input unset. Push no tag.
- The checker account (`boat-check@example.test`, owner of Default on the box) is signed in already
  in `$KIT/cli`. Use that config as it is: never `mend login` or `mend logout`, and never read a
  token from it. The password file is read only into the private account file of step 4.
- Never ssh to `acer-laptop`.
- Run the shell steps in `bash`. zsh does not split an unquoted `$MEND_VERIFY_BOX_SSH` into
  arguments, and it may alias `mend` to another checkout's CLI.

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
      "dump": "/root/backups/pre-main-<sha12>-<stamp>.sql",
      "cliDir": "/root/box-main-<sha12>-cli",
      "image": "ghcr.io/sealant-sh/mend:<version>",
      "worktrees": ["main-run-<sha8>", "main-run-run-<sha8>", "main-run-live-<sha8>"],
      "session": "<the start-session.boat-turn session id>"
    }
  ]
}
```

`runs` is newest first and lists only what this skill made and has not removed. Write each field as
soon as the step that made it succeeds, so a run that dies still leaves its ledger.

## Limits

- **One run at a time.** `mkdir $STATE/lock` is the lock; write `{ "tag", "at" }` into
  `$STATE/lock/run.json`. A lock older than **24 hours** is a dead run: remove it, say so in the
  report, and go on.
- **The wait.** A run waits for the box for at most **20 hours** from taking the lock, so it never
  meets the next day's run, then gives up with one skip line (step 3).
- **Load.** Nothing touches the box while the 1-minute load average in `/proc/loadavg` is over
  **24**: the wait (step 3) waits it out, and step 4 checks again before the deploy.
- **The box.** No run while `verify box plan` says another check holds it, a session is live, the
  box runs a migration `main` lacks, or its disk is short: the wait (step 3) waits all four out.
- **Time.** Each step has the cap below. A step past its cap is hung: stop the command it started,
  mark it failed with `hung after <n> min`, and go on to what can still run. At **4 hours** from the
  hold, start nothing new: wind down (step 6) and report what did not run as `not run · run cap`.
  The hold lapses for other checks after 6 hours.

| Step                                | Cap    |
| ----------------------------------- | ------ |
| the box (step 3's wait)             | 20 h   |
| the preview build                   | 45 min |
| the full CI run, after the flows    | 2 h    |
| `preview-deploy.sh`                 | 25 min |
| each flow                           | 10 min |
| the agent turn (`mend wait --turn`) | 8 min  |
| any other single command over ssh   | 5 min  |

A hung deploy leaves the box in an unknown state. Release the hold only once `mend server status` on
the box answers; otherwise leave it (it lapses after 6 hours), file Fix Now, and say so.

Each `gh` call spends a quota a dozen agents share: no polling loops of your own.

## 1. Skip or start

In order; the first that holds ends the run with one line in your final message, and the box
untouched:

1. `mkdir $STATE/lock` fails and the lock is under 24 hours old: `skipped · a run is in progress`.
2. No product commit since `lastCommit`: run `pnpm verify plan --base <lastCommit> --json` and read
   `.verify/latest/plan.json`. No obligation with id `judge` means no product source changed:
   `skipped · main has no product commit since <lastCommit:12>`. With no `lastCommit`, go on.

A skip removes the lock it took and leaves `lastCommit` as it was, so the next run tries again. Plan
`--base` against a `lastCommit` that is no longer on `main` fails: treat it as no `lastCommit`.

**Done when** the run stopped with a skip line, or you hold the lock and `main` has product commits.

## 2. Full CI

Start the full CI run now; you read it in step 7. A dispatch of `ci.yml` on `main` with
`formal=full` runs the same set as its nightly schedule: every package (a run that is not a pull
request selects all), cold (GitHub's runners hold no Turbo cache to read, which is what the
schedule's `--force` ensures on the box), and the formal models at full bounds. GitHub starts the
schedule hours late, so the run starts its own.

```sh
gh workflow run ci.yml --repo sealant-sh/mend --ref main -f formal=full
gh run list --repo sealant-sh/mend --workflow ci.yml --branch main --event workflow_dispatch \
  --limit 1 --json databaseId,headSha,createdAt,url
```

Take the run whose `createdAt` is after your dispatch and note its id and `headSha` in
`$STATE/lock/run.json`. Then go on: it runs while you wait for the box and use it.

**Done when** the CI run is started and its id noted.

## 3. Wait, hold and build

Wait for the box as background work, with no model calls, and hold it the moment it is free. Another
check can take the box within a minute of its release, so the waiting script takes the hold itself,
before any build:

```sh
deadline=$(( $(date -d "<the lock's at>" +%s) + 20 * 3600 ))
.agents/skills/box-main-run/wait-for-box.sh $deadline     # in the background; read its last line
```

Its last line says what happened:

- `held <sha> <tag>`: the box is yours. Set `SHA` and `TAG` from it, `E=$STATE/runs/$TAG`, run
  `pnpm install --frozen-lockfile`, and record `dump` in the ledger from
  `.verify/latest/box-prepare.json`.
- `again <what blocked>`: a background command's 2-hour limit came first. Start it again with the
  same deadline.
- `deadline <what blocked>`: 20 hours passed without a free box. End the run with
  `skipped · the box was not free in 20 h: <what blocked>`, remove the lock, and leave `lastCommit`.
  The CI run still goes on the ticket: comment its link and conclusion on SLNT-1050.

Count the wait: from the lock's `at` to the hold, for the report. Then build the preview:

```sh
gh workflow run preview.yml --repo sealant-sh/mend --ref main
gh run list --repo sealant-sh/mend --workflow preview.yml --branch main --event workflow_dispatch \
  --limit 1 --json databaseId,number,headSha,createdAt
```

Take the run whose `createdAt` is after your dispatch. Its `headSha` is the commit you test: when
`main` moved since the hold, `git checkout --detach <headSha>` and `pnpm install --frozen-lockfile`,
set `SHA` to it, and keep `TAG`: the hold's name. Wait for the build as background work:
`timeout 45m gh run watch <id> --repo sealant-sh/mend --interval 60 --exit-status`. The version is
`node scripts/next-version.mjs --package apps/cli --preview <number> --main origin/main $SHA`.

A failed build is a failure of `main`: no flow runs. File it (step 7) naming the failed job, then
wind down (step 6) and finish (step 8).

**Done when** you hold the box, the build passed, and you have `$SHA`, `$TAG` and the version.

## 4. Deploy

```sh
pnpm verify box cli --tag $TAG --yes         # this commit's CLI, under /root/box-$TAG-cli
```

Record `cliDir` in the ledger from its result. Then set up this machine's side:

```sh
mkdir -p $E && P=$(mktemp -d) && C=$(mktemp -d) && chmod 700 $P
npm install --silent --prefix $C .verify/box/cli-${SHA:0:12}/*.tgz
M() { XDG_CONFIG_HOME=$KIT/cli $C/node_modules/.bin/mend "$@"; }
jq -n --rawfile p $KIT/password '{email:"boat-check@example.test",password:($p|rtrimstr("\n"))}' \
  > $P/account.json
export MEND_VERIFY_OUTER_URL=$WEB MEND_VERIFY_PRIVATE=$P
```

`$P` holds credentials and nothing else: the evidence scan (step 7) treats every value in it as a
secret, and `--delete-hits` deletes the evidence that contains one. The CLI lives in `$C`.

`M doctor` must name `$WEB` as its server before any other `M` command: a different server means
stop, release, and report the run as not started. Take the `before` listing of flow
`server.data-intact` now, and read `df -B1 --output=avail /` on the box. Check the load average
again: over 24, wait in a shell loop that re-reads it every 2 minutes, for up to 30 minutes, then go
on either way and say so in the report (you hold the box; giving it up costs more than a slow run).
Then deploy, from the box, with the CLI `box cli` installed:

```sh
ssh $MEND_VERIFY_BOX_SSH "export PATH=/root/box-$TAG-cli/node_modules/.bin:\$PATH; \
  curl -fsSL https://raw.githubusercontent.com/sealant-sh/mend/$SHA/scripts/preview-deploy.sh \
  | timeout 25m bash -s -- <version> $SHA" 2>&1 | tee $E/deploy.log
pnpm verify box identity --tag $TAG
pnpm verify health
```

Record `version` and `image` in the ledger once the deploy pulled the image. `identity` must read
`the box runs this head`; anything else means the flows would test another build: report them all
`not run · identity`, file it, and go to step 6. A deploy that exits non-zero while `identity`
passes and `health` answers is still a deploy: record the exit and its last lines in flow
`server.upgrade`.

**Done when** `identity` passed, or the run is going to step 6 with the reason recorded.

## 5. The flows

Run this run's set of flows from [flows.md](flows.md), in its order, each within its cap. Note the
UTC time at each flow's start and end: the report gives each flow's wall time.

- A `scripted` flow runs its recipe with the verify skill's web driver. The box is the declared
  outer server (`MEND_VERIFY_OUTER_URL`, step 4), which is how the guard lets a driver reach it
  (`.agents/skills/verify/references/guard.md`): the owner asked for this run on SLNT-1050. Read
  pass or fail and the recipe's `steps.log`; open the screenshots only on a failure.

  ```sh
  MAIN_RUN_SESSION=<id> node .agents/skills/verify/scripts/drive-web.mjs --web $WEB --out $E/<flow> \
    --private $P --account $P/account.json --state $P/browser.json \
    --recipe .agents/skills/box-main-run/recipes/<recipe>.mjs
  ```

- An `agent` flow you drive by hand, as its feature file's "Driving it with verify" says, through
  `M` and a Playwright page against `$WEB` (a throwaway recipe module of your own, run with the same
  driver, keeps the redaction and the screenshots' checks). Judge only the flow's "See" line.

Keep every CLI command's stdout, stderr and exit code in `$E/<flow>/cli.log`. Each flow ends as
`seen`, `failed` or `not run · <reason>`, against the flow's own "seen" line, never a looser one. A
flow that needs an earlier flow's session and lacks it is `not run · <flow> failed`.

**Done when** every flow in flows.md has one of the three outcomes.

## 6. Wind down

1. Stop every session this run started that is still live (`M stop <id8>`), and confirm
   `M sessions --project <project> --json` lists none of them.
2. `pnpm verify box release --tag $TAG --yes`.
3. Clean up, from the ledger only. Keep `runs[0]` (this run) and `runs[1]`; for every older entry,
   remove each thing it names, after checking its name has the shape below. A name of any other
   shape is not this skill's: leave it and say so.

   | Field       | Shape it must have                                                         | Remove with                                   |
   | ----------- | -------------------------------------------------------------------------- | --------------------------------------------- |
   | `dump`      | `/root/backups/pre-main-<12 hex>-<stamp>.sql`                              | `rm -f` on the box                            |
   | `cliDir`    | `/root/box-main-<12 hex>-cli`                                              | `rm -rf` on the box                           |
   | `image`     | `ghcr.io/sealant-sh/mend:<x.y.z>-next.<n>.preview.<n>`                     | `docker image rm` on the box                  |
   | `worktrees` | each `main-run-<8 hex>`, `main-run-run-<8 hex>` or `main-run-live-<8 hex>` | `M worktrees rm <name> --force --project <p>` |

   Never remove the image `mend-mend-1` runs. A refusal (`image is in use`, a live session) keeps
   that thing and its ledger entry: say so. Drop an entry once everything it names is gone. Nothing
   else is deleted: no glob, no prune, nothing another check or the server made (the server's own
   upgrade backups under `/root/.config/mend/backups` keep the newest two by themselves).

4. Read `df -B1 --output=avail /` on the box; the report states it beside the figure read before the
   deploy (step 4).
5. `rm -rf $P` once the evidence scan (step 7) has passed.

**Done when** no session of this run is live, the hold is released (or kept for the reason in
Limits), and every ledger entry older than `runs[1]` is gone or named in the report with why.

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
made for the same test: link that one. It never stopped the box flows.

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
