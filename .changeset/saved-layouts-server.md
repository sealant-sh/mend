---
"@sealant/mend": minor
---

Mend's server keeps each person's saved layouts of a workspace's tiles (ADR 0026, "Layouts"), for
the new web app's layout menu. A saved layout is the account's own and shows in every workspace.

- `GET /api/me/layouts` lists them, oldest first. `POST /api/me/layouts` saves `{ name, layout }`,
  `PATCH /api/me/layouts/:id` renames one and `DELETE /api/me/layouts/:id` removes it.
- A layout is a versioned value (`version: 1`): tiles and splits with their sizes, and in each tile
  its kinds of tab, a conversation's place or a view by its id, never a particular session. A
  layout the server doesn't know is refused with 400 and nothing is stored.
- A name is 1 to 48 characters with no spaces at either end, used once per person ignoring case
  (409 `SavedLayoutNameTaken`). A person keeps up to 20 (409 `SavedLayoutLimitReached`).
