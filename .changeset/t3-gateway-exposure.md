---
"@sealant/mend": minor
---

The T3 Code gateway follows the server's exposure instead of loopback only, so T3 Code needs no SSH
tunnel. On a loopback install it stays on `127.0.0.1:3120`. On a private install (a tailnet or LAN
address) it is published on the same address as Mend's web port: T3 Code's Remote link takes
`http://<the name Mend is reached by>:3120` and a code from `mend pair`. Behind the edge its port
stays on `127.0.0.1`, and `mend server setup --t3-gateway-origin <host>` has the edge serve it over
HTTPS on a host of its own (a t3code client always uses a server's root path, so it cannot sit under
Mend's origin); setup says where that host resolves. `--no-t3-gateway-origin` takes it away. A
public install never publishes the gateway's raw port beyond loopback.

`mend pair` prints the address to enter in T3 Code's Remote link beside the code, and a link that
carries both. `mend doctor` has a `t3code gateway` line with that address, and `mend server status`
looks for the gateway where it is published. The guided setup says where the gateway will be reached
before it asks to turn it on, and asks about the edge's host for it on a public install.

The public exposure gate's `t3code-gateway` item reads where the gateway is published
(`MEND_T3_GATEWAY_PUBLISHED`): on loopback it is observed; on a private address it is open until
declared and, like `workspace-ssh`, an open one refuses a public start; served by the edge it is
open until the operator checked that origin's certificate from outside and declared it.
