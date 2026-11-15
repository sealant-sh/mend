---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.918, which runs workspaces on sealantd
0.21.0-next.195.

- **A connection that hangs and then drops while a workspace boots is asked again.** With sealant
  0.40.0-next.894, a session could still fail to start with "capture plan.get failed after 1
  attempts over 30.0 s" when one ask for its plan hung for 30 seconds before the connection dropped
  (1 of 14 Boat starts on our last check), and starting it again worked. sealantd now gives each ask
  a time limit of its own (10 s, then 15 s, then 20 s) and makes at least three, so the hung ask is
  made again. If every ask fails, the start ends with "capture plan.get failed after N attempts over
  T s"; when each ask hangs to its limit, that is about 46 seconds after the first. An answer slower
  than its limit on all three asks now fails the start, where before one ask could wait 30 seconds.
- **The boot's reads from the capture store are retried.** After a dropped connection, a timeout or
  a server error, sealantd tries the same read up to four times before the boot fails.
- **Every workspace image is built once more.** The workspace runtime changed again, so after the
  upgrade the first session in each project on Boat waits for its image to be built again, as long
  as a first build takes. On Docker and Kubernetes, each blueprint's image is built again once; the
  steps before the runtime's own layer can still come from the build cache. A server upgraded
  straight from a build older than 0.40.0-next.894 builds each image once, not twice. On Boat, old
  images keep their saved snapshot slots until sealant's hourly pass removes them, a day after each
  was last used.
- **A resource reads stopped as soon as its stop returns.** sealant could read a resource that had
  just been stopped as still running until its next pass.
- **A stop on Boat in a project with resources finishes in one pass** when it meets the resource
  gateway's own work, where now and then it failed and was stopped a pass later.
