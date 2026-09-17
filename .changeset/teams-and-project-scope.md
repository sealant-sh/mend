---
"@sealant/mend": minor
---

Teams. A team is a named group of accounts on one Mend; owners manage the roster and mint single-use
invite links (`/join/<token>`, optionally bound to one email), members work in its projects. Every
project now has a scope — only you, one of your teams, or everyone on this Mend — and scope is what
every project-scoped route, the terminal, the Service tunnel, and the live event stream check; a
project outside your scope answers 404. Existing projects keep today's instance-wide visibility on
multi-account installs and become your personal projects on a single-account install. `mend adopt`
gains `--team <name>` and `--everyone`; the web app gains Teams, a join page, a "visible to" column
and picker on Projects, and a Sharing panel in project Setup.
