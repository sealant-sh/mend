---
"@sealant/mend": patch
---

`mend connect claude` logs in afresh every time and keeps no copy on this machine, as
`mend connect codex` does: the browser login runs against a throwaway directory, the grant is sent
and the directory deleted (on macOS, with its Keychain item). It used to keep Mend's grant in
`~/.config/mend/claude-grant` and send that again while it had not expired; once the server had
refreshed the login, that copy held a spent refresh token, and a reconnect replaced a working login
with a dead one. The old directory is removed on the next connect. Both logins' throwaway
directories now live under `~/.config/mend`, where Codex no longer warns that it cannot create its
helper binaries.
