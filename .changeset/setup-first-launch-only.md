---
"@sealant/mend": patch
---

Custom-image setup commands now run only on a worktree's first launch. Before, a resume ran them
again over the restored worktree, so `npm ci` put a patched file in `node_modules` back to the
published bytes before the shell opened. A launch that restores a saved capture (a resume, a
recovery, a relaunch, a standby claimed onto saved work) runs none of them. It still installs the
`mend` helper and git transport, and the session says `setup skipped · restored from capture <n>`.
Run the install yourself after a resume if a lockfile changed. Put anything setup installs outside
the worktree in Extra packages or the base image.
