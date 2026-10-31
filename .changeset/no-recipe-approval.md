---
"@sealant/mend": minor
---

A recipe runs whoever added or changed it. The preview starts after a turn that changed the
worktree, with no Start first, and runs as the turn's sender, so a steerer's turn runs on the
steerer's login. A running preview whose command, `cwd`, `env` or `depends` the turn changed starts
again from the file. A restart replays the attempt it replaces, whoever asks. The lines
`recipe not approved · the owner's Start runs it` and `recipe changed · the owner's Start runs it`
are gone, and `mend service restart` no longer says a restart ran an approved version. Migration
`0170_drop_recipe_approvals` drops the `recipe_approvals` table and each attempt's launch source,
and records a turn that was refused for want of an approval as skipped, so it starts nothing after
the upgrade.
