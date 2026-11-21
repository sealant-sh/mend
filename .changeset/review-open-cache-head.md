---
"@sealant/mend": patch
---

Opening a review no longer fails now and then with `Could not access '<sha>'`.

Opening a review saves a checkpoint and reads the change straight away, while Mend counts the
change's files in the background. Both read the same copy of the project's Git history on the
server, and the count rewrote that copy's `HEAD` file in place. A read that started in that moment
found no repository and failed, so Review answered HTTP 422. Mend now replaces the file whole, so
every read sees a complete repository. Nothing recorded was affected: opening the review again
worked, and still does.
