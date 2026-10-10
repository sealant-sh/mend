---
"@sealant/mend": patch
---

Three CLI fixes from the live pass. Running `mend pull` again on a session whose change has not moved
since the last pull now says `unchanged since the last pull · nothing moved` and leaves the branch
where it is. Before, Mend committed the checkpoint anew for each bundle, so the second pull was
refused as non-fast-forward. Mend still never force-updates a branch. `mend help adopt` prints its
whole page again: help pages no longer pass through the credential redactor, and in free text the
redactor now ends a URL's authority at whitespace unless a host and a path follow its last `@`, so
`file:// … git@github.com:acme/api.git` stays as written. `mend server` refusals (an unknown flag, no
server configured, a held lock) print just the refusal, without `Server storage operation failed:`,
a doubled period and filesystem advice that does not apply. The advice now follows only the
operating system's own failures.
