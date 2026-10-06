---
"@sealant/mend": patch
---

Sessions start faster: Mend now sees each command it runs in a workspace end within about 25 ms,
where it could wait a few hundred, and a launch runs about twenty of them. The built-in workspace
images now install fixed harness versions (Claude Code 2.1.292, Codex 0.160.1, opencode 1.18.34 and
pi 1.0.4), so rebuilding an image no longer changes which version a session runs.
