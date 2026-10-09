---
"@sealant/mend": patch
---

Hot sessions: a standby claimed for a session whose worktree changed since the claim (it turned per
person, or the standby's layout no longer serves the launch) is stopped before anything runs in it
and the session starts cold, instead of failing with "start the session again". While the Sealant
control plane cannot be asked, an image Mend already knows runs with one shared home still has its
standbys claimed. A change to a person's dotfiles no longer replaces their per-person standbys,
which fetch dotfiles when claimed.
