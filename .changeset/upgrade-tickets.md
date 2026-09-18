---
"@sealant/mend": minor
---

Add upgrade tickets, so no long-lived bearer rides a URL. A WebSocket opened by a browser or the CLI
cannot set a header, and neither can a WebView loading a page, so the terminal, service tunnel and
key bridge sockets and the phone's terminal embed carried the session or device token as `?token=`,
where every proxy on the way could log it. `POST /api/upgrade-tickets` now mints a ticket that is
single use, lives thirty seconds, and opens exactly one target with exactly the parameters it was
minted for; the socket routes take it as `?ticket=`. The CLI (`mend attach`, `mend service connect`,
`mend keys share`), the desktop app, the phone and the embed page all use tickets, and the embed
page keeps a renewal ticket in memory so a dropped terminal reconnects for up to twelve hours. A
ticket is bound to the sign-in or paired device that minted it: signing out or revoking the device
ends every ticket it minted. `MEND_URL_BEARERS=refuse` answers `?token=` with 400; the default,
`accept`, keeps clients older than this release working and logs each use. A client newer than its
server falls back to `?token=` only when the mint answers 404 and `/health` does not report
`upgradeTickets`.
