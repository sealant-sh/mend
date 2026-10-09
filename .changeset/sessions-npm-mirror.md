---
"@sealant/mend": minor
---

A session's dependency install goes through the server's npm mirror (`MEND_NPM_MIRROR_URL`, which
`mend server setup` sets): a plain `pnpm install`, `npm ci` or `npm install` gets
`--registry=<mirror>` when nobody set a registry (the command, the project's `.npmrc` or
`pnpm-workspace.yaml`, the person's config, the image, the environment), nobody set a login for
registry.npmjs.org, and the mirror answers its ping. Scoped registries and their logins are
untouched. A run that failed on the mirror runs again as written, against the registry itself, and
the engine logs `dependency install · retried without the npm mirror`. The public exposure gate's
`core-private` item names the mirrors when sessions are pointed at them.
