---
"@sealant/mend": patch
---

New projects on Boat start with Docker inside the workspace turned on, as on Docker. A Boat session
runs `docker run`, `docker build` and `docker compose` in its VM, with images from Docker Hub
directly. Mend no longer turns a Boat Docker refusal into "Boat does not support it". A refusal from
Sealant reads `launch refused · Docker · …` on every runtime. Existing projects keep their
environments. This needs the Sealant release with Docker on Boat (sealant-sh/sealant Boat stack).
