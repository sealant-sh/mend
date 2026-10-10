---
"@sealant/mend": minor
---

One model picker, the same on every client, and the server owns the list. The models each harness
offers live in a table on the server, editable in place, and `GET /api/harnesses/models` hands every
client the same list with the default and the efforts each model takes. Claude is offered by family
alias (`fable`, `opus`, `sonnet`, `haiku`), which Claude Code resolves to the latest model of each
family; a Claude session with no model chosen runs the latest Fable instead of Fable 5. Codex lists
what `codex debug models` offers, GPT-6.1 Sol first and the default, and gains its `ultra` effort.
The web composer, the phone's session composer and the VS Code picks choose from it with the default
preselected; `mend models` prints it, and `--effort` takes `ultra` where the model does. Every
picker offers only the efforts the chosen model takes, a launch turns an effort the model cannot
take into the highest it can, and a saved model that is no longer listed reads as the default. Every
session records the model and effort it was started with: the session page, the phone's session
header and `mend sessions` show them.
