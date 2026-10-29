---
"@sealant/mend": minor
---

On an install whose `APP_URL` is `https:`, Mend's session cookie is now
`__Host-better-auth.session_token`: host-only, `Secure` and `Path=/`, so no other host on Mend's
site, such as a live preview on a tailnet's `ts.net` name, can set or replace it. Everyone signs in
to Mend once more after upgrading: the browser's old cookie is no longer read. Nothing is deleted;
paired devices keep working, and an earlier sign-in expires as it would have. Request budgets count
only a cookie with that exact name as a credential, so a look-alike cookie another host plants
cannot pool visitors into one window.
