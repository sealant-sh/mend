---
"@sealant/mend": patch
---

The dotfiles repository's manager can be chosen. Settings → Dotfiles offers `auto`, `copy`, `stow`
and `chezmoi`, each with a line saying what it does, and saving sends the choice; before, the page
always kept `auto`. From the terminal,
`mend dotfiles repo <url> [--ref <r>] [--subdirectory <d>] [--manager <m>] [--no-bootstrap]` sets
the repository (the server tries the clone before it saves, as the web save does) and
`mend dotfiles repo --clear` removes it. `mend dotfiles` now names the manager on the repository
line, for example `(default branch · dots/ · manager copy · install.sh on)`.
