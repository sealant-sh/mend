---
"@sealant/mend": patch
---

The packaged-server acceptance treats `mend-garage` as the third external, ownership-labelled
volume, the way `mend server setup` claims it: v0.27.0's release run refused the volume as unproven
and leaked it at cleanup. The CLI's setup, upgrade and start now carry regression tests for the
bucket's volume: a fresh install labels all three, an upgrade from a generation without Garage
claims it under the unchanged identity, and a foreign `mend-garage` is refused with the same message
as a foreign store or control volume.
