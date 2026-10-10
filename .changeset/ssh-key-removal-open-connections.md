---
"@sealant/mend": patch
---

Removing a workspace SSH key (`mend ssh keys remove`, Settings → Workspace SSH) says what happens to
the connections already open with it. With the Sealant this release pins (0.39), they end within a
minute. Against an older Sealant they stay open until you stop your running sessions, and the
removal lists those sessions: the CLI prints `mend stop` for each, and Settings offers to stop them
all after a confirmation. The published SSH port now has limits before login (sealant#359), and the
docs describe them.
