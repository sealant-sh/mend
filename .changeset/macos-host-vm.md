---
"@sealant/mend": minor
---

Add native Apple Silicon macOS `host-vm` workspace isolation (`mac-vmd` via Apple `Virtualization.framework`). `mend server setup` on Apple Silicon macOS 14+ with local OrbStack or Docker Desktop now detects `host-vm` support, installs the per-install `sealant-vmd` LaunchAgent (`sh.sealant.vmd.<installId>` with `AbandonProcessGroup: true`), verifies host self-test, `host.docker.internal` + `instanceNonce`, and shared APFS bind-mount visibility, and configures `compose.host-vm.yaml` with `SEALANT_HOST_VM_BACKEND=mac-vmd` and `mend-vmd-link` (`enable_icc=false`). `mend server upgrade`, `mend server status`, and `mend uninstall --server` manage the helper lifecycle without interrupting running VMs.
