---
"@sealant/mend": patch
---

Fixes from the 0.36.0-next.761 fresh install on Ubuntu 24.04:

- `mend uninstall --server` finishes in one run with a live session. It used to stop on
  `network sealant-…-network has active endpoints (mend-docker-mirror)`, because it removed the
  workspaces' networks while the Docker mirror was still attached to them. Workspace containers go
  first, then the server's own containers (the mirrors among them), then the networks.
- A launch refused because the host blocks user namespaces now prints a command that works when
  pasted: `… | sudo tee /etc/sysctl.d/60-mend-rootless-docker.conf && sudo sysctl --system`. The
  server's error scrubber had turned the path into `<path>`. The command crosses whole only when it
  is exactly the one Mend writes.
- `mend server setup --yes` without `--allow-userns` says to re-run with `--allow-userns`, so that
  setup writes the sysctl file and `mend uninstall` can undo it. The command to run by hand comes
  second: a file written by hand has no marker, so uninstall leaves it.
- The guided `mend server setup` asks about the host's user namespaces before its first question.
  The kernel probe uses the busybox image every install already needs (a few megabytes), not
  `postgres:17-alpine`, so nothing of the release is pulled before the question.
- After a URL change, setup says that other accounts and other machines sign in again with
  `mend login --url <new>`, which asks for a new browser authorization. It used to say their
  sign-ins "move with" it.
- A re-run of `mend uninstall` names only the containers, volumes and image Docker still holds, in
  its plan and in what it says it removed.
