---
"@sealant/mend": patch
---

Connecting a Slack app no longer refuses a valid app-level token with `invalid_auth`. Mend sent the
`xapp-` token in the request body as well as the `Authorization` header, and Slack refuses an
app-level token in a body. It now travels as a header only, the way the SDK's own Socket Mode client
sends it. The app the token belongs to is read from `auth.test` for that token; the `app_id` on the
socket URL is a hash, not the app id, and comparing it against the bot's app refused every pair of
tokens.
