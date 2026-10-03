---
"@sealant/mend": minor
---

Only a session's owner types in its terminal, even while control is shared. Attaching to a session
someone else owns prints "This session runs in a terminal. Only <owner> types here; they can
continue it as a conversation.", then streams the terminal without sending your keys or your
terminal's size; Ctrl+] or Ctrl+C detaches. `mend shell` in someone else's session is refused: a
shell is the owner's alone. `mend session share` says so in its help.
