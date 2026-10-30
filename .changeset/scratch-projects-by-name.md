---
"@sealant/mend": minor
---

Create private projects without a source using `POST /api/projects/new` and reuse one private
scratch project per person using `POST /api/projects/scratch`. Both start with a README commit on
`main` under the creator's Git author, its name written as git stores it (the email's local part,
then `person`, when git keeps none of it). T3 Code now offers New project and No project, publishes
created projects before answering, and starts each new scratch thread in a separate worktree. Client
paths remain unavailable as repository sources.
