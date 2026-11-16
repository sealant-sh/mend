---
name: box-main-run
description:
  One run of the 12-hour check: reports main's full CI run, deploys a preview of main to the box
  (VM 131) and uses it as a signed-in person through the flow list, filing a ticket per failure.
  Use when a scheduled task names this skill, or to run it by hand.
---

# Main on the box

A T3 scheduled task runs this every 12 hours in the Mend project. One run reads `main`'s full CI
run, builds a preview of `main`, deploys it to the box, and uses Mend there as a person: the CLI and
browser of the box's checker account, through the flows in [flows.md](flows.md). Every author's own
run is re-seen here, by an agent that wrote none of it. You report and file tickets; you fix
nothing.

flows.md lists every feature of the map. Which of its flows a run does is the line `Runs:` at its
top. Until the owner picks (SLNT-1050), a run does the flows marked `Sample: yes`; report the rest
as `not run · not in this run's set`.

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
  `$STATE/lock/run.json`. A lock older than 3 hours is a dead run: remove it, say so in the report,
  and go on.
- **Load.** No run while the 1-minute load average in `/proc/loadavg` is over **24**: checked at
  step 1 and again before step 4's deploy.
- **The box.** No run while `verify box plan` says another check holds it or a session is live.
- **Time.** Each step has the cap below. A step past its cap is hung: stop the command it started,
  mark it failed with `hung after <n> min`, and go on to what can still run. At **2 hours** from the
  lock, start nothing new: wind down (step 6) and report what did not run as `not run · run cap`.

| Step                                | Cap    |
| ----------------------------------- | ------ |
| the preview build                   | 45 min |
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

1. `mkdir $STATE/lock` fails and the lock is under 3 hours old: `skipped · a run is in progress`.
2. The load average is over 24: `skipped · load <n>`.
3. No product commit since `lastCommit`: run `pnpm verify plan --base <lastCommit> --json` and read
   `.verify/latest/plan.json`. No obligation with id `judge` means no product source changed:
   `skipped · main has no product commit since <lastCommit:12>`. With no `lastCommit`, go on.
4. `pnpm verify box plan --tag $TAG`: step `free` is not `passed`:
   `skipped · the box is held: <its detail>`. Step `schema` blocked means the box runs a migration
   `main` lacks (a PR preview not yet merged): `skipped · <its detail>`. Step `disk` blocked:
   `skipped · <its detail>`, and file it (step 7) once.

A skip removes the lock it took and leaves `lastCommit` as it was, so the next run tries again. Plan
`--base` against a `lastCommit` that is no longer on `main` fails: treat it as no `lastCommit`.

**Done when** the run stopped with a skip line, or every check passed and you hold the lock.

## 2. Full CI

The report leads with `main`'s latest full CI run: `ci.yml` on `schedule`, which runs every test
with turbo `--force` and the formal models at full bounds. GitHub starts that cron hours late (09:07
to 09:57 UTC for the 02:23 line, 12 to 15 Nov), so read the run that exists; never wait for one.

```sh
gh run list --repo sealant-sh/mend --workflow ci.yml --event schedule --branch main --limit 1 \
  --json databaseId,headSha,createdAt,updatedAt,conclusion,url
gh run view <id> --repo sealant-sh/mend --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv'
/home/yiannis/Developer/OSS/Sealant/agent-home/bin/ci failures --dry-run --json --repos mend \
  --since <createdAt>
gh run view <id> --repo sealant-sh/mend --log --job <the formal job id> \
  | cut -f3- | sed -E 's/^\S+Z //' | grep -E '^\S+\s+\S+: '
```

From `ci failures` keep the entries whose `runUrl` is this run: each failed, retried, over-budget or
uncaught-error test by name. `--dry-run` leaves the failed-tests watch's state alone. The formal job
prints one line per model with its status. Read `build-input-probe.yml`'s latest scheduled run the
same way (its conclusion only). A run with no scheduled CI run since the last one says so.

A red full run is reported and ticketed like a failed flow (report.md), after looking for the ticket
the failed-tests watch (the home repo's `watch-ci-failures`) already made: link that one. It never
stops the box flows.

What else runs only on a schedule, and whether this check covers it:

| Scheduled work                                         | Covered here                                           |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `ci.yml`: turbo `--force`, models at full bounds       | yes: this step                                         |
| `build-input-probe.yml` (daily)                        | yes: its conclusion, this step                         |
| the Undo crash property's full sweep (`docker-suites`) | yes: a job of every push to `main` and of the full run |
| `nightly-watch.yml` (every 6 h, on CI completion)      | no: it files the `nightly-failure` GitHub issue itself |
| `t3code-drift.yml` (daily)                             | no: it opens its own drift issue                       |
| `nix-server.yml` (Mondays)                             | no: weekly; its result is in GitHub                    |

**Done when** the report's first block has the run, its commit, every job's result, each failed or
retried test, each model's result, and the probe's conclusion, or says there was no run.

## 3. Build and hold

Another check can take the box while a build runs, so the hold comes right after the dispatch, not
after the build:

```sh
gh workflow run preview.yml --repo sealant-sh/mend --ref main
gh run list --repo sealant-sh/mend --workflow preview.yml --branch main --event workflow_dispatch \
  --limit 1 --json databaseId,number,headSha,createdAt
pnpm verify box prepare --tag $TAG --yes     # pg_dumpall to /root/backups, and the hold
```

Take the run whose `createdAt` is after your dispatch. Its `headSha` is the commit you test: when it
is not `$SHA` (main moved), `git checkout --detach <headSha>`, `pnpm install --frozen-lockfile`, and
set `SHA`, `TAG` and `E` again before `prepare`. A `prepare` that is not `passed` because the box is
held, busy or full is a skip, as in step 1: `gh run cancel <id>`, remove the lock, and end with the
skip line. A skip writes no `runs` entry: it made nothing on the box. Record `dump` in the ledger
once `prepare` passes.

Then wait for the build as background work, never in a polling loop of your own: start
`timeout 45m gh run watch <id> --repo sealant-sh/mend --interval 60 --exit-status` in the background
and wait for it to end. The version is
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

As [report.md](report.md) says: scan the evidence, comment the report on SLNT-1050, and file one
ticket per failure.

**Done when** the report is on SLNT-1050 and every `failed` flow has its ticket or a comment on an
open one.

## 8. Finish

Set `lastCommit` to `$SHA` once the report is posted (a run whose build failed counts: its ticket is
filed), remove `$STATE/lock`, and end with one line per flow and the report's link.
