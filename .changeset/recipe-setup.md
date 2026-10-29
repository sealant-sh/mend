---
"@sealant/mend": minor
---

`mend.toml` takes a `[setup]` table: `run`, shell commands a recipe start runs first, in order, at
the repository root, and `inputs`, files whose contents decide when they run again. Setup runs
before `depends` and the Service, as the person the Service runs as, once per worktree directory (or
per workspace in a captured one) and fingerprint: a done stamp skips it, and a changed step or input
runs it again. Two sessions never run it in one directory at once. A failing step stops the start
with the step, its exit code and the end of its output; your next start runs it again, a start Mend
makes on its own does not. A Stop during setup ends it. A bad `[setup]` refuses no recipe: a
person's start goes on without it and says so, an automatic one is refused. A restored workspace
runs setup at its first start; nothing is shared across workspaces yet. `mend service run --wait`
shows setup's steps, and `mend service init` writes a `[setup]` from the root's lockfile. Mend 0.37
is the first server that reads `[setup]`.
