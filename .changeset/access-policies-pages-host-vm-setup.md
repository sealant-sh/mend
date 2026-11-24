---
"@sealant/mend": minor
---

Access policies have pages. Organization → Access policies lists Standard and the organization's own
policies, with what each allows, what Restricted egress reaches without listing it, the private
destinations this server lets a policy open, and the revocations. Owners add, edit and remove
policies, and revoke a host, a project secret or everything. The dialog says a revocation lasts
before anything is stored, then shows what each running workspace answered. Project → Workspace
shows the project's copy of its policy, offers Update from template when the policy has a newer
revision, and says before anyone assigns an elevated policy that it takes an Organization Owner.
Project → Variables and secrets makes a secret Direct or Brokered when it is added (in one write)
and from its Delivery… action. A Brokered secret names its header and exact hosts. The page warns
when the project's policy would keep every session from starting. A session's Details shows where
its workspace runs (a Docker container shares the server's kernel; host-vm is a virtual machine of
its own), the worktree's pinned policy and its revocations, and Apply updated policy.

`mend server setup` on a fresh Linux install with `/dev/kvm` runs the vm-runner self-test and checks
that Docker can make an isolated-gateway network. When both pass it offers host-vm and Docker, with
new organizations on host-vm, writes `compose.host-vm.yaml`, and warns when the VM data volume
shares a filesystem with Postgres or Garage. Otherwise it says what it saw and offers Docker alone.
Setup offers host-vm only with a Mend version that runs it (0.37.0-next.1748 or later); with an
older `--version` it chooses Docker, and refuses a runtime flag naming host-vm. An install that
exists keeps its runtimes; `--session-runtime` and `--session-runtimes` now accept `host-vm`, which
setup checks before it saves it.
