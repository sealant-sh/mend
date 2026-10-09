---
"@sealant/mend": patch
---

A person's second session in their own live executor no longer delivers their agent memory again
when it is already there as stored: the one record read a person's start makes anyway now also says
which delivered files are in place, and an unchanged memory stages and runs nothing. A memory
changed since, a file gone, or a file left as the session had it is delivered as before. Codex's
summary database read back untouched is taken as delivered instead of consolidated again, which
saved a new version of it at every read-back and rewrote it at the next start. On the box a
same-person join spent about 540 ms on the memory step (delivery 820 ms against 228 ms shared).
