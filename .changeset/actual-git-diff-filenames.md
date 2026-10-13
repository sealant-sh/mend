---
"@sealant/mend": patch
---

Keep actual filenames in changed-file counts and Slack diffs, including Git-quoted Unicode names,
escaped control characters and rename destinations. Read untracked names in Git's machine format so
their file contents appear in the change instead of disappearing behind display quoting. Preserve
the existing untracked-file render limit.
