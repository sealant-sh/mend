---
"@sealant/mend": patch
---

A second person can now join a live session's worktree. On a server with more than one person, the
join used to wait about 30 minutes on a session line that read "the previous session in this
worktree is not answering", then failed with "worktree leased". Mend asked Sealant about the first
person's workspace as the second person, and Sealant only answers the person who created a
workspace. Now Mend asks about a workspace as the person who created it:

- Looking a workspace up, reading its records, saving it and ending its processes always work this
  way, whoever asks. So a check whether an executor still runs never mistakes "you may not see it"
  for "it is gone".
- Running anything in it (a terminal, a shell, a Service, a command, a repository clone) works this
  way only while both people are still members who can see the project. Otherwise Mend refuses it
  and says why.
- Starting a workspace and using inference still run on your own account. A harness run through
  Sealant is only started by the workspace's creator.

Removing a member now ends every agent, shell and Service of theirs, including in executors other
people started. Any executor they started is retired: the sessions of others working in it are
stopped with words telling them to start again in a workspace of their own, and it saves through the
normal Stop. If the platform does not close a process, Mend keeps it recorded as running, tries
again, and the session line says "could not be stopped · stop again". If the platform answers that
it cannot find a running session's workspace, the waiting line now says so instead of "not
answering", and the log records Sealant's answer.

Known limit: until per-person harness homes are on (`MEND_HARNESS_LAYOUT=person`, ADR 0016; off by
default), every process in an executor runs as root in the home of the person who started it. A
person who joins someone else's executor therefore:

- runs their agent on that person's Claude or Codex login, and a conversation records its turns as
  billed to them;
- gets root shells and Services in that person's home, which can read their Claude and Codex
  credential files and the executor's `GITHUB_TOKEN` and `GH_TOKEN`;
- signs `git push` and `git fetch` from the workspace as that person: their Mend key, or their
  machine in bridge mode. The push is recorded on their session. A repository the joiner adds is
  cloned the same way.

Landing a change is not affected. See Known issues in the docs.

Mend also checks access again at startup and every minute. Processes of anyone who can no longer
work in a project, removed or kept out of a project that went private, are ended, and so are the
executors their creators can no longer use. Typing into an existing terminal and restoring a running
agent after a restart are refused for them too. A Stop of one person's session in a shared executor
no longer ends anyone else's agent or the executor itself while someone else still works there.
