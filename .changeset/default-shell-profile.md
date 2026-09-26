---
"@sealant/mend": minor
---

A default zsh profile for workspaces. When a session launches into a zsh workspace, Mend writes
`~/.zshrc` and `~/.config/starship.toml` wherever your dotfiles left no file: history and completion
settings, fzf and direnv hooks, the autosuggestions, syntax-highlighting and
history-substring-search plugins, and a starship prompt. Mend never overwrites a file that exists,
so your dotfiles always win. Every block checks for its tool first, so an image without one of the
packages still starts the shell. A project turns it off under Setup → Dotfiles → Default shell
profile.

New installs default to zsh and add `starship`, `zsh-autosuggestions`, `zsh-syntax-highlighting`,
`zsh-history-substring-search` and `direnv` to the default packages. A saved instance, organization
or project environment is not changed. These package names need a Sealant release whose catalog has
them.
