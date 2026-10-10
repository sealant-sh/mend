---
"@sealant/mend": patch
---

Three CLI fixes from the live pass. Pull, keep working, pull again now fast-forwards. Before, every
bundle committed the checkpoint anew on the agent's head, so any second `mend pull` was refused as
non-fast-forward, even with nothing new. The clone now records the commit each pull left
(`refs/mend/pulled/<branch>`). The next pull sends it (`GET /changes/:id/bundle?onto=<sha>`), and a
server that still holds that commit builds the new checkpoint on it and leaves it out of the bundle.
With nothing new, the branch stays and the CLI says `unchanged since the last pull · nothing moved`.
A branch that cannot fast-forward (you committed on it, or the server no longer holds the last pull)
is left as it is. The CLI says why, and `mend pull <session> --branch <name>` fetches into a new
branch instead. Mend never force-updates a branch. An older server ignores `onto` and bundles as
before. `mend help adopt` prints its whole page again: help pages, which quote no URL Mend was
given, no longer pass through the credential redactor. `mend server` refusals (an unknown flag, no
server configured, a held lock) print just the refusal, without `Server storage operation failed:`,
a doubled period and filesystem advice that does not apply. The advice now follows only the
operating system's own failures, and anything else under the lock reads as
`Server command failed unexpectedly`.
