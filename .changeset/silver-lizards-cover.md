---
"@sealant/mend": patch
---

Keep valid IPv4 interface addresses ending in `.0` in the server setup guide, including `/31`
point-to-point endpoints and `/32` addresses. Exclude subnet bases using the interface's CIDR prefix
while retaining bridge and loopback exclusions.
