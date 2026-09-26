---
"@sealant/mend": patch
---

Sealant 0.37.2: the package catalog gains `starship`, `zsh-autosuggestions`,
`zsh-syntax-highlighting`, `zsh-history-substring-search`, `direnv` and `eza` on every managed OS
family, which the default shell profile uses; and projects on the nix, Fedora and Ubuntu families
launch again with packages such as `python` and `github-cli`, which Sealant 0.37.1 renamed to distro
names and then refused. The image copies the released 0.37.2 Sealant API, worker and SSH gateway by
digest, and `@sealant/sdk` and `@sealant/api-contracts` move to 0.37.2.
