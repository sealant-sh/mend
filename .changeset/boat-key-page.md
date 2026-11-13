---
"@sealant/mend": minor
---

Organization settings have a Boat page. An owner connects the organization's own Boat key there: the
page shows the Boat command that creates a key with the permissions Sealant needs, for a Boat
organization or a personal account, and one key field with Check and connect. The key is never shown
again. Once connected, the page says who connected it and when, and has Check now, Replace key and
Remove. Refusals read as sentences that say what to do. Members see only whether the organization
has its own key. The page lists what Sealant observed about the key (who it is, the wallet it bills,
whether it can start a VM, saved snapshot slots, permissions and expiry) and warns from fourteen
days before the key expires, once this server's Sealant reports those facts. Until then it says they
have not been observed yet. `GET /api/organization/boat-key` gains `details.report` for owners, null
for now.
