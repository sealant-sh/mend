---
"@sealant/mend": minor
---

`mend.toml` takes a `[setup]` table: `run`, shell commands a recipe start runs first, in order, at
the repository root, and `inputs`, files whose contents decide when they run again. Setup runs
before `depends` and the Service, as the person the Service runs as and with the same identity, once
per worktree (or per workspace in a captured one) and fingerprint: a done stamp skips it, and a
changed step, input or workspace image runs it again; `mend service run <name> --setup` runs it
anyway. One start at a time runs it in one place, and a run whose claim lapsed is stopped before
another starts there. An input is read only as a regular file inside the repository, as the person
in a captured workspace, and only its hash is kept. A failing step, or one past 30 minutes, stops
the start with the step and the end of its output; your next start runs it again, a start Mend makes
on its own does not. A Stop during setup ends it, `mend service stop <name>` included before the
Service exists. A bad `[setup]` refuses no recipe: a person's start goes on without it and says so,
an automatic one is refused. A restored workspace runs setup at its first start; nothing is shared
across workspaces yet. `mend service run --wait` shows setup's steps, and `mend service init` writes
a `[setup]` from the root's lockfile. Mend 0.37 is the first server that reads `[setup]`.
