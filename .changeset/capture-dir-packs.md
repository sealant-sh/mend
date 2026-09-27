---
"@sealant/mend": minor
---

Mend reads and registers captures whose directories travel in dir packs (sealantd's capture manifest
format 2): a pnpm `node_modules` that was about 20,000 uploads, one per directory, is now a few
packs to upload and a few to restore. `plan.get` tells executors they may write it
(`manifest_format: 2`); `MEND_CAPTURE_MANIFEST_FORMAT=1` tells them to go back to one object per
directory. Captures already written one object per directory keep restoring, and so does a capture
that holds one section of each. Register checks, prices and records dir packs like any pack;
retention keeps them; the dependency cache promotes them.

Retention also stops removing the directories below a live capture's older-format section once its
epoch is fenced. It kept only that section's root, so when a head moved to a new executor and
carried its bulk section along, the bulk tree's directories were swept once the head had stood for
the 30-minute grace.
