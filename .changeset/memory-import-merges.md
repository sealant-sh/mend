---
"@sealant/mend": minor
---

`mend memory import` now combines a machine's memory with Mend's instead of leaving every file that
differs. A file both sides have is merged keeping both sides' lines: `MEMORY.md` keeps each line
once, and a note's frontmatter is merged key by key, with the machine's differing value kept as a
comment. Mend remembers what it imported from each checkout on each machine. The next import from
there takes whichever side changed since, merges only what both changed, and does not bring back a
file removed in Mend. Codex's summary databases are merged by conversation. `--dry-run` now shows
the server's plan for each file. Every version an import replaces is kept.
