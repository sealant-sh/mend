---
"@sealant/mend": minor
---

A recipe now has a digest: a hash of its command, `cwd`, `env`, each dependency's own digest and the
`[setup]` it runs, never its port, `ready`, `host`, `address` or `browserScheme`.
`GET /sessions/:id/declarations` shows each recipe's digest. An executor replacement starts each
recipe again as the person who last started it.
