---
"@sealant/mend": patch
---

`mend server setup --url https://<origin>` now works when you run HTTPS yourself on the server in
front of Mend (nginx, Caddy, a Cloudflare Tunnel) and Mend's port stays on loopback. Setup used to
refuse it with "--bind and --url must both describe localhost exposure", although `mend doctor`
suggested exactly this command. Until the first account exists, anyone who reaches the origin can
create it, and setup says so. A plain `http` URL beyond this machine on a loopback bind is still
refused, now with a message that says how to fix it.
