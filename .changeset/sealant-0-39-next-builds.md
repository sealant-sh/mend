---
"@sealant/mend": patch
---

The bundle now runs Sealant 0.39.0-next.695, whose workspaces run sealantd 0.20.0-next.150. Sealant
no longer stores the arguments a process or terminal was started with, since they can carry secrets:
a run's record shows the program and how many arguments it had. Upgrading runs a one-time purge of
the arguments already stored, before Sealant starts. On a database the size of a small team's server
it takes 15 to 45 seconds.
