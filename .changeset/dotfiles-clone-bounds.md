---
"@sealant/mend": patch
---

The server's clone of a dotfiles repository is bounded. It clones one branch at depth 1 with no
tags, never downloads a file larger than 4MB, is stopped past 64MB on disk or after 60 seconds (git
and every helper it started are killed), and the packed archive is capped at 4MB as it streams. Each
refusal names the bound it hit, and a file over the per-file bound is named by its path. Under the
tenant source policy the pinned ssh command keeps `BatchMode=yes`, so a dotfiles clone over ssh
fails with ssh's own message instead of trying to prompt.
