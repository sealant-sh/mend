---
"@sealant/mend": patch
---

A session's Preview tab shows the running app inside the tab, where previews are on the same site as
Mend over https (`previews.example.com` beside `mend.example.com`). Elsewhere the tab shows the
Service's status and "Open in a new tab", and says why: a browser does not keep a preview signed in
inside another site's page. Every answer from the preview gateway now says that only the preview
itself and Mend's own origins may frame it, and it replaces the app's own `X-Frame-Options` and
`frame-ancestors`. The web tier reads `MEND_PREVIEW_DOMAIN`, `MEND_PREVIEW_PUBLIC_PORT` and
`MEND_PREVIEW_TAILNET_HOSTNAME` as the API does; the bundle already gives them to both, and the Helm
chart now sets the preview domain on the web container too.
