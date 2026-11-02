---
"@sealant/mend": patch
---

An npm project with no lockfile installs with `npm install --no-package-lock`, so a session's first
turn no longer shows a `package-lock.json` the agent never touched, and a landing no longer pushes
one. The npm mirror still serves that install.
