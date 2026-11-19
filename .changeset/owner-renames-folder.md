---
"@sealant/mend": minor
---

An organization's owners can rename one of its folders (`PUT /api/organization/folders/:id/name`),
with the same name rules as creating one. The folder's files stay where they are, and projects keep
the mount name they chose for it. The audit log records the rename.
