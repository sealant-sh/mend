---
"@sealant/mend": minor
---

`mend server setup` now sets up Boat sessions itself. Give it the Boat deployment with
`--boat-deployment-id <id>`, pipe the Boat API key with `--boat-api-key-stdin`, and pass the two
public addresses Boat VMs dial (`--session-endpoint-url`, `--blob-store-public-url`). Setup keeps
the key in `server.env` only. It derives the IDs Boat needs from the install, preloads the resource
gateway that lets Boat sessions reach `@db`, and keeps all of it across reruns and upgrades. At the
end it says whether each public address answered from the server. `--no-boat-resources` runs Boat
without project resources, and `--no-boat` forgets Boat. Setup refuses `--session-runtime boat`
without these settings and names what is missing, so a server no longer needs a hand-written Compose
override to run Boat. A coding agent can follow the new
[Run sessions on Boat](https://docs.mend.run/operate/boat/) page from start to finish.
