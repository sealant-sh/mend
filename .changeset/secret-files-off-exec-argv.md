---
"@sealant/mend": patch
---

Secret files and the pi profile no longer pass through the platform's exec arguments, which Sealant
Core stores in plaintext and never deletes. A launch now puts a single-use pickup ticket in the exec
instead. The ticket expires after 30 seconds and is bound to the session, its owner and the
executor's launch. The same exec redeems it over the session channel and writes the bytes straight
into the 0600 file. Delivery still takes one exec, or fewer when a file is over 90 KB, plus one
round trip from the workspace to Mend inside it.

Files delivered before this release are still stored in Core's database. Core needs to purge them
(see PLATFORM-FEEDBACK.md); until it does, treat those credentials as exposed and rotate them.

Adding a repository to a session no longer puts a password from an adopted
`https://user:token@host/…` origin in the clone's arguments or in the log. The clone asks without
it, as the workspace's remotes already do.
