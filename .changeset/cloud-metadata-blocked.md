---
"@sealant/mend": patch
---

Sessions can no longer reach the cloud metadata address (169.254.169.254, fd00:ec2::254), so a
session on a cloud VM cannot read the instance's credentials: a connection from a workspace or from
its Docker service's containers is refused at once, and the workspace gets no raw sockets to send
packets past that. The bundled Sealant adds the refusal with a pinned busybox image that the Mend
image names (`dev.sealant.mend.network-guard-image`) and hands its worker
(`SEALANT_DOCKER_NETWORK_GUARD_IMAGE`); `mend server setup` and `mend server upgrade` pull it with
the server's images, and an `--offline` setup refuses until it is loaded. Workspaces already running
at the upgrade keep the address until they stop.
