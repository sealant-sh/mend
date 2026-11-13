---
"@sealant/mend": patch
---

A person can connect a Boat key of their own, in Settings, Account, or with
`mend boat connect --mine`. The Boat sessions they start in their active organization then run in,
and are billed to, their own Boat account. A Boat session uses its owner's own key, else the
organization's, else the server's, and records which one decided when its workspace was created: the
session details in the web app ("Runs on") and `mend sessions` show it, and steering by someone else
never moves it. Only the person reads, checks, replaces or removes their own key
(`GET|PUT|DELETE /api/me/boat-key`, `POST /api/me/boat-key/check`; an access key cannot connect or
remove one). Owners see which members have their own key on the organization's Boat page and in
`mend boat status` (`peopleWithOwnKeys`), never its details. Mend keeps no standby workspace on a
person's own key. Removing it drains any standby there first and is refused with a count while a
session's VM holds the account, as removing the organization's key is. The create-key command for a
personal account now names `--org personal`, so Boat makes a personal key even when the Boat CLI's
active wallet is an organization.
