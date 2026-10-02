---
"@sealant/mend": minor
---

A Stop on Garage, the bucket `mend server setup` installs, no longer waits about 10 minutes for its
upload links to expire before its final save seals. With a sealantd that sends the bytes' SHA-256,
every upload link is bound to the bytes it was minted for: Garage refuses any others through it, so
the link can replace nothing, and the seal stands once the save is read back. An executor whose
sealantd predates this, a Stop that uploaded an object of 16 MB or more, and the first 20 minutes
after Mend starts still wait.
