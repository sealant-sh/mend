---
"@sealant/mend": patch
---

A paired phone opens a session's preview (ADR 0017 delivery step 10c). `POST /previews/:id/open`
answers `{ url }`, the preview's `/__mend/auth` address with a single-use, thirty-second ticket
minted for the calling sign-in or device, under the same rules as `/preview-auth`: the caller sees
the project, the gateway is on, and the previews read gives the preview an Open. It refuses, with
words, a token that is neither a sign-in nor a paired device, previews off, and previews served at
`*.localhost`, which only the Mend machine reaches. Revoking the device ends the preview sign-in it
opened. `GET /worktrees/:id/previews` now also says how the gateway routes previews (`routing`). The
phone app's session screen shows a `Preview` action that opens the preview in its in-app browser,
and each preview's status line under the header.
