---
"@sealant/mend": patch
---

A second person can now join a live session's worktree. On a server with more than one person, the
join used to wait about 30 minutes on a session line that read "the previous session in this
worktree is not answering", then failed with "worktree leased". Mend asked Sealant about the first
person's workspace as the second person, and Sealant only answers the person who created a
workspace. Now every request about a workspace is made as the person who created it, for anyone who
may work there: they have a session in that worktree, are still a member of the organization, and
can see the project. A joiner's terminal, shells, Services, added repositories, checkpoints and
process logs reach the shared workspace too. A person who lost access is still refused. Starting a
workspace and using inference still run on your own account, and a harness run through Sealant is
only ever started by the workspace's creator. If the platform answers that it cannot find a running
session's workspace, the session line now says that instead of "not answering", and the log records
Sealant's answer.

Known limit: with the per-person layout off (the default), every process in a workspace runs on the
logins of the person who started the workspace. A joiner's agent therefore runs on that person's
Claude or Codex login, and a conversation records its turns as billed to them. The per-person layout
(`MEND_HARNESS_LAYOUT=person`, ADR 0016) is what will run each person's processes on their own
logins.
