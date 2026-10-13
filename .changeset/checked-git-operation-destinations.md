---
"@sealant/mend": patch
---

Check Git's effective clone, fetch and push destinations before transport, using the actual
repository and configuration. Keep Git's original operand and select the owner's signer for the
checked destination. Refused base refreshes still allow sessions to start from their local base.
Dotfiles launches recheck the owner's current operator role, so a saved operator-only source loses
that authority when the role is revoked.

Mend clones no longer inherit Git's implicit system template. Explicit `GIT_TEMPLATE_DIR` and
`init.templateDir` templates remain supported through owned snapshots when they contain regular
files and directories without URL, include or remote settings. Links and special files, inherited
repository-location overrides, conditional clone includes and preconfigured remotes are refused,
including for operators. Existing-repository configuration remains available. Explicit URL pushes
with matching rewrite rules for several bases require a named remote or one matching base.
