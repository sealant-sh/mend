---
"@sealant/mend": minor
---

A Stop on Garage, the bucket `mend server setup` installs, no longer waits about 10 minutes for its
final save to seal. With a sealantd that sends the bytes' SHA-256, every upload link is bound to the
bytes it was minted for: Garage refuses any others through it, so the link can replace nothing, and
the seal stands as soon as the save is verified. An executor whose sealantd predates this keeps the
wait, and the first 15 minutes after a Mend restart still wait.
