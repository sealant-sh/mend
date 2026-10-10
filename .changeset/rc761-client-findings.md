---
"@sealant/mend": patch
---

Fixes from the 0.36.0-next.761 client pass:

- `mend run -- bash -c '…'` runs bash. Any `bash` with arguments used to be swapped for the
  workspace's login shell (zsh by default), so bash builtins such as `mapfile` and `shopt` were "not
  found", sometimes with exit 0. The program you name now runs as itself, with exactly your argv.
  Only a bare shell session still opens the login shell.
- Back-to-back `mend run` in one worktree no longer fails with "the executor is ending: a final
  capture flush closed admission" when the previous run's save is slow (a large untracked tree). A
  launch that joins the worktree's executor now counts as in use, so the previous run's save waits
  for it. If that save has already begun, the launch waits
  (`waiting · the previous session in this worktree is saving`) and then starts on a fresh executor.
- "Discard unsaved and stop…" is offered once a save has stalled (`not saved · … · workspace kept`,
  or a step past its bound), not while it is still saving. If a discard waits on a save that then
  saves everything and ends the workspace, the session reads what that save recorded, not
  `unsaved work discarded`, and no discard is audited.
- The session page no longer shows its owner the non-owner view ("runs as another account", "its
  owner shares control · Turn off", `PROJECTS/PROJECT`) for a few seconds. Ownership lines wait for
  the data they depend on. `sessions.recipes`, which reads the workspace and can take seconds, is no
  longer batched with the rest of the page's reads.
