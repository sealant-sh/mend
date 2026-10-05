---
"@sealant/mend": patch
---

The t3code gateway's state file is readable only by the gateway's own user. It holds every paired
person's Mend device token, which the gateway must keep usable to call Mend for them, so it is now
created `0600` in a `0700` directory, and an existing file and its SQLite `-wal` and `-shm` are
narrowed to `0600` on open. Pairing claims now carry the client's address to Mend, so one client's
failed codes no longer use up every client's limit, and a client Mend rate limits gets
`429 Too Many Requests` with Mend's `retry-after` instead of being told its code is invalid. The
code is not spent.
