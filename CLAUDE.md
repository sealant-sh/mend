# CLAUDE.md

Guidance for Claude Code when working in this repo. See @AGENTS.md for the full agent guidelines.

The pstack plugin is enabled for this repository in `.claude/settings.json`. Its per-person model
choices load from @~/.claude/pstack-models.md when that file exists (write it with `/setup-pstack`);
without it, pstack's defaults apply. Mend's own rules for pstack's playbooks are in
`.agents/playbooks/`.
