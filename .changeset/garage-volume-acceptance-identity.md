---
"@sealant/mend": patch
---

The packaged-server acceptance catches up with captures everywhere (decision 8): `mend-garage` is
the third external, ownership-labelled volume, the way `mend server setup` claims it — v0.27.0's
release run refused the volume as unproven and leaked it at cleanup — and the session stage no
longer looks for a workspace that mounts the store. A capture executor mounts nothing from
`mend-store` (a store mount is now the failure), the session's change is observed from a registered
capture (n ≥ 1), and the engine's `capture flush · completed · observed` report is required when the
run ends. The CLI's setup, upgrade and start carry regression tests for the bucket's volume: a fresh
install labels all three, an upgrade from a generation without Garage claims it under the unchanged
identity, and a foreign `mend-garage` is refused with the same message as a foreign store or control
volume.
