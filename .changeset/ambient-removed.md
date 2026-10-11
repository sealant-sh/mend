---
"@sealant/mend": minor
---

The `ambient` git mode is gone. Projects that used it now use their creator's own git access mode
(`mend keys mode`), or the Mend key when they never chose one: migration 0129 moves them on upgrade,
and new projects default to `mend-key`. On a server from `mend server setup` or the Kubernetes
chart, ambient meant the server container's own git and ssh setup, which is empty, so it reached
only public HTTPS remotes. Both remaining modes reach those the same way, with no key and no shared
agent: a bridge project with nobody running `mend keys share` now adopts and fetches an HTTPS remote
instead of refusing for want of a signer. For an SSH remote, add your Mend key on the git host
(`mend keys`) or share your agent (`mend keys share`, for a key that stays on your machine, such as
a YubiKey). `mend adopt --auth ambient`, or an older client asking for ambient, is refused with a
line naming `--auth mend-key` and `--auth bridge`. The dashboard's adopt offer lists `mend-key` and
`bridge` and starts on your own mode, and the web adopt panel and project setup offer the same two.
Recorded git operations keep the mode they ran under, `ambient` included. A server run from source
as your own user still uses that user's git config (credential helper, `insteadOf`) for HTTPS
remotes in either mode. Mend picks the signer by the URL git actually dials, after `insteadOf` (and
`pushInsteadOf` for a push), so an https origin rewritten to ssh signs with your key or bridge.
Wherever Mend resolves no signer, including a session's fetch of an unknown base, ssh runs with no
config, no default keys and no agent, so it refuses rather than answer as the server process. The
bridge no longer offers the server process's default key files beside the shared agent's keys. The
dashboard reads your saved mode on its own, so its adopt offer starts on bridge even in a terminal
with no agent to share.
