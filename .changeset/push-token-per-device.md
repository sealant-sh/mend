---
"@sealant/mend": patch
---

A phone's push token now belongs to the paired device that registered it. Revoking that phone in
Settings, or removing its person from the organization, drops the token in the same step, so Mend
stops sending that phone notifications. Before, a revoked phone kept receiving them. Only a paired
device's own token can register a push token: a browser sign-in or the machine token gets 403, and
the phone says to pair it from Settings → Devices. When a phone unpairs, it asks Mend to forget it
with `DELETE /api/devices`, which carries no token, so the token no longer appears in Mend's request
log or in an edge's access log. Server spans also redact the `token`, `ticket` and `code` query
parameters.

After the upgrade, phones get no notifications until they register again, because no existing token
records which phone registered it. A phone with this version of the Mend app registers again the
next time the app opens or comes back to the foreground. With an older app, tap **Enable
notifications** in Settings again. An older app still unpairs with `DELETE /api/devices/<token>`:
Mend ignores the token, forgets the calling phone, and keeps every `/api/devices/` URL out of its
request log and traces, though an edge in front of Mend may still log that URL. This version of the
app, paired to a machine older than this release, forgets nothing when it unpairs: revoke the phone
in Settings → Devices on the machine instead. 0.37 ships the server and the app together.
Downgrading the machine below this release stops notifications, and phones cannot register again
until it runs this release or later.
