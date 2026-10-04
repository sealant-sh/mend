---
"@sealant/mend": patch
---

Agent memory is credited only to the person it belongs to. When someone joined another person's
running session in the same worktree, Mend read the memory in that shared executor back into the
joiner's account, so one person's memory could be saved as another's. Mend now records whose memory
an executor holds when it delivers it, and only that person's sessions read it back. What a joined
agent learns there goes into the executor owner's memory, not the joiner's.
