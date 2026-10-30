---
"@sealant/mend": minor
---

Send steers your running turn by default. A message you send while your own turn runs goes into that
turn; otherwise, or with the setting off, it starts your next turn. `mend message <session> <text>`
sends one message that way and prints what Mend observed. `mend settings` shows your settings, and
`mend settings send-steers on|off` changes the one that decides it.
