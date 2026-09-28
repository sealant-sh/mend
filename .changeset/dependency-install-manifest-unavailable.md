---
"@sealant/mend": patch
---

A resume no longer runs the dependency install when it cannot read the saved capture's manifest.
Before, one failed read (a 503 from the bucket) counted as "no dependency tree for this platform",
so `npm ci` ran over the restored `node_modules` and put a patched file back to the published bytes.
Now Mend installs only when the manifest it read has no tree for the executor's platform, or the
worktree has nothing saved yet. When the read fails, nothing is installed and the session says
`dependency install skipped · capture <n> manifest unavailable`. Run the install yourself if the
dependencies are missing.
