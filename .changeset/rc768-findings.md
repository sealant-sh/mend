---
"@sealant/mend": patch
---

Fixes from the RC 0.36.0-next.768 re-checks.

- A session whose workspace the host's Docker stopped or killed (a `systemctl restart docker`, a
  stop past its timeout) no longer reads `completed`. Core restarts such an executor on its own disk
  to save what it held. When that boot is what answers Mend, the session's line says
  `ended · the host's Docker stopped it`, with the last capture `not confirmed`, and then
  `saved at … · capture N` once the save is observed.
- `mend doctor`, a launch refused on a host that blocks user namespaces, and the web's notice now
  name `mend server setup --allow-userns` first. Setup writes the sysctl file with its marker, so
  `mend uninstall --all` removes it and puts the kernel back. The manual command is still given as
  the alternative, and a file written by hand stays on uninstall.
- When "Discard unsaved and stop" was asked but the save under way finished first and kept
  everything, the session now says
  `stopped · the save finished before the discard, so nothing was discarded`, not plain `Stopped`.
