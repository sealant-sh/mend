---
"@sealant/mend": patch
---

The edge that `mend server setup --edge` writes keeps a request's path in its log on Mend's origin
and nothing else of its URL, and logs no URL at all for the t3code gateway's origin
(`--t3-gateway-origin`). Before, it replaced only the values of `ticket`, `token` and `code` in a
line's URL. Other query values reached its access lines, a T3 Code image URL's token and file name
reached every line about the request, and the port-80 redirect's `Location` header carried the whole
URL. Now Mend's site has a log of its own, the only one that keeps a path. From the first `?` or `#`
the URL reads `REDACTED`, as does the userinfo of an absolute-form, opaque or `CONNECT` target, in
the URL and in a `Location` header, on the access line and on Caddy's error lines. Every other line
holds no URL and no `Location`: the gateway's, a request whose `Host` is spelled in another case or
with a trailing dot, the port-80 redirect for one, and Caddy's line for a response cut short. The
cost: access lines on Mend's origin show `?REDACTED` where an ordinary query was, and the lines of a
request with such a `Host` hold no path. `mend server setup` and `mend server upgrade` from this
version rewrite the edge's files.
