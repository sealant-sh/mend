---
"@sealant/mend": patch
---

`mend server setup` no longer asks for a Boat deployment ID. Boat has no such thing to look up: the
value is only the name Mend labels the server's Boat VMs with, so setup now derives one from the
install. Setting up Boat needs just the API key (`--boat-api-key-stdin`) and the two public
addresses. `--boat-deployment-id <name>` still picks the name yourself, and a server that already
has one keeps it.
