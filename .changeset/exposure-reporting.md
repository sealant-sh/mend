---
"@sealant/mend": minor
---

Report how an instance is exposed, not whether a tailnet was found. The shell's machine block and
`mend doctor` used to say `tailnet · reachable` or `tailnet · not detected`, inferred from an
interface address in 100.64.0.0/10: a false alarm on a LAN or public install, and never a statement
about who can reach the instance. They now say what the operator declared and what the server
observed, for example `exposure · private · https · via proxy`, and `mend doctor` asks for https
only when the instance is declared reachable beyond the machine. `GET /api/machine` gains `exposure`
(declared mode, origin scheme, whether the request arrived through a trusted proxy, the kinds of
address on the host without the addresses, open gate items); `tailnet` stays for older clients.
