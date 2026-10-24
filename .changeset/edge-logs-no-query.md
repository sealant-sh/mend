---
"@sealant/mend": patch
---

The edge that `mend server setup --edge` writes no longer logs a request's query, on any route of
Mend's origin, and logs no URL at all for the t3code gateway's origin (`--t3-gateway-origin`).
Before, it replaced only the values of `ticket`, `token` and `code`. Other query values reached its
access lines, and a T3 Code image URL's token and file name reached every line about the request,
including Caddy's lines for a failed dial or a response cut short. The cost: access lines on Mend's
origin now show `?REDACTED` where an ordinary query was, and Caddy's line for a response cut short
holds no URL on either origin. The access line from the same `remote_port` still has Mend's path.
`mend server setup` and `mend server upgrade` from this version rewrite the edge's files.
