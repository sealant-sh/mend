---
"@sealant/mend": patch
---

Two images stored in the same second no longer lose one to a name clash. A pasted image, or a Slack
turn's screenshot, is named after the second it arrived and a few random hex digits. Where the
session's files live in the workspace, the default, the name now ends in eight random hex digits
instead of four (`20261115-114621-3f9a07c2.png`), so two pastes in one second effectively never
share one. Where Mend keeps the session's files beside it, a name another image already has makes
Mend pick new digits and store it. Neither leaves the image out of the turn as "not attached · Mend
could not store the file".
