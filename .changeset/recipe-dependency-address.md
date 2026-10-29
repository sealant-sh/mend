---
"@sealant/mend": minor
---

A recipe Service gets each of its `depends` as `MEND_SERVICE_<NAME>_HOST` and
`MEND_SERVICE_<NAME>_PORT`: where that dependency answers inside the workspace, `127.0.0.1` or, for
an `address = "docker"` one, the host Mend reaches it on. `<NAME>` is the recipe name upper-cased,
each character outside `A-Z0-9` an `_`; two dependencies that give the same names refuse the recipe,
and a recipe's `env` cannot set them. They are worked out again at every start and restart and never
recorded with the attempt.
