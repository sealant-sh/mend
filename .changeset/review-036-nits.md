---
"@sealant/mend": patch
---

- The t3code gateway asks Mend whether a device is still paired when a socket opens with a bearer in
  its `Authorization` header, as it already did for a ticket. A device revoked in Mend is refused at
  once instead of reading for up to 15 seconds.
- `mend pull` works for a branch whose name has characters above U+00FF (CJK, for example), which
  made the bundle download fail with a 500. The download names the file in UTF-8 (`filename*`) with
  an ASCII fallback, and sends the branch percent-encoded in `x-mend-bundle-branch-encoded`, which
  the CLI reads first.
- The docs no longer call a workspace that shares one home the default: per-person workspaces are.
