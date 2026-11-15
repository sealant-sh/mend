# What `stack down` does, and what it leaves

Read this when `pnpm verify stack down` reports something left, a Stop that stays saving, or a scan
hit, or to retry in the same session. In this file, Launch is `pnpm verify stack up` and Cleanup is
`pnpm verify stack down`. `$E` is the run's evidence directory, `$P` its private directory, `$wt`
its outer worktree and `$web` its tunnel; `.verify/stack/current.json` names each for the run that
is up.

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
  first account. Capture the inner record before the retry, then take the new account over
  (`handover.mjs keygen --dir "$P"` here, `handover.mjs seal --to <key>` in a sibling `mend run`,
  piped into `handover.mjs open --dir "$P"` here) and drop the old browser state. Or take
  `pnpm verify stack down` and `pnpm verify stack up` again: a fresh session, built cold.

- The worktree stays: it holds the outer record. When the run's evidence is no longer needed and the
  session has finished saving, remove it with `mend worktrees rm "$wt" --project mend --force`. That
  also removes its sessions' records.
- The stack's build logs are in the session's home, under `~/.cache/mend-verify-stack/logs/`, and go
  with the workspace. If a build failed, keep its tail before Cleanup:
  `$skill/scripts/capture.sh "$E/launch" build-log -- mend run --project mend --worktree "$wt" -- sh -c 'tail -n 80 ~/.cache/mend-verify-stack/logs/*/*.log'`.
