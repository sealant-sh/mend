---
"@sealant/mend": patch
---

The `/etc/sysctl.d/60-mend-rootless-docker.conf` that `mend server setup` writes on a host that
refused user namespaces now starts with `# written by mend server setup; mend uninstall removes it`,
followed by the setting it replaced
(`# previous: kernel.apparmor_restrict_unprivileged_userns = 1`). `mend uninstall` can then remove
only a file setup wrote, and put the kernel's setting back.
