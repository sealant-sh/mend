---
"@sealant/mend": patch
---

A session that claims a hot standby whose re-plan fails now runs anyway, and leaves no standby
running.

- **Mend asks the standby to re-plan again.** A re-plan that fails, usually because a connection
  dropped, is asked up to three times within the launch's three minutes. sealantd's re-plan gives
  the same result when asked twice.
- **Mend reads whether the re-plan took from the standby itself.** If the standby reports this
  session's worktree under the claim's epoch, the re-plan took and only its answer was lost: the
  session runs on the standby. If it still reports its `standby-<id>` placeholder, the re-plan never
  took, nothing of the session is on it, and nothing ran in it. Mend then discards the standby
  instead of trying to save it, and the session starts on a fresh workspace. Before this change the
  session sat at `starting · relaunch`, its stop read "not saved · workspace kept" after ten
  minutes, and on Boat its VM ran until someone pressed "Discard unsaved and stop".
- **The fresh workspace can reach Mend.** Ending the standby also took the session's channel to Mend
  with it, so the fresh workspace's first request was refused and the launch failed
  (`wrong parent: chain head is n=0`). Mend now opens the channel again before it creates the fresh
  workspace.
- **A Stop during the re-plan stops the launch.** Mend asks nothing more, starts nothing, and the
  Stop ends the standby. Before, the launch went on to a fresh workspace for a session its owner had
  stopped.
- **A refused claim's drain no longer fails on `integer out of range`.** A standby's placeholder
  epoch is a time in milliseconds; the columns that keep an epoch are now `bigint`.
- **Sessions that failed this way before the upgrade read what is known.** A failed session whose
  words said "the claimed standby may hold work not yet saved", and that has no drain left, now says
  that Mend could not confirm the standby had its worktree and that its command never ran. A session
  already kept this way ends at the capture reaper's next pass.
