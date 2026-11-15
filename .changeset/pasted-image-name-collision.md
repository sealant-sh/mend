---
"@sealant/mend": patch
---

Two images stored in the same second no longer lose one to a name clash. A pasted image, or a Slack
turn's screenshot, is named after the second it arrived and four random hex digits; when another
image already has that name, Mend now picks new digits and stores it, instead of leaving it out of
the turn as "not attached · Mend could not store the file".
