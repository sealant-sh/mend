---
"@sealant/mend": patch
---

Ubuntu projects can now have a session screen on amd64. Chromium is the official
chromium-browser-snapshots build pinned to revision 1735811, with no automatic security updates
until the pin is bumped, tracked as SLNT-536. On arm64 Ubuntu, sealant refuses Chromium at image
planning.

The bundle also carries sealant's boat groundwork with boat off. There is nothing new to choose.
