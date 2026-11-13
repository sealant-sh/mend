---
"@sealant/mend": minor
---

An organization's owner can connect the organization's own Boat key, and its new Boat sessions then
run in, and are billed to, that Boat account instead of the server's. Sealant holds the key sealed;
Mend keeps only which Sealant Boat account is the organization's. `GET /api/organization/boat-key`
says whether there is one (members see only that), and owners connect or replace it with `PUT`, ask
Sealant what it holds with `POST /api/organization/boat-key/check`, and remove it with `DELETE`.
Replacing a key with one that cannot see the account's VMs, or removing it while the account still
has VMs, is refused with Sealant's counts and what to do. Connect, replace and remove appear in the
organization's audit log, never the key. Standby workspaces move to the new account. A session that
is running stays in the account it started in; its next start uses the key the organization has
then.
