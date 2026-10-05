---
"@sealant/mend": patch
---

`mend repo add` no longer adds a private project to a session whose worktree other people can open.
A repository's files and history are saved with the session's worktree, so a private project added
to a session in a shared project reached every member who opened that worktree. A private project
can now be added only from a session in another private project of yours. The refusal says why, and
`mend repo projects` no longer lists it elsewhere.
