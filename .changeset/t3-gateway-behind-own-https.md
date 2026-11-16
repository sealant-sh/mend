---
"@sealant/mend": patch
---

When you run HTTPS yourself in front of Mend (`mend server setup --url https://<origin>` with Mend
on loopback), setup's T3 Code line now says how to use T3 Code from your other devices: forward an
HTTPS port of its own, such as `https://<host>:3120`, to the gateway on `127.0.0.1:3120`, and add
that as the Remote link. It used to name only `http://127.0.0.1:3120`, which works on the server
alone.
