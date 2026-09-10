---
"@sealant/mend": minor
---

First contact is now a three-step setup instead of a bare sign-in form. The web app asks the
instance whether any account exists (`GET /api/instance`, public): a fresh install opens on
registration and says so; one with accounts opens on sign-in. Registration asks for the password
twice, with a reveal on both fields, and continues to a second step (`/welcome`) that asks how the
account reaches its repositories — the Mend key is created before that page paints and shown with
where to add it, or the machine's ssh-agent bridge is chosen instead. The key's comment is now the
account's email rather than `mend@<host>`; existing keys are relabeled in place on the next
signed-in read (same key material, same fingerprint). The first-run checklist observes what it used
to guess: the CLI's sign-in (its token is a device of platform `cli`), connected accounts (with the
platform's own failure when it cannot be reached), paired phones, and git access — and every
observation updates live over the event stream when `mend login`, `mend connect`, `mend pair` or
`mend keys init` runs in a terminal, instead of waiting for a reload.
