---
"@sealant/mend": patch
---

A Boat session in one shared home starts when its owner has dotfiles turned on. Mend sent the
dotfiles with the workspace create as archives, which Boat refuses, so the session failed to start.
Mend now sends none on Boat when the session shares one home: it starts without them, and the
session reads `dotfiles · repo not applied` or `dotfiles · snapshot not applied` with the reason.
Sessions that run each person as their own user, the default, still apply them on Boat, and Docker
sessions are unchanged.
