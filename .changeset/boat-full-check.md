---
"@sealant/mend": minor
---

An owner can run a full check of the organization's Boat key from the Boat page or with
`mend boat check --full`.

- **It proves the key end to end.** Sealant starts the smallest VM in the key's Boat account, runs a
  command, publishes a port and saves a snapshot, then deletes both. The page says what it costs
  first: one VM start, about a minute, one saved snapshot slot for that minute.
- **Each step is shown** as passed, refused with Boat's reason, no answer, or not reached, with when
  it finished and whether everything it made was confirmed removed. It is the one way to show that a
  Boat organization's key, which cannot read its own permissions, can run sessions.
- **The result survives a closed tab.** Mend waits for Sealant on the server, and Sealant keeps the
  result on the account; the page reads it back and shows a check still running.
- **Replacing or removing the key while a check's leftovers are not yet removed** is refused with a
  sentence naming what Boat may still hold.
