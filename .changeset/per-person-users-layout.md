---
"@sealant/mend": patch
---

A Codex conversation that is resumed and whose thread Codex cannot find now fails the turn with
"Codex could not find this conversation's thread. Nothing was sent." Before, Mend quietly started a
new, empty thread under the same session, so the next turn went to a conversation with no history.

Behind `MEND_HARNESS_LAYOUT=person`, which is off by default, the first part of per-person harness
homes (ADR 0016) is in: each person gets a Linux user and saved directory, a worktree that has run
per person stays that way, and a launch the image cannot serve is refused with the reason. With the
flag off, sessions run exactly as before.
