---
"@sealant/mend": patch
---

Update the bundled sealant SDK and images to 0.40.0-next.939. The workspace runtime (sealantd
0.21.0-next.209) does not change.

- **A database or service resource starts beside a running workspace on a Docker server.** On a
  Docker server, where each workspace has an egress network of its own (from
  `SEALANT_DOCKER_WORKSPACE_EGRESS_SUBNETS`), a project's resource never started once a session's
  workspace was already running. Joining the workspace to the resource's network failed with
  `cannot program address … because it conflicts with existing route`. The resource now starts and
  the workspace reaches it by its name. The workspace still refuses every other private address,
  other workspaces' resource networks included. When the resource stops while the workspace is still
  running, the workspace refuses that network again before the network goes to any other workspace.
- **A workspace behind its own egress proxy that runs Docker inside starts again.** Its Docker
  service now joins the workspace's isolated network before that service's guard runs, where before
  the same route conflict stopped it.
