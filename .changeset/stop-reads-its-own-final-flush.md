---
"@sealant/mend": patch
---

A Stop made while a status read was on its way makes one final flush and reads `stopped`. The
person's view asks for the executor's status as they press Stop; the executor answered it during
Mend's own final flush, and the answer arrived after the final one. The drain could not decide on
evidence with an answer still unpublished, so it asked for a second final flush (5.1 s on the box),
and the late `in-progress` answer read as a final flush made outside Mend, so the session said
`stopped outside Mend · saved at …`. The drain now waits for that answer, and an `in-progress`
answer during Mend's own final flush is Mend's.
