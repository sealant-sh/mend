---
"@sealant/mend": patch
---

A seal now stands only while no upload URL of any epoch its objects live under could replace one,
including packs it carries from an earlier epoch. Migration 0092 records those epochs on the seal.
Once a seal is recorded, no epoch gets a URL for an object it names. A request for upload URLs that
waited past its epoch's end records nothing and mints nothing.

Saving what an executor already holds is never refused for the byte quota. That covers a draining,
kept or recovering executor's uploads and registers, and every `final` capture's register. The byte
ledger is now per executor launch, so a new executor starts with its own budget.

A drain's FINAL answer reads saved only when the executor's recorded evidence does. That is the same
decision seals and executor ends use. A delayed `complete` no longer logs `saved` or stops an
executor whose evidence still holds an unsaved answer made after it, or one that cannot be ordered
against it.

Mend reads sealantd round 10's stores: the `wide_times` manifest feature (modification times before
1677 or after 2262, kept exactly and handed only to executors that read them), linked worktree admin
under `.git/worktrees/`, and the extra git pack of nested-repository objects.
