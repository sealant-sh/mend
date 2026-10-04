---
"@sealant/mend": minor
---

A project's install command is now an "Automatic install" switch on its Setup page, on for every
project. On, Mend picks the command from the lockfile at the root of the repository and runs it
before the agent starts; the card shows what it detects on the default branch, for example
"detected: pnpm install --frozen-lockfile from pnpm-lock.yaml". A custom command still replaces the
detected one. Off, Mend runs no install for the project, in a session or in the install that fills
the shared dependency cache, and the agent installs when it needs to. A dependency tree already in
saved state or the shared cache is restored either way. `PUT /api/projects/:id/install-enabled` sets
it and `GET /api/projects/:id/install-detection` reads the detected command. Migration 0110 adds the
column.
