---
"@sealant/mend": minor
---

An organization's owners can now rename it with `PUT /api/organization/name` and a `name`. The name
follows the same rules as creating an organization, and each refusal has its own tag:
`OrganizationNameEmpty` and `OrganizationNameNotAllowed` (422), `OrganizationNameTaken` (409, any
letter case, across the server). A member is answered 404. The rename is recorded in the
organization's audit log as `organization.renamed`, the same entry the operator's rename writes.
