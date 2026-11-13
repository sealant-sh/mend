---
"@sealant/mend": minor
---

Setup turns Boat on without a Boat key.

- **`mend server setup --session-runtime boat` needs only the two public addresses Boat VMs dial.**
  No key is asked for. An owner of each organization connects the organization's Boat key in
  Settings, Organization, Boat, or with `mend boat connect`, and that Boat account pays for its
  sessions. Setup's last lines say so, and say which sessions run where until a key is connected.
- **The guided `mend server setup` sets Boat up itself.** Pick Boat where sessions run and it asks
  for the two addresses and whether Boat sessions reach project resources. It never asks for a key.
- **The server's own Boat key is optional.** `--boat-api-key-stdin` still gives the server one, so
  every organization with no key of its own shares its Boat account, which pays for all of them.
  `--boat-organization` names the Boat organization it bills, and `--no-boat-api-key` drops it.
- **A server set up with its own key keeps working after an upgrade with nothing to do.**
- **`--no-boat` leaves a server that runs sessions on Docker.** It no longer leaves Boat as where
  sessions run, which had every new session refused as not set up.
- **A session in an organization on Boat with no Boat key anywhere** is refused with a sentence that
  says an owner connects one, and where.
- **A server whose default for new organizations is Boat starts on Ubuntu** as its default
  environment, which Boat runs, instead of Arch, until its operator saves another.
- **The Nix module turns Boat on with `services.mend.boat`**, with no key.
