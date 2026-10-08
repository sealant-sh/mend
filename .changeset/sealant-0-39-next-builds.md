---
"@sealant/mend": patch
---

The bundle now runs Sealant 0.39.0-next.707, whose workspaces run sealantd 0.20.0-next.154. In a
workspace that runs each person as their own user, a person who joins after it started now runs
there too, where 0.20.0-next.153 refused them. Sealant no longer stores the arguments a process or
terminal was started with, since they can carry secrets: a run's record shows the program and how
many arguments it had. Upgrading runs a one-time purge of the arguments already stored, before
Sealant starts. On a database the size of a small team's server it takes 15 to 45 seconds.
