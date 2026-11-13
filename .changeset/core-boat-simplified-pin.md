---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.859. A Boat session whose worktree uses no
project resources now starts with no resource gateway, so a Boat server can run with no gateway host
at all: `SEALANT_BOAT_GATEWAY_HOST_ID`, `SEALANT_BOAT_GATEWAY_RELAY_HOST` and
`SEALANT_BOAT_GATEWAY_IMAGE` are optional together, and with a gateway the relay host is required.
Resources reach a new Boat session as soon as it is linked, and come back at once after a server
restart. One gateway host carries up to 512 Boat sessions with resources at the same time. A server
with the Boat key serves Boat to everyone who can start sessions. `SEALANT_BOAT_ADMISSION_OWNER_IDS`
and `SEALANT_BOAT_GATEWAY_ENDPOINT` are retired and ignored.
