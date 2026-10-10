---
"@sealant/mend": minor
---

A session's dependency install goes through the server's npm mirror (`MEND_NPM_MIRROR_URL`, which
`mend server setup` sets): a plain `pnpm install`, `npm ci` or `npm install` gets
`--registry=<mirror>` when the package manager, asked in the project as the person who runs the
install (`npm config list` and `<pm> config get registry`, each bounded at 15 s), reports the public
registry and no login for it; when no config file or variable the install script reads, nor a
`pnpm-workspace.yaml` in the project or above it, sets a registry; when every flag the command
passes is one that cannot choose its own configuration; and when the mirror answers its ping. Scoped
registries and their logins are untouched. A run through the mirror that fails, for any reason, runs
once more as written, against the registry itself, and the engine logs
`dependency install · retried without the npm mirror`. The public exposure gate's `core-private`
item names the mirrors when sessions are pointed at them.
