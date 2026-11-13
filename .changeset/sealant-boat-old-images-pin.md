---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.892.

- **Boat images made before the wallet upgrade are removed again.** On a server whose Boat key can
  bill more than one wallet, sealant 0.40.0-next.880 kept every saved image it had made before the
  upgrade, for good, and listed images as ones it could not reach that Boat had already deleted.
  sealant now records each such image in the wallet the key bills, and removes it at the first
  hourly pass after nothing can start from it and a day has passed since it was last used
  (`SEALANT_BOAT_IMAGE_MIN_AGE_HOURS`, counted from the last use, not from when it was made). The
  list of what sealant cannot reach clears by itself of everything Boat no longer holds, and what
  stays on it is mostly the work of a key without `account.read`. The Boat page, `mend boat status`,
  `mend doctor` and the instance page now say that, and say that replacing the key with one made
  with `account.read` is what clears the list.
- **A full check's leftover VM is found in any wallet.** sealant looks for it in every wallet the
  key can bill, not only the active one, and deletes it.
- **Stopping a session as its first Boat VM is created no longer leaves a VM billing.** A stop in
  the second the first VM was being created could leave a VM that sealant forgot and Boat kept
  billing.
- **Two commands that overlap in one session each get their own output.** One of them could be
  handed sealant's own reading of the working tree instead. In Mend this showed up as a session
  start that failed with "the home's record does not unseal".
