---
"@sealant/mend": minor
---

Your automation switches (description and tour, suggest fixes, name the session, land when a turn
completes, background sessions) are now yours alone. Nothing fills them in from your organization or
the server any more: the organization's and the server's automation defaults are no longer read.

- On upgrade, every switch left on Inherit becomes the value it resolved to then, so your sessions
  keep doing what they did. If you are in several organizations, the one Mend showed you first (the
  one you last switched to) decides.
- `GET /api/me/automation` answers `{ own, effective }`, both plain `true` or `false` and the same.
  `inherited` and `inheritedFrom` are gone.
- `PUT /api/me/automation` takes all five as `true` or `false`. A `null` (Inherit, from an older
  client) is refused with 400 `AutomationInheritRemoved`, naming the switches, and nothing is saved.
- In the web app, your own switches are On or Off with no Inherit. The organization's Defaults page
  no longer shows automation switches, and Instance · Defaults, which held only those, is gone.
- A project's own Inherit · On · Off still sits above yours; on Inherit it follows your value.
