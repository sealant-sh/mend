---
"@sealant/mend": minor
---

pi and opencode run as Mend sessions beside Claude Code and Codex: `mend pi`, `mend opencode`, and
the web and VS Code launchers. Both run in the unified image (Sealant 0.39 bakes them in) without
permission prompts: opencode through its own permission setting at launch, never by writing your
opencode config; pi asks none, and Mend answers its project-trust question with `--approve`. pi
takes a model, a thinking level and an opening prompt, keeps its home (`~/.pi`: settings, sessions,
extensions and packages) with the session, resumes with `--session`, and gets Mend's workspace note
and skills in its own folder. opencode opens its TUI on the prompt, keeps its data and state
directories with the session (its conversations, the model it last used, its prompt history), and
reads Mend's note and skills from Claude Code's. A stopped opencode session resumes its own
conversation (`opencode --session <id>`), never another session's in the same worktree; when Mend
cannot tell which conversation is the session's, the resume is refused and says so, and a shell
resume opens the shell. Neither tool's logins are kept with the session: not their `auth.json`, and
not opencode's MCP logins (`mcp-auth.json`).
