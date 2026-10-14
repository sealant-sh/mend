---
"@sealant/mend": patch
---

A removed account's event stream waits its one-second grace for the `access` event after the
removal, however long the stream has been open. The grace used to count from the stream's opening,
so a page open for more than a second was cut off before it learned why and landed on a plain
sign-in.
