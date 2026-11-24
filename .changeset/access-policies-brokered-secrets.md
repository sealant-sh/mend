---
"@sealant/mend": minor
---

Workspaces no longer join `mend_default`, the network Postgres, Garage and Mend share. Each Docker
workspace runs on a network of its own (from `MEND_WORKSPACE_EGRESS_SUBNETS`, `10.233.0.0/16` by
default) behind sealant's private-range guard, with Mend, Garage and the mirrors joined to it, so a
workspace can no longer reach Postgres or another workspace. Private destinations a workspace still
needs are opened with `MEND_OPERATOR_ALLOWED_PRIVATE_EGRESS`. Docker Engine 25 or newer is needed.

Organizations get Access policies, read and written through the API (the pages follow): the built-in
Standard and templates Organization Owners make, with Restricted egress, a Git transport cap,
Executor tools, private destinations within the server's ceiling, a VM requirement and whether
Brokered secrets may be used. Each project holds its own copy of one (Standard until an owner
assigns another); each worktree pins the rules it starts with, which the Git signer and Executor
tools now read, and "Apply updated policy" moves a running worktree to its project's current rules.
Revocations of a host, a secret or everything are kept and reach running workspaces at once. Project
secrets can be Brokered: the workspace sees only a `mend_sec_…` placeholder, and its egress proxy
puts the value in one header for the hosts it is bound to. A launch whose runtime cannot hold to its
policy is refused, never run with less. `host-vm` (a microVM per workspace on this server's KVM) can
be listed in `MEND_SESSION_RUNTIMES`; nothing chooses it by default yet.
