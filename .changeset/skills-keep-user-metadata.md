---
"@sealant/mend": patch
---

A resume leaves a skill directory alone when its files already match the library. Mend used to
remove and rewrite it at every launch, so a script you made executable came back without its
executable bit, and empty directories and hard links you added were lost. A skill Mend replaces or
retires is deleted only when it is still exactly what Mend wrote, modes included; otherwise it is
moved, unchanged, to `/workspace/harness-home/.mend/skills-kept/`. Mend's note and Claude Code
settings writers no longer delete a file that happens to have their temporary file's name.
