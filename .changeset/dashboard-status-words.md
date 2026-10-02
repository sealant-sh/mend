---
"@sealant/mend": patch
---

The dashboard says what each session is doing:

- A starting session names its launch phase, such as `booting`, `preparing the workspace` or
  `waiting for the previous save`, instead of a bare age.
- A live session reads `up 4m` from its agent's own start, and a settled one `ended 5m ago`.
- A worktree reads `starting` or `stopping` where it read `running` or `settled`.
- A save with nothing queued reads `saving · no uploads pending`, not `saving · 0 B left`.
- A stopping session with no save to report reads `workspace end not confirmed`. It is never hidden,
  and ⇧K no longer offers to stop Services it does not have.
- Footer messages use `·` between facts, not em dashes.
