---
"@sealant/mend": minor
---

Add organization folders: directories Mend keeps under the store, which owners create and fill and
projects select to mount at `/workspace/home/<name>`, read-only unless chosen otherwise. They
replace host mounts for everyone but the operator of a single-organization install. Uploads are
capped at 1 MiB a file and 4 MiB a request, and paths never leave their folder. Project detail
reports whether this deployment mounts them at all (`mountDelivery`).
