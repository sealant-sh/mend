---
"@sealant/mend": patch
---

`mend server setup` on a terminal now asks which Docker Mend runs in, on a fresh install where more
than one Docker engine answers (Docker Desktop beside OrbStack on one Mac, colima, Rancher Desktop,
a rootless Docker). It is the first question, before the host's kernel is read, since that is read
in the engine chosen. Each choice says what it is, its socket, and whether a Mend server or Mend's
volumes are already there; the current context is the answer in brackets, and the choice goes into
the printed command as `--context`. With one engine, setup says which it uses and asks nothing; a
context on another machine is listed, not offered. `--context` and `DOCKER_CONTEXT` skip the
question, and `--yes` or no terminal keeps the current context and names the others. A rerun keeps
the engine its data is in and says so: another engine is a new install, `mend uninstall --server`
and then `mend server setup` there.
