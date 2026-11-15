---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.894, which runs workspaces on sealantd
0.21.0-next.187.

- **A session's start survives one dropped connection while its workspace boots.** About twice in
  150 Boat launches, a session failed to start with "capture plan.get failed: transport: io:
  unexpected end of file", and starting it again worked. sealantd now asks again, waiting 0.25 s,
  0.5 s, 1 s, 2 s and then 4 s between tries, and gives up about 20 seconds after the first failure.
  If it still fails, the error says how many times it tried and for how long. A connection that
  hangs before it drops is asked again too, from sealant 0.40.0-next.918 on (see that entry).
- **Every workspace image is built once more.** The workspace runtime changed, so after the upgrade
  the first session in each project on Boat waits for its image to be built again, as long as a
  first build takes. On Docker and Kubernetes, each blueprint's image is built again once; the steps
  before the runtime's own layer can still come from the build cache. Running workspaces keep the
  runtime they started with until their image is rebuilt. On Boat, the old images keep their saved
  snapshot slots until sealant's hourly pass removes them, a day after each was last used.
- **A terminal opened more than once stays live in each.** Terminal output now keeps reaching every
  attach to one session.
- **A refusal for a malformed request never repeats what the request held.** No refusal did so
  before, but the guard meant to prevent it had not worked since sealant 0.39.0. A few refusals for
  unusual malformed requests now read "is invalid" in place of a check's own words.
