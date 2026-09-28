---
"@sealant/mend": patch
---

A resume keeps what you and the agent wrote in the harness's memory files. Mend's note in
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` used to run from a `<!-- mend:mounts -->` line to the
end of the file, and every launch cut the file there, so instructions added below the note were lost
at the next resume. The note is now a block between two marker lines, and a launch replaces only
that block. An old note becomes the block when it is exactly what Mend wrote; an edited one is left
in place and the block is added after it. A file Mend cannot read is left alone. Three other launch
writes no longer replace your files: Claude Code's `settings.json` and `~/.claude.json` are only
merged into when they parse, Codex's trust table starts on its own line in `config.toml`, and a
skill directory that differs from what Mend delivered is moved to
`/workspace/harness-home/.mend/skills-kept/` instead of being deleted.
