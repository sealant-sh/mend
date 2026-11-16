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
- **A session already stuck this way ends after the upgrade.** The capture reaper takes its stop up
  again, discards the standby, and the session reads that its command never ran.
- **The words are true when Mend cannot tell.** A launch that gives up on its standby no longer says
  "the claimed standby may hold work not yet saved". It says that Mend could not confirm the standby
  had this session's worktree and that the session's command never ran there.
