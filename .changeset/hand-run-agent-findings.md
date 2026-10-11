---
"@sealant/mend": patch
---

Agents in a workspace, from the 0.36 proof of agents you run yourself:

- A `codex` you run yourself can run commands. Codex's own sandbox (bubblewrap) cannot start in a
  workspace: as a person it stopped with `bwrap: Unexpected capabilities but not setuid`, so every
  command failed and asked for approval. When a workspace starts, Mend now writes Codex's system
  default, `/etc/codex/config.toml`, with `sandbox_mode = "danger-full-access"`. It writes only
  where no file or link is there, and never replaces one that appears meanwhile. Approvals stay
  Codex's own default. A `sandbox_mode` in your `~/.codex/config.toml` wins.
- A Codex conversation Mend starts in `ask` mode can run commands too. It asked Codex for
  `workspace-write`, the same sandbox, so every command failed. It now runs as the terminal's `ask`
  launch does: no sandbox, approval prompts on.
- Mend no longer picks a Claude model. A Claude launch that names none runs on the model your Claude
  settings name, else Claude Code's own default, as a `claude` you run yourself does. The catalog
  marks no Claude default (migration 0130). The web and phone pickers read `default` and preselect
  no model, VS Code leads with `claude's own choice`, and t3code with "Claude Code's default". A
  model you pick is still sent, for that launch only. Mend's launch writes
  `skipDangerousModePermissionPrompt` into `~/.claude/settings.json` and never a model. It removes
  `claude-fable-5`, the model Mend wrote there until 2026-10-01. Before this, a launch wrote
  `"model": "fable"` there, so in a per-person workspace every `claude` you ran yourself, and the VS
  Code panel, opened on Fable after one Mend launch.
- Stopping a shell session also closes the `mend shell` terminals opened beside it, and an agent
  running in them ends with them. Its own shell counted as an agent the Stop had ended, so the other
  shells stayed `running` and held the session `idle` until each was stopped by hand. A Stop that
  ends an agent Mend started still keeps your shells. A `mend shell` row now records the person it
  runs as.
