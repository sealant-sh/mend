---
"@sealant/mend": patch
---

Update the bundled Sealant Core SDK and images to 0.40.0-next.833. Boat sessions now run in the VM
itself on Core's guest agent, with a root Docker daemon, instead of in a box inside the VM. The SDK
and the bundled Core agree on the new Boat image publication, whose runtime names `sealantctl` where
it named `socat` and the relay before.
