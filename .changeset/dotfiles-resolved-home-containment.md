---
"@sealant/mend": patch
---

Refuse dotfiles sync selections whose symlink targets or parent directories resolve outside the home
directory. Keep in-home links and symlinked home directories, recheck selections before reading, and
bound reads through the selected file descriptor to the existing one-MiB limit.
