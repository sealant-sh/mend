---
"@sealant/mend": patch
---

Update the bundled Sealant Core SDK and images to 0.40.0-next.864. A new install no longer creates
Boat's three old ledger tables (`boat_allocations`, `boat_executions` and `boat_observations`). An
existing server drops them on upgrade, which removes their old rows for good: a database backup from
before the upgrade is the only copy. Boat runs have lived in one row per run since 0.40.0-next.863,
so no Boat run or session is affected.
