---
"@sealant/mend": minor
---

Workspaces carry `bun` and `unzip` by default. New installs list both in the default workspace
packages, and migration 0127 adds them to every saved managed family environment that lacks them:
the instance's, each organization's and each project's own. A custom base environment is left as it
is. Each project's image rebuilds once, on its next launch, and grows by about 80 MB. Standby
workspaces from before are replaced, since their image no longer matches. pstack needs bun for
`orch`, `watch-pr` and `ship-pr`. The machine scan under Suggestions from this machine also offers
`bun` and `unzip`.
