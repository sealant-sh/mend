---
"@sealant/mend": minor
---

The Boat page and `mend boat` show what Boat says about the organization's Boat key.

- **Who the key is, the wallet it bills, and whether it can start a VM.** Settings, Organization,
  Boat lists each fact Sealant observed when it last checked the key: the Boat account, the wallet
  and the key's role in it, running and allowed VMs, saved snapshot slots, permissions and expiry. A
  fact Boat did not show is marked not observed, with Boat's reason. Opening the page reads the last
  report and does not ask Boat; **Check now**, connecting and replacing ask Boat again.
- **What needs doing, in one sentence each.** A key that expires within fourteen days, a missing
  permission, a wallet that cannot start a VM and full snapshot slots each say what to do.
- **A Boat organization's key says what it cannot show.** Boat does not show such a key its own
  permissions or expiry; the page says so and where to see them in Boat.
- **When Boat does not answer a check,** Mend says so and keeps the last report.
- **`mend boat status` and `mend boat check` print the same facts.**
- **The personal-account command names `--org personal`,** so the Boat CLI makes a personal key even
  when an organization is its active wallet.
