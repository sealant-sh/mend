---
"@sealant/mend": patch
---

A Stop on a self-hosted (Garage) bucket no longer waits on Mend:

- A restart of Mend holds no Stop. Before, every Stop in the 20 minutes after a start waited them
  out. The first start after this upgrade still does, once.
- After a restart Mend still knows what a running session's executor can do. Before, it fell back to
  plain upload links for it, and that session's Stop waited 10.5 minutes.
- Mend reads a save back once. Before, it read every pack to check it and then read every pack again
  to accept the seal.
- Packs are checked on worker threads, up to eight at a time, starting when they arrive instead of
  when the session stops.
- One upload bound to its bytes now carries an object up to 5 GB.
