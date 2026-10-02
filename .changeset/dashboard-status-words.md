---
"@sealant/mend": patch
---

The dashboard says what each session is doing in words that make sense:

- a starting session names where its launch stands (`booting`, `preparing the workspace`,
  `waiting for the previous save`) instead of a bare age;
- a live one says `up 4m`, a settled one `ended 5m ago`;
- a worktree says `starting` or `stopping` instead of `running` or `settled`;
- a save with nothing left to upload reads `uploaded · confirming the save`, not
  `saving · 0 B left`;
- after the agent ends, `agent ended · workspace still up` until the save begins.
