---
"@sealant/mend": patch
---

A dependency install that Mend runs with pnpm no longer waits about 70 s on one stalled registry
download. It gives up on a silent connection after 15 s instead of 60 s, and waits 2 s before the
first retry instead of 10 s, so a stall now costs about 17 s. A tarball that keeps arriving, however
slowly, still downloads in full. pnpm's update check is off for that install. Settings in the
project's `.npmrc` or `pnpm-workspace.yaml`, your own `~/.npmrc` or pnpm config, or the environment
take precedence. Other package managers and custom commands that are more than a plain
`pnpm install` run as written. The engine's install line now ends with the number of retried or
stalled downloads the output reported: `dependency install · completed · exit 0 · fetch retries 2`.
