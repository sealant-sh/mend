---
"@sealant/mend": patch
---

Sealant 0.37.1, with sealantd 0.18.2: dotfiles `manager: auto` picks stow only for a stow layout, so
a home mirror keeps its dot entries; a restart keeps dotfiles; and a MicroVM boot failure reports
sealantd's last output. The image copies the released 0.37.1 Sealant API, worker and SSH gateway by
digest, and `@sealant/sdk` and `@sealant/api-contracts` move to 0.37.1.
