---
"@sealant/mend": patch
---

On a session page, `Ask before acting`, Fast and a model picked in the composer's menu now hold for
every later message, as the menu shows. Before, only the first message after a pick went with it:
the next ran on the agent's launch choice, so with `Ask before acting` still ticked the agent ran
commands without asking.
