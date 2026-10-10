---
"@sealant/mend": patch
---

The t3code gateway now asks for `filesystem:read` before signing a URL for a workspace or media
file, and for the scopes a settings change touches, as t3code's own server does. A pairing request
that names only `review:write`, the mark of grants from before t3code's granular permissions, is
refused as granting nothing. A pairing from the previous t3code pin that asked for
`orchestration:read` alone, rather than the standard scopes t3code clients ask for, no longer reads
files: those now need `filesystem:read`; pair that client again.
