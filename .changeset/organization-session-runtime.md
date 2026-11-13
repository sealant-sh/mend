---
"@sealant/mend": minor
---

Each organization chooses where its new sessions run. The operator declares where sessions may run
on the server with `mend server setup --session-runtimes docker,boat` (`MEND_SESSION_RUNTIMES`), and
`--session-runtime` names what an organization gets until it chooses. An organization's owner picks
this server's Docker or Boat in Settings · Organization · Defaults; members see the choice, and the
audit log records each change. New worktrees use the organization's choice; existing worktrees keep
the runtime they were created with. A server set up before this change offers the one runtime it had
and behaves as it did. New projects created in an organization on Boat start on Ubuntu, the hot pool
warms standbys for the organization's runtime, and the host's user-namespace check runs whenever the
server offers Docker sessions.
