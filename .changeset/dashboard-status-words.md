---
"@sealant/mend": patch
---

The dashboard says what each session is doing, in words that make sense:
- A starting session names where its launch stands (`booting`, `preparing the workspace`, `waiting
  for the previous save`), not a bare age.
- A live one says `up 4m` from its agent's own start, and a settled one `ended 5m ago`.
- A worktree says `starting` or `stopping` where it said `running` or `settled`.
- A save with nothing queued reads `saving · no uploads pending`, not `saving · 0 B left`.
- A stopping session with no save to report says `workspace end not confirmed`, is never hidden,
  and ⇧K no longer offers to stop Services it does not have.
