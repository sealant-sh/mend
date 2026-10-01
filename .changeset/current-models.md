---
"@sealant/mend": patch
---

The model lists are current. Claude is offered by family alias (`fable`, `opus`, `sonnet`, `haiku`),
which Claude Code resolves to the latest model of each family, so the list no longer goes stale; a
Claude session with no model chosen now runs the latest Fable instead of Fable 5. Codex lists what
`codex debug models` offers today, GPT-6.1 Sol first, and gains its `ultra` effort. Every picker
offers only the efforts the chosen model takes, and a launch turns an effort the model cannot take
into the highest it can. A saved model that is no longer listed reads as the default.
