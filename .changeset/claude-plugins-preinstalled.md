---
"@sealant/mend": patch
---

Claude sessions now start with the plugins their settings enable already installed, pstack among
them. Claude Code 2.1.292 did not install them itself in a workspace: a conversation session added
the marketplace and then missed the plugin, and a terminal session loaded it only in an executor's
first Claude, without its SessionStart hooks. Before Claude starts, its launch seed now reads
`enabledPlugins` from your own `~/.claude/settings.json` and the repository's
`.claude/settings.json` and `.claude/settings.local.json`, adds a marketplace it does not know from
their `extraKnownMarketplaces`, and runs `claude plugin install --scope user` for each plugin not
yet installed, as the person whose Claude it is. Every install at one launch shares 30 seconds; one
that fails or runs out of time is named and Claude starts without it. The terminal shows one line
before Claude starts: `mend: Claude plugins · installed: pstack@pstack-claude`. A new workspace
installs them again: `~/.claude/plugins` is not saved between workspaces yet.
