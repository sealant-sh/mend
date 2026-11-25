---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.941. The workspace runtime (sealantd
0.21.0-next.209) does not change.

- **A Boat image quarantined because Boat's saved snapshot changed now says which field changed.**
  When the server refuses a saved Boat image because Boat reports a different identity for it
  (`native-snapshot-identity-mismatch`), the server log names each field that differs, with the
  value sealant saved and the value Boat reported:
  `Boat image identity differs: publication <id> quarantined (native-snapshot-identity-mismatch); differences [...]`.
  What is refused, and the rebuild that follows, are unchanged.
