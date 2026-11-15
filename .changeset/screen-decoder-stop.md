---
"@sealant/mend": patch
---

Leaving a screen while it changes can no longer crash the Mend server. Screen frames are decoded on
threads of their own, and the server used to kill a thread when its viewer left, when a relay ended
or when a frame took too long. Killed at the wrong moment, inside Node's zlib, the thread took the
whole server down with it (`close before init`). A thread now finishes the frame it is on and exits.
A frame that runs past its two-second deadline still ends the screen's connection then, and its
thread exits as soon as that frame is done. Screens decode exactly as fast as before.
