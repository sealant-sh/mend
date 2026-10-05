---
"@sealant/mend": minor
---

A project's install command is now an "Automatic install" switch in the Dependencies card on its
Setup page, on for every project. On, in capture mode, Mend picks the command from the lockfile at
the root of the repository and runs it before the agent starts. The card shows what it detects on
origin's default branch as last fetched, for example "detected · pnpm install --frozen-lockfile ·
from pnpm-lock.yaml on origin/main", and says "not read" when it could not read the tree. A custom
command still replaces the detected one. Off, Mend runs no install for the project, in a session or
in the install that fills the shared dependency cache; an agent can install by hand. A dependency
tree already in saved state or the shared cache is restored either way. In co-located mode Mend runs
no install, and the card says so. `PUT /api/projects/:id/install-enabled` sets the switch, and
queues the install only when it goes from off to on; `GET /api/projects/:id/install-detection` reads
the detected command. Migration 0110 adds the column.
