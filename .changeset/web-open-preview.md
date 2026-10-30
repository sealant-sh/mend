---
"@sealant/mend": patch
---

The web Services card's Open goes to the worktree's preview of that Service when the preview gateway
serves it (ADR 0017 delivery step 10b): a link to `/preview-auth`, which signs you in to the
preview's own address. An https Service and an adopted one keep their own address, and Open waits
until the card has read the worktree's previews. The preview's status line shows under the Service's
row and keeps its age current, the worktree's own line (such as
`preview not prepared · change not captured`) shows below the rows, and a preview that a sibling
session of the worktree runs gets a row of its own that says so. The card re-reads on each step of a
preview's preparation. `GET /worktrees/:id/previews` now also says, per preview, where it opens
(`open`), which Service and session it binds (`boundTo`) and its status as facts (`facts`), and
whether a start is under way (`starting`). With the gateway off, Open is the Service's own address,
as before.
