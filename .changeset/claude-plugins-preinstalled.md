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
yet installed, as the person whose Claude it is. It asks no one: whoever can commit to an adopted
repository can enable plugins (hooks, MCP servers, agents) that then run in every member's Claude
sessions on it, as that member. Every install at one launch shares 30 seconds; one that fails or
runs out of time is named and Claude starts without it. The terminal names the plugins as their
install starts (`mend: installing Claude plugins · pstack@pstack-claude …`) and what was installed
before Claude starts (`mend: Claude plugins · installed: pstack@pstack-claude`); when every plugin
is installed already, only the last line shows. A plugin that wants to run its marketplace's command
at install is not installed. A new workspace installs them again: `~/.claude/plugins` is not saved
between workspaces yet.
