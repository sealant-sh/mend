---
"@sealant/mend": patch
---

Removing an organization's Boat key no longer waits on the standby workspaces Mend keeps for hot
sessions. `mend boat disconnect` and `DELETE /api/organization/boat-key` first stop the standbys
Mend started in that Boat account, keep new ones out of it, and then ask Sealant to remove it. The
answer says how many standbys were stopped (`removal.standbysDrained`, also in the audit log entry),
and the standbys warm again where the organization's sessions run now. A removal is refused only
while a session's VM or an image build still holds the account, with that count; nothing changes
then, and the standbys warm again in the account. Two removals at once are done once: the second
reports no removal of its own.
