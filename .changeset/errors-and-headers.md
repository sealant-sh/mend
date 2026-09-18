---
"@sealant/mend": minor
---

Add an error boundary and a browser header policy. Error messages that leave the API are scrubbed of
what arrived from below (server paths, internal hostnames, credentials and queries in URLs, tokens)
while Mend's own words pass through; a defect answers `InternalError` with a reference id and its
detail goes to the server log under that id. `MEND_ERROR_DETAIL=verbose` turns the scrubbing off for
debugging a private instance. The web tier now sets a Content-Security-Policy (this origin only, no
framing), `nosniff`, a referrer policy (`no-referrer` on pages whose URL carries a credential), a
permissions policy, same-origin opener and resource policies, and HSTS when the origin is https. The
terminal embed keeps working: the phone loads it as a top-level document.
