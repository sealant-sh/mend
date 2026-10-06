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
  way for a joiner while they can see the project and both people remain organization members.
  Otherwise Mend refuses it and says why.
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

Mend also checks access again at startup and every minute. A removed member's sessions are stopped,
and so is a session in someone else's workspace whose owner can no longer see the project. Each
one's line says why, and the organization's audit log records it. A session in your own workspace
keeps running when a project becomes private, as the setting says. Typing into an existing terminal
and restoring a running agent after a restart follow the same rules. A member who lost project
visibility can still watch their own terminal, but cannot type in it, and can always Stop their own
session, which saves their work. A Stop of one person's session in a shared executor no longer ends
anyone else's agent or the executor itself while someone else still works there.

A Stop wins over a replacement or relaunch that is saving the executor from the moment it is asked,
even while the platform is slow to close the agent: nothing starts on a new machine after it. A
refused Stop leaves a replacement or relaunch that is still saving as it was; if it finishes
meanwhile and ends the agent, the Stop counts as done and nothing starts after it. Its warning names
the process, survives a Mend restart, and clears once that process is observed ended. One failed
Stop does not interrupt the other sessions being stopped, and counts and audit entries report only
sessions whose processes ended.
