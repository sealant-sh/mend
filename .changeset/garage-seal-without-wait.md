---
"@sealant/mend": minor
---

A Stop on Garage, the bucket `mend server setup` installs, no longer waits for its upload links to
expire before its final save seals. Before, every such Stop waited about 10 minutes, longer after a
large upload. Workspaces now send each upload's SHA-256 (sealantd 0.20), and Mend binds every upload
link to the bytes it was minted for: Garage refuses any others through it, so a link can replace
nothing, and the seal stands once the save is read back. An object up to 5 GB goes up as one bound
upload instead of in parts. A restart of Mend holds no Stop. Mend reads a save back once, and checks
packs on worker threads, up to eight at a time, as they arrive rather than when the session stops. A
Stop still waits for an object over 5 GB, for an executor whose sealantd does not send SHA-256 (one
started before the upgrade), and in the 20 minutes after the first start that follows this upgrade.
