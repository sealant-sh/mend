---
"@sealant/mend": patch
---

The Dependencies card and the docs no longer say a cold launch reads the project's shared dependency
cache. Only standby workspaces start from it; a cold launch restores the session's saved state and
runs the install command when that has no tree for its platform.
