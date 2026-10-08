---
"@sealant/mend": patch
---

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, a worktree whose workspace started
before per-person homes is moved over without losing anything. Mend credits the memory saved in the
old shared home on the server: to the person the home's record names, else to the only person who
had sessions there, else to nobody, and the worktree lists what it credited to nobody. When the
worktree turns per person, it reads the old home's last capture once more and credits only what is
new. A live workspace that shares one home is replaced on its own once nothing would stop that
anyone would miss (no terminal session, shell, Service started by hand, agent turn, process Mend did
not start or running container) and only after its final save; until then it takes joins and turns
from its launcher only and says why. The change's owner can replace it sooner with "Replace this
workspace now", which lists what would stop. An opencode conversation from that shared home cannot
be resumed per person, and the session says so. With the flag off, nothing changes.
