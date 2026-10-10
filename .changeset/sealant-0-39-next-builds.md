---
"@sealant/mend": patch
---

The bundle now runs Sealant 0.39.0-next.714, whose workspaces run sealantd 0.20.0-next.157. In a
workspace that runs each person as their own user, a person who joins after it started now runs
there too, where 0.20.0-next.153 refused them, and a second person's command no longer fails when
the same telemetry event reaches the record twice. Sealant no longer stores the arguments a process
or terminal was started with, since they can carry secrets: a run's record shows the program and how
many arguments it had. Upgrading runs a one-time purge of the arguments already stored, before
Sealant starts. On a database the size of a small team's server it takes 15 to 45 seconds.

A command's arguments may now be any string: empty, starting with whitespace or spanning lines. Only
the program must be trimmed. A request Sealant refuses says why without quoting what was sent. A
registry URL's user and password are sent as Basic auth and never printed, and what Sealant's API
observes is redacted unless it is known to be safe.

A workspace's SSH sessions, VS Code Remote-SSH included, can run as its owner's own Linux user, the
person their Sealant user is bound to; SFTP runs as that user too, and the Fedora and Ubuntu
workspace images now carry an `sftp-server`, with every sshd unit masked.
