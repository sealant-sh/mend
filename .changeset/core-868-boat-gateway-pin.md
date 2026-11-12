---
"@sealant/mend": patch
---

Update the bundled Sealant Core SDK and images to 0.40.0-next.868.

- **Boat project resources work after an upgrade.** The bundle now carries Boat's resource gateway
  image, so `mend server setup --boat-resources` works on a `-next` install without building that
  image by hand.
- **Nix workspace images build again.** Core created no `/usr/local/bin` before installing Doppler,
  and `nixos/nix` doesn't ship one, so every Nix build stopped at that step.
- **Boat ledger tables are dropped.** A new install no longer creates Boat's three old ledger tables
  (`boat_allocations`, `boat_executions` and `boat_observations`). An existing server drops them on
  upgrade, which deletes their old rows for good: a database backup from before the upgrade is the
  only copy. Boat runs have lived in one row per run since 0.40.0-next.863, so no Boat run or
  session is affected.
- **Core can hold a Boat key per organization.** Core stores more than one Boat key, and each Boat
  run stays on the account it was created under. Mend doesn't use this yet: every session still runs
  on the install's own key.
