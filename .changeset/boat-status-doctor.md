---
"@sealant/mend": minor
---

`mend server status`, `mend doctor` and Settings, Instance, Exposure now say where sessions run and
what was last observed about Boat. Each prints which runtimes the server offers and which one new
organizations get. On a server that offers Boat they add whether the two public addresses Boat VMs
dial answered, and when. For the operator they add the server's own Boat key as Sealant last checked
it: who it is, the wallet it bills, whether it can start a VM and when it expires. They also say
whether Sealant lists Boat, which it does once a worker reports that it launches Boat VMs, and
whether that worker has the resource gateway. `mend doctor` also checks the organization's Boat key
and your own, in the words `mend boat status` uses.

A line that needs a person says what to do. An expired or refused key, an address that does not
answer and a server that offers Boat with no worker able to launch it are problems. A key that
expires within fourteen days is a warning. A refused key is described in the words of the Boat
failure table. The machine view (`GET /api/machine`) carries the same facts: `sessionRuntimes` for
everyone, and `boat` for the operator only, signed in rather than through an access key.
