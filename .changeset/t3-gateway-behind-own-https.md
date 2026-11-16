---
"@sealant/mend": patch
---

When you run HTTPS yourself in front of Mend (`mend server setup --url https://<origin>` with Mend
on loopback), setup now says how to reach the rest of the server from your other devices. For T3
Code, serve the gateway from that HTTPS on a name of its own, such as `https://t3.<host>`, to
`http://127.0.0.1:3120`, and add that as the Remote link; behind `tailscale serve`, serve it on
port 3120. For workspace SSH, which HTTPS cannot carry, publish it on a private network with
`--ssh-bind`. Setup used to name only `http://127.0.0.1:3120`, which works on the server alone.
