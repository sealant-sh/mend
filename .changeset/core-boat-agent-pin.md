---
"@sealant/mend": patch
---

Update the bundled Sealant Core SDK and images to 0.40.0-next.838. Boat sessions now run in the VM
itself on Core's guest agent, with a root Docker daemon, instead of in a box inside the VM. Public
names resolve inside a Boat VM, and a project's resource names still resolve through the gateway.
When sealantd exits during a Boat session's readiness, the launch diagnostic now carries the end of
its output. The SDK and the bundled Core agree on the new Boat image publication, whose runtime
names `sealantctl` where it named `socat` and the relay before.
