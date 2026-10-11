---
"@sealant/mend": patch
---

Agents you run yourself in a workspace, three fixes from the 0.36 proof:

- A `codex` you run yourself can run commands. Codex's own sandbox (bubblewrap) cannot start in a
  workspace: as a person it stopped with `bwrap: Unexpected capabilities but not setuid`, so every
  command failed and asked for approval. Mend now writes Codex's system default,
  `/etc/codex/config.toml`, with `sandbox_mode = "danger-full-access"`, the mode the Codex sessions
  Mend starts already run in. Approvals stay Codex's own default. A `sandbox_mode` in your
  `~/.codex/config.toml` wins, and a file already at that path is left as it is.
- A Claude session Mend starts no longer changes your own default model. Mend wrote
  `"model": "fable"` into `~/.claude/settings.json` when it named none, so in a per-person workspace
  every `claude` you ran yourself, and the VS Code panel, opened on Fable after one Mend launch.
  Mend's default now applies to its own launch only (`ANTHROPIC_MODEL`), and only where no settings
  file names a model.
- Stopping a shell session also closes the `mend shell` terminals opened beside it. Its own shell
  counted as an agent the Stop had ended, so the other shells stayed `running` and held the session
  `idle` until each was stopped by hand. A Stop that ends an agent Mend started still keeps your
  shells. A `mend shell` row now records the person it runs as.
