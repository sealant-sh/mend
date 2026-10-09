---
"@sealant/mend": patch
---

A dependency install that Mend runs with pnpm no longer waits about 70 s on one stalled registry
download. It gives up on a silent connection after 15 s instead of 60 s, and waits 2 s before the
first retry instead of 10 s, so a stall now costs about 17 s. A tarball that keeps arriving, however
slowly, still downloads in full. pnpm's update check is off for that install. If the shortened
install fails after reporting retries, for example behind a proxy that always takes longer than 15 s
to answer, Mend runs the command once more with pnpm's defaults and logs
`dependency install · retried with defaults`. Settings already in place take precedence: in the
command itself, the project's `.npmrc` or `pnpm-workspace.yaml`, your user config (`~/.npmrc` or
`NPM_CONFIG_USERCONFIG`) or pnpm config, the image's global `npmrc`, or the environment. Other
package managers and custom commands that are more than a plain `pnpm install` run as written. The
engine's install line now ends with the number of download retries pnpm reported:
`dependency install · completed · exit 0 · fetch retries 2`.
